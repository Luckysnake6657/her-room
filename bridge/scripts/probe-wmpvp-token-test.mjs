// 验证从 C:\r0_arena\cfg\user_login.txt 挖到的 token 能不能用
const TOKEN = process.argv[2] || 'c08338203ea5f8ee5efb66aacc2dc710';
const STEAMID = '76561198986349250'; // 从 db 文件名来的（本机主账号）

const post = async (url, body, extraHeaders = {}) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      token: TOKEN,
      appversion: '3.5.4.172',
      platform: 'android',
      'User-Agent': 'okhttp/4.9.2',
      ...extraHeaders
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, raw: text.slice(0, 400) };
  }
};

console.log(`token = ${TOKEN}`);
console.log(`steamId = ${STEAMID}\n`);

console.log('=== 1) detailStats（核心：段位/数据）===');
const d = await post('https://api.wmpvp.com/api/csgo/home/pvp/detailStats', { mySteamId: 0, toSteamId: STEAMID, accessToken: '' });
console.log(`  HTTP ${d.status}`);
if (d.json) {
  console.log(`  statusCode=${d.json.statusCode}  message=${d.json.message || ''}`);
  console.log('  ' + JSON.stringify(d.json).slice(0, 1400));
} else console.log('  ' + d.raw);

console.log('\n=== 2) match/list ===');
const m = await post('https://api.wmpvp.com/api/csgo/home/pvp/match/list', { mySteamId: 0, toSteamId: STEAMID, accessToken: '', limit: 5, offset: 0 });
console.log(`  HTTP ${m.status}`);
if (m.json) {
  console.log(`  statusCode=${m.json.statusCode}  message=${m.json.message || ''}`);
  const list = m.json.data?.matchList || m.json.data?.list || m.json.data;
  console.log('  ' + JSON.stringify(m.json).slice(0, 900));
} else console.log('  ' + m.raw);
