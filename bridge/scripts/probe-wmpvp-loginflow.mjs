// 挖完美平台的登录链路：Steam OpenID → 换 token 的接口。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const r = await fetch('https://pvp.wanmei.com/pvp/umi.e624939f.js', {
  headers: { 'User-Agent': UA },
  signal: AbortSignal.timeout(30000)
});
const t = await r.text();
console.log(`bundle len=${t.length}\n`);

const show = (label, re, max = 15) => {
  const hits = [...new Set([...t.matchAll(re)].map((m) => m[0]))];
  console.log(`=== ${label}（${hits.length}）===`);
  hits.slice(0, max).forEach((h) => console.log('  ' + h.replace(/\s+/g, ' ').slice(0, 190)));
  console.log('');
};

show('登录相关路径', /["'`][a-zA-Z0-9_\-/{}.:]{0,50}(?:login|Login|auth|Auth|token|Token|openid|OpenID)[a-zA-Z0-9_\-/{}.:]{0,50}["'`]/g, 25);
show('steam 相关', /["'`][a-zA-Z0-9_\-/{}.:]{0,60}(?:steam|Steam)[a-zA-Z0-9_\-/{}.:]{0,60}["'`]/g, 25);
show('passport / pwesports 域名', /https?:\/\/[a-z0-9.\-]*(?:passport|pwesports|steam|wmpvp)[a-z0-9.\-]*[a-zA-Z0-9_\-/.]*/gi, 25);
show('accessToken 赋值', /accessToken["'\s:=]{1,10}[^,;}]{0,80}/g, 10);
show('token 关键字上下文', /.{50}["'`]token["'`].{80}/gi, 10);

// 找登录按钮跳转目标
const loginIdx = [...t.matchAll(/login/gi)].map((m) => m.index).slice(0, 8);
console.log('=== login 出现处上下文 ===');
loginIdx.forEach((i) => console.log('  ...' + t.slice(Math.max(0, i - 100), i + 120).replace(/\s+/g, ' ') + '...'));
