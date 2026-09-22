// scanner_src.cs — Native port of scanner.ps1
//
// Compiled output:
//   scanner-x64.exe (for x64 launcher)
//   scanner-x86.exe (for ia32 launcher)
//
// Modes (CLI-compatible with scanner.ps1):
//   detect-ppapi  -BrowserPid <p> -GamePids <list>
//   listprocs     -BrowserPid <p> -GamePids <list>
//   new           -BrowserPid <p> -GamePids <list> -Value <n> -ScanType <t> -MaxResult <n> [-CachedPpapiPid <p>]
//   next          -BrowserPid <p> -GamePids <list> -Value <n> [-PrevFile <f>] [-Prev <list>] [-CachedPpapiPid <p>]
//   read          -Addr <tag>
//   write         -Addr <tag> -WriteVal <n>
//   batchwrite    -BatchFile <f>
//
// Output: single ConvertTo-Json -Compress -Depth 6 equivalent to scanner.ps1's $output.
// stderr: same [Discovery]/[Detect]/[PPAPI]/[ScanOrder]/[NewScan]/[NextScan]/[CachedPpapi] tags.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

static class Win32 {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
    [DllImport("kernel32.dll")] public static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int written);
    [DllImport("kernel32.dll")] public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, ref MBI mbi, int len);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool Module32First(IntPtr hSnapshot, ref MODULEENTRY32 lpme);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool Module32Next(IntPtr hSnapshot, ref MODULEENTRY32 lpme);
    [DllImport("kernel32.dll")] public static extern bool IsWow64Process(IntPtr h, out bool wow64);
    [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int size, out int ret);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemoryRef(IntPtr h, IntPtr addr, ref long buf, int size, out int read);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct MODULEENTRY32 {
        public uint dwSize;
        public uint th32ModuleID;
        public uint th32ProcessID;
        public uint GlblcntUsage;
        public uint ProccntUsage;
        public IntPtr modBaseAddr;
        public uint modBaseSize;
        public IntPtr hModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI {
        public IntPtr Base, AllocBase;
        public uint AllocProtect;
        public IntPtr Size;
        public uint State, Protect, Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    public const uint MEM_COMMIT = 0x1000;
    public const uint MEM_PRIVATE = 0x20000;
    public const uint MEM_MAPPED = 0x40000;
    public const uint MEM_IMAGE = 0x1000000;
    public const uint PAGE_NOACCESS = 0x01;
    public const uint PAGE_GUARD = 0x100;
    public const uint PAGE_READABLE = 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80;
}

static class MemScanner {
    static uint[] OPEN_MODES = new uint[] { 0x1F0FFF, 0x0410, 0x0010 };
    static uint[] WRITE_MODES = new uint[] { 0x1F0FFF, 0x0430, 0x0020 };

    public static IntPtr OpenBest(int pid, bool write) {
        uint[] modes = write ? WRITE_MODES : OPEN_MODES;
        foreach (uint m in modes) {
            IntPtr h = Win32.OpenProcess(m, false, pid);
            if (h != IntPtr.Zero) return h;
        }
        return IntPtr.Zero;
    }

    public static int GetParentPid(int pid) {
        try {
            IntPtr h = Win32.OpenProcess(0x0400, false, pid);
            if (h == IntPtr.Zero) return -1;
            var pbi = new Win32.PROCESS_BASIC_INFORMATION();
            int ret;
            Win32.NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret);
            Win32.CloseHandle(h);
            return (int)(long)pbi.InheritedFromUniqueProcessId;
        } catch { return -1; }
    }

    public static List<int> GetAllChildren(int rootPid) {
        var result = new List<int>();
        try {
            var all = Process.GetProcesses();
            var queue = new Queue<int>();
            queue.Enqueue(rootPid);
            var visited = new HashSet<int>(); visited.Add(rootPid);
            while (queue.Count > 0) {
                int cur = queue.Dequeue();
                foreach (var p in all) {
                    if (visited.Contains(p.Id)) continue;
                    try {
                        if (GetParentPid(p.Id) == cur) {
                            result.Add(p.Id);
                            visited.Add(p.Id);
                            queue.Enqueue(p.Id);
                        }
                    } catch { }
                }
            }
        } catch { }
        return result;
    }

    public static string GetProcName(int pid) {
        try {
            using (var p = Process.GetProcessById(pid)) {
                return (p.ProcessName ?? "").ToLowerInvariant();
            }
        } catch { return ""; }
    }

    public static string GetCmdLine(int pid) {
        IntPtr hProc = IntPtr.Zero;
        try {
            hProc = Win32.OpenProcess(0x0410, false, pid);
            if (hProc == IntPtr.Zero) hProc = Win32.OpenProcess(0x1F0FFF, false, pid);
            if (hProc == IntPtr.Zero) return "";

            bool isWow64 = false;
            Win32.IsWow64Process(hProc, out isWow64);
            // Self bitness: if we are 64-bit, isWow64=true means target is 32-bit (WOW64)
            // If we are 32-bit, this scanner is x86 → target is also x86 (we don't read 64-bit target PEB cross-arch)
            bool selfIs64 = (IntPtr.Size == 8);
            bool target32 = selfIs64 ? isWow64 : true;

            int ppOffset = target32 ? 0x10 : 0x20;
            int clOffset = target32 ? 0x40 : 0x70;
            int usSize = target32 ? 8 : 16;
            int bufPtrOff = target32 ? 4 : 8;

            var pbi = new Win32.PROCESS_BASIC_INFORMATION();
            int sz;
            int status = Win32.NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(pbi), out sz);
            if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero) return "";

            long pebAddr = (long)pbi.PebBaseAddress;
            int read = 0;

            long ppAddr = 0;
            if (target32) {
                byte[] tmp4 = new byte[4];
                if (!Win32.ReadProcessMemory(hProc, new IntPtr(pebAddr + ppOffset), tmp4, 4, out read) || read != 4) return "";
                ppAddr = (long)(uint)BitConverter.ToInt32(tmp4, 0);
            } else {
                byte[] tmp8 = new byte[8];
                if (!Win32.ReadProcessMemory(hProc, new IntPtr(pebAddr + ppOffset), tmp8, 8, out read) || read != 8) return "";
                ppAddr = BitConverter.ToInt64(tmp8, 0);
            }
            if (ppAddr == 0) return "";

            byte[] usBuf = new byte[usSize];
            if (!Win32.ReadProcessMemory(hProc, new IntPtr(ppAddr + clOffset), usBuf, usSize, out read) || read < usSize) return "";

            ushort len = BitConverter.ToUInt16(usBuf, 0);
            if (len == 0 || len > 8192) return "";
            long bufPtr;
            if (target32) bufPtr = (long)(uint)BitConverter.ToInt32(usBuf, bufPtrOff);
            else bufPtr = BitConverter.ToInt64(usBuf, bufPtrOff);
            if (bufPtr == 0) return "";

            byte[] strBuf = new byte[len];
            if (!Win32.ReadProcessMemory(hProc, new IntPtr(bufPtr), strBuf, len, out read) || read < 2) return "";
            return Encoding.Unicode.GetString(strBuf, 0, read);
        } catch { return ""; }
        finally { if (hProc != IntPtr.Zero) Win32.CloseHandle(hProc); }
    }

    public static bool HasModule(int pid, string partialName) {
        const uint TH32CS_SNAPMODULE = 0x00000008;
        const uint TH32CS_SNAPMODULE32 = 0x00000010;
        IntPtr snap = Win32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, (uint)pid);
        if (snap == new IntPtr(-1)) return false;
        var me = new Win32.MODULEENTRY32();
        me.dwSize = (uint)Marshal.SizeOf(me);
        try {
            if (!Win32.Module32First(snap, ref me)) return false;
            string lower = partialName.ToLowerInvariant();
            do {
                if (me.szModule != null && me.szModule.ToLowerInvariant().Contains(lower)) return true;
                if (me.szExePath != null && me.szExePath.ToLowerInvariant().Contains(lower)) return true;
            } while (Win32.Module32Next(snap, ref me));
        } catch { } finally { Win32.CloseHandle(snap); }
        return false;
    }

    delegate bool RegionVisitor(IntPtr base_, byte[] buf, int read);

    static void IterateRegions(IntPtr hProc, RegionVisitor cb) {
        var mbi = new Win32.MBI();
        int mbiSz = Marshal.SizeOf(mbi);
        long addrL = 0;
        // ── x64 扫 Wow64 (32-bit Flash) 目标时 maxAddr 必须夹到 32-bit 顶 ──
        // 否则会枚举到 64-bit ntdll64 / wow64*.dll 等高地址 (>0x80000000),
        // 这些区域里有大量 const Int32 = 20 的代码常量, 会被 NewScan 当作候选,
        // 但它们永远不会变成 40, 导致 NextScan(40) 把整个候选池过滤为 0。
        // 32-bit user-mode VA top = 0x7FFE0000; 64-bit user-mode VA top = 0x00007FFFFFFE0000.
        bool selfIs64 = (IntPtr.Size == 8);
        bool targetIsWow64 = false;
        if (selfIs64) {
            try { Win32.IsWow64Process(hProc, out targetIsWow64); } catch { }
        }
        long maxAddr;
        if (!selfIs64) maxAddr = 0x7FFE0000L;            // x86 scanner: 32-bit IntPtr 上限
        else if (targetIsWow64) maxAddr = 0x7FFE0000L;   // x64 scanner + Wow64 target: 夹到 32-bit
        else maxAddr = 0x00007FFFFFFE0000L;              // x64 scanner + 64-bit target
        Console.Error.WriteLine("[Regions] selfIs64=" + selfIs64 + " targetIsWow64=" + targetIsWow64 + " maxAddr=0x" + maxAddr.ToString("X"));

        // 区域内分块大小 (默认 2MB), 用于控制单次 ReadProcessMemory 的内存峰值。
        // 关键: 区域大小可能远超 CHUNK (Flash AVM2 heap 常见 50-200MB),
        // 必须分块循环直到读完整个 region; 否则 ScanInt32 只看到前 2MB,
        // GC 一搬家真实地址就漏掉, NextScan 永远过滤为 0。
        const int CHUNK = 2 * 1024 * 1024;

        bool stopAll = false;
        long regionsTotal = 0, regionsScanned = 0, totalBytesScanned = 0;
        while (!stopAll && addrL >= 0 && addrL < maxAddr) {
            IntPtr addr;
            try { addr = new IntPtr(addrL); }
            catch { break; }
            int qr = Win32.VirtualQueryEx(hProc, addr, ref mbi, mbiSz);
            if (qr == 0) break;
            long regionSize = (long)mbi.Size;
            // 防御: VirtualQueryEx 返回的 Size 异常时强制至少前进 4KB, 避免死循环
            if (regionSize <= 0) regionSize = 0x1000;
            long next = addrL + regionSize;
            // 防御: 如果 next 不前进, 强制前进
            if (next <= addrL) next = addrL + 0x1000;
            regionsTotal++;

            if (mbi.State == Win32.MEM_COMMIT
                && mbi.Type == Win32.MEM_PRIVATE
                && (mbi.Protect & Win32.PAGE_READABLE) != 0
                && (mbi.Protect & Win32.PAGE_NOACCESS) == 0
                && (mbi.Protect & Win32.PAGE_GUARD) == 0) {
                regionsScanned++;
                long off = 0;
                long regionBaseAbs = (long)mbi.Base;
                while (off < regionSize) {
                    long remaining = regionSize - off;
                    int chunk = (int)Math.Min(remaining, (long)CHUNK);
                    long absBase = regionBaseAbs + off;
                    try {
                        byte[] buf = new byte[chunk];
                        int read = 0;
                        if (Win32.ReadProcessMemory(hProc, new IntPtr(absBase), buf, chunk, out read) && read >= 4) {
                            totalBytesScanned += read;
                            if (!cb(new IntPtr(absBase), buf, read)) { stopAll = true; break; }
                        }
                    } catch { }
                    off += chunk;
                }
            }
            addrL = next;
        }
        Console.Error.WriteLine("[Regions] regionsTotal=" + regionsTotal + " regionsScanned=" + regionsScanned + " bytesScanned=" + totalBytesScanned);
    }

    public static List<string> ScanInt32(IntPtr hProc, int pid, int val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        IterateRegions(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 4; i += 4) {
                if (buf[i] == valB[0] && buf[i + 1] == valB[1] && buf[i + 2] == valB[2] && buf[i + 3] == valB[3]) {
                    results.Add(((long)base_ + i).ToString("X") + ":" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    public static List<string> ScanFloat(IntPtr hProc, int pid, float val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        IterateRegions(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 4; i += 4) {
                if (buf[i] == valB[0] && buf[i + 1] == valB[1] && buf[i + 2] == valB[2] && buf[i + 3] == valB[3]) {
                    results.Add(((long)base_ + i).ToString("X") + ":F:" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    public static List<string> ScanDouble(IntPtr hProc, int pid, double val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        IterateRegions(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 8; i += 8) {
                bool match = true;
                for (int j = 0; j < 8; j++) if (buf[i + j] != valB[j]) { match = false; break; }
                if (match) {
                    results.Add(((long)base_ + i).ToString("X") + ":D:" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    public static List<string> FilterAddresses(string[] addrTags, long val) {
        var results = new List<string>();
        var byPid = new Dictionary<int, List<string>>();
        foreach (var tag in addrTags) {
            var parts = tag.Split(':');
            int pid2 = -1;
            if (parts.Length == 2) { int.TryParse(parts[1], out pid2); }
            else if (parts.Length == 3) { int.TryParse(parts[2], out pid2); }
            if (pid2 < 0) continue;
            if (!byPid.ContainsKey(pid2)) byPid[pid2] = new List<string>();
            byPid[pid2].Add(tag);
        }
        foreach (var kv in byPid) {
            IntPtr hProc = OpenBest(kv.Key, false);
            if (hProc == IntPtr.Zero) continue;
            byte[] buf4 = new byte[4], buf8 = new byte[8];
            try {
                foreach (var tag in kv.Value) {
                    var parts = tag.Split(':');
                    string dtype = parts.Length == 3 ? parts[1] : "I";
                    long la;
                    if (!long.TryParse(parts[0], NumberStyles.HexNumber, null, out la)) continue;
                    int read = 0;
                    if (dtype == "D") {
                        if (Win32.ReadProcessMemory(hProc, new IntPtr(la), buf8, 8, out read) && read == 8) {
                            double v = BitConverter.ToDouble(buf8, 0);
                            if (Math.Abs(v - (double)val) < 0.5) results.Add(tag);
                        }
                    } else if (dtype == "F") {
                        if (Win32.ReadProcessMemory(hProc, new IntPtr(la), buf4, 4, out read) && read == 4) {
                            float v = BitConverter.ToSingle(buf4, 0);
                            if (Math.Abs(v - (float)val) < 0.5f) results.Add(tag);
                        }
                    } else {
                        if (Win32.ReadProcessMemory(hProc, new IntPtr(la), buf4, 4, out read) && read == 4) {
                            int v = BitConverter.ToInt32(buf4, 0);
                            if (v == (int)val) results.Add(tag);
                        }
                    }
                }
            } finally { Win32.CloseHandle(hProc); }
        }
        return results;
    }

    public static string ReadTagged(string tag) {
        var parts = tag.Split(':');
        string dtype = parts.Length == 3 ? parts[1] : "I";
        int pid2; long la;
        if (parts.Length == 2) { if (!int.TryParse(parts[1], out pid2)) return "ERR"; }
        else if (parts.Length == 3) { if (!int.TryParse(parts[2], out pid2)) return "ERR"; }
        else return "ERR:fmt";
        if (!long.TryParse(parts[0], NumberStyles.HexNumber, null, out la)) return "ERR:addr";
        IntPtr hProc = OpenBest(pid2, false);
        if (hProc == IntPtr.Zero) return "ERR:open";
        byte[] buf = new byte[8]; int read = 0;
        try {
            if (dtype == "D") {
                if (!Win32.ReadProcessMemory(hProc, new IntPtr(la), buf, 8, out read) || read != 8) return "ERR:read";
                return BitConverter.ToDouble(buf, 0).ToString();
            } else if (dtype == "F") {
                if (!Win32.ReadProcessMemory(hProc, new IntPtr(la), buf, 4, out read) || read != 4) return "ERR:read";
                return BitConverter.ToSingle(buf, 0).ToString();
            } else {
                if (!Win32.ReadProcessMemory(hProc, new IntPtr(la), buf, 4, out read) || read != 4) return "ERR:read";
                return BitConverter.ToInt32(buf, 0).ToString();
            }
        } finally { Win32.CloseHandle(hProc); }
    }

    public static bool WriteTagged(string tag, long val) {
        var parts = tag.Split(':');
        string dtype = parts.Length == 3 ? parts[1] : "I";
        int pid2; long la;
        if (parts.Length == 2) { if (!int.TryParse(parts[1], out pid2)) return false; }
        else if (parts.Length == 3) { if (!int.TryParse(parts[2], out pid2)) return false; }
        else return false;
        if (!long.TryParse(parts[0], NumberStyles.HexNumber, null, out la)) return false;
        IntPtr hProc = OpenBest(pid2, true);
        if (hProc == IntPtr.Zero) return false;
        byte[] buf; int written = 0;
        if (dtype == "D") buf = BitConverter.GetBytes((double)val);
        else if (dtype == "F") buf = BitConverter.GetBytes((float)val);
        else buf = BitConverter.GetBytes((int)val);
        try { return Win32.WriteProcessMemory(hProc, new IntPtr(la), buf, buf.Length, out written); }
        finally { Win32.CloseHandle(hProc); }
    }
}

static class JsonW {
    public static string Esc(string s) {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s) {
            switch (c) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.AppendFormat("\\u{0:X4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
    public static string Arr(IEnumerable<int> a) {
        if (a == null) return "[]";
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var v in a) {
            if (!first) sb.Append(',');
            sb.Append(v);
            first = false;
        }
        sb.Append(']');
        return sb.ToString();
    }
    public static string ArrStr(IEnumerable<string> a) {
        if (a == null) return "[]";
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var v in a) {
            if (!first) sb.Append(',');
            sb.Append(Esc(v));
            first = false;
        }
        sb.Append(']');
        return sb.ToString();
    }
}

class Program {
    static Dictionary<string, string> ParseArgs(string[] args) {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++) {
            var a = args[i];
            if (a.StartsWith("-") && i + 1 < args.Length && !args[i + 1].StartsWith("-")) {
                d[a.Substring(1)] = args[i + 1];
                i++;
            } else if (a.StartsWith("-")) {
                d[a.Substring(1)] = "";
            }
        }
        return d;
    }

    static void Err(string msg) { Console.Error.WriteLine(msg); }

    static int Main(string[] args) {
        try {
            var a = ParseArgs(args);
            string mode = a.ContainsKey("Mode") ? a["Mode"] : "new";
            string browserPid = a.ContainsKey("BrowserPid") ? a["BrowserPid"] : "";
            string gamePids = a.ContainsKey("GamePids") ? a["GamePids"] : "";
            string prev = a.ContainsKey("Prev") ? a["Prev"] : "";
            string prevFile = a.ContainsKey("PrevFile") ? a["PrevFile"] : "";
            string batchFile = a.ContainsKey("BatchFile") ? a["BatchFile"] : "";
            string addr = a.ContainsKey("Addr") ? a["Addr"] : "";
            long value = 0; long.TryParse(a.ContainsKey("Value") ? a["Value"] : "0", out value);
            long writeVal = 0; long.TryParse(a.ContainsKey("WriteVal") ? a["WriteVal"] : "0", out writeVal);
            int maxResult = 50000; int.TryParse(a.ContainsKey("MaxResult") ? a["MaxResult"] : "50000", out maxResult);
            string scanType = (a.ContainsKey("ScanType") ? a["ScanType"] : "int32").ToLowerInvariant();
            string cachedPpapiPid = a.ContainsKey("CachedPpapiPid") ? a["CachedPpapiPid"] : "";

            int browserPidInt = 0; int.TryParse(browserPid, out browserPidInt);

            // ── DETECT-PPAPI ──────────────────────────────────────────────
            if (mode == "detect-ppapi") {
                var rootPids = new List<int>();
                if (browserPidInt > 0) rootPids.Add(browserPidInt);
                if (gamePids != "") {
                    foreach (var p in gamePids.Split(',')) {
                        int n; if (int.TryParse(p.Trim(), out n) && n > 0) rootPids.Add(n);
                    }
                }
                var allPids = new HashSet<int>();
                foreach (var r in rootPids) {
                    allPids.Add(r);
                    foreach (var c in MemScanner.GetAllChildren(r)) allPids.Add(c);
                }
                string[] excludeNames = { "powershell", "pwsh", "conhost", "cmd" };
                var found = new List<int>();
                foreach (var pid2 in allPids) {
                    if (pid2 == browserPidInt) continue;
                    string n2 = MemScanner.GetProcName(pid2);
                    if (Array.IndexOf(excludeNames, n2) >= 0) continue;
                    bool hasFlash = MemScanner.HasModule(pid2, "pepflash");
                    string cmd = "";
                    try { cmd = MemScanner.GetCmdLine(pid2); } catch { }
                    bool isPpapi = cmd.Contains("--type=ppapi") || cmd.Contains("--type=pepper");
                    Err("[Detect] PID=" + pid2 + " name=" + n2 + " hasFlashDLL=" + hasFlash + " cmdHasPpapi=" + isPpapi);
                    if (hasFlash || isPpapi) found.Add(pid2);
                }
                Console.WriteLine("{\"ok\":" + (found.Count > 0 ? "true" : "false") + ",\"ppapi\":" + JsonW.Arr(found) + ",\"scanned\":" + allPids.Count + "}");
                return 0;
            }

            // ── BATCHWRITE ────────────────────────────────────────────────
            if (mode == "batchwrite") {
                if (batchFile == "" || !File.Exists(batchFile)) {
                    Console.WriteLine("{\"ok\":false,\"error\":" + JsonW.Esc("BatchFile not found: " + batchFile) + "}");
                    return 0;
                }
                int ok2 = 0, fail2 = 0;
                foreach (var line in File.ReadAllLines(batchFile)) {
                    if (line == "") continue;
                    var parts = line.Split('\t');
                    if (parts.Length != 2) { fail2++; continue; }
                    long wv; if (!long.TryParse(parts[1], out wv)) { fail2++; continue; }
                    if (MemScanner.WriteTagged(parts[0], wv)) ok2++; else fail2++;
                }
                Console.WriteLine("{\"ok\":true,\"written\":" + ok2 + ",\"failed\":" + fail2 + "}");
                return 0;
            }

            // ── WRITE ────────────────────────────────────────────────────
            if (mode == "write") {
                bool ok = MemScanner.WriteTagged(addr, writeVal);
                Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"msg\":" + JsonW.Esc(ok ? "OK" : "ERR:write failed") + "}");
                return 0;
            }

            // ── READ ─────────────────────────────────────────────────────
            if (mode == "read") {
                string r = MemScanner.ReadTagged(addr);
                bool ok = !r.StartsWith("ERR");
                Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"value\":" + JsonW.Esc(r) + "}");
                return 0;
            }

            // ── NEXT ─────────────────────────────────────────────────────
            if (mode == "next") {
                string[] addrArr = new string[0];
                if (prevFile != "" && File.Exists(prevFile)) {
                    addrArr = File.ReadAllLines(prevFile).Where(s => s != "").ToArray();
                } else if (prev != "") {
                    addrArr = prev.Split(',').Where(s => s != "").ToArray();
                }
                int inD = addrArr.Count(t => System.Text.RegularExpressions.Regex.IsMatch(t, @"^[0-9A-Fa-f]+:D:\d+$"));
                int inF = addrArr.Count(t => System.Text.RegularExpressions.Regex.IsMatch(t, @"^[0-9A-Fa-f]+:F:\d+$"));
                int inI = addrArr.Length - inD - inF;
                Err("[NextScan] input=" + addrArr.Length + " (Double=" + inD + " Float=" + inF + " Int32=" + inI + ") filterValue=" + value);
                var res = MemScanner.FilterAddresses(addrArr, value);
                int outD = res.Count(t => System.Text.RegularExpressions.Regex.IsMatch(t, @"^[0-9A-Fa-f]+:D:\d+$"));
                int outF = res.Count(t => System.Text.RegularExpressions.Regex.IsMatch(t, @"^[0-9A-Fa-f]+:F:\d+$"));
                int outI = res.Count - outD - outF;
                Err("[NextScan] output=" + res.Count + " (Double=" + outD + " Float=" + outF + " Int32=" + outI + ")");
                Console.WriteLine("{\"ok\":true,\"addresses\":" + JsonW.ArrStr(res) + ",\"count\":" + res.Count + "}");
                return 0;
            }

            // ── NEW SCAN ─────────────────────────────────────────────────
            // Process discovery (mirrors scanner.ps1)
            var rootPids2 = new List<int>();
            if (browserPidInt > 0) rootPids2.Add(browserPidInt);
            if (gamePids != "") {
                foreach (var p in gamePids.Split(',')) {
                    int n; if (int.TryParse(p.Trim(), out n) && n > 0) rootPids2.Add(n);
                }
            }
            var allPids2 = new HashSet<int>();
            foreach (var r in rootPids2) {
                allPids2.Add(r);
                foreach (var c in MemScanner.GetAllChildren(r)) allPids2.Add(c);
            }

            var ppApiPids = new List<int>();
            string[] excludeNames2 = { "powershell", "pwsh", "conhost", "cmd" };

            // Cache fast-path
            bool usedCache = false;
            if (cachedPpapiPid != "") {
                int cachedPid = 0;
                if (int.TryParse(cachedPpapiPid.Trim(), out cachedPid) && cachedPid > 0) {
                    string pname = MemScanner.GetProcName(cachedPid);
                    bool alive = false;
                    try {
                        using (var p = Process.GetProcessById(cachedPid)) { alive = (p != null); }
                    } catch { }
                    Err("[CachedPpapi] pid=" + cachedPid + " name=" + pname + " alive=" + alive);
                    if (alive && !string.IsNullOrEmpty(pname)) {
                        ppApiPids.Add(cachedPid);
                        usedCache = true;
                    }
                }
            }

            // Full discovery if cache missed
            if (!usedCache) {
                Err("[Discovery] Scanning " + allPids2.Count + " PIDs (BrowserPid=" + browserPid + ")...");
                foreach (var pid2 in allPids2) {
                    string name = MemScanner.GetProcName(pid2);
                    string cmd = "";
                    try { cmd = MemScanner.GetCmdLine(pid2); } catch { }
                    string type = "other";
                    if (cmd.Contains("--type=ppapi")) { type = "ppapi"; ppApiPids.Add(pid2); }
                    else if (cmd.Contains("--type=renderer")) { type = "renderer"; }
                    else if (cmd.Contains("--type=gpu-process")) { type = "gpu"; }
                    string cmdShort = cmd.Length > 80 ? cmd.Substring(0, 80) : cmd;
                    Err("[Discovery]   PID=" + pid2 + " name=" + name + " type=" + type + " cmd=[" + cmdShort + "]");
                }
                Err("[Discovery] ppapi=" + string.Join(",", ppApiPids.Select(p => p.ToString()).ToArray()));
            }

            ppApiPids = ppApiPids.Where(p => Array.IndexOf(excludeNames2, MemScanner.GetProcName(p)) < 0).ToList();

            // DLL fallback
            if (ppApiPids.Count == 0) {
                Err("[PPAPI] cmdline detection failed, trying DLL module scan on tree...");
                foreach (var pid2 in allPids2) {
                    string n2 = MemScanner.GetProcName(pid2);
                    if (Array.IndexOf(excludeNames2, n2) >= 0) continue;
                    if (pid2 == browserPidInt) continue;
                    bool hasFlash = MemScanner.HasModule(pid2, "pepflash");
                    Err("[PPAPI]   PID=" + pid2 + " name=" + n2 + " hasFlashDLL=" + hasFlash);
                    if (hasFlash) { ppApiPids.Add(pid2); break; }
                }
            }

            // ScanOrder + new/next refusal
            if (ppApiPids.Count == 0) {
                Err("[ScanOrder] ppapi NOT found; refusing renderer fallback");
                if (mode == "new") {
                    Console.WriteLine("{\"ok\":false,\"error\":\"Flash PPAPI process not detected. Refresh the game and reopen the scanner.\",\"ppapi\":[],\"allPids\":[]}");
                    return 0;
                }
            }

            if (mode == "listprocs") {
                Console.WriteLine("{\"ok\":true,\"ppapi\":" + JsonW.Arr(ppApiPids) + ",\"renderer\":[]}");
                return 0;
            }

            // NEW SCAN
            var allResults = new List<string>();
            var pidStatsList = new List<string>();
            Err("[NewScan] scanOrder=" + string.Join(",", ppApiPids.Select(p => p.ToString()).ToArray()) + " value=" + value + " type=" + scanType + " maxResult=" + maxResult);

            foreach (var pid2 in ppApiPids) {
                int remaining = maxResult - allResults.Count;
                if (remaining <= 0) break;

                IntPtr hProc = MemScanner.OpenBest(pid2, false);
                if (hProc == IntPtr.Zero) {
                    pidStatsList.Add("{\"pid\":" + pid2 + ",\"name\":" + JsonW.Esc(MemScanner.GetProcName(pid2)) + ",\"found\":0,\"skipped\":true,\"reason\":\"open failed\"}");
                    Err("[NewScan]   PID=" + pid2 + " OPEN FAILED");
                    continue;
                }

                int cntD = 0, cntF = 0, cntI = 0;
                try {
                    if (scanType == "all" || scanType == "double") {
                        int budgetD = (scanType == "all") ? Math.Min(remaining, 10000) : remaining;
                        var rD = MemScanner.ScanDouble(hProc, pid2, (double)value, budgetD);
                        allResults.AddRange(rD); cntD = rD.Count; remaining -= rD.Count;
                    }
                    if (scanType == "all" || scanType == "float") {
                        int budgetF = (scanType == "all") ? Math.Min(remaining, 5000) : remaining;
                        var rF = MemScanner.ScanFloat(hProc, pid2, (float)value, budgetF);
                        allResults.AddRange(rF); cntF = rF.Count; remaining -= rF.Count;
                    }
                    if (scanType == "all" || scanType == "int32") {
                        int budgetI = Math.Min(remaining, maxResult);
                        var r32 = MemScanner.ScanInt32(hProc, pid2, (int)value, budgetI);
                        allResults.AddRange(r32); cntI = r32.Count; remaining -= r32.Count;
                    }
                } finally { Win32.CloseHandle(hProc); }

                int found = cntD + cntF + cntI;
                Err("[NewScan]   PID=" + pid2 + " type=ppapi total=" + found + " Double=" + cntD + " Float=" + cntF + " Int32=" + cntI);
                pidStatsList.Add("{\"pid\":" + pid2 + ",\"name\":" + JsonW.Esc(MemScanner.GetProcName(pid2)) + ",\"type\":\"ppapi\",\"found\":" + found + ",\"cntD\":" + cntD + ",\"cntF\":" + cntF + ",\"cntI\":" + cntI + "}");
            }

            // Output
            var sbOut = new StringBuilder();
            sbOut.Append("{\"ok\":true,\"addresses\":");
            sbOut.Append(JsonW.ArrStr(allResults));
            sbOut.Append(",\"count\":").Append(allResults.Count);
            sbOut.Append(",\"pids\":[");
            sbOut.Append(string.Join(",", pidStatsList.ToArray()));
            sbOut.Append("],\"ppapi\":");
            sbOut.Append(JsonW.Arr(ppApiPids));
            sbOut.Append(",\"allPids\":");
            sbOut.Append(JsonW.Arr(ppApiPids));
            sbOut.Append("}");
            Console.WriteLine(sbOut.ToString());
            return 0;
        } catch (Exception ex) {
            string msg = ex.Message + " | " + ex.StackTrace;
            Console.WriteLine("{\"ok\":false,\"error\":" + JsonW.Esc(msg) + "}");
            return 1;
        }
    }
}
