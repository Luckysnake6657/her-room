// 5E 完整链路实测（不带任何 token）：
//   搜昵称 → domain → idTransfer → uuid → player/home + match/list + user/header
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const J = (t) => { try { return JSON.parse(t); } catch { return null; } };

const req = async (url, opts = {}) => {
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://view-arena.5eplay.com/', ...(opts.headers || {}) },
      body: opts.body,
      signal: AbortSignal.timeout(20000)
    });
    const t = await r.text();
    return { status: r.status, text: t, json: J(t) };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message, json: null };
  }
};

const ID_TRANSFER_HEADERS = {
  accept: '*/*',
  'content-type': 'application/json',
  'x-ca-key': '5eplay',
  'x-ca-signature': 'pm/c+nYSScWXLOYG7WCczBallQAPFsQ+mu3szgvr7xg=',
  'x-ca-signature-headers': 'Accept-Language,Authorization',
  'x-ca-signature-method': 'HmacSHA256',
  'Accept-Language': 'zh-cn',
  authorization: ''
};

const nickname = process.argv[2] || 'ropz';
const now = Math.floor(Date.now() / 1000);

// 1) 搜索
const s = await req(`https://arena.5eplay.com/api/search/player/1/16?keywords=${encodeURIComponent(nickname)}`);
const list = s.json?.data?.user?.list || [];
console.log(`1) 搜索 "${nickname}" -> ${s.status}，命中 ${list.length} 个`);
list.slice(0, 5).forEach((p, i) => console.log(`   [${i}] ${p.username}  domain=${p.domain}`));
if (!list.length) process.exit(0);

// 2) domain -> uuid（用抄来的签名）
const domain = list[0].domain;
const t = await req('https://gate.5eplay.com/userinterface/http/v1/userinterface/idTransfer', {
  method: 'POST',
  headers: ID_TRANSFER_HEADERS,
  body: JSON.stringify({ trans: { domain } })
});
console.log(`\n2) idTransfer(${domain}) -> ${t.status}`);
console.log('   ' + t.text.replace(/\s+/g, ' ').slice(0, 400));
const uuid = t.json?.data?.uuid || null;
console.log(`   uuid = ${uuid || '(未取到)'}`);
if (!uuid) process.exit(0);

// 3) 赛季数据
const home = await req(`https://gate.5eplay.com/crane/http/api/data/player/home?uuid=${uuid}`);
console.log(`\n3) player/home -> ${home.status}`);
console.log('   ' + home.text.replace(/\s+/g, ' ').slice(0, 1000));

// 4) 用户头部信息
const hd = await req(`https://gate.5eplay.com/userinterface/pt/v1/userinterface/header/${uuid}`);
console.log(`\n4) userinterface/header -> ${hd.status}`);
console.log('   ' + hd.text.replace(/\s+/g, ' ').slice(0, 600));

// 5) 对局列表
const ml = await req(
  `https://gate.5eplay.com/crane/http/api/data/match/list?match_type=-1&page=1&date=0&start_time=${now - 86400 * 60}&end_time=${now}&uuid=${uuid}&limit=5&cs_type=0`
);
console.log(`\n5) match/list -> ${ml.status}`);
console.log('   ' + ml.text.replace(/\s+/g, ' ').slice(0, 900));
