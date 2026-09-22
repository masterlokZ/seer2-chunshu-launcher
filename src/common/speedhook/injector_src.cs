// ce_injector.exe — Seer2 变速注入器（纯注入版）
//
// 用法: ce_injector.exe <pid> <dllPath>
//
// 输出（stdout）:
//   成功: "0\n<dllBaseHex>\n"  (exit 0)
//   失败: "<errorCode>\n"       (exit 1)
//
// 错误码:
//   1xxx  OpenProcess 失败，后三位为 Win32 错误码
//   2000  VirtualAllocEx 失败
//   3000  CreateRemoteThread 失败
//   4000  LoadLibraryW 返回 NULL（DLL 加载失败）
//   4998~4999  参数解析失败
//   5000  架构不匹配（32/64 位）
//   6000  DLL 文件不存在
//   7000  注入成功但枚举不到 DLL 模块基址
//
// 职责：仅注入 DLL，速度命令通过 DLL 内置的 Named Pipe 发送。
// Named Pipe 路径: \\.\pipe\Seer2SpeedHack_<pid>
// Named Pipe 在 DLL 内会原子更新时间基线，彻底解决高速→低速冻结问题。

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class CeInjector {

    const uint PROCESS_ALL = 0x1F0FFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualAllocEx(IntPtr hProc, IntPtr addr,
                                         uint size, uint type, uint prot);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteProcessMemory(IntPtr hProc, IntPtr baseAddr,
                                           byte[] buf, uint size, out uint written);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateRemoteThread(IntPtr hProc, IntPtr attr, uint stackSz,
                                             IntPtr startAddr, IntPtr param,
                                             uint flags, out uint tid);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeThread(IntPtr thread, out uint code);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetProcAddress(IntPtr hMod, string name);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string name);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process(IntPtr hProc, out bool isWow64);

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EnumProcessModules(IntPtr hProc, IntPtr[] mods,
                                           uint cb, out uint needed);

    [DllImport("psapi.dll", CharSet = CharSet.Unicode)]
    static extern uint GetModuleFileNameExW(IntPtr hProc, IntPtr hMod,
                                             StringBuilder buf, uint size);

    static int Main(string[] args) {
        if (args.Length < 2) { Emit("4999"); return 1; }

        uint pid;
        if (!uint.TryParse(args[0], out pid)) { Emit("4998"); return 1; }
        string dllPath = args[1];

        IntPtr dllBase;
        int result = Inject(pid, dllPath, out dllBase);
        if (result != 0) { Emit(result.ToString()); return 1; }

        Console.Out.WriteLine("0");
        Console.Out.WriteLine(dllBase.ToInt64().ToString("X"));
        Console.Out.Flush();
        return 0;
    }

    static int Inject(uint pid, string dllPath, out IntPtr dllBase) {
        dllBase = IntPtr.Zero;
        if (!File.Exists(dllPath)) return 6000;

        IntPtr hp = OpenProcess(PROCESS_ALL, false, pid);
        if (hp == IntPtr.Zero) return Marshal.GetLastWin32Error() + 1000;

        bool targetWow, selfWow;
        IsWow64Process(hp, out targetWow);
        IsWow64Process(GetCurrentProcess(), out selfWow);
        if (targetWow != selfWow) { CloseHandle(hp); return 5000; }

        byte[] pathBytes = Encoding.Unicode.GetBytes(dllPath);
        uint allocSz = (uint)pathBytes.Length + 4;
        IntPtr mem = VirtualAllocEx(hp, IntPtr.Zero, allocSz, 0x3000, 0x40);
        if (mem == IntPtr.Zero) { CloseHandle(hp); return 2000; }

        uint w;
        WriteProcessMemory(hp, mem, pathBytes, (uint)pathBytes.Length, out w);

        IntPtr loadLib = GetProcAddress(GetModuleHandle("kernel32.dll"), "LoadLibraryW");
        uint tid;
        IntPtr ht = CreateRemoteThread(hp, IntPtr.Zero, 0, loadLib, mem, 0, out tid);
        if (ht == IntPtr.Zero) { CloseHandle(hp); return 3000; }

        WaitForSingleObject(ht, 10000);
        uint exitCode = 0;
        GetExitCodeThread(ht, out exitCode);
        CloseHandle(ht);

        if (exitCode == 0) { CloseHandle(hp); return 4000; }

        string target = Path.GetFileName(dllPath).ToLowerInvariant();
        dllBase = FindModuleBase(hp, target);
        CloseHandle(hp);

        return dllBase == IntPtr.Zero ? 7000 : 0;
    }

    static IntPtr FindModuleBase(IntPtr hp, string targetName) {
        IntPtr[] mods = new IntPtr[1024];
        uint needed;
        if (!EnumProcessModules(hp, mods, (uint)(mods.Length * IntPtr.Size), out needed))
            return IntPtr.Zero;

        int count = (int)(needed / IntPtr.Size);
        StringBuilder sb = new StringBuilder(1024);
        for (int i = 0; i < count; i++) {
            sb.Clear();
            if (GetModuleFileNameExW(hp, mods[i], sb, (uint)sb.Capacity) > 0) {
                string name = Path.GetFileName(sb.ToString()).ToLowerInvariant();
                if (name == targetName) return mods[i];
            }
        }
        return IntPtr.Zero;
    }

    static void Emit(string msg) {
        Console.Out.WriteLine(msg);
        Console.Out.Flush();
    }
}
