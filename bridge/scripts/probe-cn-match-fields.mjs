// 探查 dashen-match 返回的字段结构，找时间戳字段（用于"只保留今天/昨天"）。
const BASE = 'http://127.0.0.1:18080';
const PLAYER = process.argv[2] || '随缘居士#5729';

const r = await fetch(`${BASE}/api/v2/dashen-match`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bnet_id: PLAYER }),
  signal: AbortSignal.timeout(120000),
});
const j = await r.json();

console.log('顶层键:', Object.keys(j).join(', '));
const list = j.matches || j.list || j.data || [];
console.log('列表长度:', Array.isArray(list) ? list.length : typeof list);

if (Array.isArray(list) && list.length) {
  const m0 = list[0];
  console.log('\n=== 第一条全部标量字段 ===');
  for (const [k, v] of Object.entries(m0)) {
    if (v !== null && typeof v === 'object') {
      console.log(`  ${k}: <${Array.isArray(v) ? 'array' : 'object'}> ${JSON.stringify(v).slice(0, 200)}`);
    } else {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
  }

  console.log('\n=== 疑似时间字段（全表扫描第一条）===');
  const s = JSON.stringify(m0);
  for (const k of ['ts', 'time', 'date', 'matchTime', 'startTime', 'beginTs', 'startTs', 'endTs', 'timestamp']) {
    const m = s.match(new RegExp('"' + k + '"\\s*:\\s*[^,}]+'));
    if (m) console.log('  ' + m[0]);
  }

  // 如果拿到时间戳，换算一下看是不是今天
  const ts = m0.ts || m0.matchTime || m0.startTime || m0.beginTs;
  if (typeof ts === 'number' && ts > 1e12) {
    console.log('\n=== 前 8 条时间 ===');
    list.slice(0, 8).forEach((m, i) => {
      const t = m.ts || m.matchTime || m.startTime || m.beginTs;
      console.log(`  [${i}] ${t ? new Date(t).toLocaleString('zh-CN') : '(无时间)'}  ${m.instanceType || ''}  ${m.kill ?? '?'}/${m.death ?? '?'}/${m.assist ?? '?'}`);
    });
    const now = Date.now();
    const dayMs = 86400000;
    const todayStart = new Date().setHours(0, 0, 0, 0);
    console.log('\n今天0点 =', new Date(todayStart).toLocaleString('zh-CN'));
    console.log('今日场次 =', list.filter((m) => (m.ts || 0) >= todayStart).length);
    console.log('昨日场次 =', list.filter((m) => (m.ts || 0) >= todayStart - dayMs && (m.ts || 0) < todayStart).length);
  }
}
