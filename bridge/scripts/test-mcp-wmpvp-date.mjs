// 验证 date 参数（查已知有对局的某一天）
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

let pass = 0, fail = 0;
const chk = (l, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${l}${e ? ' — ' + e : ''}`); } else { fail++; console.log(`  ❌ ${l}${e ? ' — ' + e : ''}`); } };

console.log('=== date 参数：查 2026-08-29（已知 2 场，全胜）===');
const t = await call('query', { action: 'get_wmpvp_daily_summary', player: '76561198986349250', date: '2026-08-29' });
chk('返回一条总结', (t.总结 || []).length === 1);
const s = (t.总结 || [])[0] || {};
console.log('    ' + JSON.stringify({ 日期: s.日期, 场次: s.场次, 胜负: s.胜负, 胜率: s.胜率, 总KDA: s.总KDA, 平均Rating: s.平均Rating }));
chk('场次=2', s.场次 === 2, `实际 ${s.场次}`);
chk('2 胜 0 负', s.胜负 === '2 胜 0 负', `实际 ${s.胜负}`);
chk('总KDA=39/18/7', s.总KDA === '39/18/7', `实际 ${s.总KDA}`);
chk('平均Rating=1.73', s.平均Rating === 1.73, `实际 ${s.平均Rating}`);
chk('含对局明细', Array.isArray(s.对局) && s.对局.length === 2);
chk('最佳一场有值', !!s.最佳一场, JSON.stringify(s.最佳一场));

console.log('\n=== date 参数：查没对局的一天（应干净报空）===');
const t2 = await call('query', { action: 'get_wmpvp_daily_summary', player: '76561198986349250', date: '2026-09-01' });
const s2 = (t2.总结 || [])[0] || {};
chk('场次=0 且有说明', s2.场次 === 0 && !!s2.说明, s2.说明);

console.log('\n=== date 格式错误（应给提示不崩）===');
const t3 = await call('query', { action: 'get_wmpvp_daily_summary', player: '76561198986349250', date: '上个月' });
chk('给了参数错误提示', !!t3.参数有问题, t3.参数有问题);

console.log(`\n=========== 通过 ${pass} / 失败 ${fail} ===========`);
child.kill();
process.exit(fail ? 1 : 0);
