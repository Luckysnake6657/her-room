// 探完美的网页端登录入口与可能的 token 相关接口。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const get = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow'
    });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, finalUrl: url };
  }
};

console.log('=== 候选登录/门户入口 ===');
for (const u of [
  'https://passport.pwesports.cn/',
  'https://passport.pwesports.cn/login',
  'https://www.pwesports.cn/',
  'https://cs.wanmei.com/',
  'https://news.wmpvp.com/',
  'https://client.wmpvp.com/index.html',
  'https://pvp.wanmei.com/csgo/home'
]) {
  const r = await get(u);
  const title = (r.text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  console.log(`  ${String(r.status).padEnd(4)} ${u}`);
  console.log(`       → ${r.finalUrl}  len=${r.text.length}  title=${title.slice(0, 60)}`);
  if (/登录|login|passport/i.test(r.text.slice(0, 4000)) && r.text.length < 30000) {
    const hints = ['steam', '扫码', '二维码', 'qrcode', 'account', '密码'].filter((h) =>
      new RegExp(h, 'i').test(r.text)
    );
    if (hints.length) console.log(`       登录线索: ${hints.join(', ')}`);
  }
}

console.log('\n=== 探 token 相关接口（无 token 时看提示）===');
const post = async (url, body) => {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Accept: '*/*', 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': UA, Referer: 'https://client.wmpvp.com' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(18000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};
for (const p of [
  'https://appengine.wmpvp.com/steamcn/app/login/getToken',
  'https://appengine.wmpvp.com/steamcn/app/user/token',
  'https://api.wmpvp.com/api/csgo/home/user/token',
  'https://appengine.wmpvp.com/steamcn/app/search/user'
]) {
  const r = await post(p, { keyword: 'ropz', page: 1 });
  console.log(`  ${r.status} ${p}\n       ${r.text.replace(/\s+/g, ' ').slice(0, 150)}`);
}
