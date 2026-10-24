// Confirm the sticker-semantics patches are actually present in the source the
// bridge and MCP servers load at runtime.
import fs from 'node:fs';

const b = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
const m = fs.readFileSync('D:/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');

const checks = [
  ['bridge: isStickerSegment 分类函数', b.includes('function isStickerSegment')],
  ['bridge: 文本区分 [表情包] 与 [图片]', b.includes("isStickerSegment(d) ? '[表情包]' : '[图片]'")],
  ['bridge: extractMedia kind=sticker', b.includes("kind: isStickerSegment(d) ? 'sticker' : 'image'")],
  ['bridge: fetchMediaData 透传 kind/summary', b.includes("const isSticker = media.kind === 'sticker'")],
  ['bridge: mediaHintFor 提示禁止描述画面', b.includes('上面的表情包是对方在表达情绪')],
  ['mcp: 标签区分 表情包/QQ表情/图片', m.includes("img.kind === 'sticker' ? '表情包'")],
  ['mcp: 摘要 summary 一并带出', m.includes('img.summary ?')],
  ['mcp: 明确告知表情包是情绪表达', m.includes('属于情绪表达/反应')],
];

console.log('=== 补丁落位 ===');
let ok = 0;
for (const [name, pass] of checks) {
  if (pass) ok++;
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
}
console.log(`  ${ok}/${checks.length} 通过`);

console.log('\n=== 语法 ===');
console.log('  bridge.js 字节:', b.length, '| mcp 字节:', m.length);
