// 分析卡的空间占用，找出可压缩的冗余（卡接近 6000 硬截断上限）。
import fs from 'node:fs';

const p = 'D:/qq-bridge/roles/程莫雯.md';
const src = fs.readFileSync(p, 'utf8');
const lines = src.split('\n');

console.log('总字符数:', src.length, '| 上限 6000 | 余量', 6000 - src.length);

// 按章节统计
console.log('\n=== 各章节字符数 ===');
let cur = '(前言)';
let acc = 0;
const stats = [];
for (const l of lines) {
  if (/^## /.test(l)) {
    stats.push([cur, acc]);
    cur = l.replace('## ', '').trim();
    acc = 0;
  }
  acc += l.length + 1;
}
stats.push([cur, acc]);
for (const [name, n] of stats.sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${name}`);
}

// 找重复/可压缩的模式
console.log('\n=== 可能的冗余 ===');
const dupes = new Map();
for (const l of lines) {
  const t = l.trim();
  if (t.length < 12) continue;
  if (!t.startsWith('-') && !t.startsWith('>')) continue;
  dupes.set(t, (dupes.get(t) ?? 0) + 1);
}
const repeated = [...dupes.entries()].filter(([, n]) => n > 1);
console.log(repeated.length ? repeated.map(([t, n]) => `  x${n}  ${t.slice(0, 70)}`).join('\n') : '  （无明显重复行）');

// 示例段占比
const exampleStart = lines.findIndex((l) => /^## .*回复示例/.test(l));
const exampleEnd = lines.findIndex((l, i) => i > exampleStart && /^## /.test(l));
console.log(`\n回复示例段: ${exampleEnd - exampleStart} 行，约 ${lines.slice(exampleStart, exampleEnd).join('\n').length} 字符`);
