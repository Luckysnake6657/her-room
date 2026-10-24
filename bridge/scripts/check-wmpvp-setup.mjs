// 完美平台（wmpvp）MCP 自检：看 token 配了没、通不通、能查到谁。
// 用法：
//   node scripts/check-wmpvp-setup.mjs            只检查当前状态
//   node scripts/check-wmpvp-setup.mjs <player>   顺带查一个玩家
import fs from 'node:fs';

const TOKEN_FILE = 'D:/qq-bridge/state/wmpvp-token.json';
const PLAYER = process.argv[2] || '';

const UA = 'okhttp/4.9.2';

console.log('════ 完美平台（wmpvp）自检 ════\n');

// 1) token 配置
console.log('【1】token 文件');
let token = '';
if (fs.existsSync(TOKEN_FILE)) {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, ''));
    token = typeof j.token === 'string' ? j.token.trim() : '';
    console.log(`  ✅ 存在：${TOKEN_FILE}`);
    console.log(`  token：${token ? token.slice(0, 6) + `…(${token.length}位)` : '❌ 空'}`);
  } catch (e) {
    console.log(`  ⚠️ 文件存在但解析失败：${e.message}`);
  }
} else {
  console.log(`  ❌ 不存在：${TOKEN_FILE}`);
  console.log('     获取：登录 pvp.wanmei.com → F12 → 网络 → 任一 api.wmpvp.com 请求头里的 token');
  console.log(`     写入：{"token":"粘贴到这里"}`);
}

// 2) 搜索（免 token，永远能测）
console.log('\n【2】搜索接口（免 token，必定可用）');
const search = async (kw) => {
  const r = await fetch('https://appengine.wmpvp.com/steamcn/app/search/user', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://client.wmpvp.com',
      Origin: 'https://news.wmpvp.com',
      'x-requested-with': 'XMLHttpRequest',
      'User-Agent': UA
    },
    body: JSON.stringify({ keyword: kw, page: 1 }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  return j?.code === 1 && Array.isArray(j.result) ? j.result : [];
};
try {
  const list = await search('ropz');
  console.log(`  搜索 "ropz" → ${list.length} 条  ${list.length ? '✅' : '❌'}`);
  if (list[0]) console.log(`     首条：${list[0].pvpNickName} steamId=${list[0].steamId}`);
} catch (e) {
  console.log(`  ❌ ${e.message}`);
}

// 3) 赛季统计（需 token）
console.log('\n【3】赛季统计接口（需 token）');
if (!token) {
  console.log('  ⏭ 跳过（没配 token）');
} else {
  const target = PLAYER || '76561199089054183';
  try {
    const r = await fetch('https://api.wmpvp.com/api/csgo/home/pvp/detailStats', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        token,
        appversion: '3.5.4.172',
        platform: 'android',
        'User-Agent': 'okhttp/4.9.2'
      },
      body: JSON.stringify({ mySteamId: 0, toSteamId: Number(target), accessToken: '' }),
      signal: AbortSignal.timeout(25000)
    });
    const j = await r.json();
    if (j.statusCode === 4001) {
      console.log(`  ❌ token 已失效（statusCode 4001），需要重新获取`);
    } else if (j.statusCode !== 0) {
      console.log(`  ⚠️ statusCode=${j.statusCode}  ${j.errorMessage || ''}`);
    } else {
      const d = j.data || {};
      const meaningful = ['name', 'pvpScore', 'cnt', 'winRate', 'pwRating', 'adr', 'rws'].filter(
        (k) => d[k] !== null && d[k] !== undefined && d[k] !== 0 && d[k] !== ''
      );
      console.log(`  查询 ${target} → statusCode=0`);
      console.log(`     昵称=${d.name ?? '(null)'}  段位分=${d.pvpScore}  场次=${d.cnt}  胜率=${d.winRate}`);
      console.log(`     pwRating=${d.pwRating}  ADR=${d.adr}  RWS=${d.rws}  爆头率=${d.headShotRatio}`);
      console.log(`     ${meaningful.length ? '✅ 有有效数据' : '⚠️ 字段全为 0（该账号本赛季可能没打天梯）'}`);
    }
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
  }
}

console.log('\n════ 自检结束 ════');
