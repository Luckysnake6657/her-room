// 1) 看 mini-profiles 到底给什么；2) 试其它免密钥 CS 数据源。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const ID = '76561198084749846';

const get = async (url, asJson = false) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' },
      signal: AbortSignal.timeout(25000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 1) mini-profiles 完整内容
const mp = await get(`https://api.leetify.com/api/mini-profiles/${ID}`, true);
console.log('=== Leetify mini-profiles 完整返回 ===');
try {
  const j = JSON.parse(mp.text);
  console.log(JSON.stringify(j, null, 1).slice(0, 2200));
} catch {
  console.log(mp.text.slice(0, 600));
}

// 2) 其它免密钥源
console.log('\n=== 其它 CS 数据源探测 ===');
const others = [
  ['csstats.gg API', `https://csstats.gg/player/${ID}`],
  ['csstats.gg json', `https://csstats.gg/api/player/${ID}`],
  ['scope.gg', `https://scope.gg/players/${ID}`],
  ['steamprofile xml', `https://steamcommunity.com/profiles/${ID}?xml=1`],
  ['Steam 官方 (无 key)', `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?steamids=${ID}`],
  ['steamid.io 反查', `https://steamid.io/lookup/${ID}`]
];
for (const [name, url] of others) {
  const r = await get(url);
  const hits = [];
  if (/7656119\d{10}/.test(r.text)) hits.push('含SteamID');
  if (/premier|rank|elo|rating/i.test(r.text)) hits.push('含段位相关词');
  console.log(`  ${String(r.status).padEnd(4)} ${name}  len=${r.text.length}${hits.length ? '  ★ ' + hits.join('/') : ''}`);
  if (r.status === 200 && r.text.length < 400) console.log(`       ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
}
