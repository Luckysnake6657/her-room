// 探完美 PC 客户端的下载与更新清单，看客户端是否有内置浏览器/网页入口可抓 token。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(22000),
      redirect: 'follow'
    });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, finalUrl: url };
  }
};

console.log('=== 更新清单 / 下载入口 ===');
for (const u of [
  'https://client.wmpvp.com/download/latest.yml',
  'https://client.wmpvp.com/dota2/latest.yml',
  'https://pvp.wanmei.com/appdownload-csgo/index.html'
]) {
  const r = await get(u);
  console.log(`  ${String(r.status).padEnd(4)} ${u}  len=${r.text.length}`);
  console.log('       ' + r.text.replace(/\s+/g, ' ').slice(0, 300));
}

console.log('\n=== 从 pvp.wanmei.com 页面找 CS 客户端下载地址 ===');
const home = await get('https://pvp.wanmei.com/');
const bundle = await get('https://pvp.wanmei.com/pvp/umi.e624939f.js');
const t = bundle.text;
// 找 exe 下载链接
const exes = [...new Set([...t.matchAll(/["'`]([^"'`]*\.exe)["'`]/gi)].map((m) => m[1]))];
console.log('  bundle 里的 .exe 路径:');
exes.slice(0, 10).forEach((e) => console.log('    ' + e));
// 找下载相关拼装
const ctx = t.indexOf('perfectworldarena_win32');
if (ctx >= 0) {
  console.log('\n  下载地址拼装上下文:');
  console.log('    ...' + t.slice(Math.max(0, ctx - 400), ctx + 300).replace(/\s+/g, ' ') + '...');
}
