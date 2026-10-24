// 用 /api 前缀实测完美竞技平台的玩家接口。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://pvp.wanmei.com/api';

const call = async (path, opts = {}) => {
  try {
    const r = await fetch(BASE + path, {
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

const show = (label, r) =>
  console.log(`  ${String(r.status).padEnd(4)} ${label}\n       ${r.text.replace(/\s+/g, ' ').slice(0, 280)}`);

console.log('=== GET ===');
for (const p of [
  '/client/player/commonRankList',
  '/client/match/season',
  '/user-info/season-list',
  '/ranking/list-by-season',
  '/csgo/ranking.ladder',
  '/honor-user/list',
  '/user-info/forbid-stats'
]) {
  show(p, await call(p));
}

console.log('\n=== 带参数 ===');
for (const p of [
  '/client/player/commonRankList?page=1&limit=5',
  '/client/player/commonRankList?page=1&size=5&seasonId=1',
  '/ranking/list-by-season?seasonId=1&page=1&limit=5',
  '/client/match/season?seasonId=1'
]) {
  show(p, await call(p));
}

console.log('\n=== POST ===');
for (const p of ['/client/player/commonRankList', '/client/match/season', '/ranking/list-by-season']) {
  show('POST ' + p, await call(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 1, size: 5, seasonId: 1 })
  }));
}
