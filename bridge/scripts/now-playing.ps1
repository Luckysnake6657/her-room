# 读"他现在在听/在看什么"（2026-10-14）。
#
# 为什么用系统媒体会话（SMTC / GSMTC）而不是去翻网易云的私有文件：
#   • 它是 Windows 自带的"媒体会话"接口，网易云、QQ音乐、Edge、Chrome、PotPlayer…**全都**会注册；
#     实测这条命令当场就读到了 Edge 里播的 B 站视频（曲名/状态/进度），比"只读网易云"通用得多；
#   • 只读、不需要登录态、不碰对方进程内存、不写任何东西；
#   • 结果由**桥接**读出来拼进她的上下文 —— 所以她**不需要任何新工具**（不扩她的能力面）。
#
# 输出：一行 JSON（给桥接解析）。没有会话或读不到时输出 {"playing":false}。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/now-playing.ps1
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Result($obj) {
  # 一律 UTF-8 直出：中文歌名/视频标题不能在这儿被 GBK 吃掉
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
    if (-not $task.Wait(8000)) { throw '媒体会话读取超时' }
    $task.Result
  }
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = & $await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $mgr.GetSessions()
  if (-not $sessions -or $sessions.Count -eq 0) { Write-Result @{ playing = $false; reason = 'no-session' }; exit 0 }

  # 优先挑"正在播放"的；都在暂停就挑最后有更新的那个
  $best = $null
  $bestScore = -1
  foreach ($s in $sessions) {
    $status = ''
    try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { }
    $score = switch ($status) { 'Playing' { 3 } 'Paused' { 2 } 'Changing' { 1 } default { 0 } }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $s }
  }
  if (-not $best) { Write-Result @{ playing = $false; reason = 'no-session' }; exit 0 }

  $props = & $await ($best.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $timeline = $null; try { $timeline = $best.GetTimelineProperties() } catch { }
  $status = ''; try { $status = [string]$best.GetPlaybackInfo().PlaybackStatus } catch { }
  $pos = if ($timeline) { [math]::Round($timeline.Position.TotalSeconds, 0) } else { $null }
  $end = if ($timeline) { [math]::Round($timeline.EndTime.TotalSeconds, 0) } else { $null }
  $app = [string]$best.SourceAppUserModelId
  $appName = switch -Regex ($app) {
    'cloudmusic' { '网易云音乐' }
    'QQMusic' { 'QQ音乐' }
    'MSEdge' { 'Edge 浏览器' }
    'Chrome' { 'Chrome 浏览器' }
    'PotPlayer' { 'PotPlayer' }
    'foobar' { 'foobar2000' }
    default { ($app -replace '\.exe$', '') }
  }
  # 媒体类型：SMTC 的 PlaybackType 有的应用不填（默认 Music），所以三层一起判 ——
  # ① 应用自己报的类型；② 应用是谁（浏览器多半在看视频）；③ 标题里的平台特征（B站/YouTube/腾讯视频…）
  $rawType = ''
  try { $rawType = [string]$props.PlaybackType } catch { }
  $title = [string]$props.Title
  $mediaType = 'unknown'
  if ($rawType -eq 'Video') { $mediaType = 'video' }
  elseif ($rawType -eq 'Music') { $mediaType = 'music' }
  if ($mediaType -ne 'video') {
    if ($app -match '浏览器|MSEdge|Chrome|Firefox') { $mediaType = 'video' }
    elseif ($title -match '哔哩哔哩|bilibili|youtube|腾讯视频|爱奇艺|优酷|抖音|西瓜视频') { $mediaType = 'video' }
    elseif ($app -match '音乐|Music|Spotify|foobar|PotPlayer') { if ($mediaType -eq 'unknown') { $mediaType = 'music' } }
  }
  Write-Result @{
    playing   = ($status -eq 'Playing')
    paused    = ($status -eq 'Paused')
    status    = $status
    app       = $appName
    title     = $title
    artist    = [string]$props.Artist
    album     = [string]$props.AlbumTitle
    mediaType = $mediaType
    positionS = $pos
    durationS = $end
    sessionCount = $sessions.Count
  }
  exit 0
} catch {
  Write-Result @{ playing = $false; reason = ('error: ' + $_.Exception.Message) }
  exit 0
}
