// 给所有 stdio MCP 服务器加一段"stdin 关闭就退出"的兜底。幂等，可重复跑。
//
// 为什么：DSH 换代会关掉这些子进程的 stdin，但 MCP SDK 不保证因此退出 ——
// 实测（2026-09-28）killed 旧的 mcp-snowluma-safe 让 DSH 重新拉起之后，
// 会同时存在两个空闲进程；热重载几次就越攒越多。这些服务器都没有后台工作，
// stdin 一断干净退出最合适。
//
// ⚠️ 必须用 `globalThis.process?.…` 而不是裸 `process`：审计测试
//   （scripts/test-audit-security-mcp.mjs）会在**没有 process 的 vm 沙箱**里
//   加载 mcp-web-search-safe.js —— 裸 process 会直接 ReferenceError，
//   整套离线审计当场变红（第一次加守卫时就踩了）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const MARK = 'stdin 一断就干净退出';
const ANCHOR = 'await server.connect(new StdioServerTransport());';

const GUARD = `// DSH 换代时关掉 stdin（热重载/重启）时，MCP SDK 不保证本进程会退出，
// 会留下空闲僵尸进程（实测热重载一次就有两个）。stdin 一断就干净退出。
// 用 globalThis 取 process：审计测试会在没有 process 的 vm 沙箱里加载本文件。
const exitOnStdinClose = () => { try { globalThis.process?.exit(0); } catch {} };
globalThis.process?.stdin?.on?.('end', exitOnStdinClose);
globalThis.process?.stdin?.on?.('close', exitOnStdinClose);
// 注意：**不要**在这里 process.stdin.resume() —— 那会提前进入 flowing 模式，
// 把客户端刚发出的 initialize 请求吞掉（StdioServerTransport 自己去读 stdin）。

`;

// 早期版本（裸 process）的写法，用来原地升级
const OLD_START = '// DSH 换代时关掉 stdin';
const OLD_END = 'StdioServerTransport 自己去读 stdin）。\n\n';

const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /^mcp-.*\.js$/.test(f));
let added = 0;
let upgraded = 0;
let skipped = 0;
for (const f of files) {
  const p = path.join(ROOT, 'src', f);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('globalThis.process?.stdin')) { console.log(`= 已是新写法，跳过：${f}`); skipped++; continue; }
  const at = s.indexOf(OLD_START);
  if (at >= 0 && s.includes(MARK)) {
    const end = s.indexOf(OLD_END, at);
    if (end < 0) { console.log(`? 旧守卫块没找到结尾，跳过：${f}`); skipped++; continue; }
    s = s.slice(0, at) + GUARD + s.slice(end + OLD_END.length);
    fs.writeFileSync(p, s, 'utf8');
    console.log(`⬆️  已升级为新写法：${f}`);
    upgraded++;
    continue;
  }
  const anchorAt = s.lastIndexOf(ANCHOR);
  if (anchorAt < 0) { console.log(`? 找不到 connect 锚点，跳过：${f}`); skipped++; continue; }
  s = s.slice(0, anchorAt) + GUARD + s.slice(anchorAt);
  fs.writeFileSync(p, s, 'utf8');
  console.log(`✅ 已加守卫：${f}`);
  added++;
}
console.log(`\n完成：新增 ${added} 个，升级 ${upgraded} 个，跳过 ${skipped} 个`);
