// 恢复 restart-dsh.bat：纯 ASCII + CRLF（之前误被 start-overstats 的内容覆盖）。
import fs from 'node:fs';

const lines = [
  '@echo off',
  'rem ============================================================',
  'rem  restart-dsh.bat - fully restart the DSH process tree.',
  'rem',
  'rem  Why this is needed:',
  'rem  Agent-preset plugins (qq-tool-restrict.mjs) are imported into',
  'rem  the long-lived DSH process. Node caches ES modules per process,',
  'rem  so editing the file on disk does NOT affect an already-running',
  'rem  DSH - it keeps executing the old whitelist from memory.',
  'rem  Restarting the bridge is not enough; the DSH process itself must',
  'rem  be replaced before a changed preset takes effect.',
  'rem',
  'rem  What it does:',
  'rem    1. kills any running DSH (node ... dsh/lib/bin.js) process tree',
  'rem    2. relaunches it detached via dsh-guard.bat',
  'rem    3. prints the new PID and the newest log lines',
  'rem',
  'rem  The bridge detects the DSH restart (dshReady false -> true) and',
  'rem  reconnects on its own; queued messages are delivered afterwards.',
  'rem',
  'rem  NOTE: keep this file ASCII-only, and keep CRLF line endings',
  'rem  (cmd.exe reads .bat in the OEM code page; lone LF truncates lines).',
  'rem ============================================================',
  'setlocal enabledelayedexpansion',
  'chcp 65001 >nul',
  '',
  'echo [restart-dsh] looking for running DSH processes...',
  '',
  'set "FOUND="',
  'for /f "tokens=1" %%p in (\'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'lib.bin.js\' } | Select-Object -ExpandProperty ProcessId"\') do (',
  '  echo [restart-dsh] killing DSH PID %%p and its children',
  '  taskkill /PID %%p /T /F >nul 2>&1',
  '  set "FOUND=1"',
  ')',
  '',
  'if not defined FOUND (',
  '  echo [restart-dsh] no running DSH found.',
  ') else (',
  '  echo [restart-dsh] DSH stopped. Waiting for port 3080 to be released...',
  '  timeout /t 4 /nobreak >nul',
  ')',
  '',
  'echo [restart-dsh] starting DSH again...',
  'start "" /min cmd /c "D:\\qq-bridge\\dsh-guard.bat"',
  '',
  'timeout /t 12 /nobreak >nul',
  '',
  'echo.',
  'echo [restart-dsh] new DSH process:',
  'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'lib.bin.js\' } | ForEach-Object { \'  PID \' + $_.ProcessId + \'  started \' + $_.CreationDate.ToString(\'HH:mm:ss\') }"',
  '',
  'echo.',
  'echo [restart-dsh] newest log:',
  'powershell -NoProfile -Command "$f = Get-ChildItem \\"$env:USERPROFILE\\.dsh\\guard\\logs\\" -Filter \'server-*.out.log\' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { \'  \' + $f.Name; Get-Content $f.FullName -Tail 3 | ForEach-Object { \'  \' + $_ } }"',
  '',
  'echo.',
  'echo [restart-dsh] done. Give it ~10s, then ask the bot to look up a match.',
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
console.log(`  独立 LF  : ${(text.match(/(?<!\r)\n/g) || []).length}`);
console.log(`  含 overstats 残留: ${text.includes('overstats') ? '⚠️ 是' : '✅ 否'}`);
console.log(`  含 restart-dsh 标识: ${text.includes('restart-dsh') ? '✅ 是' : '⚠️ 否'}`);
