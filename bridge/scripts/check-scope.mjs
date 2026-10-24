// 判断若干标识符是出现在模块顶层还是 main() 内部（用缩进与上下文粗判），
// 并检查语法。用于确认测试钩子能否在 main() 不执行时取到函数。
import fs from 'node:fs';

const src = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
const lines = src.split('\n');

const find = (needle) => lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(needle));

console.log('=== main() 起点 ===');
console.log(find('async function main()').map(([n, l]) => `${n}: ${l.trim()}`).join('\n'));

for (const name of ['function filterMemoryForChat', 'function normalizeMemorySource', 'const socialV2 = {', 'function formatMemoryV2ForChat', 'globalThis.__QQ_BRIDGE_TEST__', 'loadSocialV2State();']) {
  console.log(`\n=== ${name} ===`);
  const hits = find(name);
  if (!hits.length) { console.log('  (未找到)'); continue; }
  for (const [n, l] of hits) console.log(`  行 ${n} | 缩进 ${l.length - l.trimStart().length} | ${l.trim().slice(0, 70)}`);
}

console.log('\n=== 判断 ===');
const mainLine = find('async function main()')[0]?.[0] ?? 0;
const hookLine = find('globalThis.__QQ_BRIDGE_TEST__')[0]?.[0] ?? 0;
console.log(`main() 在第 ${mainLine} 行；钩子在 ${hookLine} 行 -> ${hookLine > mainLine ? '钩子在 main() 内部（需要 main 执行才能设置）' : '钩子在模块顶层'}`);
const filterLine = find('function filterMemoryForChat')[0]?.[0] ?? 0;
const filterIndent = (lines[filterLine - 1] ?? '').length - (lines[filterLine - 1] ?? '').trimStart().length;
console.log(`filterMemoryForChat 在第 ${filterLine} 行，缩进 ${filterIndent} -> ${filterIndent === 0 ? '模块顶层（可直接导出）' : '嵌套在函数内'}`);
