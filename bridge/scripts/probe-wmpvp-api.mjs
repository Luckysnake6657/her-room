// 实测完美平台 api.wmpvp.com 的玩家接口（无认证的那些）。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const call = async (url, opts = {}) => {
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Origin: 'https://pvp.wanmei.com',
        Referer: 'https://pvp.wanmei.com/',
        ...(opts.headers || {})
      },
      body: opts.body,
      signal: AbortSignal.timeout(22000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

const show = (label, r, max = 600) =>
  console.log(`  ${String(r.status).padEnd(4)} ${label}\n       ${r.text.replace(/\s+/g, ' ').slice(0, max)}\n`);

// 用一个已知的 SteamID64（ropz 的，来自 5E 那条链路：76561197960435530）
const ID = '76561197960435530';

console.log('=== 1) pvpMapStats（无认证）===');
for (const url of [
  `https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=${ID}&csgoSeasonId=S11`,
  `https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=${ID}`,
  'https://api.wmpvp.com/api/v2/csgo/pvpMapStats'
]) {
  show(url.replace('https://api.wmpvp.com', ''), await call(url));
}

console.log('=== 2) pvpDetailDataStats（需要 token，看无 token 会怎样）===');
show('GET 无 token', await call('https://api.wmpvp.com/api/v2/csgo/pvpDetailDataStats'));
show('POST 无 token', await call('https://api.wmpvp.com/api/v2/csgo/pvpDetailDataStats', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ steamId64: ID, csgoSeasonId: 'S11' })
}));

console.log('=== 3) 封禁统计（无认证）===');
show('/user-info/forbid-stats', await call('https://pvp.wanmei.com/user-info/forbid-stats?game_abbr_list=PVP,CSGO'));

console.log('=== 4) 探其它可能的玩家接口 ===');
for (const p of [
  '/api/v2/csgo/playerInfo',
  '/api/v2/csgo/pvpDataStats',
  '/api/v2/csgo/season',
  '/api/v2/csgo/rank',
  '/api/v1/csgo/pvpMapStats'
]) {
  show(p, await call('https://api.wmpvp.com' + p + `?steamId64=${ID}`), 200);
}
