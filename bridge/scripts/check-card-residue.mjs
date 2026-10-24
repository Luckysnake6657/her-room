// Re-check the 程莫雯 card for leftover old-identity text after the tsundere edits.
import fs from 'node:fs';

const p = 'D:/qq-bridge/roles/程莫雯.md';
const raw = fs.readFileSync(p, 'utf8');
const lines = raw.split('\n');

console.log('字节数 / 字符数 :', fs.statSync(p).size, '/', raw.length);
// 注入上限跟 bridge 侧一致（默认 8000，可被 socialV2.roleCard.maxChars 覆盖；0 = 不截断）
let LIMIT = 8000;
try {
  const v = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, '')).socialV2?.roleCard?.maxChars;
  if (v === 0) LIMIT = Infinity;
  else if (Number.isFinite(Number(v)) && Number(v) >= 1000) LIMIT = Math.round(Number(v));
} catch {}
console.log(`注入上限        : ${LIMIT === Infinity ? '不截断' : LIMIT}`);
console.log('超上限截断      :', raw.length > LIMIT ? `❌ 会截断（丢 ${raw.length - LIMIT} 字符）` : '✅ 不会');

const GEN1 = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
const dropped = lines.filter((l) => GEN1.test(l));
console.log('被过滤的行      :', dropped.length === 0 ? '✅ 无' : '❌ ' + dropped.length);

console.log('\n=== 旧身份残留复查 ===');
// 角色卡里会**故意**写出那些词——写在"不要/黑名单"里当反面例子（例如第九节
// "AI 味黑名单"里就有 `- 自称"本小姐"`）。旧版本只按关键词找，把这种正确写法
// 也报成 ⚠️ 残留，属于误报；所以这里把"禁止语境"排除掉：
//   ① 落在「AI 味黑名单」小节里的行；② 行内带 不要/别/不得/禁止/除非/❌ 的。
const banStart = lines.findIndex((l) => /^##\s*九、|AI 味黑名单/.test(l));
let banEnd = lines.length;
for (let i = banStart + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) { banEnd = i; break; }
}
const inBanSection = (i) => banStart >= 0 && i >= banStart && i < banEnd;
const isProhibition = (l) => /不要|别自称|不得|禁止|除非|❌|黑名单|不是群友腔|那是二创|作废|不再包含|不会说|绝不|绝对不会/.test(l);

const residue = [];
for (const bad of ['小鲸鱼', '鲸鱼', '大肥鱼', 'D指导', 'D老师', 'DeepSeek', '偷吃 token', '本小姐']) {
  const hits = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => l.includes(bad) && !inBanSection(i) && !isProhibition(l));
  if (hits.length === 0) {
    console.log(`  ✅ ${bad}: 无`);
  } else {
    console.log(`  ⚠️  ${bad}: ${hits.length} 行`);
    for (const { l } of hits) { console.log(`        ${l.trim().slice(0, 96)}`); residue.push(bad); }
  }
}
console.log(`\n  结论：${residue.length === 0 ? '✅ 没有真的残留（黑名单里的反面例子不算）' : `❌ ${residue.length} 处需要人工看`}`);

console.log('\n=== 傲娇嘴硬相关（确认已加入）===');
for (const l of lines.filter((l) => /傲娇|嘴硬|少来|随便你/.test(l))) {
  console.log('  ' + l.trim().slice(0, 110));
}
