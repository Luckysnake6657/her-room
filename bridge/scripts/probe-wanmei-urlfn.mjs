// 掘出 Object(c["d"]) 这个 URL 解析函数的完整定义，以及它支持的 key。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const r = await fetch('https://pvp.wanmei.com/pvp/umi.e624939f.js', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30000)
});
const t = await r.text();

// 1) 打印 pvp-api 那段前后的大段上下文（函数定义应在附近）
const idx = t.indexOf('"pvp-api"===e');
if (idx >= 0) {
  console.log('=== "pvp-api"===e 前后 1800 字符 ===');
  console.log(t.slice(Math.max(0, idx - 1500), idx + 400).replace(/\s+/g, ' '));
} else {
  console.log('没找到 "pvp-api"===e');
}

// 2) 找 host 映射对象（key: "https://..." 形式）
console.log('\n=== 像 host 映射的片段 ===');
const maps = [...t.matchAll(/\{[^{}]{0,80}(?:goCom|clientWmpvp|pvpDota2)[^{}]{0,400}\}/g)];
maps.slice(0, 3).forEach((m) => console.log('  ' + m[0].replace(/\s+/g, ' ').slice(0, 500)));

// 3) 所有 "xxx-api" 形式的 key
const keys = [...new Set([...t.matchAll(/["'`]([a-zA-Z-]{2,20}-api)["'`]/g)].map((m) => m[1]))];
console.log('\n=== 形如 xxx-api 的 key ===');
keys.forEach((k) => console.log('  ' + k));

// 4) 所有以 /api/ 开头的字符串（可能带前缀不同）
const apiPaths = [...new Set([...t.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-/{}.:]{2,70})["'`]/g)].map((m) => m[1]))];
console.log(`\n=== /api/ 开头的路径（${apiPaths.length}）===`);
apiPaths.slice(0, 40).forEach((p) => console.log('  ' + p));

// 5) 所有相对业务路径（/xxx/yyy 两段以上）
const biz = [
  ...new Set(
    [...t.matchAll(/["'`](\/[a-z][a-zA-Z0-9_\-]*(?:\/[a-zA-Z0-9_\-{}.:]+){1,3})["'`]/g)].map((m) => m[1])
  )
].filter((p) => !/\.(png|jpg|css|js|svg|gif|woff|json)$/i.test(p));
console.log(`\n=== 相对业务路径（${biz.length}）===`);
biz.slice(0, 60).forEach((p) => console.log('  ' + p));
