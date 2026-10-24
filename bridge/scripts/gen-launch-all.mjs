// 生成一键启动的 .bat（纯 ASCII + CRLF）+ 桌面快捷方式。
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const BAT = 'D:\\qq-bridge\\launch-all.bat';
const DESKTOP = 'D:\\桌面\\AIbot一键启动';

const lines = [
  '@echo off',
  'rem ============================================================',
  'rem  launch-all.bat - ONE-CLICK start of the whole AI bot stack.',
  'rem',
  'rem  Order matters and is enforced by scripts/launch-all.mjs:',
  'rem    Overstats -> SnowLuma (wait for OneBot 3000/3001) -> DSH -> bridge',
  'rem',
  'rem  Why the wait: the bridge delivers prompts right after start. If',
  'rem  SnowLuma is not listening yet, delivery fails and the session gets',
  'rem  stuck in a permanent "busy" state. Blind sleeps are not enough.',
  'rem',
  'rem  DSH must be started via dsh-guard.bat so its launch token lands in',
  'rem  ~/.dsh/guard/logs; a manually started DSH never logs the token and',
  'rem  the bridge would fail with HTTP 401 forever.',
  'rem',
  'rem  Keep this file ASCII-only with CRLF line endings.',
  'rem ============================================================',
  'setlocal',
  'chcp 65001 >nul',
  '',
  'set "NODE=C:\\Program Files\\nodejs\\node.exe"',
  'if not exist "%NODE%" for /f "delims=" %%p in (\'where node 2^>nul\') do set "NODE=%%p"',
  'if not exist "%NODE%" (',
  '  echo [launch-all] ERROR: node.exe not found. Edit NODE in this file.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo ============================================',
  'echo   AI Bot - one-click start',
  'echo ============================================',
  'echo.',
  '"%NODE%" "D:\\qq-bridge\\scripts\\launch-all.mjs" %*',
  'set "CODE=%ERRORLEVEL%"',
  'echo.',
  'if not "%CODE%"=="0" echo [launch-all] finished with code %CODE%',
  'echo This window closes in about 30 seconds (Ctrl+C to close now).',
  'echo.',
  'rem ping as a sleep: the timeout command fails when stdin is redirected.',
  'ping -n 31 127.0.0.1 >nul',
  '',
];

const text = lines.join('\r\n');
const buf = Buffer.from(text, 'ascii');
fs.writeFileSync(BAT, buf);
const nonAscii = buf.filter((b) => b > 127).length;
console.log(`写入 ${BAT}`);
console.log(`  非 ASCII: ${nonAscii} ${nonAscii === 0 ? '✅' : '⚠️'}  CRLF: ${(text.match(/\r\n/g) || []).length}  独立LF: ${(text.match(/(?<!\r)\n/g) || []).length}`);

// 桌面快捷方式
fs.mkdirSync(DESKTOP, { recursive: true });
const lnk = `${DESKTOP}\\启动AI机器人.lnk`;
const ps = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')
$s.TargetPath = '${BAT}'
$s.WorkingDirectory = 'D:\\qq-bridge'
$s.Description = 'AI Bot one-click start'
$s.IconLocation = '%SystemRoot%\\System32\\shell32.dll,137'
$s.Save()
`;
execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, { stdio: 'inherit' });
console.log(`写入快捷方式 ${lnk}`);
console.log(`  存在: ${fs.existsSync(lnk)}`);
