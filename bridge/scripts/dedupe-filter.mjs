// 删除 main() 内重复的 filterMemoryForChat（模块顶层已定义同一函数），
// 并修复 formatMemoryV2 声明与首行被挤在一起的问题。
import fs from 'node:fs';

const p = 'D:/qq-bridge/src/bridge.js';
let src = fs.readFileSync(p, 'utf8');
const before = src;

// 1) 删除 main() 内部那份 filterMemoryForChat（从注释起到函数结束）
const startMarker = '  // 纯函数：按会话类型过滤记忆。**这是隐私边界的唯一实现点**，特意做成无副作用的';
const start = src.indexOf(startMarker);
if (start < 0) throw new Error('内部注释未找到');
const endMarker = '\n\n  // 跨会话记忆注入（带隐私过滤）。规则见 filterMemoryForChat。';
const end = src.indexOf(endMarker, start);
if (end < 0) throw new Error('结束锚点未找到');
const removed = src.slice(start, end);
if (!removed.includes('function filterMemoryForChat')) throw new Error('待删片段不含目标函数，已中止');
src = src.slice(0, start) + '  // 纯函数 filterMemoryForChat 定义在模块顶层（便于测试直接 import，运行时共用同一实现）。' + src.slice(end);
console.log('删除内部重复实现:', removed.length, '字符');

// 2) 修复被挤在一行的 formatMemoryV2 声明
const broken = '  function formatMemoryV2(st) {    if (!st) return \'\';';
if (src.includes(broken)) {
  src = src.replace(broken, '  function formatMemoryV2(st) {\n    if (!st) return \'\';');
  console.log('已修复 formatMemoryV2 声明换行');
}

if (src === before) throw new Error('没有任何改动');
fs.writeFileSync(p, src, 'utf8');
console.log('字节:', before.length, '->', src.length);

// 3) 确认模块顶层与 main 内各只有一份
const all = [...src.matchAll(/function filterMemoryForChat/g)].length;
const exported = [...src.matchAll(/export function filterMemoryForChat/g)].length;
console.log(`filterMemoryForChat 定义数: ${all}（其中 export ${exported} 份）-> ${all === 1 && exported === 1 ? '✅ 单一实现' : '❌ 数量异常'}`);
