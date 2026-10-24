// 从 5E 前端 bundle 里挖 API 路径；并找完美竞技平台的真实数据域名。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 1) 5E 首页里找脚本和接口线索
const home = await get('https://www.5eplay.com/');
console.log(`5E 首页 ${home.status} len=${home.text.length}`);
const scripts = [...home.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
const links = [...home.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /player|match|api|data/i.test(h));
console.log('  脚本:', scripts.slice(0, 6));
console.log('  可疑链接:', [...new Set(links)].slice(0, 12));

// 首页里直接出现的 api 域名/路径
const apiHits = [...new Set([...home.text.matchAll(/https?:\/\/[a-z0-9.-]*5e[a-z0-9.-]*\/[A-Za-z0-9_\-/.]*/gi)].map((m) => m[0]))];
console.log('  页面里的 5E 域名/路径:');
apiHits.slice(0, 20).forEach((h) => console.log('    ' + h));

// 2) 完美：找玩家数据域名
console.log('\n完美相关域名探测:');
const wm = [
  'https://www.csgo.com.cn/api/',
  'https://pj.coreworld.cn/',
  'https://arena.wanmei.com/api/',
  'https://csgo.wanmei.com/',
  'https://www.csgo.com.cn/player/',
];
for (const u of wm) {
  const r = await get(u);
  console.log(`  ${String(r.status).padEnd(4)} ${u}  len=${r.text.length}`);
  if (r.status === 200 && r.text.length < 300) console.log(`       ${r.text.replace(/\s+/g, ' ')}`);
}

// 3) 从完美首页找线索
const wmHome = await get('https://www.csgo.com.cn/');
const wmDomains = [...new Set([...wmHome.text.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:cn|com|net)[A-Za-z0-9_\-/.]*/gi)].map((m) => m[0]))];
console.log('\n  完美首页里出现的域名（过滤常见cdn）:');
wmDomains
  .filter((d) => !/\.(png|jpg|css|js|gif|svg|woff)/i.test(d))
  .filter((d) => !/googletagmanager|google-analytics|baidu|bdstatic|gtimg|qpic|tencent/i.test(d))
  .slice(0, 25)
  .forEach((d) => console.log('    ' + d));
