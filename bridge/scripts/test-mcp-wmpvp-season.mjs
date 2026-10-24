// 用真正的 MCP stdio 协议测 mcp-cs-wmpvp-stats 的新工具
import { spawn } from 'node:child_process';

const child = spawn('node', ['src/mcp-cs-wmpvp-stats.js'], { cwd: 'D:/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  // 这个 SDK 版本的 stdio 传输是 NDJSON（每行一个 JSON-RPC 消息）
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '').trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s && !/ExperimentalWarning|--trace-warnings/.test(s)) console.log('[stderr] ' + s.slice(0, 200));
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 90000);
  });

const notify = (method, params) => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
};

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
notify('notifications/initialized', {});

const tools = await send('tools/list', {});
console.log('=== 已注册工具 ===');
for (const t of tools.result.tools) {
  const props = Object.keys(t.inputSchema?.properties || {});
  console.log(`  ${t.name}(${props.join(', ')})`);
}

const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  return txt;
};

const MINE = '76561199185773869';
const OLD = '76561198986349250';

console.log('\n=== 测试1: 指定上赛季 S24（你的号，应为空）===');
console.log((await call('query', { action: 'get_wmpvp_player_stats', player: MINE, season: 'S24' })).slice(0, 700));

console.log('\n=== 测试2: 指定 S24（旧号，应有 77 场）===');
const t2 = await call('query', { action: 'get_wmpvp_player_stats', player: OLD, season: 24 });
console.log(t2.slice(0, 900));

console.log('\n=== 测试3: 赛季参数写错（应给提示）===');
console.log((await call('query', { action: 'get_wmpvp_player_stats', player: OLD, season: '去年' })).slice(0, 400));

console.log('\n=== 测试4: 历史赛季扫描（旧号）===');
const t4 = await call('query', { action: 'get_wmpvp_player_season_history', player: OLD });
const j4 = JSON.parse(t4);
console.log('  扫描范围: ' + j4.扫描范围);
console.log('  汇总: ' + JSON.stringify(j4.汇总, null, 2).slice(0, 900));
console.log('  各赛季行数: ' + (j4.各赛季 || []).length);
console.log('  前 3 行: ' + JSON.stringify((j4.各赛季 || []).slice(0, 3)));

console.log('\n=== 测试5: 历史扫描（你的号，应为空）===');
const t5 = JSON.parse(await call('query', { action: 'get_wmpvp_player_season_history', player: MINE }));
console.log('  ' + JSON.stringify({ 扫描范围: t5.扫描范围, 说明2: t5.说明2, 汇总: t5.汇总 }));

child.kill();
process.exit(0);
