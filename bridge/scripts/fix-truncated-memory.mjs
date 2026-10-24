// 上一步把那条记忆改长后被 200 字上限截断了（尾巴停在"要求语气"），这里再收一次，让它读得通。
// 只更新、不删除。用法：node scripts/fix-truncated-memory.mjs [--apply]
import fs from 'node:fs';
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const APPLY = process.argv.includes('--apply');
const token = readConsoleToken();
const KEY = 'private:984776985';
const st = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));

const SHORT = '更新：艾莉丝那段结束了，之后用我自己的口吻说话（别端那套"短句、直、不绕"的腔）。'
  + 'OW 群有复读文化，说话可以短、可以接梗；但**管理员 2026-09-29 要求语气别太硬**：损要收着，说正事时放平。';

const targets = [];
for (const [tag, list] of [['conv', st.conversations[KEY]?.activeTopics], ['core', st.coreMemory?.activeTopics]]) {
  for (const t of list ?? []) {
    const s = String(t?.text ?? '');
    if (s.startsWith('演「艾莉丝·格雷拉特」那段已经到点结束了') && s.includes('要求语气') && s.length >= 195) {
      targets.push({ tag, old: s });
    }
  }
}
console.log(`需要收紧的条目：${targets.length} 条（新文本 ${SHORT.length} 字）`);
for (const t of targets) console.log(`  [${t.tag}] ${t.old.length}字 → 截断处「…${t.old.slice(-10)}」`);

if (!targets.length) process.exit(0);
if (!APPLY) { console.log('（预演；加 --apply 才写）'); process.exit(0); }

for (const t of targets) {
  const res = await fetch(`${BRIDGE_BASE}/api/socialV2/memory-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key: KEY, category: 'activeTopic', oldContent: t.old, newContent: SHORT }),
  });
  const j = await res.json().catch(() => null);
  console.log(`  ${j?.ok ? '✅' : '❌'} [${t.tag}] HTTP ${res.status} ${j?.error ?? ''}`);
}
console.log('完成。');
