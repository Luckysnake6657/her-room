// 复现：用群主的两条消息，看模块的 resolveSteamId 到底选了谁
import { spawn } from 'node:child_process';
const child = spawn('node', ['src/mcp-cs-wmpvp-stats.js'], { cwd: 'D:/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } } catch {}
  }
});
let id = 1;
const send = (method, params) => new Promise((res) => {
  const i = id++; const p = new Promise((r) => pending.set(i, r));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  Promise.race([p, new Promise((r) => setTimeout(() => r({}), 90000))]).then(res);
});
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  try { return JSON.parse(r.result?.content?.[0]?.text ?? '{}'); } catch { return {}; }
};

console.log('=== search_wmpvp_player("今晚吃兔兔")：看精确匹配排第几 ===');
const s1 = await call('query', { action: 'search_wmpvp_player', keyword: '今晚吃兔兔' });
console.log(`  total=${s1.total}`);
(s1.results || []).slice(0, 6).forEach((u, i) => {
  console.log(`  [${i}] ${u.nickname}  steamId=${u.steamId}`);
});
const exactIdx = (s1.results || []).findIndex((u) => u.nickname === '今晚吃兔兔');
console.log(`  「今晚吃兔兔」精确匹配在第 ${exactIdx} 位（0 起）`);

console.log('\n=== 🔴 关键：get_wmpvp_player_stats("今晚吃兔兔") 会解析成谁？ ===');
const a = await call('query', { action: 'get_wmpvp_player_stats', player: '今晚吃兔兔' });
console.log(`  player=${a.player}  解析方式=${a.解析方式}  steamId=${a.steamId}`);
if (a.赛季统计) console.log(`  昵称=${a.赛季统计.昵称} 赛季=${a.赛季统计.赛季} 场次=${a.赛季统计.赛季场次}`);
if (a.需要确认) console.log('  ⚠️ 要求确认: ' + a.需要确认);

console.log('\n=== get_wmpvp_player_stats("今晚第一个吃兔兔") ===');
const b = await call('query', { action: 'get_wmpvp_player_stats', player: '今晚第一个吃兔兔' });
console.log(`  player=${b.player} 解析方式=${b.解析方式} steamId=${b.steamId}`);
if (b.赛季统计) console.log(`  昵称=${b.赛季统计.昵称} 赛季=${b.赛季统计.赛季} 场次=${b.赛季统计.赛季场次}`);
if (b.需要确认) console.log('  ⚠️ 要求确认: ' + b.需要确认);

console.log('\n=== 上赛季 S24 对比（两个号）===');
for (const kw of ['今晚吃兔兔', '今晚第一个吃兔兔']) {
  const r = await call('query', { action: 'get_wmpvp_player_stats', player: kw, season: 'S24' });
  console.log(`  「${kw}」→ steamId=${r.steamId} 昵称=${r.赛季统计?.昵称} S24场次=${r.赛季统计?.赛季场次} 段位分=${r.赛季统计?.段位分}`);
}

console.log('\n=== last_match + season（群主最后那条问的）===');
for (const kw of ['今晚吃兔兔', '今晚第一个吃兔兔']) {
  const r = await call('query', { action: 'get_wmpvp_last_match', player: kw, season: 'S24' });
  console.log(`  「${kw}」→ steamId=${r.steamId} 最近一把=${JSON.stringify(r.最近一把 || r.该赛季最后一把)}`);
}

child.kill();
process.exit(0);
