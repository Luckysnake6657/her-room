// 手动唤醒指定会话（仅 reserved2 模式）。
// 用法：node scripts/wake-session.mjs private:984776985 [原因]
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const key = String(process.argv[2] || '').trim();
const reason = String(process.argv[3] || 'admin-frontend-check').trim();
if (!key) { console.error('用法：node scripts/wake-session.mjs <会话key> [原因]'); process.exit(2); }
const token = readConsoleToken();
const res = await fetch(`${BRIDGE_BASE}/api/socialV2/wake`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ key, reason }),
});
console.log(`HTTP ${res.status}`);
console.log(await res.text());
