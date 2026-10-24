// 验证 pvpMapStats 免认证路径能否拿到真实玩家数据。
// 关键：需要一个「确实在完美平台打过天梯」的玩家 steamId。
const UA =
  'Mozilla/5.0 (Linux; Android 9; INE-AL00 Build/HUAWEIINE-AL00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046141 Mobile Safari/537.36 EsportsApp Version=2.3.28.105';

const call = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { Accept: '*/*', 'User-Agent': UA, Origin: 'https://pvp.wanmei.com', Referer: 'https://pvp.wanmei.com/' },
      signal: AbortSignal.timeout(20000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 先用搜索拿几个「看起来是真实完美玩家」的 steamId（搜索命中的都是在完美注册过的）
const searchMany = async (kw) => {
  const r = await fetch('https://appengine.wmpvp.com/steamcn/app/search/user', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://client.wmpvp.com',
      Origin: 'https://news.wmpvp.com',
      'x-requested-with': 'XMLHttpRequest',
      'User-Agent': UA
    },
    body: JSON.stringify({ keyword: kw, page: 1 }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  return Array.isArray(j?.result) ? j.result : [];
};

console.log('=== 用几个常见词搜，收集真实 steamId ===');
const ids = new Set();
for (const kw of ['a', 'zzz', '1', '哥', '神']) {
  try {
    const list = await searchMany(kw);
    list.slice(0, 5).forEach((u) => u.steamId && ids.add(u.steamId));
    console.log(`  "${kw}" → ${list.length} 条，累计 ${ids.size} 个 id`);
  } catch (e) {
    console.log(`  "${kw}" ERR ${e.message}`);
  }
}

console.log(`\n=== 拿 ${ids.size} 个 id 逐个试 pvpMapStats（免认证）===`);
const all = [...ids].slice(0, 6);
for (const id of all) {
  const r = await call(`https://api.wmpvp.com/api/v2/csgo/pvpMapStats?steamId64=${id}&csgoSeasonId=S11`);
  const brief = r.text.replace(/\s+/g, ' ').slice(0, 180);
  const hasData = /"data":\s*\[/.test(r.text) && !/"data":\s*\[\s*\]/.test(r.text);
  console.log(`  ${hasData ? '★有数据' : '  空数据'}  ${id}  ${brief}`);
}

console.log('\n=== 同时试另一个可能的免认证接口 ===');
for (const id of all.slice(0, 2)) {
  for (const p of [
    `/api/csgo/home/pvp/rankInfo?steamId64=${id}`,
    `/api/csgo/home/player/info?steamId64=${id}`,
    `/api/v2/csgo/pvpData?steamId64=${id}`
  ]) {
    const r = await call('https://api.wmpvp.com' + p);
    if (r.status !== 404) console.log(`  ${r.status} ${p}  ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`);
    else console.log(`  404 ${p}`);
  }
}
