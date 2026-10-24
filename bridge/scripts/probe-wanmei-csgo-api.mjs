// 实测 www.csgo.com.cn 域下的玩家接口（完美 CS 平台）。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOST = 'https://www.csgo.com.cn';

const call = async (path, opts = {}) => {
  try {
    const r = await fetch(HOST + path, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.csgo.com.cn/',
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

const show = (label, r) =>
  console.log(`  ${String(r.status).padEnd(4)} ${label}\n       ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`);

console.log('=== 玩家/排行接口（csgo.com.cn）===');
for (const p of [
  '/client/player/commonRankList',
  '/client/player/commonRankList?page=1&size=5',
  '/client/match/season',
  '/client/match/season?seasonId=1',
  '/honor-user/list',
  '/user-info/season-list'
]) {
  show(p, await call(p));
}

console.log('\n=== 其它可能的玩家接口 ===');
for (const p of [
  '/api/client/player/commonRankList',
  '/csgo/player',
  '/csgo/ranking.ladder',
  '/player/info',
  '/api/player/info',
  '/data/player'
]) {
  show(p, await call(p));
}

console.log('\n=== data.wanmei.com（完美赛事数据中心）===');
for (const u of ['https://data.wanmei.com/', 'https://data.wanmei.com/api/', 'https://data.wanmei.com/player/']) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(18000) });
    const t2 = await r.text();
    console.log(`  ${String(r.status).padEnd(4)} ${u}  len=${t2.length}`);
    if (t2.length < 400) console.log(`       ${t2.replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`  ERR  ${u}  ${e.message}`);
  }
}
