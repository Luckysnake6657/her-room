// 把所有会话的"普通消息概率唤醒"关掉（triggers.probability → 0），
// 只保留 @/名字/关键词/提问/拍一拍 这类"确实被点到"的唤醒。
//
// 用法：node scripts/set-wake-probability.mjs 0        # 关掉概率唤醒（默认）
//       node scripts/set-wake-probability.mjs 0.02     # 改成 2%
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const p = process.argv[2] !== undefined ? Number(process.argv[2]) : 0;
if (!Number.isFinite(p) || p < 0 || p > 1) { console.error('用法：node scripts/set-wake-probability.mjs <0~1>'); process.exit(2); }
const token = readConsoleToken();

const res = await fetch(`${BRIDGE_BASE}/api/socialV2/states`, { headers: { 'x-console-token': token } });
const data = await res.json();
// 端点的形状是 { ok, conversations: [{ key, wakeConfig, ... }] }
const keys = (data.conversations ?? []).map((c) => c.key).filter(Boolean);
if (!keys.length) { console.error('拿不到会话列表：', JSON.stringify(data).slice(0, 200)); process.exit(1); }

console.log(`准备把 ${keys.length} 个会话的 triggers.probability 设为 ${p}\n`);
for (const key of keys) {
  const r = await fetch(`${BRIDGE_BASE}/api/socialV2/wake-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key, config: { triggers: { probability: p } } }),
  });
  const j = await r.json();
  const got = j?.wakeConfig?.triggers?.probability ?? j?.config?.triggers?.probability;
  console.log(`  ${key.padEnd(22)} HTTP ${r.status}  probability => ${got !== undefined ? got : JSON.stringify(j).slice(0, 120)}`);
}

// 回读一遍确认真的落盘（这个端点是"改完即生效"，不信返回值信回读）
const after = await (await fetch(`${BRIDGE_BASE}/api/socialV2/states`, { headers: { 'x-console-token': token } })).json();
console.log('\n回读确认：');
for (const c of after.conversations ?? []) {
  const t = c.wakeConfig?.triggers ?? {};
  console.log(`  ${String(c.key).padEnd(22)} probability=${t.probability}  模式=${c.wakeConfig?.mode}  仍开的触发=${['atMention', 'nameMention', 'question', 'poke', 'anyMessage'].filter((k) => t[k]).join('/') || '（无）'}`);
}
