// 审查：当前人格卡里与"游戏/搜索/事实核查"相关的内容，以及可用的联网工具。
import fs from 'node:fs';

const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
const lines = card.split('\n');

console.log('=== 卡里提到 游戏 / 玩 / 搜索 / 查 的行 ===');
lines.forEach((l, i) => {
  if (/游戏|打游戏|玩|搜索|web_search|web_fetch|查一下|资料|不确定|编造/.test(l)) {
    console.log(`  ${String(i + 1).padStart(3)}: ${l.trim().slice(0, 120)}`);
  }
});

console.log('\n=== 卡的章节结构 ===');
lines.forEach((l) => { if (/^## /.test(l)) console.log('  ' + l.replace('## ', '')); });

console.log('\n=== 可用工具里与联网/知识相关的 ===');
const mcp = fs.readFileSync('D:/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');
const webTools = [...mcp.matchAll(/'(web_[a-z_]+|qq_slang_[a-z_]+)'/g)].map((x) => x[1]);
console.log('  snowluma MCP:', webTools.length ? [...new Set(webTools)].join(', ') : '(无)');
const webMcp = fs.readFileSync('D:/qq-bridge/src/mcp-web-search-safe.js', 'utf8');
const wt = [...new Set([...webMcp.matchAll(/'(web_[a-z_]+)'/g)].map((x) => x[1]))];
console.log('  web-search MCP:', wt.join(', ') || '(无)');

console.log('\n=== 卡字数 ===');
console.log('  ' + card.length + ' 字符（上限 6000）');
const GEN1 = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
console.log('  会被过滤的行:', lines.filter((l) => GEN1.test(l)).length);
