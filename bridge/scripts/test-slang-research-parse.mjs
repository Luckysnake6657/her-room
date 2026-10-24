// 验证 parseResearchJson 对 confirmed 各种写法的容错
import { parseResearchJson, buildResearchPrompt } from '../src/slang-learner.js';

const cases = [
  ['布尔 true', [{ content: 'a', meaning: 'm', confirmed: true }], true],
  ['字符串 "true"', [{ content: 'b', meaning: 'm', confirmed: 'true' }], true],
  ['中文 "是"', [{ content: 'c', meaning: 'm', confirmed: '是' }], true],
  ['中文 "确认"', [{ content: 'd', meaning: 'm', confirmed: '确认' }], true],
  ['数字 1', [{ content: 'e', meaning: 'm', confirmed: 1 }], true],
  ['布尔 false', [{ content: 'f', meaning: 'm', confirmed: false }], false],
  ['缺字段', [{ content: 'g', meaning: 'm' }], false],
  ['字符串 "false"', [{ content: 'h', meaning: 'm', confirmed: 'false' }], false],
];

console.log('=== confirmed 容错 ===');
let pass = 0, fail = 0;
for (const [label, arr, want] of cases) {
  const got = parseResearchJson(JSON.stringify(arr));
  const val = got[0]?.confirmed;
  const ok = got.length === 1 && val === want;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(16)} → confirmed=${JSON.stringify(val)} (期望 ${want})`);
  ok ? pass++ : fail++;
}

console.log('\n=== 输出被 markdown 包裹 ===');
const wrapped = '好的，这是结果：\n```json\n' + JSON.stringify([{ content: 'x', meaning: 'm', confirmed: true }]) + '\n```';
const w = parseResearchJson(wrapped);
console.log(`  ${w.length === 1 && w[0].confirmed === true ? '✅' : '❌'} 代码块包裹 → 解析出 ${w.length} 条, confirmed=${JSON.stringify(w[0]?.confirmed)}`);
w.length === 1 && w[0].confirmed === true ? pass++ : fail++;

console.log('\n=== 纯文本（无 JSON）===');
const junk = parseResearchJson('我搜了一下，这些词大多没有确切含义。');
console.log(`  ${junk.length === 0 ? '✅' : '❌'} 非 JSON → 返回空数组（${junk.length} 条）`);
junk.length === 0 ? pass++ : fail++;

console.log('\n=== buildResearchPrompt 是否含"不要一律 false"的引导 ===');
const p = buildResearchPrompt([{ content: '绷不住', evidence: [{ text: '给我整笑了' }] }]);
const hints = [
  ['有 confirmed 判断标准', p.includes('confirmed 的判断标准')],
  ['明确说常见词也该 true', p.includes('同样应该 true')],
  ['警告全 false 等于白做', p.includes('等于这次研究白做')],
  ['要求原样照抄 content', p.includes('原样照抄')],
  ['禁止 markdown 代码块', p.includes('不要 markdown 代码块')],
  ['包含候选词条', p.includes('绷不住')],
];
for (const [label, ok] of hints) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  ok ? pass++ : fail++;
}

console.log(`\n=========== 通过 ${pass} / 失败 ${fail} ===========`);
process.exit(fail ? 1 : 0);
