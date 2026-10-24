// 完美平台 token 自检：检查文件 / 有效性 / 能否查询
// 用法: node scripts/check-wmpvp-token.mjs [steamId64]
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TOKEN_FILE = path.join(BRIDGE_ROOT, 'state', 'wmpvp-token.json');
const TEST_STEAMID = process.argv[2] || '76561199185773869'; // 默认用机主的号做连通性测试

const ok = (s) => console.log(`  \u2705 ${s}`);
const bad = (s) => console.log(`  \u274c ${s}`);
const warn = (s) => console.log(`  \u26a0\ufe0f  ${s}`);

// 抓包期间 hosts 会把 wmpvp 域名指到 127.0.0.1，Node 默认解析会绕回本机。
// 所以这里统一用公共 DNS 解析真实 IP 后直连（Host/SNI 仍用原域名）。
import dns from 'node:dns';
import https from 'node:https';

const DNS_SERVERS = ['223.5.5.5', '119.29.29.29'];
const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(DNS_SERVERS);
const ipCache = new Map();

async function realIp(host) {
  if (ipCache.has(host)) return ipCache.get(host);
  const addrs = (await resolver.resolve4(host)).filter((a) => !a.startsWith('127.'));
  if (!addrs.length) throw new Error('no non-loopback address');
  ipCache.set(host, addrs[0]);
  return addrs[0];
}

/** 用真实 IP 直连，绕开被 hosts 劫持的解析。 */
function rawRequest(host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    realIp(host).then((ip) => {
      const r = https.request(
        {
          host: ip,
          servername: host,
          port: 443,
          method,
          path,
          headers: { Host: host, ...headers },
          timeout: 25000
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, text: b, ip }));
        }
      );
      r.on('error', (e) => resolve({ status: 0, error: e.message }));
      r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (body) r.write(body);
      r.end();
    }).catch((e) => resolve({ status: 0, error: 'DNS: ' + e.message }));
  });
}

const UA_APP = 'okhttp/4.9.2';
const APP_VERSION = '3.5.4.172';

console.log('=== 完美平台 token 自检 ===\n');

console.log('[1] token 文件');
if (!fs.existsSync(TOKEN_FILE)) {
  bad(`不存在: ${TOKEN_FILE}`);
  console.log('\n    需要抓包获取。见 scripts\\抓包说明.md，或直接运行:');
  console.log('      powershell -File scripts\\wmpvp-install-capture.ps1   (提权安装，然后跑代理)');
  process.exit(1);
}
ok(`存在: ${TOKEN_FILE}`);

let token = '';
try {
  const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  token = typeof j?.token === 'string' ? j.token.trim() : '';
} catch (e) {
  bad(`解析失败: ${e.message}`);
  process.exit(1);
}

if (!token) {
  bad('文件里没有 token 字段（应为 {"token":"..."}）');
  process.exit(1);
}
ok(`token 长度 ${token.length}，前 6 位 ${token.slice(0, 6)}…`);

// 写入时间 / 年龄
const st = fs.statSync(TOKEN_FILE);
const ageDays = (Date.now() - st.mtimeMs) / 86400000;
console.log(`    写入时间: ${st.mtime.toLocaleString('zh-CN')}（${ageDays.toFixed(1)} 天前）`);

console.log('\n[2] 连通性 + 有效性');
const post = async (url, body, extra = {}) => {
  const u = new URL(url);
  const r = await rawRequest(u.hostname, u.pathname + u.search, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      token,
      appversion: APP_VERSION,
      platform: 'android',
      'User-Agent': UA_APP,
      ...extra
    },
    body: JSON.stringify(body)
  });
  if (r.status === 0) return { status: 0, error: r.error };
  let j = null;
  try { j = JSON.parse(r.text); } catch {}
  return { status: r.status, json: j, text: r.text };
};

const ds = await post('https://api.wmpvp.com/api/csgo/home/pvp/detailStats', {
  mySteamId: 0,
  toSteamId: Number(TEST_STEAMID),
  accessToken: ''
});

if (ds.status === 0) {
  bad(`网络不通: ${ds.error}`);
} else if (ds.json?.statusCode === 4001) {
  bad('token 已失效（4001 登录失效，请重新登录）');
  console.log('\n    重新抓包:');
  console.log('      1) powershell -File scripts\\wmpvp-install-capture.ps1');
  console.log('      2) node scripts\\wmpvp-proxy.mjs');
  console.log('      3) 启动完美客户端并登录');
  console.log('    或手动写入新的 token 到 ' + TOKEN_FILE);
  process.exit(2);
} else if (ds.json?.statusCode === 0) {
  ok('token 有效，detailStats 返回正常');
  const d = ds.json.data || {};
  const nick = d.pvpNickName || d.nickName || d.nickname || '(?)';
  const score = d.pvpScore ?? d.score ?? d.rankScore ?? '(?)';
  console.log(`    测试对象 ${TEST_STEAMID}: 昵称=${nick} 天梯分=${score}`);
  console.log(`    顶用字段: ${Object.keys(d).slice(0, 14).join(', ')}${Object.keys(d).length > 14 ? ' …' : ''}`);
} else if (ds.json?.statusCode === 90003) {
  warn(`服务端返回 90003「网络开小差了」——通常是 token 为空/格式不对，而不是失效`);
} else {
  warn(`意外返回: HTTP ${ds.status} statusCode=${ds.json?.statusCode} ${ds.json?.errorMessage || ds.text.slice(0, 120)}`);
}

console.log('\n[3] 对局列表接口');
const ml = await post(
  'https://api.wmpvp.com/api/csgo/home/match/list',
  { mySteamId: 0, toSteamId: Number(TEST_STEAMID), page: 1, limit: 5 },
  { platform: 'HarmonyOS', gametype: '2', gametypestr: '2', 'User-Agent': 'libcurl-agent/1.0' }
);
if (ml.status === 0) bad(`网络不通: ${ml.error}`);
else if (ml.json?.statusCode === 4001) bad('登录失效');
else if (ml.json?.statusCode === 0) {
  const list = ml.json.data?.list ?? ml.json.data ?? [];
  ok(`对局接口正常，返回 ${Array.isArray(list) ? list.length : 0} 场`);
  if (Array.isArray(list) && list[0]) {
    console.log(`    首场字段: ${Object.keys(list[0]).slice(0, 16).join(', ')}`);
  }
} else {
  warn(`HTTP ${ml.status} statusCode=${ml.json?.statusCode} ${ml.json?.errorMessage || ml.text.slice(0, 120)}`);
}

console.log('\n[4] 搜索接口（免 token，用于确认昵称→SteamID）');
{
  const r = await rawRequest('appengine.wmpvp.com', '/steamcn/app/search/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA_APP },
    body: JSON.stringify({ keyword: TEST_STEAMID, page: 1 })
  });
  if (r.status === 0) {
    bad('搜索接口异常: ' + r.error);
  } else {
    let j = null;
    try { j = JSON.parse(r.text); } catch {}
    const hit = (j?.result || []).find((u) => String(u.steamId) === String(TEST_STEAMID));
    if (hit) ok(`搜索正常：${hit.pvpNickName || hit.appNickName || '(无昵称)'}（天梯分 ${hit.pvpScore ?? '无'}）`);
    else warn(`搜索返回 ${(j?.result || []).length} 条，但没匹配到 ${TEST_STEAMID}`);
  }
}

console.log('\n=== 自检结束 ===');
