// 用完整参数打 5E gate 接口，试图不用 token 拿到数据；并找玩家搜索/资料接口。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://gate.5eplay.com/crane/http/api/data';

const call = async (endpoint, params = {}, opts = {}) => {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://view-arena.5eplay.com/',
        Accept: 'application/json, text/plain, */*',
        ...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {})
      },
      signal: AbortSignal.timeout(20000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

const show = (label, r) => {
  console.log(`  ${String(r.status).padEnd(4)} ${label}`);
  console.log(`       ${r.text.replace(/\s+/g, ' ').slice(0, 230)}`);
};

// 1) match/list 完整参数（uuid 用占位）
const full = {
  match_type: -1,
  page: 1,
  date: 0,
  start_time: 1729699200,
  end_time: Math.floor(Date.now() / 1000),
  uuid: '00000000-0000-0000-0000-000000000000',
  limit: 5,
  cs_type: 0
};
console.log('=== match/list 完整参数（uuid 占位，不带 token）===');
show('match/list 全参数', await call('match/list', full));

// 2) 少一个参数对照
console.log('\n=== 逐项去掉参数，看哪个是必需的 ===');
for (const drop of ['cs_type', 'uuid', 'date', 'match_type']) {
  const p = { ...full };
  delete p[drop];
  const r = await call('match/list', p);
  let brief = '';
  try {
    const j = JSON.parse(r.text);
    brief = `code=${j.code} msg=${j.message}`;
  } catch {}
  console.log(`  去掉 ${drop.padEnd(11)} → ${r.status} ${brief}`);
}

// 3) 探玩家相关接口
console.log('\n=== 探玩家搜索/资料接口 ===');
for (const ep of [
  'player/search',
  'search/player',
  'player/get',
  'account/info',
  'user/search',
  'player/card',
  'player/season',
  'rank/info',
  'match/detail'
]) {
  const r = await call(ep, { keyword: 'test', page: 1, limit: 5 });
  if (r.status !== 404) show(ep, r);
  else console.log(`  404  ${ep}`);
}
