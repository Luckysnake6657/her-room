// 完美模块全套回归测试：6 个工具，走真 MCP stdio 协议
import { spawn } from 'node:child_process';

const child = spawn('node', ['src/mcp-cs-wmpvp-stats.js'], { cwd: 'D:/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s && !/ExperimentalWarning|trace-warnings/.test(s)) console.log('[stderr] ' + s.slice(0, 200));
});
let id = 1;
const send = (method, params) => new Promise((res, rej) => {
  const i = id++; pending.set(i, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 90000);
});
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n');

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
notify('notifications/initialized', {});

const tools = await send('tools/list', {});
console.log(`=== 已注册 ${tools.result.tools.length} 个工具 ===`);
for (const t of tools.result.tools) console.log(`  ${t.name}(${Object.keys(t.inputSchema?.properties || {}).join(', ')})`);

const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r);
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
};

const OLD = '76561198986349250';
const MINE = '76561199185773869';
let pass = 0, fail = 0;
const chk = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
};

console.log('\n=== 1. get_wmpvp_player_matches（修复 data.matchList 后应不再返回 0 场）===');
const t1 = await call('query', { action: 'get_wmpvp_player_matches', player: OLD, limit: 10 });
chk('返回了对局', Array.isArray(t1.对局) && t1.对局.length > 0, `条数=${t1.对局?.length}`);
if (t1.对局?.[0]) console.log('    首条: ' + JSON.stringify(t1.对局[0]));

console.log('\n=== 2. get_wmpvp_last_match（最近一把）===');
const t2 = await call('query', { action: 'get_wmpvp_last_match', player: OLD });
chk('有最近一把数据', !!t2.最近一把, JSON.stringify(t2.最近一把));
chk('含地图/比分/KDA/结果', !!(t2.最近一把?.地图 && t2.最近一把?.比分 && t2.最近一把?.结果 !== undefined));
chk('结果只能是胜或负', ['胜', '负'].includes(t2.最近一把?.结果));

console.log('\n=== 3. get_wmpvp_daily_summary（今日昨日）===');
const t3 = await call('query', { action: 'get_wmpvp_daily_summary', player: OLD });
chk('返回了总结数组', Array.isArray(t3.总结) && t3.总结.length === 2, `条数=${t3.总结?.length}`);
for (const s of t3.总结 || []) {
  console.log(`    ${s.日期}: 场次=${s.场次}${s.场次 ? ` 胜负=${s.胜负} 总KDA=${s.总KDA} 平均Rating=${s.平均Rating}` : ' ' + (s.说明 || '')}`);
}
chk('含"今天"和"昨天"标签', JSON.stringify(t3.总结 || []).includes('今天') && JSON.stringify(t3.总结 || []).includes('昨天'));
chk('有数据覆盖范围提示', !!t3.数据覆盖到, t3.数据覆盖到 || '');
chk('有 10 场上限说明', !!t3.说明);

console.log('\n=== 4. 查另一个号（本赛季没打，应干净地报空）===');
const t4m = await call('query', { action: 'get_wmpvp_last_match', player: MINE });
chk('无对局时给说明而非报错', !!t4m.说明, t4m.说明 || JSON.stringify(t4m).slice(0, 120));
const t4d = await call('query', { action: 'get_wmpvp_daily_summary', player: MINE });
chk('日总结也能干净报空', Array.isArray(t4d.总结) && (t4d.总结[0].场次 === 0));

console.log('\n=== 5. 回归：赛季相关工具仍正常 ===');
const t5a = await call('query', { action: 'get_wmpvp_player_stats', player: OLD, season: 'S23' });
chk('S23 段位分 1766', t5a.赛季统计?.段位分 === '1766', `实际=${t5a.赛季统计?.段位分}`);
const t5b = await call('query', { action: 'get_wmpvp_player_season_history', player: OLD, fromSeason: 20, toSeason: 26 });
chk('扫描 7 个赛季(20~26)', t5b.扫描范围?.includes('S20 ~ S26'), t5b.扫描范围);
chk('剔除幽灵赛季', Array.isArray(t5b.各赛季) && t5b.各赛季.every((x) => Number(x.赛季.slice(1)) <= Number((t5b.当前赛季 || 'S25').slice(1))), `当前=${t5b.当前赛季}`);
chk('段位分最高有值', !!t5b.汇总?.段位分最高, t5b.汇总?.段位分最高);

console.log('\n=== 6. 回归：搜索 ==');
const t6 = await call('query', { action: 'search_wmpvp_player', keyword: 'ropz' });
chk('搜索有结果', (t6.total || 0) > 0, `total=${t6.total}`);

console.log(`\n=========== 通过 ${pass} / 失败 ${fail} ===========`);
child.kill();
process.exit(fail ? 1 : 0);
