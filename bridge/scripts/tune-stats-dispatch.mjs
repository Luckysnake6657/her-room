// 给四个战绩服务器的"单一入口"描述瘦身（第二版：按服务器的固定套话剥前缀）。
//
// 各 action 的原描述开头都是同一句「只读查询 XX 平台（…）玩家」——
// 6 条里重复 6 遍纯属浪费每回合的 token。v1 试过"求最长公共前缀"，但对完美那套没用：
// 有的写「只读搜索」有的写「只读查询」，公共前缀只有「只读」两个字 → 剥不掉。
// 所以改成按服务器**显式**剥一句套话，再把摘要上限收到 46 字符。
//
// 幂等：已经带 ACTION_BOILER 就跳过。用法：node scripts/tune-stats-dispatch.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const FILES = {
  'mcp-ow-stats.js': '/^只读(?:查询|搜索)\\s*守望先锋2\\s*(?:玩家)?[，,]?/',
  'mcp-ow-cn-stats.js': '/^只读(?:查询|搜索)\\s*守望先锋【国服】\\s*(?:玩家)?[，,]?/',
  'mcp-cs-5e-stats.js': '/^只读(?:查询|搜索)\\s*5E 对战平台（国内 CS）\\s*(?:玩家)?[，,]?/',
  'mcp-cs-wmpvp-stats.js': '/^只读(?:查询|搜索)\\s*完美世界竞技平台（完美平台，国内 CS）\\s*(?:玩家)?[，,]?/',
};

// v1 的 actionBrief 块（求公共前缀那版），需要时整体替换成 v2
const V1_START = '// 各 action 的描述开头都是同一句「只读查询 XX 平台…」';
const V1_END = "  return first.length > 46 ? first.slice(0, 46) + '…' : first;\n};";

const V2 = (boiler) => `// 各 action 的描述开头都是同一句「只读查询 XX 平台（…）玩家」：逐条重复纯属浪费 token，
// 这里按服务器剥掉这句套话（不许用"最长公共前缀"——有的写"只读搜索"有的写"只读查询"，
// 公共前缀只有"只读"两字，根本剥不动）。
const ACTION_BOILER = ${boiler};
const actionDescs = new Map(actionNames.map((n) => [n, String(exposedActions.get(n)?.description ?? '').replace(/\\s+/g, ' ').trim()]));
const actionBrief = (n) => {
  let s = actionDescs.get(n) ?? '';
  const stripped = s.replace(ACTION_BOILER, '').trim();
  if (stripped.length >= 6) s = stripped;
  const first = s.split(/[。；;]/)[0] ?? '';
  return first.length > 46 ? first.slice(0, 46) + '…' : first;
};`;

let changed = 0;
for (const [file, boiler] of Object.entries(FILES)) {
  const p = path.join(ROOT, 'src', file);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('const ACTION_BOILER')) { console.log(`= 已瘦身到 v2，跳过：${file}`); continue; }
  const at = s.indexOf(V1_START);
  const end = s.indexOf(V1_END, at);
  if (at < 0 || end < 0) { console.error(`❌ 找不到 actionBrief 块：${file}`); process.exitCode = 1; continue; }
  s = s.slice(0, at) + V2(boiler) + s.slice(end + V1_END.length);
  fs.writeFileSync(p, s, 'utf8');
  console.log(`✅ 已瘦身 v2：${file}`);
  changed++;
}
console.log(`\n完成：改了 ${changed} 个文件`);
for (const file of Object.keys(FILES)) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', file)], { stdio: 'pipe' }); }
  catch (error) { console.error(`❌ ${file} 语法失败：${String(error.stdout ?? error.message).slice(0, 300)}`); process.exitCode = 1; }
}
