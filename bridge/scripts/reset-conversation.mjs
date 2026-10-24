// Reset one QQ conversation's DSH session through the bridge console API.
//
// Use when a conversation is permanently "busy": messages arrive and are logged
// as 消息已入未读, but every wake is deferred with 会话繁忙，暂存唤醒原因 and the
// agent never runs. That means isConversationBusyV2() still sees an in-flight
// turn (orphaned by a restart or a killed tool call).
//
// Usage: node scripts/reset-conversation.mjs private:984776985
import fs from 'node:fs';

const key = process.argv[2];
if (!key) {
  console.error('usage: node scripts/reset-conversation.mjs <key>');
  console.error('  key 形如 private:984776985 或 group:123456');
  process.exit(1);
}

// 控制台令牌实际存在 config.json 的 consoleToken（state/console-token 是旧路径，已不存在）
const token = (() => {
  try {
    const j = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
    if (j?.consoleToken) return String(j.consoleToken).trim();
  } catch {}
  try {
    return fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
  } catch {
    console.error('找不到控制台令牌（config.json 的 consoleToken）');
    process.exit(1);
  }
})();
const base = 'http://127.0.0.1:3100';
const headers = { 'content-type': 'application/json', 'x-console-token': token };

let before;
try {
  const r = await fetch(`${base}/api/sessions`, { headers, signal: AbortSignal.timeout(8000) });
  before = await r.json();
  console.log('reset 前的映射:', JSON.stringify(before).slice(0, 300));
} catch (e) {
  console.error('控制台不可达（桥接没在跑？）:', e.cause?.code ?? e.message);
  process.exit(1);
}

const res = await fetch(`${base}/api/session/reset`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ key }),
  signal: AbortSignal.timeout(20000),
});
console.log(`POST /api/session/reset {key:${key}} -> ${res.status}`);
console.log((await res.text()).slice(0, 300));

try {
  const r = await fetch(`${base}/api/sessions`, { headers, signal: AbortSignal.timeout(8000) });
  console.log('reset 后的映射:', JSON.stringify(await r.json()).slice(0, 300));
} catch { /* ignore */ }

console.log('\n下一步：在 QQ 里再发一条消息，会触发全新会话（日志出现 新会话 ... ）。');
