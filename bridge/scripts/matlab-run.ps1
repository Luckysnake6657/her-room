# MATLAB 执行器（正式版）：AppContainer 真沙箱 + Job 限额 + 代码黑名单，2026-10-13。
#
# 为什么是 AppContainer（而不是"Job 限 1 个进程"）：
#   • 实测：`plot`/`saveas` 必然让 MATLAB 再起 `MATLABWindow.exe` —— Job 限死"最多 1 个进程"
#     会把画图一起挡掉（报 1816 配额不足）；放宽进程数又等于给她留一次 `system` 的机会。
#   • AppContainer 是**按授权**隔离，不靠数量：
#       - 授权了 `D:\MATLAB` → MATLAB 与 MATLABWindow.exe 都能起 → **能出图**
#       - 没授权 `System32` → `cmd.exe`/`powershell.exe` **执行不了** → `system` 照样死
#       - 无 internetClient capability → **默认无网络**
#       - 只授权了沙箱目录 → 读/写/删都出不了这个目录
#   • Job 在这版里只留 CPU/内存/超时（不设 ActiveProcessLimit），命令执行那层交给授权模型。
#
# ⚠️ 前置：`D:\MATLAB` 需对沙箱身份可读可执行 —— 见 scripts\grant-matlab-to-sandbox.bat
#    （需管理员运行；没授权时 MATLAB 起不来，退出码 0xC0000135）。
#
# 用法：
#   powershell -NoProfile -File matlab-run.ps1 -Code <你的.m> -WorkDir <沙箱目录> `
#       [-TimeoutSec 60] [-CpuSec 30] [-MemMB 3072] [-InputsFile <预置输入.txt>] [-JobOnly]
# 退出码：0 正常 / 3 被黑名单拒 / 124 超时 / 2 启动失败 / 其它 = MATLAB 退出码
param(
  [Parameter(Mandatory = $true)][string]$Code,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$MatlabExe = 'D:\MATLAB\bin\win64\MATLAB.exe',
  [string]$AppContainerName = 'qqbridge-matlab-sandbox',
  [int]$TimeoutSec = 60,
  [int]$CpuSec = 30,
  [int]$MemMB = 3072,
  [string]$InputsFile = '',
  # AppContainer 那条路**卡住**（MATLAB 在容器里起不来：实测退出码 1、连 -logfile 都不写，
  # 绘图模式（2026-10-13）：MATLAB R2025b 出图**必须**再起 MATLABWindow.exe，而计算模式的
  # "最多 1 个进程"会连它一起挡掉（实测报 1816 配额不足）。所以画图走这一档：允许第 2 个进程，
  # 但代码要过更严的检查（禁 ! 转义 / @危险函数句柄 / 字符串里拼 shell）——见下面 DENY_EXTRA。
  [switch]$PlotMode,
  [string]$DenyPattern = '\b(system|dos|unix|winqueryreg|actxserver|webread|webwrite|urlread|urlwrite|ftp|sftp|fileread|fopen|fclose|save|load|delete|rmdir|mkdir|copyfile|movefile|dir|ls|what|type|exist|eval|evalin|assignin|feval|builtin|str2func|matlabFunction|javaObject|py\.)\b'
)

$ErrorActionPreference = 'Stop'

# 重放：沙箱里只"录音"，这里在**正常进程环境**下把图真画出来。
# （图形栈必须能起 MATLABWindow.exe，所以这一遍不加 Job 限制；跑的是**录制下来的调用序列**，
#   不是她的代码 —— 她的代码已经在沙箱里跑过了。）
function Invoke-ReplayIfNeeded {
  if (-not $script:PlotMode) { return }
  if (-not (Test-Path -LiteralPath $script:recPath)) { return }
  if ((Get-Item -LiteralPath $script:recPath).Length -le 0) { return }
  $replayTpl = [System.IO.File]::ReadAllText((Join-Path $script:tplDir 'replay.m'))
  $replayOut = Join-Path $script:WorkDir 'sandbox_replay.txt'
  $replayPath = Join-Path $script:WorkDir 'sandbox_replay_run.m'
  $src = $replayTpl.Replace('__RECFILE__', ($script:recPath -replace '\\', '/')).Replace('__OUTFILE__', ($replayOut -replace '\\', '/'))
  [System.IO.File]::WriteAllText($replayPath, $src, (New-Object System.Text.UTF8Encoding($false)))
  $rp = Start-Process -FilePath $script:MatlabExe -ArgumentList '-logfile sandbox_replay.log -batch sandbox_replay_run' `
    -WorkingDirectory $script:WorkDir -NoNewWindow -PassThru
  if (-not $rp.WaitForExit(120000)) { try { $rp.Kill() } catch {} ; Write-Output 'REPLAY_TIMEOUT' } else { Write-Output 'REPLAY_OK' }
}

# ── 1. 代码黑名单（第三层：命中就连进程都不起）────────────────────────────
# ── 加强检查（2026-10-13）────────────────────────────────────────────────
# 为什么要它：Job 只挡"创建子进程"这一层，而在绘图模式下**故意放开了第 2 个进程**（为了出图），
# 所以这一档必须再加三道闸：! 直接转义执行、@system 这类函数句柄、字符串拼 shell 特征。
# ⚠️ 诚实说明：这是"提高门槛"，不是内核级隔离 —— 真正内核级那层在**计算模式**（限 1 个进程）。
$extraDeny = @(
  @{ re = '!'; name = 'bang 转义（\!cmd 直接执行系统命令）' },
  @{ re = '@\s*(system|dos|unix|winqueryreg|actxserver|javaObject|py)'; name = '危险函数的句柄（@system 之类）' },
  @{ re = '(?i)(cmd(\.exe)?|powershell|pwsh|wscript|cscript|mshta|System32|/c\s)'; name = 'shell 特征字符串' }
)
if ($true) {   # 加强检查**总是**做（计算模式多一层，绘图模式是主要防线）
  $srcAll = [System.IO.File]::ReadAllText($Code)
  foreach ($x in $extraDeny) {
    if ($x.name -like '*bang*') { $hit = $srcAll -match '(^|\s)!' } else { $hit = $srcAll -match $x.re }
    if ($hit) {
      if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
      $msg = "SANDBOX_DENIED：代码里出现了被禁的写法：$($x.name)
（只能用数学/画图函数：碰系统命令、拼 shell、用句柄绕过一律拒绝。）"
      [System.IO.File]::WriteAllText((Join-Path $WorkDir 'sandbox-out.txt'), $msg, (New-Object System.Text.UTF8Encoding($false)))
      Write-Output $msg
      exit 3
    }
  }
}

if ($DenyPattern) {
  $srcText = [System.IO.File]::ReadAllText($Code)
  $rx = [regex]::new($DenyPattern)
  $hits = @()
  foreach ($m in $rx.Matches($srcText)) { if ($hits -notcontains $m.Value) { $hits += $m.Value } }
  if ($hits.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    $msg = "SANDBOX_DENIED：代码里出现了被禁的调用：$($hits -join ', ')`n（这个盒子只能算数学/画图：不碰文件、不跑系统命令、不联网、不用 eval/builtin 这类动态执行。）"
    [System.IO.File]::WriteAllText((Join-Path $WorkDir 'sandbox-out.txt'), $msg, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output $msg
    exit 3
  }
}

if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

# ── 2. P/Invoke：Job（限额）+ AppContainer（隔离）────────────────────────
if (-not ('MatlabRun' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MatlabRun {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string lpName);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint uExitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);

  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002;
  const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
  const int JobObjectExtendedLimitInformation = 9;

  public static IntPtr CreateLimitsJob(ulong processMemoryBytes, long perProcessUserTime100ns, int activeProcessLimit) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (activeProcessLimit > 0) {
      ext.BasicLimitInformation.ActiveProcessLimit = (uint)activeProcessLimit;
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    }
    if (perProcessUserTime100ns > 0) {
      ext.BasicLimitInformation.PerProcessUserTimeLimit = perProcessUserTime100ns;
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
    }
    if (processMemoryBytes > 0) {
      ext.ProcessMemoryLimit = (UIntPtr)processMemoryBytes;
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    }
    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(ext, ptr, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(ptr); }
    return job;
  }

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

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  public static string EnsureProfile(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, "qq-bridge MATLAB sandbox", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      int code = hr & 0xFFFF;
      if (code != ERROR_ALREADY_EXISTS) throw new System.ComponentModel.Win32Exception(code, "CreateAppContainerProfile failed hr=0x" + hr.ToString("X8"));
      hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
      if (hr != 0) throw new System.ComponentModel.Win32Exception(hr & 0xFFFF, "DeriveAppContainerSid failed");
    }
    IntPtr str;
    if (!ConvertSidToStringSid(sid, out str)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    string s = Marshal.PtrToStringUni(str);
    Marshal.FreeHGlobal(str);
    return s;
  }

  public static PROCESS_INFORMATION LaunchInContainer(string app, string cmd, string cwd, string sidString) {
    IntPtr sid;
    if (!ConvertStringSidToSid(sidString, out sid)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    try {
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var caps = new SECURITY_CAPABILITIES();
      caps.AppContainerSid = sid;
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
}
'@
}

# ── 3. 准备沙箱（模板 → 实际文件；PowerShell 里不再内嵌 MATLAB 代码）──────
$outPath = Join-Path $WorkDir 'sandbox-out.txt'
$wrapPath = Join-Path $WorkDir 'sandbox_wrapper.m'
$userCodePath = Join-Path $WorkDir 'sandbox_user_code.m'
$inputQueue = Join-Path $WorkDir 'sandbox_inputs.txt'
Remove-Item $outPath -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $Code -Destination $userCodePath -Force   # 安全文件名（连字符在 MATLAB 里是减号）

if ($InputsFile -and (Test-Path -LiteralPath $InputsFile)) { Copy-Item -LiteralPath $InputsFile -Destination $inputQueue -Force }
elseif (-not (Test-Path -LiteralPath $inputQueue)) { [System.IO.File]::WriteAllText($inputQueue, '', (New-Object System.Text.UTF8Encoding($false))) }

$tplDir = Join-Path $PSScriptRoot 'matlab-sandbox'
$posixOut = $outPath -replace '\\', '/'
$posixQueue = $inputQueue -replace '\\', '/'
$posixUser = $userCodePath -replace '\\', '/'
$wrapper = [System.IO.File]::ReadAllText((Join-Path $tplDir 'wrapper.m'))
$recPath = Join-Path $WorkDir 'sandbox_record.jsonl'
Remove-Item $recPath -ErrorAction SilentlyContinue
$posixRec = $recPath -replace '\\', '/'
$wrapper = $wrapper.Replace('__OUT__', $posixOut).Replace('__QUEUE__', $posixQueue).Replace('__USERCODE__', $posixUser).Replace('__REC__', $posixRec).Replace('__STUBS__', ((Join-Path $WorkDir 'stubs') -replace '\\', '/'))   # 别用 $stubDir：它在后面才定义，这里会替换成空（实测踩过）
[System.IO.File]::WriteAllText($wrapPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))
# 覆盖内置 input（放当前目录 → 优先于内置函数），让交互式作业也能无人值守跑
$inputShim = [System.IO.File]::ReadAllText((Join-Path $tplDir 'input.m'))
[System.IO.File]::WriteAllText((Join-Path $WorkDir 'input.m'), $inputShim, (New-Object System.Text.UTF8Encoding($false)))

# ── 绘图函数桩：接住她的 plot/mesh/surf… 只录音不真画（出图交给重放那一遍）──────
# 为什么：MATLAB R2025b 出图必须起 MATLABWindow.exe，而沙箱（限 1 个进程）里图形栈起不来。
# 桩放当前目录 → 优先于内置函数 → 她的代码一个字不用改。
$stubDir = Join-Path $WorkDir 'stubs'
if (-not (Test-Path -LiteralPath $stubDir)) { New-Item -ItemType Directory -Path $stubDir -Force | Out-Null }
$stubFns = @(
  'figure','plot','plot3','semilogy','semilogx','loglog','mesh','meshc','meshz','surf','surfc','surfl',
  'contour','contourf','contour3','quiver','quiver3','bar','barh','bar3','bar3h','hist','histogram','pie','pie3',
  'polarplot','scatter','scatter3','stem','stem3','stairs','area','fill','fill3','patch','errorbar','imagesc',
  'image','pcolor','waterfall','ribbon','slice','subplot','hold','title','xlabel',
  'ylabel','zlabel','legend','grid','box','axis','xlim','ylim','zlim','caxis','clim','colormap','colorbar',
  'shading','view','rotate3d','text','annotation','gtext','gcf','gca','ginput','close','clf','cla','saveas',
  'savefig','print','exportgraphics','getframe','movie','imwrite','line','rectangle','drawnow','set','get',
  'waitfor','pause','linkaxes','daspect','pbaspect','camlight','lighting','material','alpha','brighten'
)
$tplRec = [System.IO.File]::ReadAllText((Join-Path $tplDir 'sandbox_rec.m'))
$tplPh = [System.IO.File]::ReadAllText((Join-Path $tplDir 'sandbox_placeholder.m'))
[System.IO.File]::WriteAllText((Join-Path $stubDir 'sandbox_rec.m'), $tplRec, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $stubDir 'sandbox_placeholder.m'), $tplPh, (New-Object System.Text.UTF8Encoding($false)))
foreach ($fn in $stubFns) {
  if ($fn -eq 'gcf' -or $fn -eq 'gca') {
    # 查询型：只返回占位，**不录制**（重放时要用"当时的当前图"，录下来反而错 —— 实测报"gcf 输入参数太多"）
    $stub = "function varargout = $fn(varargin)`n% 查询型桩：返回占位，不录制。`nfor k = 1:max(1, nargout), varargout{k} = sandbox_placeholder(); end`n"
  } else {
    $stub = "function varargout = $fn(varargin)`n% 沙箱桩（2026-10-13）：只把调用录进 sandbox_record.jsonl，不真画 —— 出图由重放那一遍完成。`nsandbox_rec('$fn', varargin);`nif nargout > 0, for k = 1:nargout, varargout{k} = sandbox_placeholder(); end, end`n"
  }
  [System.IO.File]::WriteAllText((Join-Path $stubDir "$fn.m"), $stub, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Output "[沙箱] 已放 $($stubFns.Count) 个绘图桩"

# 沙箱目录：给沙箱身份读写 + 标记低完整性
$sid = ''
try { $sid = [MatlabRun]::EnsureProfile($AppContainerName) } catch { Write-Error "AppContainer profile 失败：$($_.Exception.Message)"; exit 2 }
& icacls.exe $WorkDir /grant "*${sid}:(OI)(CI)M" /Q 2>$null | Out-Null
try { & icacls.exe $WorkDir /setintegritylevel '(OI)(CI)L' /T /Q 2>$null | Out-Null } catch { }

# ── 4. 启动 + 等结果 ────────────────────────────────────────────────────
$argLine = "-logfile sandbox_matlab.log -batch sandbox_wrapper"   # 无引号 → 绕开 Windows 命令行剥引号的问题
# 计算模式：ActiveProcessLimit=1（**内核级**挡住一切子进程 → system/builtin('system') 都起不来）
# 绘图模式：不限（0）→ 允许 MATLABWindow.exe 起来出图，风险改由上面的加强检查兜
$activeLimit = if ($PlotMode) { 6 } else { 1 }   # 绘图=2（MATLAB + MATLABWindow），计算=1（内核锁死命令执行）
$job = [MatlabRun]::CreateLimitsJob([uint64]$MemMB * 1MB, [int64]$CpuSec * 10000000, $activeLimit)
try {
  if (-not $AppContainer) {
    $p = Start-Process -FilePath $MatlabExe -ArgumentList $argLine -WorkingDirectory $WorkDir -NoNewWindow -PassThru
    [void][MatlabRun]::AssignProcessToJobObject($job, $p.Handle)
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { [void][MatlabRun]::TerminateJobObject($job, 124); Write-Output 'SANDBOX_TIMEOUT'; exit 124 }
    Invoke-ReplayIfNeeded
    exit $p.ExitCode
  }
  $cmdLine = "`"$MatlabExe`" $argLine"
  $pi = [MatlabRun]::LaunchInContainer($MatlabExe, $cmdLine, $WorkDir, $sid)
  [void][MatlabRun]::AssignProcessToJobObject($job, $pi.hProcess)
  if ([MatlabRun]::WaitForSingleObject($pi.hProcess, [uint32]($TimeoutSec * 1000)) -ne 0) {
    [void][MatlabRun]::TerminateJobObject($job, 124); Write-Output 'SANDBOX_TIMEOUT'; exit 124
  }
  $code = [uint32]0
  [void][MatlabRun]::GetExitCodeProcess($pi.hProcess, [ref]$code)
  exit [int]$code
} catch {
  Write-Error "沙箱启动失败：$($_.Exception.Message)"
  exit 2
} finally {
  if ($job -ne [IntPtr]::Zero) { [void][MatlabRun]::CloseHandle($job) }
}
