// 生成 start-overstats.bat：必须纯 ASCII + CRLF。
// 原因：cmd.exe 用 OEM 代码页（本机 GBK）读取 .bat，非 ASCII 字节会解析错乱；
// 且实测单独的 LF 会导致 cmd 截断行。
import fs from 'node:fs';

const lines = [
  '@echo off',
  'rem ============================================================',
  'rem  start-overstats.bat - start the local Overstats service.',
  'rem',
  'rem  Overstats serves the CN (NetEase Dashen) Overwatch stats API',
  'rem  that the qq-bridge MCP server mcp-ow-cn-stats talks to.',
  'rem  It listens on 127.0.0.1:18080 (loopback only, never exposed).',
  'rem',
  'rem  Credentials live in config/config.py (DASHEN_ACCOUNTS).',
  'rem  See the setup guide under D:/Overstats for role_id / token.',
  'rem',
  'rem  NOTE: keep this file ASCII-only (cmd.exe reads .bat in the OEM',
  'rem  code page; non-ASCII bytes can corrupt parsing).',
  'rem ============================================================',
  'setlocal',
  'chcp 65001 >nul',
  'cd /d "%~dp0Overstats-main"',
  '',
  'if not exist "run.py" (',
  '  echo [overstats] ERROR: run.py not found in %CD%',
  '  echo [overstats] expected the repo at D:\\Overstats\\Overstats-main',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'set "PY=C:\\Program Files\\Python312\\python.exe"',
  'if not exist "%PY%" (',
  '  echo [overstats] ERROR: python not found at "%PY%"',
  '  echo [overstats] edit PY in this file to point at your python.exe',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo [overstats] starting from %CD%',
  'echo [overstats] python : %PY%',
  'echo [overstats] url    : http://127.0.0.1:18080',
  'echo.',
  'echo   First start downloads ~1700 static assets and can take a few minutes.',
  'echo   Wait for the health check to pass before using the bot.',
  'echo.',
  'echo   Keep this window open. Closing it stops CN stats lookups.',
  'echo.',
  '',
  ':loop',
  '"%PY%" run.py',
  'set "CODE=%ERRORLEVEL%"',
  'echo.',
  'echo [overstats] exited with code %CODE%, restarting in 5 seconds...',
  'timeout /t 5 /nobreak >nul',
  'goto loop',
  '',
];

const text = lines.join('\r\n');
const buf = Buffer.from(text, 'ascii');
const target = process.argv[2] || 'D:/Overstats/start-overstats.bat';
fs.writeFileSync(target, buf);

const nonAscii = buf.filter((b) => b > 127).length;
console.log(`写入 ${target}`);
console.log(`  字节数      : ${buf.length}`);
console.log(`  非 ASCII    : ${nonAscii} ${nonAscii === 0 ? '✅' : '⚠️'}`);
console.log(`  CRLF        : ${(text.match(/\r\n/g) || []).length}`);
console.log(`  独立 LF     : ${(text.match(/(?<!\r)\n/g) || []).length} ${(text.match(/(?<!\r)\n/g) || []).length === 0 ? '✅' : '⚠️'}`);
