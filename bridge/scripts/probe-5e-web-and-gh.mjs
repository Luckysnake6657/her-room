// 从 5E 网页版找玩家搜索接口；并看有哪些 5E 相关开源项目。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, finalUrl: url };
  }
};

// 1) 5E 各页面 + 从 HTML 里挖脚本
for (const u of [
  'https://www.5eplay.com/',
  'https://view-arena.5eplay.com/',
  'https://arena.5eplay.com/',
  'https://www.5eplay.com/search',
  'https://view-arena.5eplay.com/search'
]) {
  const r = await get(u);
  const scripts = [...r.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  const apis = [...new Set([...r.text.matchAll(/["'`](\/[a-z0-9_\-/]*(?:api|player|search|match)[a-z0-9_\-/]*)["'`]/gi)].map((m) => m[1]))];
  console.log(`${String(r.status).padEnd(4)} ${u}`);
  console.log(`      len=${r.text.length}  脚本=${scripts.length}  疑似API路径=${apis.length}`);
  scripts.slice(0, 4).forEach((s) => console.log('      js: ' + s.slice(0, 110)));
  apis.slice(0, 8).forEach((a) => console.log('      api?: ' + a));
}

// 2) GitHub 上 5E 相关项目
console.log('\n=== GitHub 上的 5E / 完美 相关项目 ===');
for (const q of ['5eplay', '5e+csgo', '完美世界+csgo', 'wanmei+csgo']) {
  try {
    const r = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=5`);
    const j = JSON.parse(r.text);
    console.log(`  --- ${q} (${j.total_count} 个) ---`);
    (j.items || []).slice(0, 5).forEach((it) =>
      console.log(`    ${it.full_name}  ★${it.stargazers_count}  ${(it.description || '').slice(0, 70)}`)
    );
  } catch (e) {
    console.log(`  ${q}: ${e.message}`);
  }
}
