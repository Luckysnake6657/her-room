# 探针：用 AppContainer（Windows 进程级沙箱，普通用户可用、不需要管理员）跑 MATLAB，
# 看三件事能不能同时成立：① 能算 ② 能出图 ③ `system`/`cmd` 被挡。
# 2026-10-13。这是**实验脚本**，跑通后才会整合进 matlab-sandbox.ps1。
param(
  [string]$WorkDir = 'D:\qq-bridge\state\matlab-sandbox',
  [string]$MatlabDir = 'D:\MATLAB',
  [string]$AppContainerName = 'qqbridge-matlab-sandbox',
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

if (-not ('AppBox' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AppBox {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

  const int ERROR_ALREADY_EXISTS = 183;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_NO_WINDOW = 0x08000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = false)]
  static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = false)]
  static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  /** 建（或复用）AppContainer profile，返回 SID 字符串。 */
  public static string EnsureProfile(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "qq-bridge MATLAB sandbox", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      int code = hr & 0xFFFF;
      if (code != ERROR_ALREADY_EXISTS) throw new System.ComponentModel.Win32Exception(code, "CreateAppContainerProfile 失败 hr=0x" + hr.ToString("X8"));
      hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
      if (hr != 0) throw new System.ComponentModel.Win32Exception(hr & 0xFFFF, "DeriveAppContainerSid 失败");
    }
    IntPtr str;
    if (!ConvertSidToStringSid(sid, out str)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    string s = Marshal.PtrToStringUni(str);
    Marshal.FreeHGlobal(str);
    Marshal.FreeHGlobal(sid);
    return s;
  }

  /** 在 AppContainer 里启动进程（无任何 capability → 默认无网络、无额外文件权限）。 */
  public static PROCESS_INFORMATION LaunchInAppContainer(string app, string cmd, string cwd, string sidString) {
    IntPtr sid;
    if (!ConvertStringSidToSidW(sidString, out sid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    try {
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var caps = new SECURITY_CAPABILITIES();
      caps.AppContainerSid = sid;
      caps.Capabilities = IntPtr.Zero;
      caps.CapabilityCount = 0;
      caps.Reserved = 0;
      IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      Marshal.StructureToPtr(caps, capsPtr, false);
      try {
        if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capsPtr,
              new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = list;
        PROCESS_INFORMATION pi;
        if (!CreateProcess(app, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return pi;
      } finally { Marshal.FreeHGlobal(capsPtr); }
    } finally {
      DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      Marshal.FreeHGlobal(sid);
    }
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);
}
'@
}

$sid = [AppBox]::EnsureProfile($AppContainerName)
Write-Output "AppContainer SID = $sid"

# 授权：MATLAB 目录只读+执行；沙箱目录读写
Write-Output '授权 D:\MATLAB（RX，继承）…'
& icacls.exe $MatlabDir /grant "*${sid}:(OI)(CI)RX" /Q | Out-Null
Write-Output '授权沙箱目录（M，继承）…'
& icacls.exe $WorkDir /grant "*${sid}:(OI)(CI)M" /Q | Out-Null
try { & icacls.exe $WorkDir /setintegritylevel '(OI)(CI)L' /T /Q | Out-Null } catch { }

# 探针代码：算 + 画图 + 试命令
$probeCode = @'
disp('--- AppContainer 探针 ---');
X = linspace(0, 20, 101); P = X.^4 + X.^2 + 2*X + 0.5;
fprintf('算: max=%.1f\n', max(P));
try
    f = figure('Visible','off'); plot(X, P); saveas(f, 'probe-curve.png'); close(f);
    fprintf('画图: 成功 probe-curve.png\n');
catch e
    fprintf('画图: 失败 %s\n', e.message);
end
try
    rc = system('cmd /c echo SHOULD_NOT_RUN');
    fprintf('system: rc=%d（若成功说明没锁住）\n', rc);
catch e
    fprintf('system: 报错 %s\n', e.message);
end
try
    t = fileread('C:\Users\zjin6\.dsh\AGENTS.md');
    fprintf('读用户目录: 读到 %d 字符（不该成功）\n', numel(t));
catch e
    fprintf('读用户目录: 被挡（%s）\n', strtrim(e.message));
end
'@
$probePath = Join-Path $WorkDir 'ac_probe.m'
$wrapPath = Join-Path $WorkDir 'sandbox_wrapper.m'
[System.IO.File]::WriteAllText($probePath, $probeCode, (New-Object System.Text.UTF8Encoding($false)))
$outPath = Join-Path $WorkDir 'sandbox-out.txt'
Remove-Item $outPath -ErrorAction SilentlyContinue
$posixOut = $outPath -replace '\\', '/'
$posixProbe = $probePath -replace '\\', '/'
$wrapper = "diary('$posixOut'); diary on;`ntry, run('$posixProbe'); catch err, disp(getReport(err,'basic')); end`ndiary off;`n"
[System.IO.File]::WriteAllText($wrapPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

$exe = 'D:\MATLAB\bin\win64\MATLAB.exe'
$cmd = "`"$exe`" -nojvm -batch sandbox_wrapper"
Write-Output '在 AppContainer 里启动 MATLAB…'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$pi = [AppBox]::LaunchInAppContainer($exe, $cmd, $WorkDir, $sid)
$w = [AppBox]::WaitForSingleObject($pi.hProcess, [uint32]($TimeoutSec * 1000))
$sw.Stop()
"等待结果=$w（0=正常结束，258=超时）  耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"
$code = [uint32]0
[void][AppBox]::GetExitCodeProcess($pi.hProcess, [ref]$code)
"MATLAB 退出码=$code"
if (Test-Path $outPath) {
  Write-Output '=== 输出 ==='
  [System.IO.File]::ReadAllText($outPath, [System.Text.Encoding]::UTF8)
} else { Write-Output '（没有输出文件 —— MATLAB 没起来）' }
Get-ChildItem $WorkDir -Filter 'probe-curve.png' | ForEach-Object { "出图: $($_.Name) $([math]::Round($_.Length/1KB)) KB" }
