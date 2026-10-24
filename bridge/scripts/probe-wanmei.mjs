// 探完美世界竞技平台（pvp.wanmei.com）与其 CSGO 战绩查询页。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url, extra = {}) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra },
      signal: AbortSignal.timeout(22000)
    });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, finalUrl: url };
  }
};

const targets = [
  ['pvp.wanmei.com 主站', 'https://pvp.wanmei.com/'],
  ['CSGO 战绩查询页', 'https://www.csgo.com.cn/hd/1705/query/index.html'],
  ['战绩查询页(带参数)', 'https://www.csgo.com.cn/hd/1705/query/index.html?eqid=a28feee1000043f4000000066468aad8'],
  ['csgo data 页', 'https://www.csgo.com.cn/data/index.html'],
  ['完美世界主站', 'https://www.wanmei.com/']
];

for (const [name, url] of targets) {
  const r = await get(url);
  const scripts = [...r.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  const apis = [
    ...new Set(
      [...r.text.matchAll(/["'`](\/[a-zA-Z0-9_\-/]*(?:api|query|player|match|data)[a-zA-Z0-9_\-/]*)["'`]/gi)].map(
        (m) => m[1]
      )
    )
  ];
  console.log(`${String(r.status).padEnd(4)} ${name}`);
  console.log(`     ${url}`);
  console.log(`     len=${r.text.length} 脚本=${scripts.length} 疑似API=${apis.length}`);
  scripts.slice(0, 5).forEach((s) => console.log('       js: ' + s.slice(0, 115)));
  apis.slice(0, 10).forEach((a) => console.log('       api?: ' + a));
  // 是否含登录/框架线索
  const frames = ['vue', 'react', 'angular', 'require.js'].filter((f) => new RegExp(f, 'i').test(r.text));
  if (frames.length) console.log(`     框架线索: ${frames.join(', ')}`);
  console.log('');
}
