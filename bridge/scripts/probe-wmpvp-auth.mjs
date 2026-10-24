// 细探 pvpMapStats：无认证时对不同 steamId / 赛季 的表现，判断是否需要凭据。
const UA =
  'Mozilla/5.0 (Linux; Android 9; INE-AL00 Build/HUAWEIINE-AL00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046141 Mobile Safari/537.36 EsportsApp Version=2.3.28.105';

const call = async (url, opts = {}) => {
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://pvp.wanmei.com',
        Referer: 'https://pvp.wanmei.com/',
        'platform': 'h5_android',
        'User-Agent': opts.ua || UA,
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

const IDS = ['76561197960435530', '76561198084749846', '76561197960287930'];

console.log('=== pvpMapStats：不同 season 参数 ===');
for (const season of ['S11', 'S12', 'S10', '', '11']) {
  for (const id of IDS.slice(0, 1)) {
    const u = `https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=${id}${season ? `&csgoSeasonId=${season}` : ''}`;
    const r = await call(u);
    console.log(`  season=${season || '(空)'}  ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

console.log('\n=== pvpDetailDataStats：加 device 头（无 token）===');
const r1 = await call('https://api.wmpvp.com/api/v2/csgo/pvpDetailDataStats', {
  method: 'POST',
  headers: { 'content-type': 'application/json', device: 'test-device-1234' },
  body: JSON.stringify({ steamId64: IDS[0], csgoSeasonId: '' })
});
console.log('  ' + r1.text.replace(/\s+/g, ' ').slice(0, 300));

console.log('\n=== pvpDetailDataStats：加假 accessToken ===');
const r2 = await call('https://api.wmpvp.com/api/v2/csgo/pvpDetailDataStats', {
  method: 'POST',
  headers: { 'content-type': 'application/json', device: 'test-device-1234', accessToken: 'fake-token-test' },
  body: JSON.stringify({ steamId64: IDS[0], csgoSeasonId: '' })
});
console.log('  ' + r2.text.replace(/\s+/g, ' ').slice(0, 300));

console.log('\n=== 试「按名字/昵称」的接口 ===');
for (const p of [
  '/api/v2/csgo/searchPlayer',
  '/api/v2/csgo/player',
  '/api/v2/csgo/playerSearch',
  '/api/v2/csgo/getPlayerInfo'
]) {
  const r = await call(`https://api.wmpvp.com${p}?keyword=test`);
  console.log(`  ${r.status} ${p}  ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
}
