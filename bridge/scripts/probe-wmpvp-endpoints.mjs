// 用"过期 token"当探针：返回 4001 = 端点存在；404 = 端点不存在
const DEAD = 'c08338203ea5f8ee5efb66aacc2dc710'; // 已知过期，但足以判存在性
const SID = 76561198986349250;

const req = async (url, body, extra = {}) => {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        token: DEAD,
        appversion: '3.5.4.172',
        platform: 'android',
        'User-Agent': 'okhttp/4.9.2',
        ...extra
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { status: r.status, code: j?.statusCode, msg: j?.errorMessage, raw: t.slice(0, 120) };
  } catch (e) {
    return { status: 0, code: null, msg: 'ERR ' + e.message, raw: '' };
  }
};

const PATHS = [
  '/api/csgo/home/pvp/detailStats',
  '/api/csgo/home/pvp/match/list',
  '/api/csgo/home/match/list',
  '/api/csgo/home/pvp/matchList',
  '/api/csgo/home/pvp/matchlist',
  '/api/csgo/home/matchList',
  '/api/csgo/home/pvp/match/detail',
  '/api/csgo/home/pvp/seasonStats',
  '/api/csgo/home/pvp/mapStats',
  '/api/csgo/home/pvp/pvpMapStats',
  '/api/v2/csgo/pvpMapStats',
  '/api/csgo/home/pvp/rank',
  '/api/csgo/home/pvp/rankInfo',
  '/api/csgo/home/pvp/history',
  '/api/csgo/home/user/info',
  '/api/csgo/home/pvp/data',
  '/api/csgo/home/pvp/index',
  '/api/csgo/home/pvp/summary',
  '/api/csgo/home/pvp/trend',
  '/api/csgo/home/pvp/highlights',
  '/api/csgo/home/pvp/weaponStats',
  '/api/csgo/home/pvp/rateOfFire'
];

console.log('=== POST api.wmpvp.com 端点存在性（4001=存在）===');
const alive = [];
for (const p of PATHS) {
  const r = await req('https://api.wmpvp.com' + p, { mySteamId: 0, toSteamId: SID, accessToken: '', page: 1, limit: 5 });
  const verdict = r.status === 404 ? '❌ 不存在' : r.code === 4001 ? '✅ 存在(需token)' : `⚠️ ${r.status} code=${r.code} ${r.msg || ''}`;
  console.log(`  ${verdict.padEnd(20)} ${p}`);
  if (r.status !== 404) alive.push({ p, r });
}

console.log('\n=== 存在端点的详细返回 ===');
for (const { p, r } of alive) {
  console.log(`  ${p}\n      status=${r.status} code=${r.code} msg=${r.msg}\n      ${r.raw}`);
}

console.log('\n=== GET 变体（pvpMapStats 等）===');
for (const u of [
  'https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=76561198986349250&csgoSeasonId=S11',
  'https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=76561198986349250&csgoSeasonId=S12',
  'https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=76561198986349250'
]) {
  try {
    const r = await fetch(u, { headers: { token: DEAD, appversion: '3.5.4.172', platform: 'android', 'User-Agent': 'okhttp/4.9.2' }, signal: AbortSignal.timeout(18000) });
    console.log(`  ${r.status}  ${u.slice(30)}\n      ${(await r.text()).slice(0, 200)}`);
  } catch (e) { console.log('  ERR ' + e.message); }
}
