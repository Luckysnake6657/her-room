// 在 umi bundle 里找 API baseURL / 请求前缀的拼接方式。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const r = await fetch('https://pvp.wanmei.com/pvp/umi.e624939f.js', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30000)
});
const t = await r.text();
console.log(`bundle len=${t.length}`);

const show = (label, re, max = 12) => {
  const hits = [...new Set([...t.matchAll(re)].map((m) => m[0]))];
  console.log(`\n=== ${label}（${hits.length}）===`);
  hits.slice(0, max).forEach((h) => console.log('  ' + h.replace(/\s+/g, ' ').slice(0, 200)));
};

show('baseURL 赋值', /baseURL\s*[:=]\s*["'`][^"'`]{0,80}["'`]/g);
show('带 /api 的完整路径', /["'`][^"'`]{0,40}\/api\/[a-zA-Z0-9_\-/{}.:]{2,60}["'`]/g);
show('player 相关路径', /["'`][a-zA-Z0-9_\-/{}.:]{0,60}player[a-zA-Z0-9_\-/{}.:]{0,60}["'`]/gi, 20);
show('match 相关路径', /["'`][a-zA-Z0-9_\-/{}.:]{0,60}match[a-zA-Z0-9_\-/{}.:]{0,60}["'`]/gi, 20);
show('wmpvp 域名上下文', /.{60}wmpvp\.com.{60}/gi, 10);
show('axios/create 配置', /\.create\(\{[^}]{0,160}\}/g, 8);

// 找 season / rank 等业务词
show('season/rank 路径', /["'`][a-zA-Z0-9_\-/{}.:]{0,50}(?:season|rank)[a-zA-Z0-9_\-/{}.:]{0,50}["'`]/gi, 20);
