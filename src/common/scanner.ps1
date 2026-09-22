# scanner.ps1 - Seer2 Memory Scanner v3
# Scans the PPAPI Flash plugin process (child of browser process)
param(
    [string]$BrowserPid = "",   # Main electron browser process PID (process.pid)
    [string]$GamePids   = "",   # Fallback: comma-separated renderer PIDs
    [long]  $Value      = 0,
    [string]$Mode       = "new",
    [string]$Prev       = "",
    [string]$PrevFile   = "",   # Path to temp file containing addresses (one per line) — avoids ENAMETOOLONG
    [string]$BatchFile  = "",   # Path to temp file for batchwrite: "ADDR\tVALUE" per line
    [string]$Addr       = "",
    [long]  $WriteVal   = 0,
    [int]   $MaxResult  = 50000,
    [string]$ScanType       = "int32",  # int32 | float | double | all
    [string]$CachedPpapiPid = ""          # pre-discovered ppapi PID: skips process discovery
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class MemScanner {
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern bool  CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool  ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
    [DllImport("kernel32.dll")] public static extern bool  WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int written);
    [DllImport("kernel32.dll")] public static extern int   VirtualQueryEx(IntPtr h, IntPtr addr, ref MBI mbi, int len);

    // Module enumeration — used to identify Flash PPAPI process by loaded DLL name
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll")] static extern bool   Module32First(IntPtr hSnapshot, ref MODULEENTRY32 lpme);
    [DllImport("kernel32.dll")] static extern bool   Module32Next(IntPtr hSnapshot, ref MODULEENTRY32 lpme);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    struct MODULEENTRY32 {
        public uint    dwSize;
        public uint    th32ModuleID;
        public uint    th32ProcessID;
        public uint    GlblcntUsage;
        public uint    ProccntUsage;
        public IntPtr  modBaseAddr;
        public uint    modBaseSize;
        public IntPtr  hModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath;
    }

    // Returns true if the process has a loaded module whose name contains 'partialName' (case-insensitive).
    // Used to detect the Flash PPAPI process: it's the only electron.exe that loads pepflashplayer*.dll
    public static bool HasModule(int pid, string partialName) {
        const uint TH32CS_SNAPMODULE   = 0x00000008;
        const uint TH32CS_SNAPMODULE32 = 0x00000010;
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, (uint)pid);
        if (snap == new IntPtr(-1)) return false;
        var me = new MODULEENTRY32();
        me.dwSize = (uint)Marshal.SizeOf(me);
        try {
            if (!Module32First(snap, ref me)) return false;
            string lower = partialName.ToLower();
            do {
                if (me.szModule != null && me.szModule.ToLower().Contains(lower)) return true;
                if (me.szExePath != null && me.szExePath.ToLower().Contains(lower)) return true;
            } while (Module32Next(snap, ref me));
        } catch {
        } finally {
            CloseHandle(snap);
        }
        return false;
    }

    // For reading process command line
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int size, out int ret);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, IntPtr buf, int size, out int read);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, ref long buf, int size, out int read);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, ref int  buf, int size, out int read);
    // WOW64 检测：目标进程是否是运行在 64 位 OS 上的 32 位进程
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow64);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI {
        public IntPtr Base, AllocBase;
        public uint   AllocProtect;
        public IntPtr Size;
        public uint   State, Protect, Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    public const uint MEM_COMMIT   = 0x1000;
    public const uint MEM_PRIVATE  = 0x20000;    // heap/stack — game variables live here
    public const uint MEM_MAPPED   = 0x40000;    // memory-mapped files — skip
    public const uint MEM_IMAGE    = 0x1000000;  // DLL/exe code — skip, dangerous to write
    public const uint PAGE_NOACCESS = 0x01;
    public const uint PAGE_GUARD    = 0x100;
    // All readable page protections
    public const uint PAGE_READABLE = 0x02|0x04|0x08|0x20|0x40|0x80;

    // Access levels to try in order
    static uint[] OPEN_MODES = new uint[]{
        0x1F0FFF,           // PROCESS_ALL_ACCESS
        0x0410,             // QUERY_INFO + VM_READ
        0x0010,             // VM_READ only
    };
    static uint[] WRITE_MODES = new uint[]{
        0x1F0FFF,           // PROCESS_ALL_ACCESS
        0x0430,             // QUERY_INFO + VM_READ + VM_WRITE
        0x0020,             // VM_WRITE only
    };

    public static IntPtr OpenBest(int pid, bool write) {
        uint[] modes = write ? WRITE_MODES : OPEN_MODES;
        foreach (uint m in modes) {
            IntPtr h = OpenProcess(m, false, pid);
            if (h != IntPtr.Zero) return h;
        }
        return IntPtr.Zero;
    }

    public static int GetParentPid(int pid) {
        try {
            IntPtr h = OpenProcess(0x0400, false, pid);
            if (h == IntPtr.Zero) return -1;
            var pbi = new PROCESS_BASIC_INFORMATION();
            int ret;
            NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret);
            CloseHandle(h);
            return (int)(long)pbi.InheritedFromUniqueProcessId;
        } catch { return -1; }
    }

    // Get all recursive children of a PID
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
                    } catch {}
                }
            }
        } catch {}
        return result;
    }

    // Get command line via PEB (direct kernel read, no WMI — ~50x faster)
    // Layout: PEB -> RTL_USER_PROCESS_PARAMETERS -> CommandLine (UNICODE_STRING)
    // 支持 x64 和 ia32(WOW64) 目标进程：运行时通过 IsWow64Process 检测目标位数，
    // 动态切换 PEB 结构体偏移量（x64: 0x20/0x70；ia32: 0x10/0x40）
    public static string GetCmdLine(int pid) {
        IntPtr hProc = IntPtr.Zero;
        try {
            hProc = OpenProcess(0x0410, false, pid);
            if (hProc == IntPtr.Zero) hProc = OpenProcess(0x1F0FFF, false, pid);
            if (hProc == IntPtr.Zero) return "";

            // 检测目标进程是否是 WOW64（32 位进程运行在 64 位 OS）
            bool isWow64 = false;
            IsWow64Process(hProc, out isWow64);
            // 本 PowerShell 进程（扫描器）是 64 位；若目标是 WOW64 则是 32 位进程
            bool target32 = isWow64;

            // PEB 字段偏移：x64 进程 vs ia32(WOW64) 进程
            int ppOffset  = target32 ? 0x10 : 0x20;  // ProcessParameters 指针偏移
            int clOffset  = target32 ? 0x40 : 0x70;  // CommandLine UNICODE_STRING 偏移
            int usSize    = target32 ? 8    : 16;     // UNICODE_STRING 结构大小（字节）
            // Buffer 指针在 UNICODE_STRING 中的字节偏移：
            //   x64: Length(2)+MaxLength(2)+pad(4)+Buffer(8) → offset 8
            //   ia32: Length(2)+MaxLength(2)+Buffer(4)        → offset 4
            int bufPtrOff = target32 ? 4    : 8;
            int ptrSize   = target32 ? 4    : 8;      // 指针字节数

            // Step 1: get PEB address via NtQueryInformationProcess
            var pbi = new PROCESS_BASIC_INFORMATION();
            int sz; int status = NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(pbi), out sz);
            if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero) return "";

            long pebAddr = (long)pbi.PebBaseAddress;
            int  read    = 0;
            long ppAddr  = 0;

            // Step 2: read ProcessParameters pointer（按目标进程指针大小读取）
            if (target32) {
                int ppAddr32 = 0;
                if (!ReadProcessMemory(hProc, new IntPtr(pebAddr + ppOffset), ref ppAddr32, 4, out read) || read != 4) return "";
                ppAddr = (long)(uint)ppAddr32;  // 零扩展到 64 位
            } else {
                if (!ReadProcessMemory(hProc, new IntPtr(pebAddr + ppOffset), ref ppAddr, 8, out read) || read != 8) return "";
            }
            if (ppAddr == 0) return "";

            // Step 3: read CommandLine UNICODE_STRING
            byte[] usBuf = new byte[usSize];
            if (!ReadProcessMemory(hProc, new IntPtr(ppAddr + clOffset), usBuf, usSize, out read) || read < usSize) return "";

            ushort len = BitConverter.ToUInt16(usBuf, 0);   // byte length of string
            long bufPtr;
            if (target32) {
                bufPtr = (long)(uint)BitConverter.ToInt32(usBuf, bufPtrOff);
            } else {
                bufPtr = BitConverter.ToInt64(usBuf, bufPtrOff);
            }
            if (len == 0 || bufPtr == 0) return "";

            // Step 4: read the actual command line string
            byte[] strBuf = new byte[len];
            if (!ReadProcessMemory(hProc, new IntPtr(bufPtr), strBuf, len, out read) || read < 2) return "";
            return System.Text.Encoding.Unicode.GetString(strBuf, 0, read);
        } catch { return ""; }
        finally { if (hProc != IntPtr.Zero) CloseHandle(hProc); }
    }

    public static string GetProcName(int pid) {
        try { return Process.GetProcessById(pid).ProcessName; } catch { return "?"; }
    }

    // ── Core scan functions ──────────────────────────────

    // Scan for 4-byte signed integer
    public static List<string> ScanInt32(IntPtr hProc, int pid, int val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        EnumPages(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 4; i += 4) {
                if (buf[i]==valB[0] && buf[i+1]==valB[1] && buf[i+2]==valB[2] && buf[i+3]==valB[3]) {
                    results.Add(((long)base_ + i).ToString("X") + ":" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    // Scan for 4-byte float (e.g. value might be stored as float in ActionScript)
    public static List<string> ScanFloat(IntPtr hProc, int pid, float val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        EnumPages(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 4; i += 4) {
                if (buf[i]==valB[0] && buf[i+1]==valB[1] && buf[i+2]==valB[2] && buf[i+3]==valB[3]) {
                    results.Add(((long)base_ + i).ToString("X") + ":F:" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    // Scan for 8-byte double (ActionScript Number type)
    public static List<string> ScanDouble(IntPtr hProc, int pid, double val, int maxR) {
        var results = new List<string>();
        byte[] valB = BitConverter.GetBytes(val);
        EnumPages(hProc, (base_, buf, read) => {
            for (int i = 0; i <= read - 8; i += 4) {
                bool match = true;
                for (int j = 0; j < 8; j++) if (buf[i+j] != valB[j]) { match=false; break; }
                if (match) {
                    results.Add(((long)base_ + i).ToString("X") + ":D:" + pid);
                    if (results.Count >= maxR) return false;
                }
            }
            return results.Count < maxR;
        });
        return results;
    }

    // Page enumeration helper
    static void EnumPages(IntPtr hProc, Func<IntPtr, byte[], int, bool> cb) {
        var mbi   = new MBI();
        int mbiSz = Marshal.SizeOf(typeof(MBI));
        IntPtr addr = IntPtr.Zero;
        while (true) {
            if (VirtualQueryEx(hProc, addr, ref mbi, mbiSz) == 0) break;
            long next = (long)mbi.Base + (long)mbi.Size;

            if (mbi.State == MEM_COMMIT
                && mbi.Type  == MEM_PRIVATE              // heap/stack only — skip DLL (MEM_IMAGE) and mapped files (MEM_MAPPED)
                && (mbi.Protect & PAGE_NOACCESS) == 0
                && (mbi.Protect & PAGE_GUARD)    == 0
                && (mbi.Protect & PAGE_READABLE) != 0) {
                int size = (int)(long)mbi.Size;
                if (size > 0 && size <= 512 * 1024 * 1024) {
                    byte[] buf = new byte[size];
                    int read = 0;
                    if (ReadProcessMemory(hProc, mbi.Base, buf, size, out read) && read >= 4) {
                        if (!cb(mbi.Base, buf, read)) break;
                    }
                }
            }
            if (next <= (long)addr) break;
            addr = new IntPtr(next);
        }
    }

    // Next scan (filter addresses) - supports ADDR:PID, ADDR:F:PID, ADDR:D:PID
    public static List<string> FilterAddresses(string[] addrTags, long val) {
        var results = new List<string>();
        var byPid = new Dictionary<int, List<string>>();
        foreach (var tag in addrTags) {
            var parts = tag.Split(':');
            // Format: HEX | HEX:PID | HEX:F:PID | HEX:D:PID
            int pid2 = -1; string dtype = "I";
            if (parts.Length == 2) { int.TryParse(parts[1], out pid2); }
            else if (parts.Length == 3) { dtype = parts[1]; int.TryParse(parts[2], out pid2); }
            if (pid2 < 0) continue;
            var key = pid2 + ":" + dtype;
            if (!byPid.ContainsKey(pid2)) byPid[pid2] = new List<string>();
            byPid[pid2].Add(tag);
        }
        foreach (var kv in byPid) {
            IntPtr hProc = OpenBest(kv.Key, false);
            if (hProc == IntPtr.Zero) continue;
            byte[] buf4 = new byte[4], buf8 = new byte[8];
            foreach (var tag in kv.Value) {
                var parts = tag.Split(':');
                string dtype = parts.Length == 3 ? parts[1] : "I";
                long la;
                if (!long.TryParse(parts[0], System.Globalization.NumberStyles.HexNumber, null, out la)) continue;
                int read = 0;
                if (dtype == "D") {
                    if (ReadProcessMemory(hProc, new IntPtr(la), buf8, 8, out read) && read == 8) {
                        double v = BitConverter.ToDouble(buf8, 0);
                        if (Math.Abs(v - (double)val) < 0.5) results.Add(tag);
                    }
                } else if (dtype == "F") {
                    if (ReadProcessMemory(hProc, new IntPtr(la), buf4, 4, out read) && read == 4) {
                        float v = BitConverter.ToSingle(buf4, 0);
                        if (Math.Abs(v - (float)val) < 0.5f) results.Add(tag);
                    }
                } else {
                    if (ReadProcessMemory(hProc, new IntPtr(la), buf4, 4, out read) && read == 4) {
                        int v = BitConverter.ToInt32(buf4, 0);
                        if (v == (int)val) results.Add(tag);
                    }
                }
            }
            CloseHandle(hProc);
        }
        return results;
    }

    // Read a tagged address
    public static string ReadTagged(string tag) {
        var parts = tag.Split(':');
        string dtype = parts.Length == 3 ? parts[1] : "I";
        int pid2; long la;
        if (parts.Length == 2) { if (!int.TryParse(parts[1], out pid2)) return "ERR"; }
        else if (parts.Length == 3) { if (!int.TryParse(parts[2], out pid2)) return "ERR"; }
        else return "ERR:fmt";
        if (!long.TryParse(parts[0], System.Globalization.NumberStyles.HexNumber, null, out la)) return "ERR:addr";
        IntPtr hProc = OpenBest(pid2, false);
        if (hProc == IntPtr.Zero) return "ERR:open";
        byte[] buf = new byte[8]; int read = 0;
        try {
            if (dtype == "D") {
                if (!ReadProcessMemory(hProc, new IntPtr(la), buf, 8, out read) || read != 8) return "ERR:read";
                return BitConverter.ToDouble(buf, 0).ToString();
            } else if (dtype == "F") {
                if (!ReadProcessMemory(hProc, new IntPtr(la), buf, 4, out read) || read != 4) return "ERR:read";
                return BitConverter.ToSingle(buf, 0).ToString();
            } else {
                if (!ReadProcessMemory(hProc, new IntPtr(la), buf, 4, out read) || read != 4) return "ERR:read";
                return BitConverter.ToInt32(buf, 0).ToString();
            }
        } finally { CloseHandle(hProc); }
    }

    // Write to a tagged address
    public static bool WriteTagged(string tag, long val) {
        var parts = tag.Split(':');
        string dtype = parts.Length == 3 ? parts[1] : "I";
        int pid2; long la;
        if (parts.Length == 2) { if (!int.TryParse(parts[1], out pid2)) return false; }
        else if (parts.Length == 3) { if (!int.TryParse(parts[2], out pid2)) return false; }
        else return false;
        if (!long.TryParse(parts[0], System.Globalization.NumberStyles.HexNumber, null, out la)) return false;
        IntPtr hProc = OpenBest(pid2, true);
        if (hProc == IntPtr.Zero) return false;
        byte[] buf; int written = 0;
        if (dtype == "D")      buf = BitConverter.GetBytes((double)val);
        else if (dtype == "F") buf = BitConverter.GetBytes((float)val);
        else                   buf = BitConverter.GetBytes((int)val);
        try { return WriteProcessMemory(hProc, new IntPtr(la), buf, buf.Length, out written); }
        finally { CloseHandle(hProc); }
    }
}
'@

$output = @{}

try {
    # ── DETECT-PPAPI: lightweight PID detection only, no memory scanning ────
    # main.js 的 refreshPpapiPid() 优先从 app.getAppMetrics() 找 Flash PPAPI;
    # 如果 metrics 里没有明显标记的 ppapi/pepper/plugin/flash 类型, 就调 detect-ppapi
    # mode 让 scanner.ps1 通过 pepflash DLL 加载和命令行 --type=ppapi 来识别。
    # 不执行任何内存扫描, 只返回候选 PID 列表。
    if ($Mode -eq "detect-ppapi") {
        $rootPids = @()
        if ($BrowserPid -ne "") {
            $bp = 0
            if ([int]::TryParse($BrowserPid.Trim(), [ref]$bp) -and $bp -gt 0) { $rootPids += $bp }
        }
        if ($GamePids -ne "") {
            foreach ($p in ($GamePids -split ",")) {
                $n = 0
                if ([int]::TryParse($p.Trim(), [ref]$n) -and $n -gt 0) { $rootPids += $n }
            }
        }
        $detectAllPids = New-Object System.Collections.Generic.HashSet[int]
        foreach ($r in $rootPids) {
            [void]$detectAllPids.Add($r)
            $children = [MemScanner]::GetAllChildren($r)
            foreach ($c in $children) { [void]$detectAllPids.Add($c) }
        }
        $browserPidInt2 = 0
        if ($BrowserPid -ne "") { [int]::TryParse($BrowserPid.Trim(), [ref]$browserPidInt2) | Out-Null }
        $excludeNames2 = @("powershell","pwsh","conhost","cmd")
        $found = @()
        foreach ($pid2 in $detectAllPids) {
            if ($pid2 -eq $browserPidInt2) { continue }
            $n2 = [MemScanner]::GetProcName($pid2)
            if ($excludeNames2 -contains $n2) { continue }
            $hasFlash = [MemScanner]::HasModule($pid2, "pepflash")
            $cmd = ""
            try { $cmd = [MemScanner]::GetCmdLine($pid2) } catch {}
            $isPpapi = ($cmd -match "--type=ppapi") -or ($cmd -match "--type=pepper")
            [System.Console]::Error.WriteLine("[Detect] PID=$pid2 name=$n2 hasFlashDLL=$hasFlash cmdHasPpapi=$isPpapi")
            if ($hasFlash -or $isPpapi) {
                $found += $pid2
                # Don't break: log all candidates for diagnostics
            }
        }
        $output = @{
            ok    = ($found.Count -gt 0)
            ppapi = [int[]]@($found)
            scanned = $detectAllPids.Count
        }
        $output | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # ── FAST PATH: write/read don't need process discovery ──────────────────
    if ($Mode -eq "batchwrite") {
        # BatchFile format: one entry per line → "ADDR<TAB>VALUE"
        if ($BatchFile -eq "" -or -not (Test-Path $BatchFile)) {
            $output = @{ ok = $false; error = "BatchFile not found: $BatchFile" }
            Write-Output (ConvertTo-Json $output -Compress)
            exit 0
        }
        $lines = Get-Content $BatchFile | Where-Object { $_ -ne "" }
        $ok2 = 0; $fail2 = 0
        foreach ($line in $lines) {
            $parts = $line -split "`t"
            if ($parts.Length -lt 2) { $fail2++; continue }
            $addrTag = $parts[0].Trim()
            $wval = 0L
            if (-not [long]::TryParse($parts[1].Trim(), [ref]$wval)) { $fail2++; continue }
            $res = [MemScanner]::WriteTagged($addrTag, $wval)
            if ($res) { $ok2++ } else { $fail2++ }
        }
        $output = @{ ok = $true; written = $ok2; failed = $fail2 }
        Write-Output (ConvertTo-Json $output -Compress)
        exit 0
    }
    if ($Mode -eq "write") {
        $ok = [MemScanner]::WriteTagged($Addr, [long]$WriteVal)
        $output = @{ ok = $ok; msg = if($ok){"OK"}else{"ERR:write failed"} }
        Write-Output (ConvertTo-Json $output -Compress)
        exit 0
    }
    if ($Mode -eq "read") {
        $r = [MemScanner]::ReadTagged($Addr)
        $output = @{ ok = (-not $r.StartsWith("ERR")); value = $r }
        Write-Output (ConvertTo-Json $output -Compress)
        exit 0
    }
    # ── Resolve all PIDs to scan ─────────────────────────────────────────────
    $rootPids = @()
    
    # Primary: browser process (parent of everything)
    if ($BrowserPid -ne "") {
        $n = 0
        if ([int]::TryParse($BrowserPid.Trim(), [ref]$n)) { $rootPids += $n }
    }
    
    # Also include renderer PIDs passed
    if ($GamePids -ne "") {
        foreach ($p in ($GamePids -split ",")) {
            $n = 0
            if ([int]::TryParse($p.Trim(), [ref]$n) -and $n -gt 0) { $rootPids += $n }
        }
    }

    # Expand: get all children of all root PIDs
    $allPids = New-Object System.Collections.Generic.HashSet[int]
    foreach ($r in $rootPids) {
        [void]$allPids.Add($r)
        $children = [MemScanner]::GetAllChildren($r)
        foreach ($c in $children) { [void]$allPids.Add($c) }
    }

    # Annotate each PID with process name and command line type
    $procInfoList = @()
    $ppApiPids    = @()   # --type=ppapi  ← Flash lives here
    $rendererPids = @()   # --type=renderer
    $otherPids    = @()

    # Fast path: if caller already knows the ppapi PID, skip process discovery entirely.
    # 信任 main.js 的 refreshPpapiPid 已经基于 app.getAppMetrics() + process.kill(0) 验证过 PID,
    # 这里只确认 PID 进程仍存活, 不再硬性要求 process name == 'electron'
    # (打包后 process name 是 'seer2-春树登陆器' 等中文, 不会匹配到 electron 字面量)。
    $usedCache = $false
    if ($CachedPpapiPid -ne "") {
        $cachedPid = 0
        if ([int]::TryParse($CachedPpapiPid.Trim(), [ref]$cachedPid) -and $cachedPid -gt 0) {
            $pname = [MemScanner]::GetProcName($cachedPid)
            $alive = $false
            try { $alive = ($null -ne (Get-Process -Id $cachedPid -ErrorAction SilentlyContinue)) } catch {}
            [System.Console]::Error.WriteLine("[CachedPpapi] pid=$cachedPid name=$pname alive=$alive")
            if ($alive -and $pname) {
                $ppApiPids += $cachedPid
                # Classify remaining allPids by name only (no cmdline needed)
                foreach ($pid2 in $allPids) {
                    if ($pid2 -eq $cachedPid) {
                        $procInfoList += @{ pid = $pid2; name = $pname; type = "ppapi" }
                        continue
                    }
                    $n2 = [MemScanner]::GetProcName($pid2)
                    $excludeNames = @("powershell","pwsh","conhost","cmd")
                    if ($excludeNames -contains $n2) { continue }
                    if ($pid2 -eq [int]$BrowserPid) { $otherPids += $pid2 }
                    else { $rendererPids += $pid2 }
                    $procInfoList += @{ pid = $pid2; name = $n2; type = "other" }
                }
                $usedCache = $true
            }
        }
    }

    if (-not $usedCache) {
        # Full discovery via PEB cmdline read (first scan or cache miss)
        [System.Console]::Error.WriteLine("[Discovery] Scanning $($allPids.Count) PIDs (BrowserPid=$BrowserPid)...")
        foreach ($pid2 in $allPids) {
            $name = [MemScanner]::GetProcName($pid2)
            $cmd  = ""
            try { $cmd = [MemScanner]::GetCmdLine($pid2) } catch {}
            $type = "other"
            if     ($cmd -match "--type=ppapi")          { $type = "ppapi";    $ppApiPids    += $pid2 }
            elseif ($cmd -match "--type=renderer")       { $type = "renderer"; $rendererPids += $pid2 }
            elseif ($cmd -match "--type=gpu-process")    { $type = "gpu" }
            elseif ($cmd -match "--type=zygote")         { $type = "zygote" }
            elseif ($cmd -match "--type=utility")        { $type = "utility" }
            else { $otherPids += $pid2 }
            $procInfoList += @{ pid = $pid2; name = $name; type = $type }
            $cmdShort = if ($cmd.Length -gt 80) { $cmd.Substring(0,80) } else { $cmd }
            [System.Console]::Error.WriteLine("[Discovery]   PID=$pid2 name=$name type=$type cmd=[$cmdShort]")
        }
        [System.Console]::Error.WriteLine("[Discovery] ppapi=$($ppApiPids -join ',') renderer=$($rendererPids -join ',') other=$($otherPids -join ',')")
    }

    # ── EXCLUDE our own scanner processes (false positives) ──────────────────
    # powershell.exe = our scanner process (it holds the search value in its own memory)
    # conhost.exe    = console host for powershell, also irrelevant
    # These produce false positives because the scanner reads/buffers the target value
    $excludeNames = @("powershell", "pwsh", "conhost", "cmd")
    $ppApiPids    = $ppApiPids    | Where-Object { $excludeNames -notcontains [MemScanner]::GetProcName($_) }
    $rendererPids = $rendererPids | Where-Object { $excludeNames -notcontains [MemScanner]::GetProcName($_) }
    $otherPids    = $otherPids    | Where-Object { $excludeNames -notcontains [MemScanner]::GetProcName($_) }

    # ── PPAPI Fallback: DLL-based detection ──────────────────────────────────
    # If cmdline-based detection didn't find PPAPI (GetCmdLine may fail due to
    # access restrictions or timing), fall back to checking loaded modules.
    # The Flash PPAPI process is the ONLY process that loads pepflashplayer*.dll.
    # This is exactly how Cheat Engine identifies Flash processes.

    # 提前初始化 browserPidInt (DLL fallback 与系统级 fallback 都要用它跳过主进程)
    $browserPidInt = 0
    if ($BrowserPid -ne "") { [int]::TryParse($BrowserPid.Trim(), [ref]$browserPidInt) | Out-Null }

    # 取启动器实际 exe 名 (无后缀), 用于系统级兜底枚举同名进程。
    # 正式打包后 exe 名是 "seer2-春树登陆器" 而非 "electron",
    # Get-Process -Name electron 会返回空, 必须额外加这个名字。
    $launcherExeName = ""
    try {
        $bp = Get-Process -Id $browserPidInt -ErrorAction SilentlyContinue
        if ($bp -and $bp.MainModule -and $bp.MainModule.FileName) {
            $launcherExeName = [System.IO.Path]::GetFileNameWithoutExtension($bp.MainModule.FileName)
        }
    } catch {}
    [System.Console]::Error.WriteLine("[PPAPI] BrowserPid=$browserPidInt launcherExeName=[$launcherExeName]")

    if ($ppApiPids.Count -eq 0) {
        [System.Console]::Error.WriteLine("[PPAPI] cmdline detection failed, trying DLL module scan on tree...")
        # Check all known electron children first
        foreach ($pid2 in $allPids) {
            $n2 = [MemScanner]::GetProcName($pid2)
            if ($excludeNames -contains $n2) { continue }
            if ($pid2 -eq $browserPidInt) { continue }
            $hasFlash = [MemScanner]::HasModule($pid2, "pepflash")
            [System.Console]::Error.WriteLine("[PPAPI]   PID=$pid2 name=$n2 hasFlashDLL=$hasFlash")
            if ($hasFlash) {
                $ppApiPids += $pid2
                [System.Console]::Error.WriteLine("[PPAPI]   --> FOUND via DLL! PID=$pid2")
                break
            }
        }
        # If still not found, scan ALL electron.exe AND launcher exe-name system-wide
        # (handles re-parenting + production exe-name not being "electron.exe")
        if ($ppApiPids.Count -eq 0) {
            [System.Console]::Error.WriteLine("[PPAPI] tree scan failed, trying system-wide enum...")
            $candNames = @("electron")
            if ($launcherExeName -and ($candNames -notcontains $launcherExeName)) { $candNames += $launcherExeName }
            [System.Console]::Error.WriteLine("[PPAPI]   candidate process names: $($candNames -join ',')")
            $allElec = @()
            foreach ($n in $candNames) {
                $got = Get-Process -Name $n -ErrorAction SilentlyContinue
                if ($got) { $allElec += $got }
            }
            [System.Console]::Error.WriteLine("[PPAPI]   sysWide enum found $($allElec.Count) processes")
            foreach ($ep in $allElec) {
                if ($ep.Id -eq $browserPidInt) { continue }
                $hasFlash = [MemScanner]::HasModule($ep.Id, "pepflash")
                [System.Console]::Error.WriteLine("[PPAPI]   SysWide PID=$($ep.Id) name=$($ep.ProcessName) hasFlashDLL=$hasFlash")
                if ($hasFlash) {
                    $ppApiPids += $ep.Id
                    [System.Console]::Error.WriteLine("[PPAPI]   --> FOUND system-wide! PID=$($ep.Id)")
                    break
                }
            }
        }
    }

    # ── SCAN ORDER: ppapi ONLY (Flash game data lives here) ──────────────────
    # 严格模式: 只扫真正的 Flash PPAPI 进程, 不再退化扫 renderer 子进程。
    # main.js 已经在 mem-scan-new / mem-scan-next 入口阻止 PPAPI 未识别时调用,
    # 这里是 defense-in-depth: scanner.ps1 自己再守一遍。
    # 仅 read/write/listprocs 模式不需要扫描器, 不受此限制。

    $scanOrder = @()
    if ($ppApiPids.Count -gt 0) {
        $scanOrder += $ppApiPids
        [System.Console]::Error.WriteLine("[ScanOrder] ppapi found: $($ppApiPids -join ',')")
    } else {
        # PPAPI 未识别: new / next 模式直接返回错误, 不做任何 renderer 兜底扫描
        [System.Console]::Error.WriteLine("[ScanOrder] ppapi NOT found; refusing renderer fallback")
        if ($Mode -eq "new" -or $Mode -eq "next") {
            $output = @{
                ok    = $false
                error = "Flash PPAPI process not detected. Refresh the game and reopen the scanner."
                ppapi = @()
                allPids = @()
            }
            $output | ConvertTo-Json -Compress -Depth 6
            exit 0
        }
        # read/write/listprocs 等模式仍走原 PID 解析路径 (虽然 PID 来自 tag 而非 scanOrder)
    }

    # deduplicate and remove browserPid
    $seen = @{}; $scanOrder2 = @()
    foreach ($p in $scanOrder) {
        if ($seen.ContainsKey($p)) { continue }
        if ($browserPidInt -gt 0 -and $p -eq $browserPidInt) { continue }
        $scanOrder2 += $p; $seen[$p] = 1
    }
    $scanOrder = $scanOrder2

    # ── MODE DISPATCH ─────────────────────────────────────────────────────────

    if ($Mode -eq "listprocs") {
        $output = @{ ok = $true; procs = $procInfoList; ppapi = [int[]]@($ppApiPids); renderer = [int[]]@($rendererPids) }
    }
    elseif ($Mode -eq "write") {
        $ok = [MemScanner]::WriteTagged($Addr, [long]$WriteVal)
        $output = @{ ok = $ok; msg = if($ok){"OK"}else{"ERR:write failed"} }
    }
    elseif ($Mode -eq "read") {
        $r = [MemScanner]::ReadTagged($Addr)
        $output = @{ ok = (-not $r.StartsWith("ERR")); value = $r }
    }
    elseif ($Mode -eq "next") {
        # Read addresses from file (preferred, avoids ENAMETOOLONG) or fall back to -Prev string
        if ($PrevFile -ne "" -and (Test-Path $PrevFile)) {
            $addrArr = Get-Content $PrevFile | Where-Object { $_ -ne "" }
        } else {
            $addrArr = $Prev -split "," | Where-Object { $_ -ne "" }
        }
        # Count input by type for diagnostics
        $inD = ($addrArr | Where-Object { $_ -match "^[0-9A-Fa-f]+:D:\d+$" }).Count
        $inF = ($addrArr | Where-Object { $_ -match "^[0-9A-Fa-f]+:F:\d+$" }).Count
        $inI = $addrArr.Count - $inD - $inF
        [System.Console]::Error.WriteLine("[NextScan] input=$($addrArr.Count) (Double=$inD Float=$inF Int32=$inI) filterValue=$Value")
        $res = [MemScanner]::FilterAddresses($addrArr, [long]$Value)
        $outD = ($res | Where-Object { $_ -match "^[0-9A-Fa-f]+:D:\d+$" }).Count
        $outF = ($res | Where-Object { $_ -match "^[0-9A-Fa-f]+:F:\d+$" }).Count
        $outI = $res.Count - $outD - $outF
        [System.Console]::Error.WriteLine("[NextScan] output=$($res.Count) (Double=$outD Float=$outF Int32=$outI)")
        $output = @{ ok = $true; addresses = $res; count = $res.Count }
    }
    else {
        # NEW SCAN
        if ($scanOrder.Count -eq 0) {
            $output = @{ ok = $false; error = "No PIDs found. BrowserPid=$BrowserPid GamePids=$GamePids" }
        } else {
            $allResults = @()
            $pidStats   = @()

            [System.Console]::Error.WriteLine("[NewScan] scanOrder=$($scanOrder -join ',') value=$Value type=$ScanType maxResult=$MaxResult")

            foreach ($pid2 in $scanOrder) {
                $remaining = $MaxResult - $allResults.Count
                if ($remaining -le 0) { break }
                
                $hProc = [MemScanner]::OpenBest($pid2, $false)
                if ($hProc -eq [IntPtr]::Zero) {
                    $pidStats += @{ pid=$pid2; name=[MemScanner]::GetProcName($pid2); found=0; skipped=$true; reason="open failed" }
                    [System.Console]::Error.WriteLine("[NewScan]   PID=$pid2 OPEN FAILED")
                    continue
                }

                $cntD = 0; $cntF = 0; $cntI = 0

                # ── SCAN ORDER: Double first, then Int32, then Float ──────────
                # Flash ActionScript stores ALL numbers as IEEE 754 Double (8 bytes).
                # Scanning Double first ensures Flash game values are never crowded out
                # by the far more numerous Int32 false-positives from the same process.
                # 单类型扫描时 (ScanType in {double,float,int32}) 给该类型完整 MaxResult 配额;
                # 仅在 ScanType='all' 时按比例分配, 防止 Int32 把 Double 挤掉。
                if ($ScanType -eq "all" -or $ScanType -eq "double") {
                    if ($ScanType -eq "all") { $budgetD = [Math]::Min($remaining, 10000) }
                    else                     { $budgetD = $remaining }
                    $rD = [MemScanner]::ScanDouble($hProc, $pid2, [double]$Value, $budgetD)
                    $allResults += $rD; $cntD = $rD.Count; $remaining -= $rD.Count
                }

                if ($ScanType -eq "all" -or $ScanType -eq "float") {
                    if ($ScanType -eq "all") { $budgetF = [Math]::Min($remaining, 5000) }
                    else                     { $budgetF = $remaining }
                    $rF = [MemScanner]::ScanFloat($hProc, $pid2, [float]$Value, $budgetF)
                    $allResults += $rF; $cntF = $rF.Count; $remaining -= $rF.Count
                }

                if ($ScanType -eq "all" -or $ScanType -eq "int32") {
                    $budgetI = [Math]::Min($remaining, $MaxResult)
                    $r32 = [MemScanner]::ScanInt32($hProc, $pid2, [int]$Value, $budgetI)
                    $allResults += $r32; $cntI = $r32.Count; $remaining -= $r32.Count
                }

                $found = $cntD + $cntF + $cntI
                [MemScanner]::CloseHandle($hProc) | Out-Null

                # 从 procInfoList 中找到该 PID 的 type 字符串。
                # 注意: Hashtable + Select-Object -ExpandProperty 不返回 key 值, 而返回整个 Hashtable,
                # 在 JSON 里展开成嵌套对象, JS 端读到 {object Object}。改用显式取值。
                $procEntry = $procInfoList | Where-Object { $_.pid -eq $pid2 } | Select-Object -First 1
                $ptype = if ($procEntry -and $procEntry.ContainsKey('type')) { [string]$procEntry['type'] } else { 'unknown' }
                $hitCapD = ($cntD -ge [Math]::Min($MaxResult, 10000))
                $hitCapI = ($cntI -ge [Math]::Min($remaining + $cntI, $MaxResult))
                $capWarn = if ($hitCapD) { "  *** DOUBLE HIT CAP — may be missing results ***" } elseif ($hitCapI) { "  *** INT32 HIT CAP ***" } else { "" }
                [System.Console]::Error.WriteLine("[NewScan]   PID=$pid2 type=$ptype total=$found  Double=$cntD  Float=$cntF  Int32=$cntI$capWarn")

                $pidStats += @{
                    pid   = $pid2
                    name  = [MemScanner]::GetProcName($pid2)
                    type  = $ptype
                    found = $found
                    cntD  = $cntD
                    cntF  = $cntF
                    cntI  = $cntI
                }
            }

            $output = @{
                ok        = $true
                addresses = $allResults
                count     = $allResults.Count
                pids      = $pidStats
                ppapi     = [int[]]@($ppApiPids)
                allPids   = [int[]]@($scanOrder | ForEach-Object { $_ })
            }
        }
    }
} catch {
    $output = @{ ok = $false; error = $_.Exception.Message + "`n" + $_.ScriptStackTrace }
}

$output | ConvertTo-Json -Compress -Depth 6
