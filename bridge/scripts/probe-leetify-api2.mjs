// 列出 Leetify bundle 里的全部 API 路径，并实测"玩家档案/对局"相关的候选。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const ID = '76561198084749846';

const get = async (url, asJson = false) => {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' },
    signal: AbortSignal.timeout(25000)
  });
  return { status: r.status, text: await r.text() };
};

const page = await get('https://leetify.com/app/');
const scripts = [...page.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
const found = new Set();
for (const s of scripts) {
  const url = s.startsWith('http') ? s : `https://leetify.com${s.startsWith('/') ? '' : '/'}${s}`;
  try {
    const r = await get(url);
    if (r.status !== 200) continue;
    for (const m of r.text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/{}$.:]+)["'`]/g)) found.add(m[1]);
    // 也搜带模板变量的路径（可能用反引号拼接）
    for (const m of r.text.matchAll(/\/api\/(?:profile|players?|users?|matches?|games?)[A-Za-z0-9_\-/${}.]*/g)) found.add(m[0]);
  } catch {}
}
const all = [...found].sort();
console.log(`共 ${all.length} 个路径。只列非 club 的：`);
all.filter((p) => !p.startsWith('/api/club')).forEach((p) => console.log('  ' + p));

// 实测候选
console.log('\n实测候选：');
const cands = [
  `/api/profile/${ID}`,
  `/api/profiles/${ID}`,
  `/api/mini-profiles/${ID}`,
  `/api/players/${ID}`,
  `/api/users/${ID}`,
  `/api/user/${ID}`,
  `/api/profile-summary/${ID}`,
  `/api/player-summary/${ID}`,
  `/api/mini-profiles/${ID}/matches`,
  `/api/mini-profiles/${ID}?include=matches`,
];
for (const p of cands) {
  try {
    const r = await get(`https://api.leetify.com${p}`, true);
    console.log(`  ${String(r.status).padEnd(4)} ${p}${r.status === 200 ? '  → ' + r.text.slice(0, 160) : ''}`);
  } catch (e) {
    console.log(`  ERR  ${p}  ${e.message}`);
  }
}
