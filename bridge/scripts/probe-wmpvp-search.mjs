// 实测完美平台的免认证搜索接口 appengine.wmpvp.com/steamcn/app/search/user
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const search = async (keyword) => {
  try {
    const r = await fetch('https://appengine.wmpvp.com/steamcn/app/search/user', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://client.wmpvp.com',
        Origin: 'https://news.wmpvp.com',
        'x-requested-with': 'XMLHttpRequest',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': UA
      },
      body: JSON.stringify({ keyword: String(keyword), page: 1 }),
      signal: AbortSignal.timeout(20000)
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  } catch (e) {
    return { status: 0, json: null, text: 'ERR ' + e.message };
  }
};

for (const kw of process.argv.slice(2).length ? process.argv.slice(2) : ['ropz', '76561197960435530']) {
  const r = await search(kw);
  console.log(`\n=== 搜索 "${kw}" -> HTTP ${r.status} ===`);
  if (r.json) {
    console.log(`  code=${r.json.code}  result 长度=${Array.isArray(r.json.result) ? r.json.result.length : typeof r.json.result}`);
    if (Array.isArray(r.json.result) && r.json.result.length) {
      console.log('  第一条完整字段:');
      console.log('  ' + JSON.stringify(r.json.result[0], null, 1).split('\n').join('\n  ').slice(0, 1200));
      console.log(`  共 ${r.json.result.length} 条，前 5 条:`);
      r.json.result.slice(0, 5).forEach((u, i) =>
        console.log(`    [${i}] ${JSON.stringify({ name: u.name ?? u.nickName, steamId: u.steamId ?? u.steam_id, rank: u.rank ?? u.pvpRank ?? u.score })}`)
      );
    } else {
      console.log('  ' + r.text.slice(0, 400));
    }
  } else {
    console.log('  ' + r.text.slice(0, 400));
  }
}
