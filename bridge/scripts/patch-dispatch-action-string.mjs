// action 参数从 z.enum(短名) 改成 z.string()。
//
// 为什么：z.enum 会在 **MCP SDK 层**就把不在枚举里的值拒掉（"Invalid option: expected one of…"），
// 于是"旧工具全名当别名"这条退路根本走不到我们自己的 handler —— 实测
// test-mcp-wmpvp-all.mjs 全线报 -32602。改成 z.string() 后：
//   ① 别名能进 handler 再解析；② schema 少一份枚举（更省 token）；
//   ③ 合法值本来就在工具描述里逐条列着，写错会收到"未知 action，可用：…"的明确报错。
// 幂等。用法：node scripts/patch-dispatch-action-string.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FILES = ['mcp-ow-stats.js', 'mcp-ow-cn-stats.js', 'mcp-cs-5e-stats.js', 'mcp-cs-wmpvp-stats.js'];
const OLD = "const dispatchShape = { action: z.enum(actionNames).describe('要执行哪个查询（见上方描述里的清单）') };";
const NEW = `// action 用 z.string() 而不是 z.enum(actionNames)：z.enum 会在 SDK 层就把"旧工具全名"
// 这种别名拒掉（Invalid option），轮不到我们的 handler 去解析别名。合法值在工具描述里
// 逐条列着，写错会收到"未知 action，可用：…"。
const dispatchShape = { action: z.string().describe('要执行哪个查询；可选值见工具描述里的 action 清单') };`;

let changed = 0;
for (const f of FILES) {
  const p = path.join(ROOT, 'src', f);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('z.string().describe(\'要执行哪个查询')) { console.log(`= 已是 string，跳过：${f}`); continue; }
  if (!s.includes(OLD)) { console.error(`❌ 找不到 dispatchShape 行：${f}`); process.exitCode = 1; continue; }
  s = s.replace(OLD, NEW);
  fs.writeFileSync(p, s, 'utf8');
  console.log(`✅ 已改为 z.string()：${f}`);
  changed++;
}
console.log(`\n完成：改了 ${changed} 个文件`);
for (const f of FILES) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', f)], { stdio: 'pipe' }); }
  catch { console.error(`❌ ${f} 语法失败`); process.exitCode = 1; }
}
