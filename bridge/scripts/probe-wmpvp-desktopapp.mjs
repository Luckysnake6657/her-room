// 抓 desktop-app.r0csgo.com 的前端 bundle，找 API 基址 / token / 签名算法
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  return { status: r.status, text: await r.text(), url: r.url };
};

console.log('=== index.html ===');
const html = await get('https://desktop-app.r0csgo.com/');
console.log(`status=${html.status} len=${html.text.length} url=${html.url}`);
console.log(html.text.slice(0, 1200));

const assets = new Set();
for (const m of html.text.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/gi)) assets.add(m[1]);
for (const m of html.text.matchAll(/["'](\/assets\/[^"']+\.js)["']/gi)) assets.add(m[1]);
console.log(`\n资源 ${assets.size}:`);
[...assets].forEach((a) => console.log('  ' + a));

// 抓 JS，搜关键逻辑
const NEEDLES = ['api.wmpvp.com', 'api.r0csgo.com', 'detailStats', 'pvpMapStats', 'match/list', 'refreshToken', 'ac_token', 'sign', 'md5', 'timestamp', 'nonce'];
for (const a of [...assets].filter((x) => x.endsWith('.js'))) {
  const u = a.startsWith('http') ? a : 'https://desktop-app.r0csgo.com' + (a.startsWith('/') ? '' : '/') + a;
  let r;
  try { r = await get(u); } catch (e) { console.log(`ERR ${u}: ${e.message}`); continue; }
  console.log(`\n######## ${u} (${r.text.length} B) ########`);
  for (const n of NEEDLES) {
    const lc = r.text.toLowerCase();
    const klc = n.toLowerCase();
    let idx = lc.indexOf(klc);
    let c = 0;
    while (idx !== -1 && c < 2) {
      console.log(`  [${n}] ...${r.text.slice(Math.max(0, idx - 130), idx + 200).replace(/\s+/g, ' ')}...`);
      idx = lc.indexOf(klc, idx + 1);
      c++;
    }
  }
}
