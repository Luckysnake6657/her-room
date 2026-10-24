// 给指定会话换一个新的 DSH 会话（保留全部记忆）。
//
// 用途：某个会话的历史里一旦混进非法字符（如被截断的半个 emoji），
// 该会话之后每轮都会被 API 判 400；换新会话即可绕开。
//
// 用法：node scripts/rotate-session.mjs private:984776985
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const key = String(process.argv[2] || '').trim();
if (!key) {
  console.error('用法：node scripts/rotate-session.mjs <会话key，如 private:984776985>');
  process.exit(2);
}
const token = readConsoleToken();
if (!token) {
  console.error('❌ 读不到控制台令牌（config.json / state/console-token 都没有）');
  process.exit(2);
}

const res = await fetch(`${BRIDGE_BASE}/api/socialV2/rotate-session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ key }),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);
process.exit(res.ok ? 0 : 1);
