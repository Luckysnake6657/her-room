// 1) validate the card after the sticker section was added
// 2) unit-test the sticker-vs-photo classifier against the shapes QQ actually sends
import fs from 'node:fs';

// ---- card validation ----
const cardPath = 'D:/qq-bridge/roles/程莫雯.md';
const raw = fs.readFileSync(cardPath, 'utf8');
const GEN1 = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
console.log('=== 角色卡 ===');
console.log('字符数      :', raw.length, raw.length > 6000 ? '❌ 会截断' : '✅ 不截断');
console.log('被过滤的行  :', raw.split('\n').filter((l) => GEN1.test(l)).length);
console.log('含表情包章节:', raw.includes('## 六、表情包和图片怎么接') ? '✅' : '❌');

// ---- classify test: mirror of isStickerSegment() in bridge.js ----
function isStickerSegment(data) {
  const d = data ?? {};
  const subType = d.subType != null ? String(d.subType) : '';
  if (subType === '1') return true;
  const summary = String(d.summary ?? '');
  if (!summary) return false;
  return /表情|贴纸|sticker/i.test(summary) && !/^\[图片\]?$/.test(summary);
}

const cases = [
  ['自定义表情包（subType=1）', { subType: '1', summary: '[动画表情]' }, true],
  ['表情包（只有 summary）', { summary: '[动画表情]' }, true],
  ['表情包（summary=[表情]）', { summary: '[表情]' }, true],
  ['表情包（subType=1 无 summary）', { subType: 1 }, true],
  ['普通照片（无字段）', {}, false],
  ['普通照片（summary=[图片]）', { summary: '[图片]' }, false],
  ['普通照片（subType=0）', { subType: '0' }, false],
  ['普通照片（有 summary 但不是表情）', { summary: '这是我看的番的截图' }, false],
];

console.log('\n=== 表情包/照片 分类测试 ===');
let pass = 0;
for (const [name, input, expected] of cases) {
  const got = isStickerSegment(input);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(30)} -> ${got ? '表情包' : '照片'} (期望 ${expected ? '表情包' : '照片'})`);
}
console.log(`  通过 ${pass}/${cases.length}`);
