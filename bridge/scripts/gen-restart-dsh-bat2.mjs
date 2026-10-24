// 生成可用的 restart-dsh.bat：纯 ASCII + CRLF。
//
// 关键修复：旧的 for /f 里用 \" 转义双引号 —— 那是 PowerShell 的转义法，
// cmd.exe 的 for /f 不认，整个命令被解析坏掉（The string is missing the terminator），
// 于是 PID 列表为空、taskkill 一个都没杀，看起来"重启没生效"。
// cmd 里的正确写法是用单引号包 PowerShell 表达式。
import fs from 'node:fs';

// 只匹配主 DSH 进程：命令行含 dsh\lib\bin.js（或正斜杠版）+ 参数 web。
// 不能只匹配 'dsh.lib.bin.js'——那会连带命中 dsh-subprocess-local 的子进程。
const PS_FIND =
  "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'dsh.lib.bin.js' -and $_.CommandLine -match '\\bweb\\b' -and $_.CommandLine -notmatch 'subprocess-local' } | Select-Object -ExpandProperty ProcessId";

const lines = [
  '@echo off',
  'rem ============================================================',
  'rem  restart-dsh.bat - fully restart the DSH process tree.',
  'rem',
  'rem  Why a full restart is needed:',
  'rem  Agent-preset plugins (qq-tool-restrict.mjs) are imported into',
  'rem  the long-lived DSH process, and MCP servers are spawned by it.',
  'rem  Node caches ES modules per process, so editing a preset/guard or',
  'rem  an MCP script on disk does NOT affect an already-running DSH.',
  'rem  Restarting qq-bridge is not enough.',
  'rem',
  'rem  What it does:',
  'rem    1. kills the DSH web process tree',
  'rem    2. relaunches it detached via dsh-guard.bat',
  'rem    3. prints the new PID and the newest log lines',
  'rem',
  'rem  The bridge detects dshReady false -> true and reconnects itself.',
  'rem',
  'rem  NOTE: keep this file ASCII-only with CRLF line endings.',
  'rem  Do NOT use backslash-escaped double quotes inside for /f:',
  'rem  cmd.exe does not understand them and the whole line breaks.',
  'rem ============================================================',
  'setlocal enabledelayedexpansion',
  'chcp 65001 >nul',
  '',
  'echo [restart-dsh] looking for the DSH web process...',
  '',
  'set "FOUND="',
  `for /f "delims=" %%p in ('powershell -NoProfile -Command "${PS_FIND}"') do (`,
  '  echo [restart-dsh] killing DSH PID %%p (with children)',
  '  taskkill /PID %%p /T /F >nul 2>&1',
  '  set "FOUND=1"',
  ')',
  '',
  'if not defined FOUND (',
  '  echo [restart-dsh] no running DSH web process found.',
  ') else (',
  '  echo [restart-dsh] stopped. waiting for port 3080 to be released...',
  '  timeout /t 5 /nobreak >nul',
  ')',
  '',
  'echo [restart-dsh] starting DSH again...',
  'start "" /min cmd /c "D:\\qq-bridge\\dsh-guard.bat"',
  '',
  'echo [restart-dsh] waiting for it to come up...',
  'timeout /t 20 /nobreak >nul',
  '',
  'echo.',
  'echo [restart-dsh] current DSH process:',
  "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'dsh.lib.bin.js' -and $_.CommandLine -match 'web' } | ForEach-Object { '  PID ' + $_.ProcessId + '  started ' + $_.CreationDate.ToString('HH:mm:ss') }\"",
  '',
  'echo.',
  'echo [restart-dsh] health on port 3080:',
  "powershell -NoProfile -Command \"$c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue; if ($c) { '  listening, PID ' + $c.OwningProcess } else { '  NOT listening yet' }\"",
  '',
  'echo.',
  'echo [restart-dsh] newest DSH log:',
  "powershell -NoProfile -Command \"$f = Get-ChildItem \\\"$env:USERPROFILE\\.dsh\\guard\\logs\\\" -Filter 'server-*.out.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { '  ' + $f.Name; Get-Content $f.FullName -Tail 3 | ForEach-Object { '  ' + $_ } }\"",
  '',
  'echo.',
  'echo [restart-dsh] done. refresh the DSH web page, then test the bot.',
  'echo.',
  'pause',
  '',
];

const text = lines.join('\r\n');
const buf = Buffer.from(text, 'ascii');
const target = 'D:/qq-bridge/restart-dsh.bat';
fs.writeFileSync(target, buf);

const nonAscii = buf.filter((b) => b > 127).length;
console.log(`写入 ${target}`);
console.log(`  字节数   : ${buf.length}`);
console.log(`  非 ASCII : ${nonAscii} ${nonAscii === 0 ? '✅' : '⚠️'}`);
console.log(`  CRLF     : ${(text.match(/\r\n/g) || []).length}`);
console.log(`  独立 LF  : ${(text.match(/(?<!\r)\n/g) || []).length} ${(text.match(/(?<!\r)\n/g) || []).length === 0 ? '✅' : '⚠️'}`);
console.log(`  含反斜杠转义双引号(应为0): ${(text.match(/\\"/g) || []).length}`);
console.log(`  含 dsh-guard: ${text.includes('dsh-guard') ? '✅' : '⚠️'}`);
