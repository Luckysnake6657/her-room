// 热重载一个由 DSH 托管的 MCP 服务器（改完 src/mcp-*.js 之后不用重启整个 DSH）。
//
// 原理：DSH 的 dsh-mcp-client 默认开着断线重连（enabled=true, maxAttempts=10,
// initialDelayMs=500）——把它的子进程结束掉，它会用**磁盘上的新代码**重新拉起。
// 实测 2026-09-28：合并出 qq_read_file 之后这样操作，工具面立刻变成新的，
// 完全不用重启 DSH（也就不会踢掉正在用的 Web GUI 会话）。
//
// 用法：
//   node scripts/reload-mcp.mjs                # 默认重载 snowluma（qq_* 那一套）
//   node scripts/reload-mcp.mjs ow-stats       # 重载指定的那个
//   node scripts/reload-mcp.mjs --list         # 只列出当前在跑的 MCP 进程
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = (args.find((a) => !a.startsWith('--')) ?? 'snowluma-safe').replace(/^mcp-/, '').replace(/\.js$/, '');
const pattern = `mcp-${name}`;

function procs() {
  // ⚠️ 过滤必须**精确到"命令行以这个脚本结尾"**：曾经用宽匹配 `-match 'mcp-snowluma-safe'`，
  //    结果把"正在跑这条查询命令的 node（DSH 的 subprocess runner，命令行里带着这个字符串）"
  //    也匹配上了，然后 taskkill 把自己的执行器杀了 —— 症状是
  //    「Windows Job runner exited with exit code 4294967295 before proving its managed range empty」。
  //    所以：脚本路径必须在**结尾**，且排除 runner/查询命令自身。
  const ps = [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `
    + `$_.CommandLine -match 'src[\\\\/]${pattern}\\.js"?\\s*$' -and `
    + `$_.CommandLine -notmatch 'subprocess-local|runner\\.js|Get-CimInstance|powershell' `
    + `} | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress`,
  ];
  const out = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  if (!out) return [];
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j : [j]).map((p) => ({
    pid: p.ProcessId, ppid: p.ParentProcessId,
    // CreationDate 是 /Date(ms)/ 形式
    started: Number(String(p.CreationDate).replace(/[^0-9]/g, '')) || 0,
  }));
}

const before = procs();
console.log(`匹配 ${pattern} 的 MCP 进程：${before.length ? before.map((p) => `${p.pid}(父 ${p.ppid})`).join(', ') : '（没有）'}`);

/**
 * ★ 顺带体检：**别的** MCP 服务器有没有"源码比进程新"（= 跑着旧代码）的情况。
 *
 * 为什么必须查（2026-10-10 真踩了）：我给 `web_fetch` 加了 offset 分页，只重载了 snowluma 那套
 * （这个脚本的默认目标），`web-search-safe` 还跑着旧代码 —— 她传 offset 被静默忽略、结果里也没有
 * nextOffset，而"工具名在不在"那类检查完全看不出来。她只能靠"试了发现没用"来报告。
 *
 * 只**报告**不自动重载：重载会掐掉正在跑的调用，该不该重载由人决定（也可能你改的是别的服务）。
 */
{
  // 一次查出所有 MCP 进程（按脚本名分组），再和各自源码 mtime 比
  const ps = [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `
    + `$_.CommandLine -match 'src[\\\\/]mcp-[a-z0-9-]+\\.js"?\\s*$' -and `
    + `$_.CommandLine -notmatch 'subprocess-local|runner\\.js|Get-CimInstance|powershell' `
    + `} | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
  ];
  let rows = [];
  try {
    const out = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
    if (out) { const j = JSON.parse(out); rows = Array.isArray(j) ? j : [j]; }
  } catch { rows = []; }
  const stale = [];
  for (const r of rows) {
    const m = /src[\\/](mcp-[a-z0-9-]+)\.js/.exec(String(r.CommandLine ?? ''));
    if (!m) continue;
    const file = path.join(ROOT, 'src', `${m[1]}.js`);
    const started = Number(String(r.CreationDate).replace(/[^0-9]/g, '')) || 0;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (mtime > started + 2000) stale.push(`${m[1]}（源码 ${new Date(mtime).toLocaleTimeString('zh-CN')} 比进程 ${new Date(started).toLocaleTimeString('zh-CN')} 新）`);
    // safe-fetch.js 这类**被引用**的文件也算：改了它，所有用到它的 MCP 都得重载
    for (const dep of ['safe-fetch.js', 'emotion-net.js']) {
      const depFile = path.join(ROOT, 'src', dep);
      let depM = 0;
      try { depM = fs.statSync(depFile).mtimeMs; } catch { continue; }
      if (depM > started + 2000 && new RegExp(dep.replace('.js', '')).test(fs.readFileSync(file, 'utf8'))) {
        stale.push(`${m[1]}（依赖 ${dep} 改过，比进程新）`);
      }
    }
  }
  const uniq = [...new Set(stale)];
  if (uniq.length) {
    console.log(`\n⚠️ 还有 MCP 跑着**旧代码**（改了没重载）：\n   - ${uniq.join('\n   - ')}`);
    console.log('   重载：node scripts/reload-mcp.mjs <名字>（不带参数只重载 snowluma-safe！）');
  }
}
if (args.includes('--list')) process.exit(0);
if (!before.length) {
  console.error(`\n❌ 没找到 ${pattern} 的进程。若它确实应该由 DSH 托管，说明这个 MCP 没起起来 —— 看 ~/.dsh 下的日志，或重启 DSH。`);
  process.exit(1);
}

for (const p of before) {
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); console.log(`已结束 PID ${p.pid}`); }
  catch { console.log(`结束 PID ${p.pid} 失败（可能已退出）`); }
}

// 等 DSH 用新代码拉起来（默认 500ms 起退避重试，最多 10 次）
let after = [];
const deadline = Date.now() + 40_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  after = procs().filter((p) => p.started > (before[0]?.started ?? 0) && !before.some((b) => b.pid === p.pid));
  if (after.length) break;
}
if (!after.length) {
  console.error('\n❌ DSH 没有把它重新拉起来（重连可能被关掉了）。需要重启 DSH 才能生效。');
  process.exit(1);
}
console.log(`\n✅ DSH 已用新代码重新拉起：${after.map((p) => `${p.pid}(父 ${p.ppid})`).join(', ')}`);
if (after.length > 1) {
  console.log(`⚠️ 同时有 ${after.length} 个进程：DSH 的重连不会回收旧的那一代，会多留一个**空闲**进程`);
  console.log('   （这些 MCP 服务器没有定时任务，只是占几十 MB 内存；DSH 重启会清掉）');
}

// 顺手验证"她实际拿到的工具面"是不是新的
const probe = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-dsh-v2-wait.mjs')], { cwd: ROOT, encoding: 'utf8' });
const tail = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n');
console.log('\n--- 工具面验证（test-dsh-v2-wait）---');
console.log(tail);
process.exit(probe.status === 0 ? 0 : 1);
