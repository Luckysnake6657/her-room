// 实测完美竞技平台 client.wmpvp.com 的玩家接口。
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

const show = (label, r) => {
  console.log(`  ${String(r.status).padEnd(4)} ${label}`);
  console.log(`       ${r.text.replace(/\s+/g, ' ').slice(0, 260)}`);
};

console.log('=== 1) 探 client.wmpvp.com 基础可达性 ===');
for (const u of [
  'https://client.wmpvp.com/',
  'https://client.wmpvp.com/api',
  'https://client.wmpvp.com/client/player/commonRankList',
  'https://pvp.wanmei.com/api/client/player/commonRankList',
  'https://pvp.wanmei.com/client/player/commonRankList'
]) {
  show(u, await call(u));
}

console.log('\n=== 2) 带参数试玩家接口 ===');
const tries = [
  'https://client.wmpvp.com/client/player/commonRankList?seasonId=1&page=1&limit=5',
  'https://client.wmpvp.com/client/player/commonRankList?page=1&size=5',
  'https://client.wmpvp.com/user-info/season-list',
  'https://client.wmpvp.com/client/match/season',
  'https://client.wmpvp.com/api/client/player/commonRankList'
];
for (const u of tries) show(u, await call(u));

console.log('\n=== 3) 试 POST（很多接口只收 POST）===');
for (const p of ['/client/player/commonRankList', '/client/match/season', '/user-info/season-list']) {
  show('POST ' + p, await call(`https://client.wmpvp.com${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 1, size: 5, seasonId: 1 })
  }));
}
