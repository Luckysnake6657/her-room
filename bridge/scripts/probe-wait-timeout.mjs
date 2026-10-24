// 复现她反馈的问题：qq_wait_for_messages 长等待返回「fetch failed」（60s/120s 正常，180s+ 挂）。
//
// 直接从 MCP 服务那一侧打桥接的 /api/socialV2/wait，测不同 timeoutMs 的结果与耗时，
// 用来判断是"桥接服务端掐了 socket"还是"MCP 客户端超时"。
//
// 用法：node scripts/probe-wait-timeout.mjs [毫秒...]   默认 60000 180000 300000
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
const cfg = readJson(path.join(ROOT, 'config.json'));
const port = Number(cfg.consolePort) || 3100;
let consoleToken = String(cfg.consoleToken ?? '').trim();
if (!consoleToken) { try { consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {} }

const st = readJson(path.join(ROOT, 'state', 'social-v2.json'));
const key = process.argv[2] && /^(group|private):/.test(process.argv[2])
  ? process.argv[2]
  : Object.keys(st.conversations ?? {})[0];
const agentToken = st.conversations?.[key]?.agentToken;
if (!key || !agentToken) { console.error('拿不到会话/令牌'); process.exit(2); }
console.log(`会话 ${key}\n桥接 http://127.0.0.1:${port}\n`);

const durations = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const list = durations.length ? durations : [60000, 180000, 300000];

for (const timeoutMs of list) {
  const started = Date.now();
  // 客户端超时给足（比等待时间多 60s）：这样如果是服务端掐的，我们能看到
  const clientTimeout = timeoutMs + 60000;
  let outcome = '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-token': agentToken },
      body: JSON.stringify({ key, timeoutMs }),
      signal: AbortSignal.timeout(clientTimeout),
    });
    const elapsed = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch {}
    outcome = `HTTP ${res.status}  ${body ? `timeout=${body.timeout} waitedMs=${body.waitedMs} satisfied=${body.preSleepWaitSatisfied}` : '(无 JSON)'}`;
    console.log(`timeoutMs=${timeoutMs}  实际 ${Math.round(elapsed / 1000)}s  ✅ ${outcome}`);
  } catch (error) {
    const elapsed = Date.now() - started;
    const cause = error?.cause?.code || error?.cause?.message || error?.code || '';
    console.log(`timeoutMs=${timeoutMs}  实际 ${Math.round(elapsed / 1000)}s  ❌ ${error?.name}: ${error?.message}${cause ? `  (cause: ${cause})` : ''}`);
  }
  // 两次等待之间留点空，避免同时占两个 wait
  await new Promise((r) => setTimeout(r, 1500));
}
