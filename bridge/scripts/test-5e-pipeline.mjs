// 实测 5E 三个接口（不带 token）：搜玩家 → 拿 uuid → 拿赛季数据。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const getJson = async (url, referer = 'https://view-arena.5eplay.com/') => {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: referer },
      signal: AbortSignal.timeout(20000)
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  } catch (e) {
    return { status: 0, json: null, text: 'ERR ' + e.message };
  }
};

// 1) 按昵称搜索
const kw = process.argv[2] || 'ropz';
console.log(`=== 1) 搜索玩家 "${kw}" ===`);
const s = await getJson(`https://arena.5eplay.com/api/search/player/1/16?keywords=${encodeURIComponent(kw)}`);
console.log(`  HTTP ${s.status}  len=${s.text.length}`);
console.log('  ' + s.text.replace(/\s+/g, ' ').slice(0, 700));

// 尝试从结果里取 uuid
let uuid = null;
if (s.json) {
  const dig = (o, d = 0) => {
    if (!o || d > 5 || uuid) return;
    if (typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (/uuid/i.test(k) && typeof v === 'string' && /^[0-9a-f-]{32,40}$/i.test(v)) { uuid = v; return; }
        dig(v, d + 1);
      }
    }
  };
  dig(s.json);
}
console.log(`\n  提取到 uuid: ${uuid || '(没提到)'}`);

// 2) 用 uuid 拿赛季数据
if (uuid) {
  console.log(`\n=== 2) player/home?uuid=${uuid} ===`);
  const h = await getJson(`https://gate.5eplay.com/crane/http/api/data/player/home?uuid=${uuid}`);
  console.log(`  HTTP ${h.status}`);
  console.log('  ' + h.text.replace(/\s+/g, ' ').slice(0, 900));

  console.log(`\n=== 3) userinterface/header/${uuid} ===`);
  const u = await getJson(`https://gate.5eplay.com/userinterface/pt/v1/userinterface/header/${uuid}`);
  console.log(`  HTTP ${u.status}`);
  console.log('  ' + u.text.replace(/\s+/g, ' ').slice(0, 500));

  console.log(`\n=== 4) match/list（该 uuid）===`);
  const now = Math.floor(Date.now() / 1000);
  const ml = await getJson(
    `https://gate.5eplay.com/crane/http/api/data/match/list?match_type=-1&page=1&date=0&start_time=${now - 86400 * 30}&end_time=${now}&uuid=${uuid}&limit=5&cs_type=0`
  );
  console.log(`  HTTP ${ml.status}`);
  console.log('  ' + ml.text.replace(/\s+/g, ' ').slice(0, 700));
}
