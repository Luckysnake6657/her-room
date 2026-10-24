// 从 pvp.wanmei.com 的 umi bundle 里挖 API 路径，并实测。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(25000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

// 1) 首页全文（可能内联了路由/配置）
const home = await get('https://pvp.wanmei.com/');
console.log('首页 len=' + home.text.length);
console.log('首页内容:');
console.log(home.text.replace(/\s+/g, ' ').slice(0, 1200));

// 2) bundle
const bundle = await get('https://pvp.wanmei.com/pvp/umi.e624939f.js');
console.log(`\nbundle HTTP ${bundle.status} len=${bundle.text.length}`);

if (bundle.status === 200) {
  // API 路径 / 域名
  const paths = [...new Set([...bundle.text.matchAll(/["'`](\/[a-zA-Z0-9_\-/]{3,60})["'`]/g)].map((m) => m[1]))];
  const apis = paths.filter((p) => /api|query|player|match|user|data|search|rank/i.test(p));
  console.log(`\n可疑路径（${apis.length}）:`);
  apis.slice(0, 50).forEach((p) => console.log('  ' + p));

  const hosts = [...new Set([...bundle.text.matchAll(/https?:\/\/[a-z0-9.-]*wanmei[a-z0-9.-]*/gi)].map((m) => m[0]))];
  console.log(`\nwanmei 域名（${hosts.length}）:`);
  hosts.slice(0, 25).forEach((h) => console.log('  ' + h));

  const hosts2 = [
    ...new Set([...bundle.text.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:com|cn|net)(?=[/"'`])/gi)].map((m) => m[0]))
  ].filter((h) => !/wanmei|jquery|react|google|baidu|gtimg|qpic|wx\.qq|alicdn|cdn/i.test(h));
  console.log(`\n其它域名（${hosts2.length}）:`);
  hosts2.slice(0, 25).forEach((h) => console.log('  ' + h));
}
