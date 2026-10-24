# 控制"正在播放的媒体"（2026-10-20）。
#
# 为什么用 SMTC 而不是去操作网易云窗口：
#   • 网易云、QQ音乐、Edge、Chrome、PotPlayer 全都注册在这套接口上，**一个脚本通吃**；
#   • 不需要 UI 坐标、不需要窗口在前台、不会被"点偏"；
#   • now-playing.ps1 已经在读这套接口了，这里只是加上"写"的那一半。
#
# **只暴露 4 个动作**（play/pause/toggle/next/prev）：
#   音量、跳转进度、退出、播放列表——一律不碰。切歌是低风险高频操作，
#   但"突然把音量拉满"会伤人耳朵，所以刻意不给。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/media-control.ps1 -Action next
# 输出：一行 JSON {"ok":true,"action":"next","title":"..."}

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('play', 'pause', 'toggle', 'next', 'prev')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $stdout = [System.Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $await = {
    param($op, $type)
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(8000)) { throw '媒体会话操作超时' }
    $task.Result
  }
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = & $await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

  # ★ 特化网易云（2026-10-20 管理员："我电脑里面只有网易云，可以搞特化一下"）。
  #   原来按"谁在播就控谁"挑，实测控到了 Edge 里的 B 站视频（标题变成《现代战争4》首发情报）。
  #   现在：**优先锁 cloudmusic**；没有它才退回到"正在播的那个"，并在返回里说明不是网易云。
  $all = @($mgr.GetSessions())
  $session = $null
  $isNetease = $false
  foreach ($s in $all) {
    $app = ''
    try { $app = [string]$s.SourceAppUserModelId } catch { }
    if ($app -match 'cloudmusic') { $session = $s; $isNetease = $true; break }
  }
  if (-not $session) {
    $bestScore = -1
    foreach ($s in $all) {
      $st2 = ''
      try { $st2 = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { }
      $score = switch ($st2) { 'Playing' { 3 } 'Paused' { 2 } 'Changing' { 1 } default { 0 } }
      if ($score -gt $bestScore) { $bestScore = $score; $session = $s }
    }
  }
  if (-not $session) { Write-Result @{ ok = $false; error = '网易云没开着，也没有别的媒体在播（先让他打开网易云放一首）' }; exit 0 }

  $titleBefore = ''
  try { $titleBefore = [string](& $await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])).Title } catch { }

  # ⚠️ 不能写成 `switch { ... (& $await ($x.TryPlayAsync()) ([bool])) }` ——
  #   实测（2026-10-20）在 switch 块里带泛型参数 type 的调用解析不了，直接报错。
  #   包成函数，用 MakeGenericMethod 明确指定 [bool]。
  function Invoke-MediaOp($op) {
    try {
      $task = $asTask.MakeGenericMethod([bool]).Invoke($null, @($op))
      if (-not $task.Wait(8000)) { return $false }
      return [bool]$task.Result
    } catch { return $false }
  }
  $ok = $false
  if ($Action -eq 'play') { $ok = Invoke-MediaOp $session.TryPlayAsync() }
  elseif ($Action -eq 'pause') { $ok = Invoke-MediaOp $session.TryPauseAsync() }
  elseif ($Action -eq 'next') { $ok = Invoke-MediaOp $session.TrySkipNextAsync() }
  elseif ($Action -eq 'prev') { $ok = Invoke-MediaOp $session.TrySkipPreviousAsync() }
  elseif ($Action -eq 'toggle') {
    $st = ''
    try { $st = [string]$session.GetPlaybackInfo().PlaybackStatus } catch { }
    if ($st -eq 'Playing') { $ok = Invoke-MediaOp $session.TryPauseAsync() }
    else { $ok = Invoke-MediaOp $session.TryPlayAsync() }
  }

  Start-Sleep -Milliseconds 700
  $titleAfter = ''
  try { $titleAfter = [string](& $await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])).Title } catch { }
  $statusAfter = ''
  try { $statusAfter = [string]$session.GetPlaybackInfo().PlaybackStatus } catch { }

  Write-Result @{
    ok = $ok
    action = $Action
    title = $titleAfter
    status = $statusAfter
    changed = ($titleBefore -ne $titleAfter)
    netease = $isNetease
  }
} catch {
  Write-Result @{ ok = $false; error = ('媒体控制失败：' + $_.Exception.Message) }
}
