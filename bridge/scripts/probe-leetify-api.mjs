// 摸清 Leetify 可用接口：从他们的前端 bundle 里搜 API 路径。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const ID = '76561198084749846';

const get = async (url, asJson = false) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  return { status: r.status, text: t };
};

// 1) 找前端脚本
const page = await get('https://leetify.com/app/');
const scripts = [...page.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
console.log(`页面 ${page.status}，脚本 ${scripts.length} 个`);
scripts.slice(0, 6).forEach((s) => console.log('  ' + s));

// 2) 在脚本里搜 /api/ 路径
const found = new Set();
for (const s of scripts.slice(0, 6)) {
  const url = s.startsWith('http') ? s : `https://leetify.com${s.startsWith('/') ? '' : '/'}${s}`;
  try {
    const r = await get(url);
    if (r.status !== 200) {
      console.log(`  跳过 ${url} (${r.status})`);
      continue;
    }
    for (const m of r.text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/{}$.:]+)["'`]/g)) found.add(m[1]);
  } catch (e) {
    console.log(`  取 ${url} 失败: ${e.message}`);
  }
}
console.log(`\n从 bundle 里找到 ${found.size} 个 API 路径：`);
[...found].sort().slice(0, 60).forEach((p) => console.log('  ' + p));

// 3) 猜几个可能的"对局/详情"路径
console.log('\n试猜对局相关路径：');
const guesses = [
  `/api/mini-profiles/${ID}`,
  `/api/profile-summary/${ID}`,
  `/api/player/${ID}`,
  `/api/players/${ID}/matches`,
  `/api/matches/${ID}`,
  `/api/recent-matches/${ID}`,
];
for (const p of guesses) {
  try {
    const r = await get(`https://api.leetify.com${p}`, true);
    const note = r.status === 200 ? '  ✅ ' + r.text.slice(0, 120) : '';
    console.log(`  ${r.status}  ${p}${note}`);
  } catch (e) {
    console.log(`  ERR ${p} ${e.message}`);
  }
}
