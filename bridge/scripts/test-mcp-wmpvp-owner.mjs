// 验证 SteamID64 字符串传参修复：用群主那个号（...869，昵称"今晚第一个吃兔兔"）
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

const SID = '76561199185773869';
console.log('=== 群主的号（...869 今晚第一个吃兔兔）===\n');

const s = await call('query', { action: 'get_wmpvp_player_stats', player: SID });
console.log('[赛季统计] ' + JSON.stringify({ 昵称: s.赛季统计?.昵称, 赛季: s.赛季统计?.赛季, 场次: s.赛季统计?.赛季场次, 段位分: s.赛季统计?.段位分 }));
if (s.说明) console.log('  说明: ' + s.说明);

console.log('\n[历史赛季扫描]');
const h = await call('query', { action: 'get_wmpvp_player_season_history', player: SID, fromSeason: 19, toSeason: 25 });
console.log('  扫描范围: ' + h.扫描范围);
if (h.已忽略的幽灵赛季) console.log('  幽灵赛季: ' + h.已忽略的幽灵赛季);
if (h.各赛季?.length) {
  for (const r of h.各赛季) console.log(`    ${r.赛季}: ${r.场次}场 段位分=${r.段位分} KD=${r.KD} 评分=${r.完美Rating} 胜率=${r.胜率}`);
  console.log('  汇总: ' + JSON.stringify(h.汇总?.段位分最高) + ' | ' + JSON.stringify(h.汇总?.场次最多));
} else {
  console.log('  ' + (h.说明2 || JSON.stringify(h).slice(0, 150)));
}

console.log('\n[最近一把]');
const l = await call('query', { action: 'get_wmpvp_last_match', player: SID });
if (l.最近一把) console.log('  ' + JSON.stringify(l.最近一把));
else console.log('  ' + (l.说明 || ''));

console.log('\n[上赛季 S24 最后一把]');
const l24 = await call('query', { action: 'get_wmpvp_last_match', player: SID, season: 'S24' });
console.log('  ' + JSON.stringify(l24.该赛季最后一把));
console.log('  该赛季: ' + l24.赛季 + ' 场次=' + l24.该赛季场次 + ' 段位分=' + l24.该赛季段位分 + ' 评价=' + l24.该赛季评价);
if (l24.该赛季地图明细) console.log('  地图明细: ' + JSON.stringify(l24.该赛季地图明细));
if (l24.该赛季全部场次) console.log('  全部场次: ' + l24.该赛季全部场次.map((x) => x.时间 + '(' + x.段位分 + ')').join(' | '));

console.log('\n[今日昨日]');
const d = await call('query', { action: 'get_wmpvp_daily_summary', player: SID });
for (const x of d.总结 || []) console.log(`  ${x.日期}: 场次=${x.场次} ${x.胜负 || x.说明 || ''}`);

console.log('\n[用昵称搜 → 再查（验证昵称路径）]');
const sr = await call('query', { action: 'search_wmpvp_player', keyword: '今晚第一个吃兔兔' });
const hit = (sr.results || []).find((u) => u.steamId === SID);
console.log('  搜到: ' + JSON.stringify(hit));
if (hit) {
  const s2 = await call('query', { action: 'get_wmpvp_player_stats', player: '今晚第一个吃兔兔' });
  console.log('  按昵称查 → 昵称=' + s2.赛季统计?.昵称 + ' steamId=' + s2.steamId + ' 场次=' + s2.赛季统计?.赛季场次);
}

child.kill();
process.exit(0);
