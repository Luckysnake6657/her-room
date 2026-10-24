// 找 axios 实例的实际调用：baseURL 实例变量 → 请求路径，拼出完整 URL。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const r = await fetch('https://pvp.wanmei.com/pvp/umi.e624939f.js', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30000)
});
const t = await r.text();
console.log(`bundle len=${t.length}`);

// 1) 首页 HTML 里还引了别的 chunk 吗
const home = await fetch('https://pvp.wanmei.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
const ht = await home.text();
const chunks = [...new Set([...ht.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1]))];
console.log('\n首页引用的 js:');
chunks.forEach((c) => console.log('  ' + c));

// 2) .create({baseURL:...}) 附近的完整上下文
console.log('\n=== axios.create 上下文 ===');
let idx = -1;
while ((idx = t.indexOf('.create({baseURL:', idx + 1)) !== -1) {
  console.log('  ...' + t.slice(Math.max(0, idx - 260), idx + 160).replace(/\s+/g, ' ') + '...');
  console.log('');
}

// 3) 搜所有含 wmpvp / wanmei 的 URL 字符串（含端口/路径）
const urls = [
  ...new Set(
    [...t.matchAll(/["'`](https?:\/\/[a-z0-9.\-]*(?:wmpvp|wanmei|pwesports)[a-z0-9.\-]*(?::\d+)?[a-zA-Z0-9_\-/.]*)["'`]/gi)].map(
      (m) => m[1]
    )
  )
];
console.log(`=== 完美系域名/URL（${urls.length}）===`);
urls.forEach((u) => console.log('  ' + u));

// 4) 搜 "csgo" 开头的相对路径（可能是另一个 API 前缀）
const csgo = [...new Set([...t.matchAll(/["'`](\/[a-zA-Z0-9_\-/]*(?:csgo|pvp)[a-zA-Z0-9_\-/.]*)["'`]/gi)].map((m) => m[1]))];
console.log(`\n=== 含 csgo/pvp 的相对路径（${csgo.length}）===`);
csgo.slice(0, 30).forEach((p) => console.log('  ' + p));
