// 实测 Leetify 的玩家数据接口：v2/games/history（对局历史）等。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const ID = '76561198084749846';

const call = async (path, method = 'GET', body = null) => {
  try {
    const r = await fetch(`https://api.leetify.com${path}`, {
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://leetify.com',
        Referer: 'https://leetify.com/'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000)
    });
    const t = await r.text();
    return { status: r.status, text: t };
  } catch (e) {
    return { status: 0, text: 'ERR ' + e.message };
  }
};

const tries = [
  ['GET', `/api/v2/games/history?steam64Id=${ID}`],
  ['GET', `/api/v2/games/history?players=${ID}`],
  ['GET', `/api/v2/games/history?id=${ID}`],
  ['POST', `/api/v2/games/history`, { steam64Ids: [ID], limit: 10 }],
  ['POST', `/api/v2/games/history`, { steam64Id: ID }],
  ['GET', `/api/mini-profiles/${ID}`],
  ['GET', `/api/general-data/recent-form?steam64Id=${ID}`],
  ['GET', `/api/maps/history?steam64Id=${ID}`]
];

for (const [method, path, body] of tries) {
  const r = await call(path, method, body);
  let brief = '';
  if (r.status === 200) {
    try {
      const j = JSON.parse(r.text);
      brief = Array.isArray(j)
        ? `[数组 ${j.length} 项] ${JSON.stringify(j[0] ?? {}).slice(0, 220)}`
        : `字段=${Object.keys(j).slice(0, 14).join(',')} | ${r.text.slice(0, 220)}`;
    } catch {
      brief = r.text.slice(0, 220);
    }
  } else {
    brief = r.text.slice(0, 120);
  }
  console.log(`${String(r.status).padEnd(4)} ${method.padEnd(5)} ${path}`);
  console.log(`     ${brief.replace(/\s+/g, ' ')}`);
}
