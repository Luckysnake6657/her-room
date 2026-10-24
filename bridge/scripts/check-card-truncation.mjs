// 看角色卡在注入上限处被截掉的是什么（默认 8000，可用 socialV2.roleCard.maxChars 覆盖）。
import fs from 'node:fs';

const p = 'D:/qq-bridge/roles/程莫雯.md';
const raw = fs.readFileSync(p, 'utf8');
let LIMIT = 8000;
try {
  const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, ''));
  const v = cfg.socialV2?.roleCard?.maxChars;
  if (v === 0) LIMIT = Infinity;
  else if (Number.isFinite(Number(v)) && Number(v) >= 1000) LIMIT = Math.round(Number(v));
} catch {}
console.log(`卡片字符数 ${raw.length}，上限 ${LIMIT === Infinity ? '不截断' : LIMIT}，超出 ${LIMIT === Infinity ? 0 : Math.max(0, raw.length - LIMIT)}`);
if (raw.length <= LIMIT) {
  console.log('✅ 整张卡都能进提示词，没有内容被切掉。');
} else {
  console.log('\n被截掉的部分（上限之后）：');
  console.log(JSON.stringify(raw.slice(LIMIT)));
}console.log('\n=== 各小节起始位置 ===');
let pos = 0;
for (const line of raw.split('\n')) {
  if (/^##\s/.test(line)) console.log(`  ${String(pos).padStart(5)}  ${line.trim()}${pos >= LIMIT ? '   ← 完全在截断区' : (pos + line.length > LIMIT ? '   ← 跨过截断点' : '')}`);
  pos += line.length + 1;
}
