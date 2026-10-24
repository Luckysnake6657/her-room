// 找 5E 的"按名字查玩家"接口（拿到 uuid 就能查战绩）。
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
        Accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(15000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 常见命名 + 常见参数名，两两组合
const endpoints = [
  'search', 'search/user', 'search/player', 'search/all', 'search/keyword',
  'player/search', 'player/list', 'player/info', 'player/detail', 'player/card',
  'user/search', 'user/list', 'user/info', 'user/detail',
  'account/search', 'rank/search', 'season/list', 'player/season', 'match/list'
];
const paramsets = [
  { keyword: 'test', page: 1, limit: 5 },
  { keyword: 'test', page: 1 },
  { query: 'test', page: 1, limit: 5 },
  { name: 'test', page: 1, limit: 5 },
  { search_key: 'test', page: 1, limit: 5 }
];

const interesting = [];
for (const ep of endpoints) {
  for (const ps of paramsets) {
    const r = await call(ep, ps);
    if (r.status === 404) continue;
    let msg = r.text.replace(/\s+/g, ' ').slice(0, 150);
    // 只记下"不是纯参数错误"的（说明接口认了这组参数）
    const isParamErr = /参数错误|uuid不能为空|不能为空/.test(r.text);
    interesting.push({ ep, ps: Object.keys(ps).join(','), status: r.status, isParamErr, msg });
    break; // 同接口只试第一个不 404 的参数组合
  }
}

console.log('=== 存在的接口（按是否有用排序）===');
interesting
  .sort((a, b) => Number(a.isParamErr) - Number(b.isParamErr))
  .forEach((x) => {
    const tag = x.isParamErr ? '参数不足' : '★ 可能可用';
    console.log(`  ${tag.padEnd(10)} ${x.ep.padEnd(18)} [${x.ps}] ${x.status}`);
    console.log(`      ${x.msg}`);
  });
