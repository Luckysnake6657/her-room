// 探 5E 的 gate.5eplay.com 接口：不带 token 会怎样；有没有按名搜玩家的接口。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://gate.5eplay.com/crane/http/api/data';

const call = async (endpoint, params = {}, withAuth = false) => {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://view-arena.5eplay.com/',
        Accept: 'application/json, text/plain, */*',
        ...(withAuth ? { Authorization: 'Bearer test' } : {})
      },
      signal: AbortSignal.timeout(20000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 1) match/list 不带 token
console.log('=== gate.5eplay.com 可达性（不带 token）===');
for (const ep of ['match/list', 'player/info', 'search', 'user/info']) {
  const r = await call(ep, { page: 1, limit: 5 });
  console.log(`  ${String(r.status).padEnd(4)} ${ep}  ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

// 2) 5E 网页版可达性（view-arena 是战绩页面）
console.log('\n=== 5E 网页版探测 ===');
for (const u of [
  'https://view-arena.5eplay.com/',
  'https://www.5eplay.com/player',
  'https://gate.5eplay.com/',
  'https://arena.5eplay.com/'
]) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(18000) });
    const t = await r.text();
    console.log(`  ${String(r.status).padEnd(4)} ${u}  len=${t.length}`);
    if (r.status === 200 && t.length < 600) console.log(`       ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    console.log(`  ERR  ${u}  ${e.message}`);
  }
}
