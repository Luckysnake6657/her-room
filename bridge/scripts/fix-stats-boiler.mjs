// 把四个战绩服务器里的 ACTION_BOILER 套话正则补全：
//   - 加 |扫描（season_history 的描述以「只读扫描…」开头，原来漏了）
//   - 允许「玩家的」这种"的"（原来只吃到「玩家」，摘要会剩下一个光秃秃的"的…"）
// 幂等。用法：node scripts/fix-stats-boiler.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FILES = ['mcp-ow-stats.js', 'mcp-ow-cn-stats.js', 'mcp-cs-5e-stats.js', 'mcp-cs-wmpvp-stats.js'];
const OLD_RE = '/^只读(?:查询|搜索)\\s*';
const NEW_RE = '/^只读(?:查询|搜索|扫描)\\s*';
const OLD_TAIL = '\\s*(?:玩家)?[，,]?/;';
const NEW_TAIL = '\\s*(?:玩家)?的?[，,]?/;';

let changed = 0;
for (const f of FILES) {
  const p = path.join(ROOT, 'src', f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  s = s.replace(OLD_RE, NEW_RE).replace(OLD_TAIL, NEW_TAIL);
  if (s !== before) { fs.writeFileSync(p, s, 'utf8'); console.log(`✅ 已补全套话正则：${f}`); changed++; }
  else console.log(`= 无需改动：${f}`);
}
console.log(`\n完成：改了 ${changed} 个文件`);
for (const f of FILES) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', f)], { stdio: 'pipe' }); }
  catch (error) { console.error(`❌ ${f} 语法失败`); process.exitCode = 1; }
}
