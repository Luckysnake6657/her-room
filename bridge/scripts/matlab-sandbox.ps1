# MATLAB 沙箱执行器（Windows：Job Object 锁进程 + 低完整性级别锁写/删），2026-10-13。
#
# 两层都是实测逼出来的：
#   • 禁函数桩**不可靠**：`system = @(varargin) error(...)` 能挡直接调用，但
#     `builtin('system','cmd /c …')` **直接绕过**（实测 rc=0，命令真的执行了）。
#   • 第一层 **Job Object**：`ACTIVE_PROCESS = 1` → job 里创建任何子进程都失败
#     （`system`/`!`/`dos`/`unix` 全要 CreateProcess）→ 实测 `system` 与 `builtin('system')` 都是 rc=-1。
#     ⚠️ 必须启动 **win64\MATLAB.exe（真身）**：`bin\matlab.exe` 是启动器，它会再 spawn 真身，
#       于是"最多 1 个进程"会把 MATLAB 自己打死（实测 System Error 0x00000718 配额不足）。
#   • 第二层 **低完整性级别令牌（Low IL, S-1-16-4096）**：Job 只管"创建进程"，文件系统它管不着 ——
#     实测 Job 版里 `fopen(...,'w')`、`delete`、`fileread`、列目录**全部成功**。
#     Low IL 写不了中完整性对象（用户目录/系统目录就是中完整性）→ 挡住写与删；
#     **读仍然可以**（完整性级别不拦读）—— 这条如实写在 QUICKSTART 里，没有藏。
#
# 输出：不用管道重定向（CreateProcessWithTokenW 没有控制台），让 MATLAB 自己 `diary` 落到沙箱目录。
#
# 用法：
#   powershell -NoProfile -File matlab-sandbox.ps1 -Code <你的.m> -WorkDir <沙箱目录> `
#       [-TimeoutSec 30] [-CpuSec 20] [-MemMB 2048] [-LowIntegrity]
# 退出码：0 正常 / 124 超时 / 2 启动失败 / 其它 = MATLAB 退出码
param(
  [Parameter(Mandatory = $true)][string]$Code,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$MatlabExe = 'D:\MATLAB\bin\win64\MATLAB.exe',
  [int]$TimeoutSec = 30,
  [int]$CpuSec = 20,
  [int]$MemMB = 2048,
  # ⚠️ 降完整性（Low IL）默认**关着**：它走 CreateProcessWithTokenW，需要 SeImpersonatePrivilege，
  #    而当前账户不是管理员、令牌里没有该特权（实测报 "A required privilege is not held by the client"）。
  #    哪天这个服务跑在有该特权的账户下，加 -LowIntegrity 即可启用。
  [switch]$LowIntegrity,
  # 代码黑名单（正则）。为什么要它：Job 只挡"创建子进程"，文件系统它管不着；
  # 而当前账户**不是管理员**，拿不到 SeImpersonatePrivilege → 降完整性令牌（Low IL）这条路走不通
  # （实测 CreateProcessWithTokenW 报 "A required privilege is not held by the client"）。
  # 所以退到"提高门槛"：把显式文件 IO / 动态执行 / 网络 / 命令都拒掉。
  # ⚠️ 诚实说明：这**不是隔离** —— 间接调用理论上仍可能绕（所以 builtin/eval/feval 也在黑名单里）。
  [string]$DenyPattern = '\b(system|dos|unix|winqueryreg|actxserver|webread|webwrite|urlread|urlwrite|ftp|sftp|fileread|fopen|fclose|save|load|delete|rmdir|mkdir|copyfile|movefile|dir|ls|what|type|exist|eval|evalin|assignin|feval|builtin|str2func|matlabFunction|javaObject|py\.)\b'
)

$ErrorActionPreference = 'Stop'

# ── 代码黑名单检查（在启动 MATLAB 之前做，命中直接拒，连进程都不起）────────
if ($DenyPattern) {
  $srcText = [System.IO.File]::ReadAllText($Code)
  # 去掉注释和字符串里的大段文本？不做 —— 宁可误伤（她少用一次）也不要放过。
  $rx = [regex]::new($DenyPattern)
  $hits = @()
  foreach ($m in $rx.Matches($srcText)) { if ($hits -notcontains $m.Value) { $hits += $m.Value } }
  if ($hits.Count -gt 0) {
    $out0 = Join-Path $WorkDir 'sandbox-out.txt'
    $msg = "SANDBOX_DENIED：代码里出现了被禁的调用：$($hits -join ', ')`n" +
           "（这个盒子只能做纯计算/画图：不碰文件、不跑系统命令、不联网、不用 eval/builtin 这类动态执行。）"
    [System.IO.File]::WriteAllText($out0, $msg, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output $msg
    exit 3
  }
}

# ── P/Invoke：Job Object + 低完整性启动 ──────────────────────────────────
if (-not ('MatlabSandbox' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MatlabSandbox {
  // ---- Job Object ----
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

  public static IntPtr CreateJob(int activeProcessLimit, ulong processMemoryBytes, long perProcessUserTime100ns) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (perProcessUserTime100ns > 0) {
      ext.BasicLimitInformation.PerProcessUserTimeLimit = perProcessUserTime100ns;
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
    }
    if (processMemoryBytes > 0) {
      ext.ProcessMemoryLimit = (UIntPtr)processMemoryBytes;
      ext.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    }
    ext.BasicLimitInformation.ActiveProcessLimit = (uint)activeProcessLimit;
    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(ext, ptr, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(ptr); }
    return job;
  }

  // ---- 低完整性级别启动 ----
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr tok, uint acc, IntPtr attrs, int impLevel, int tokType, out IntPtr newTok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, IntPtr info, int len);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string str, out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessWithTokenW(IntPtr tok, uint logonFlags, string app, string cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const int SecurityImpersonation = 2, TokenPrimary = 1, TokenIntegrityLevel = 25;
  const uint SE_GROUP_INTEGRITY = 0x00000020;
  const uint CREATE_NO_WINDOW = 0x08000000, CREATE_SUSPENDED = 0x00000004;

  /** 低完整性级别启动（挂起），调用方先入 Job 再 ResumeThread 放行。 */
  public static PROCESS_INFORMATION LaunchLowIntegrity(string app, string cmd, string cwd) {
    IntPtr tok = IntPtr.Zero, dup = IntPtr.Zero, sid = IntPtr.Zero, labelMem = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out tok))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (!DuplicateTokenEx(tok, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (!ConvertStringSidToSid("S-1-16-4096", out sid))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      int sidLen = GetLengthSid(sid);
      int labelSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
      labelMem = Marshal.AllocHGlobal(labelSize + sidLen);
      Marshal.WriteIntPtr(labelMem, 0, new IntPtr(labelMem.ToInt64() + labelSize));   // offset 必须是 int（传 IntPtr.Zero 会编译不过）
      Marshal.WriteInt32(labelMem, IntPtr.Size, (int)SE_GROUP_INTEGRITY);
      byte[] sidBytes = new byte[sidLen];
      Marshal.Copy(sid, sidBytes, 0, sidLen);
      Marshal.Copy(sidBytes, 0, new IntPtr(labelMem.ToInt64() + labelSize), sidLen);
      if (!SetTokenInformation(dup, TokenIntegrityLevel, labelMem, labelSize + sidLen))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      PROCESS_INFORMATION pi;
      if (!CreateProcessWithTokenW(dup, 0, app, cmd, CREATE_NO_WINDOW | CREATE_SUSPENDED, IntPtr.Zero, cwd, ref si, out pi))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return pi;
    } finally {
      if (labelMem != IntPtr.Zero) Marshal.FreeHGlobal(labelMem);
      if (sid != IntPtr.Zero) Marshal.FreeHGlobal(sid);
      if (dup != IntPtr.Zero) CloseHandle(dup);
      if (tok != IntPtr.Zero) CloseHandle(tok);
    }
  }

  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr hThread);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
}
'@
}

# 沙箱目录 + 输出/包装文件
if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
$outPath = Join-Path $WorkDir 'sandbox-out.txt'
$wrapPath = Join-Path $WorkDir 'sandbox_wrapper.m'
Remove-Item $outPath -ErrorAction SilentlyContinue

# 沙箱目录标记为**低完整性**：否则 Low IL 连这儿都写不了，diary 落不下来
try { & icacls.exe $WorkDir /setintegritylevel '(OI)(CI)L' /T /Q 2>$null | Out-Null } catch { }

$posixOut = $outPath -replace '\\', '/'
# 把她的代码复制成**安全文件名**（只含字母数字下划线）再 run：
#   MATLAB 的 run/'脚本名' 里连字符会被当减号（实测 math-ok.m → "函数或变量 'math' 无法识别"）
$userCodePath = Join-Path $WorkDir 'sandbox_user_code.m'
Copy-Item -LiteralPath $Code -Destination $userCodePath -Force
$posixCode = $userCodePath -replace '\\', '/'
$wrapper = @"
diary('$posixOut'); diary on;
try
    run('$posixCode');
catch err
    disp(getReport(err, 'basic'));
    disp('SANDBOX_USER_CODE_ERROR');
end
diary off;
"@
[System.IO.File]::WriteAllText($wrapPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))
$posixWrap = $wrapPath -replace '\\', '/'

$job = [MatlabSandbox]::CreateJob(1, [uint64]$MemMB * 1MB, [int64]$CpuSec * 10000000)
try {
  if ($LowIntegrity) {
    # ★ 低完整性 + Job（限 1 进程）双锁：先挂起启动 → 入 Job → 放行
    $cmdLine = "`"$MatlabExe`" -noFigureWindows -batch sandbox_wrapper"
    $pi = [MatlabSandbox]::LaunchLowIntegrity($MatlabExe, $cmdLine, $WorkDir)
    [void][MatlabSandbox]::AssignProcessToJobObject($job, $pi.hProcess)
    [void][MatlabSandbox]::ResumeThread($pi.hThread)
    $wait = [MatlabSandbox]::WaitForSingleObject($pi.hProcess, [uint32]($TimeoutSec * 1000))
    if ($wait -ne 0) {
      [void][MatlabSandbox]::TerminateJobObject($job, 124)
      Write-Output 'SANDBOX_TIMEOUT'
      exit 124
    }
    $code = [uint32]0
    [void][MatlabSandbox]::GetExitCodeProcess($pi.hProcess, [ref]$code)
    exit [int]$code
  } else {
    # 默认路径：Job（限 1 进程）+ 黑名单 + -nojvm
    # ⚠️ `-batch` 的参数**必须手动加双引号**：Start-Process 传数组时不会加引号，而 Windows 命令行里
    #    只有双引号是定界符 → 单引号会被剥掉，`run('D:/…')` 就变成除法表达式
    #    （实测报「函数或变量 'sandbox' 无法识别」，因为路径被当成 D/qq-bridge/state/… 去算了）。
    # （不用 run() 传路径：命令行里的单引号会被 Windows 剥掉 → 路径被当成除法表达式）
    $argLine = "-noFigureWindows -batch sandbox_wrapper"   # 脚本名（工作目录=沙箱）→ 命令行无引号，绕开转义问题
    $p = Start-Process -FilePath $MatlabExe -ArgumentList $argLine `
      -WorkingDirectory $WorkDir -NoNewWindow -PassThru
    [void][MatlabSandbox]::AssignProcessToJobObject($job, $p.Handle)
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      [void][MatlabSandbox]::TerminateJobObject($job, 124)
      Write-Output 'SANDBOX_TIMEOUT'
      exit 124
    }
    exit $p.ExitCode
  }
} catch {
  Write-Error "沙箱启动失败：$($_.Exception.Message)"
  exit 2
} finally {
  if ($job -ne [IntPtr]::Zero) { [void][MatlabSandbox]::CloseHandle($job) }
}
