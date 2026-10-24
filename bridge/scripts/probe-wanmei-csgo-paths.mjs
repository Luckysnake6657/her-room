// 挖 www.csgo.com.cn 域下的接口路径（用 csgoCom 拼接的那套）。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const r = await fetch('https://pvp.wanmei.com/pvp/umi.e624939f.js', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30000)
});
const t = await r.text();

// 1) 找 csgoCom 拼接的调用点及其路径参数
console.log('=== csgoCom 的使用上下文 ===');
let idx = -1;
let n = 0;
while ((idx = t.indexOf('csgoCom', idx + 1)) !== -1 && n < 12) {
  n++;
  console.log('  ...' + t.slice(Math.max(0, idx - 120), idx + 200).replace(/\s+/g, ' ') + '...');
  console.log('');
}

// 2) 找第二参数里以 / 开头的路径（形如 p("/xxx/yyy", {...})）
console.log('=== 形如 (function)(  "/path"  的调用 ===');
const calls = [...new Set([...t.matchAll(/\(["'`](\/[a-zA-Z0-9_\-/.]{3,60})["'`]\s*,/g)].map((m) => m[1]))];
calls.forEach((c) => console.log('  ' + c));

// 3) csgo.com.cn 域的完整 URL（含路径）
const urls = [...new Set([...t.matchAll(/["'`](https?:\/\/[a-z0-9.\-]*csgo\.com\.cn[a-zA-Z0-9_\-/.]*)["'`]/gi)].map((m) => m[1]))];
console.log(`\n=== csgo.com.cn 完整 URL（${urls.length}）===`);
urls.forEach((u) => console.log('  ' + u));

// 4) data.wanmei.com 相关
const urls2 = [...new Set([...t.matchAll(/["'`](https?:\/\/data\.wanmei\.com[a-zA-Z0-9_\-/.]*)["'`]/gi)].map((m) => m[1]))];
console.log(`\n=== data.wanmei.com URL（${urls2.length}）===`);
urls2.forEach((u) => console.log('  ' + u));
const ctx = t.indexOf('data.wanmei.com');
if (ctx >= 0) console.log('\n  data.wanmei.com 上下文: ...' + t.slice(Math.max(0, ctx - 200), ctx + 200).replace(/\s+/g, ' ') + '...');
