// CS（完美世界竞技平台 / 完美平台）战绩查询 MCP server（stdio）。
//
// 数据源：完美平台公开/半公开接口。
//   1) appengine.wmpvp.com/steamcn/app/search/user        POST 按昵称或 steamId 搜人（**免 token**）
//   2) api.wmpvp.com/api/csgo/home/pvp/detailStats        POST 赛季统计（**需 token**）
//   3) api.wmpvp.com/api/csgo/home/match/list             POST 近期对局（**需 token**）
//
// 认证：完美用一个登录 token（**没有可调的 refresh/login 端点**，只能抓包）。
//   2026-09 全面排查后的确定事实（别重复踩坑）：
//   - 完美**没有**网页登录能拿到 api.wmpvp.com 的 token：pvp.wanmei.com 的
//     /login/steam 走 passport.pwesports.cn → store.steampowered.com（OAuth implicit），
//     而这台机器到 store.steampowered.com / steamcommunity.com 网络不通；
//     且 pvp.wanmei.com/csgo/pwaSteam 的前端 bundle 只在 *DOTA2* 站调用 api.wmpvp.com，
//     CS 网页版不调，所以 F12 抓不到 CS 的 token。
//   - 客户端侧：C:\r0_arena\cfg\user_login.txt 里有明文 {username,password,token}，
//     但那份是**长期不用后过期的**（实测 4001）；客户端 db 缓存是服务端 AES 加密的。
//   - gate.wmpvp.com 从本机网络不可达；appengine/api.wmpvp.com 可达。
//   - 结论：只能靠抓包（让客户端重新登录一次，从它的 HTTP 头里取 token）。
//   - 试探端点是否存在的小技巧：**拿一个过期 token 发请求** —— 返回 4001 说明端点
//     存在（只是登录失效），返回 404 才是路径写错。本文件的两个路径就是这样做实的。
//
//   存放：state/wmpvp-token.json（**每次调用现读**，所以换 token 不用重启本服务）。
//   关键：请求体里 mySteamId 填 0，即可用该 token 查询**任意**玩家的数据，
//     不需要对方也登录（来自 wmpvp-rank-overlay 的实测注释）。
//
// 安全设计：只读；域名硬编码白名单；参数清洗与长度截断；不写任何本地业务数据。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'okhttp/4.9.2';
const APP_VERSION = '3.5.4.172';
const TIMEOUT_MS = Number(process.env.WMPVP_TIMEOUT_MS) || 25000;

// ── token ─────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(__dirname, '..');
const TOKEN_FILE = process.env.WMPVP_TOKEN_FILE || path.join(BRIDGE_ROOT, 'state', 'wmpvp-token.json');
// pwaweblogin.wmpvp.com 的接口要 a/r/s/t 签名；抓包代理会把抓到的签名写到这里。
const SIGN_FILE = process.env.WMPVP_SIGN_FILE || path.join(BRIDGE_ROOT, 'state', 'wmpvp-sign.json');

/** 每次现读 token，这样用户在网页/文件里更新后无需重启 MCP。 */
function readToken() {
  // 1) 环境变量优先（便于临时覆盖）
  if (process.env.WMPVP_TOKEN && String(process.env.WMPVP_TOKEN).trim()) {
    return String(process.env.WMPVP_TOKEN).trim();
  }
  // 2) state/wmpvp-token.json
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    const t = typeof j?.token === 'string' ? j.token.trim() : '';
    if (t) return t;
  } catch {
    // 文件不存在或损坏 → 视为未配置
  }
  return '';
}

/**
 * 读抓包存下来的接口签名（state/wmpvp-sign.json）。
 * pwaweblogin 的接口要 `a/r/s/t`，签名与 path 无关（实测两个不同 path 用同一签名），
 * 但有**时间窗口**——旧签名会返回 906 校验失败。所以只在抓到后尽快用。
 */
function readSign() {
  try {
    const raw = fs.readFileSync(SIGN_FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    if (j?.sign && j?.rand && j?.ts) {
      return {
        sign: String(j.sign),
        appId: String(j.appId || '20000'),
        rand: String(j.rand),
        ts: String(j.ts),
        capturedAt: j.capturedAt || null,
        ageSec: j.capturedAt ? Math.floor((Date.now() - Date.parse(j.capturedAt)) / 1000) : null
      };
    }
  } catch {}
  return null;
}

const NO_TOKEN_HINT =
  '完美平台需要登录 token 才能查赛季战绩/对局，而这个 token 只能靠抓包获取（完美没有可用的网页登录能拿到它）。' +
  '办法：在装了完美竞技平台的机器上重新登录客户端一次，同时用抓包工具（如 Reqable / Charles / Fiddler）' +
  '看它发往 api.wmpvp.com 的请求，把请求头里的 token 字段复制出来，写入 ' +
  'D:\\qq-bridge\\state\\wmpvp-token.json（形如 {"token":"粘贴到这里"}）。' +
  '注意：搜索玩家不需要 token，仍然可用。';

// ── 输入清洗 ──────────────────────────────────────────────────────
function sanitizeKeyword(input) {
  return String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function sanitizeSteamId(input) {
  const s = String(input ?? '').replace(/\s+/g, '').trim();
  return /^\d{17}$/.test(s) ? s : '';
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// ── 赛季编号 ──────────────────────────────────────────────────────
/** 'S24' / 's24' / '24' / 24 → 'S24'；无法识别返回 ''。 */
function normalizeSeason(input) {
  if (input === undefined || input === null) return '';
  const s = String(input).trim().toUpperCase();
  if (!s) return '';
  const m = s.match(/^S?(\d{1,3})$/);
  if (!m) return '';
  const n = Number(m[1]);
  return n >= 1 && n <= 99 ? `S${n}` : '';
}

/** 赛季列表（用于历史扫描）。完美赛季编号是 S1 起的连续整数，跳过无效的靠请求结果判断。 */
function seasonList(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(`S${i}`);
  return out;
}

const DEFAULT_SEASON_FROM = 1;
const DEFAULT_SEASON_TO = 30; // 当前是 S25；多扫几个以防将来赛季推进
const SCAN_CONCURRENCY = 6; // 实测并发 6 扫 25 个赛季约 0.6s

/** 并发跑一堆任务（保持结果顺序）。 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// 允许的域名白名单
const ALLOWED_HOSTS = new Set(['appengine.wmpvp.com', 'api.wmpvp.com']);

async function post(url, body, opts = {}) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.host)) throw new Error(`域名不在白名单：${u.host}`);
  let res;
  try {
    res = await fetch(u, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': opts.ua || UA,
        Referer: 'https://client.wmpvp.com',
        Origin: 'https://news.wmpvp.com',
        'x-requested-with': 'XMLHttpRequest',
        ...(opts.headers || {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`请求完美平台失败：${error?.message ?? error}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// ── 接口封装 ──────────────────────────────────────────────────────
/** 按昵称或 steamId 搜索玩家（免 token）。 */
async function searchUsers(keyword) {
  const { json, text } = await post('https://appengine.wmpvp.com/steamcn/app/search/user', {
    keyword: String(keyword),
    page: 1
  });
  if (!json || json.code !== 1) {
    throw new Error(`搜索接口返回异常：${String(text).slice(0, 160)}`);
  }
  const list = Array.isArray(json.result) ? json.result : [];
  return list.map((u) => ({
    steamId: u.steamId ?? null,
    nickname: u.pvpNickName ?? u.appNickName ?? u.steamNickName ?? null,
    完美昵称: u.pvpNickName ?? null,
    steam昵称: u.steamNickName ?? null,
    头像: u.pvpAvatar ?? u.steamAvatar ?? null,
    userId: u.userId ?? null,
    天梯分: typeof u.pvpScore === 'number' ? u.pvpScore : undefined
  }));
}

/** 解析玩家标识 → steamId64。 */
async function resolveSteamId(input) {
  const raw = sanitizeKeyword(input);
  if (!raw) return { error: '玩家标识是空的。' };
  const asId = sanitizeSteamId(raw);
  if (asId) return { steamId: asId, resolved: asId, via: 'steamId' };

  const list = await searchUsers(raw);
  if (!list.length) {
    return {
      error:
        `完美平台没搜到「${raw}」。可以给完整昵称（区分大小写），或直接给 17 位 SteamID64。` +
        '注意：只在完美平台打过天梯的账号才能搜到。'
    };
  }
  const exact = list.filter((u) => u.nickname === raw);

  // ⚠️ 防"报错人"：完美搜索是**模糊**的，前缀高度相似的号会混在一起。
  // 实测踩过：机器人自己的名字叫「今晚吃兔兔」，而完美里真有个人叫「今晚吃兔兔」（2021 年打过 S4），
  // 另一个人的号叫「今晚第一个吃兔兔」—— 搜「今晚吃兔兔」会把两者一起返回。
  // 所以在"存在互为前缀的近义候选"或"精确匹配不唯一"时，一律要求确认，不要擅自选一个。
  const similar = list.filter((u) => {
    const n = u.nickname;
    if (!n || n === raw) return false;
    return n.startsWith(raw) || raw.startsWith(n);
  });
  const exactUniq = exact.length === 1 ? exact[0] : null;
  if (exactUniq?.steamId && !similar.length) {
    return { steamId: exactUniq.steamId, resolved: exactUniq.nickname, via: 'nickname', profile: exactUniq };
  }
  if (exactUniq?.steamId && similar.length) {
    return {
      candidates: [exactUniq, ...similar].slice(0, 8),
      total: list.length,
      error:
        `「${raw}」在完美平台有 ${similar.length + 1} 个名字极为相近的玩家（名字互为前缀），` +
        '很可能不是同一个人，必须先确认是哪一个再查。'
    };
  }

  const pick = exact.length === 0 && list.length === 1 ? list[0] : null;
  if (pick?.steamId) return { steamId: pick.steamId, resolved: pick.nickname, via: 'nickname', profile: pick };
  return {
    candidates: list.slice(0, 8),
    total: list.length,
    error: `「${raw}」在完美平台匹配到 ${list.length} 个玩家，需要更准确的昵称或直接给 SteamID64。`
  };
}

/** 赛季统计（需 token）。season 传 'S24' / '24' 都能识别；不传 = 当前赛季。 */
async function fetchDetailStats(steamId, token, season) {
  // ⚠️ toSteamId 必须传**字符串**。SteamID64 约 1.8e16，超过 double 的 2^53 安全整数
  // 范围，传 Number 会被四舍五入成**另一个账号**（实测 ...869 → 服务端按 ...870 处理，
  // 于是返回别人的空数据，看起来像"这个号没打过天梯"）。踩过一次，别改回 Number。
  const body = { mySteamId: 0, toSteamId: String(steamId), accessToken: '' };
  const sid = normalizeSeason(season);
  if (sid) body.csgoSeasonId = sid; // 实测唯一能切赛季的参数名；seasonId/season 都无效
  const { json, text } = await post('https://api.wmpvp.com/api/csgo/home/pvp/detailStats', body, {
    headers: {
      token,
      appversion: APP_VERSION,
      platform: 'android',
      'User-Agent': 'okhttp/4.9.2'
    }
  });
  if (!json) throw new Error(`detailStats 返回非 JSON：${String(text).slice(0, 160)}`);
  const code = json.statusCode;
  if (code === 4001) return { loginExpired: true };
  if (code !== 0) {
    return { failed: true, message: json.errorMessage || `statusCode=${code}` };
  }
  const data = json.data ?? null;
  // 陷阱：请求不存在的赛季时接口**不报错**，而是把某个真实赛季的数据原样返回
  // （请求 S26~S30 都返回 S24 的 cnt/评分，只有 pvpScore 归零）。
  // 所以必须确认返回的 seasonId 就是请求的那个，否则数据不可信。
  const mismatch = !!(sid && data && data.seasonId && data.seasonId !== sid);
  return { data, requestedSeason: sid || null, actualSeason: data?.seasonId ?? null, mismatch };
}

/**
 * 单局详情（`pwaweblogin.wmpvp.com/match-api/detail`）。
 * 这个接口**存在**（实测缺签名返回 903、错签名返回 906），但要 `a/r/s/t` 签名，
 * 而签名算法用了客户端 JS 里的未知固定盐（爆破了 7 万多种组合都没还原），
 * 所以只能复用抓包抓到的签名。签名有**时间窗口**，过期会返回 906。
 * 没签名文件或签名过期时，明确告诉调用方，不要假装查到了。
 */
async function fetchMatchDetail(matchId, token) {
  const sg = readSign();
  if (!sg) {
    return {
      needSign: true,
      message:
        '完美平台的单局详情接口要一个接口签名（a/r/s/t），而这个签名只能靠抓包拿到。' +
        '用法：跑 抓取完美token.bat → 在客户端里打开一局对局的详情页 → 代理会自动把签名存到 ' +
        'state/wmpvp-sign.json → 然后尽快再问一次（签名有有效期）。'
    };
  }

  const qs = new URLSearchParams({
    a: sg.appId,
    r: sg.rand,
    s: sg.sign,
    t: sg.ts,
    access_token: token,
    matchId: String(matchId)
  });
  const u = new URL(`https://pwaweblogin.wmpvp.com/match-api/detail?${qs}`);
  let res;
  try {
    res = await fetch(u, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UA,
        appversion: APP_VERSION,
        Referer: 'https://client.wmpvp.com'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    return { failed: true, message: `请求单局详情失败：${e?.message ?? e}` };
  }
  let json = null;
  let text = '';
  try { text = await res.text(); json = JSON.parse(text); } catch {}
  if (!json) return { failed: true, message: `单局详情返回非 JSON：${String(text).slice(0, 160)}` };
  const code = json.code;
  if (code === 906) {
    return {
      signExpired: true,
      message: '签名已过期（906）。需要重新抓一次：打开客户端里某局对局的详情页，让代理抓到新签名。'
    };
  }
  if (code === 903) return { signExpired: true, message: '签名缺失或被拒（903）。' };
  if (code !== 0 && code !== 1) {
    return { failed: true, message: `单局详情返回 code=${code} ${json.msg || ''}`, raw: json };
  }
  return { data: json.data ?? json.result ?? json, signAgeSec: sg.ageSec };
}

/** 近期对局（需 token）。 */
async function fetchMatchList(steamId, token, limit = 10) {  const { json, text } = await post(
    'https://api.wmpvp.com/api/csgo/home/match/list', // 注意：不是 home/pvp/match/list（那个 404）
    { mySteamId: 0, toSteamId: String(steamId), page: 1, limit: Number(limit) || 10 },
    {
      headers: {
        token,
        appversion: APP_VERSION,
        platform: 'HarmonyOS',
        gametype: '2',
        gametypestr: '2',
        'User-Agent': 'libcurl-agent/1.0'
      }
    }
  );
  if (!json) throw new Error(`match/list 返回非 JSON：${String(text).slice(0, 160)}`);
  if (json.statusCode === 4001) return { loginExpired: true };
  if (json.statusCode !== 0) {
    return { failed: true, message: json.errorMessage || `statusCode=${json.statusCode}` };
  }
  // 字段名是 data.matchList（早期版本这里错写成 data.list，导致一直返回 0 场）。
  // 实测 limit 传多少都最多返回 10 条，且不支持 page/offset 翻页。
  const list = json.data?.matchList ?? json.data?.list ?? json.data ?? [];
  return { list: Array.isArray(list) ? list : [] };
}

/**
 * 把一条对局整理成可读对象。
 *
 * 胜负判据：`team === winTeam` 即胜。
 * 这是用 `deltaRank`（天梯分变动，正=上分=赢）交叉验证出来的，5/5 命中；
 * 而 `score1 > score2` 只有 2/5 命中，不能用。
 *
 * 比分语义：`score1`/`score2` 是**地图视角**的队伍比分（地图的 Team1/Team2），
 * 不是"本方/对方"。玩家在哪边就要按 team 翻转，否则会出现"赢了但 7-13 落后"。
 * 例：team=2, score1=7, score2=13 → 本方 13 : 对方 7（胜，deltaRank +408 ✓）
 */
function shapeMatch(g) {
  if (!g) return null;
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const team = num(g.team);
  const winTeam = num(g.winTeam);
  const win = team > 0 && winTeam > 0 && team === winTeam;
  const raw1 = num(g.score1);
  const raw2 = num(g.score2);
  // team=2 时本方是地图 Team2，所以翻转
  const mine = team === 2 ? raw2 : raw1;
  const theirs = team === 2 ? raw1 : raw2;

  const out = {
    时间: g.startTime ?? g.leaveTime ?? null,
    地图: g.mapName ?? null,
    模式: g.mode2 ?? g.mode ?? null,
    结果: win ? '胜' : '负',
    比分: `${mine}-${theirs}`,
    击杀: num(g.kill),
    死亡: num(g.death),
    助攻: num(g.assist),
    KD: num(g.death) ? Number((num(g.kill) / num(g.death)).toFixed(2)) : num(g.kill),
    Rating: num(g.rating)
  };
  const k4 = num(g.k4);
  const k5 = num(g.k5);
  const dur = num(g.duration);
  const ch = num(g.pvpScoreChange);
  if (k4) out.四杀 = k4;
  if (k5) out.五杀 = k5;
  if (g.mvp === true) out.MVP = true;
  if (dur) out.时长分钟 = dur;
  if (ch) out.段位分变化 = ch;
  return out;
}

/** 胜负（供汇总统计复用，判据与 shapeMatch 保持一致）。 */function isWin(g) {
  const team = Number(g?.team) || 0;
  const winTeam = Number(g?.winTeam) || 0;
  return team > 0 && winTeam > 0 && team === winTeam;
}

/** 本地日期（客户端返回的 startTime 已经是北京时间字符串 YYYY-MM-DD HH:mm:ss）。 */
function localDateString(offsetDays = 0) {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const matchDate = (g) => String(g?.startTime ?? g?.leaveTime ?? '').slice(0, 10);

/** 把 detailStats 的字段整理成中文（只映射确实返回了的字段）。 */
function shapeStats(d) {
  if (!d) return null;
  const out = {};
  const put = (label, v, suffix = '') => {
    if (v === undefined || v === null || v === '') return;
    out[label] = typeof v === 'number' ? `${v}${suffix}` : `${v}${suffix}`;
  };
  put('昵称', d.name);
  put('赛季', d.seasonId);
  put('段位分', d.pvpScore);
  put('段位星级', d.stars);
  put('赛季场次', d.cnt);
  put('胜率', d.winRate !== undefined ? `${(Number(d.winRate) * 100).toFixed(1)}%` : undefined);
  put('完美Rating', d.pwRating);
  put('平均WE', d.avgWe ?? d.avg_we);
  put('KD', d.kd);
  put('ADR', d.adr);
  put('RWS', d.rws);
  put('爆头率', d.headShotRatio !== undefined ? `${(Number(d.headShotRatio) * 100).toFixed(1)}%` : undefined);
  put('击杀', d.kills);
  put('死亡', d.deaths);
  put('助攻', d.assists);
  put('MVP', d.mvpCount);
  put('评价', d.summary);
  put('头像', d.avatar);
  // 未识别到的原始字段也带上，避免漏信息（但去掉明显空的）
  const known = new Set(['name', 'seasonId', 'pvpScore', 'stars', 'cnt', 'winRate', 'pwRating', 'avgWe', 'avg_we', 'kd', 'adr', 'rws', 'headShotRatio', 'kills', 'deaths', 'assists', 'mvpCount', 'summary', 'avatar']);
  const extra = {};
  for (const [k, v] of Object.entries(d)) {
    if (known.has(k)) continue;
    if (v === null || v === undefined || v === 0 || v === '' || v === 0.0) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    extra[k] = Array.isArray(v) ? v.slice(0, 10) : v;
  }
  if (Object.keys(extra).length) out['其他原始字段'] = extra;
  return out;
}

// ── 工具实现 ──────────────────────────────────────────────────────
async function toolSearch({ keyword }) {
  const clean = sanitizeKeyword(keyword);
  if (!clean) return err('昵称或 steamId 是空的。');
  const list = await searchUsers(clean);
  if (!list.length) {
    return ok({
      keyword: clean,
      total: 0,
      results: [],
      提示: '完美平台只在打过天梯的账号里能搜到。也可以让对方直接给 17 位 SteamID64。'
    });
  }
  return ok({
    keyword: clean,
    total: list.length,
    results: list,
    提示: '把 steamId 交给 get_wmpvp_player_stats / get_wmpvp_player_matches 查战绩。'
  });
}

/** 单赛季数据指纹（用于识别“幽灵赛季”的数据副本）。 */
function statFingerprint(d) {
  if (!d) return '';
  return [d.cnt, d.kills, d.deaths, d.assists, d.mvpCount, d.adr, d.rws, d.rating, d.pwRating].join('|');
}

/**
 * 幽灵赛季检测。
 * 完美平台对**超出范围的赛季号**不报错，而是回显请求的 seasonId + 返回某个真实赛季的
 * 数据副本（实测 S26~S30 都是 S24 的副本，且 pvpScore 被清零）。
 * 判据（任一成立）：
 *   1) 请求的赛季号 > 当前赛季号 → 这赛季还没到，必然不存在（最可靠）；
 *   2) 请求的 seasonId 与返回的不一致（明显错位）；
 *   3) 数据指纹与"当前赛季"完全相同。
 * 注意：S4/S17 这类早期赛季会出现 cnt>0 而 pvpScore=0，那是真实数据（当年还没段位分体系），
 * 所以**不能**用 pvpScore=0 判幽灵，否则会误杀。
 */
function seasonNumber(value) {
  const m = String(value ?? '').match(/^S?(\d{1,3})$/i);
  return m ? Number(m[1]) : 0;
}

function isPhantomCandidate(res, requestedSeason, currentSeason, baselineFp) {
  if (!res?.data) return false;
  const req = seasonNumber(requestedSeason);
  const cur = seasonNumber(currentSeason);
  if (req && cur && req > cur) return true; // 未来的赛季
  if (res.mismatch) return true;
  if (baselineFp && statFingerprint(res.data) === baselineFp) return true;
  return false;
}

async function toolStats({ player, season }) {
  const r = await resolveSteamId(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const token = readToken();
  const payload = { player: r.resolved || player, steamId: r.steamId, 解析方式: r.via };
  if (r.profile) payload.profile = r.profile;
  const wantSeason = normalizeSeason(season);
  if (season !== undefined && season !== null && String(season).trim() && !wantSeason) {
    payload.赛季参数有问题 = `看不懂「${season}」。用 S24 或 24 这种写法；不传就是当前赛季。`;
    return ok(payload);
  }
  if (wantSeason) payload.查询赛季 = wantSeason;

  if (!token) {
    payload.需要配置 = NO_TOKEN_HINT;
    payload.数据来源 = '完美世界竞技平台（appengine.wmpvp.com / api.wmpvp.com）';
    return ok(payload);
  }

  const res = await fetchDetailStats(r.steamId, token, wantSeason);
  if (res.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，需要重新获取并写入 state/wmpvp-token.json。' + NO_TOKEN_HINT;
    return ok(payload);
  }
  if (res.failed) {
    payload.查询失败 = res.message;
    return ok(payload);
  }

  // 查具体赛季时，先拿"当前赛季"当基线：它的 seasonId 给出赛季号上限，指纹用于比对副本。
  let baselineFp = '';
  let currentSeason = '';
  if (wantSeason) {
    const base = await fetchDetailStats(r.steamId, token);
    if (!base.loginExpired && !base.failed && base.data) {
      baselineFp = statFingerprint(base.data);
      currentSeason = base.data.seasonId || '';
      payload.当前赛季 = currentSeason;
    }
  }

  if (isPhantomCandidate(res, wantSeason, currentSeason, baselineFp)) {
    payload.赛季不存在 =
      `完美平台没有 ${wantSeason} 赛季的数据（这个赛季号超出范围了，平台会返回别赛季的副本，不可信）。` +
      (currentSeason ? `当前赛季是 ${currentSeason}。` : '');
    if (!currentSeason) {
      const cur = await fetchDetailStats(r.steamId, token);
      if (!cur.loginExpired && !cur.failed && cur.data) {
        payload.赛季统计 = shapeStats(cur.data);
        payload.当前赛季 = cur.data.seasonId;
      }
    }
    payload.数据来源 = '完美世界竞技平台；只陈述返回内容，不要编造。';
    return ok(payload);
  }

  const shaped = shapeStats(res.data);
  if (!shaped || !Object.keys(shaped).length) {
    payload.说明 = wantSeason
      ? `完美平台没有这个账号 ${wantSeason} 赛季的数据（那个赛季可能没打天梯）。`
      : '完美平台没有返回这个账号的赛季数据（可能本赛季没打天梯）。可以加 season 参数查历史赛季，或让群友问“他历史最高赛季”。';
  } else {
    payload.赛季统计 = shaped;
    const cnt = Number(res.data?.cnt ?? 0);
    if (cnt === 0) {
      payload.说明 = wantSeason
        ? `${wantSeason} 赛季这个账号没有天梯场次，所以下面各项都是 0。`
        : '当前赛季这个账号没有天梯场次（各项为 0）。要看他以前的战绩，用 get_wmpvp_player_season_history。';
    }
  }
  payload.数据来源 = '完美世界竞技平台；只陈述返回内容，不要编造。';
  return ok(payload);
}

/** 单赛季精简一行（用于历史扫描表格）。 */
function seasonRow(sid, d) {
  const num = (v) => (typeof v === 'number' ? v : 0);
  return {
    赛季: sid,
    场次: num(d.cnt),
    KD: num(d.kd),
    段位分: num(d.pvpScore),
    完美Rating: num(d.pwRating),
    胜率: `${(num(d.winRate) * 100).toFixed(1)}%`,
    ADR: num(d.adr),
    RWS: num(d.rws),
    爆头率: `${(num(d.headShotRatio) * 100).toFixed(1)}%`,
    多杀: num(d.multiKill),
    MVP: num(d.mvpCount),
    评价: d.summary ?? null
  };
}

/** 历史赛季扫描：逐赛季取数据，汇总出最高段位等。 */
async function toolSeasonHistory({ player, fromSeason, toSeason }) {
  const r = await resolveSteamId(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const token = readToken();
  const payload = { player: r.resolved || player, steamId: r.steamId, 解析方式: r.via };
  if (!token) {
    payload.需要配置 = NO_TOKEN_HINT;
    return ok(payload);
  }

  const from = Math.max(1, Number(fromSeason) || DEFAULT_SEASON_FROM);
  const to = Math.min(99, Number(toSeason) || DEFAULT_SEASON_TO);
  if (from > to) {
    payload.参数有问题 = `fromSeason(${from}) 不能大于 toSeason(${to})`;
    return ok(payload);
  }

  const seasons = seasonList(from, to);
  payload.扫描范围 = `${seasons[0]} ~ ${seasons[seasons.length - 1]}（共 ${seasons.length} 个赛季）`;
  payload.说明 = '完美平台没有“一次返回所有赛季”的接口，这里是逐赛季查询后汇总（实测约 1 秒内完成）。';

  // 先问一次"当前赛季"，它的编号就是赛季号上限——高过它的都是不存在的赛季。
  const base = await fetchDetailStats(r.steamId, token);
  if (base.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }
  const currentSeason = base.data?.seasonId || '';
  const currentNum = seasonNumber(currentSeason);
  if (currentSeason) payload.当前赛季 = currentSeason;

  const results = await mapPool(seasons, SCAN_CONCURRENCY, async (sid) => {
    try {
      if (currentNum && seasonNumber(sid) > currentNum) return { sid, phantom: true, reason: '晚于当前赛季' };
      const res = await fetchDetailStats(r.steamId, token, sid);
      if (res.loginExpired) return { sid, loginExpired: true };
      if (res.failed || !res.data) return { sid, empty: true };
      if (res.mismatch) return { sid, phantom: true, reason: 'seasonId 不符' };
      if (!Number(res.data.cnt)) return { sid, empty: true };
      return { sid, data: res.data };
    } catch {
      return { sid, empty: true };
    }
  });

  if (results.some((x) => x.loginExpired)) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }

  const played = results.filter((x) => x.data);
  if (!played.length) {
    payload.说明2 = `这个账号在 ${seasons[0]}~${seasons[seasons.length - 1]} 里没有查到任何打过的赛季。`;
    return ok(payload);
  }

  // 去掉“幽灵赛季”：请求超出范围的赛季时，接口会**回显请求的 seasonId** 却返回
  // 某个真实赛季的数据副本（实测 S26~S30 都是 S24 的副本，只有 pvpScore 被清零）。
  // 所以按数据指纹分组，同一指纹里只保留赛季号最小的那个。
  const phantom = results.filter((x) => x.phantom).map((x) => x.sid);
  const dedup = new Map();
  for (const x of played) {
    const d = x.data;
    const fp = [d.cnt, d.kills, d.deaths, d.assists, d.mvpCount, d.adr, d.rws, d.rating, d.pwRating].join('|');
    const n = Number(String(x.sid).slice(1));
    const prev = dedup.get(fp);
    if (!prev) dedup.set(fp, { sid: x.sid, n, data: d });
    else if (n < prev.n) {
      dedup.set(fp, { sid: x.sid, n, data: d });
      if (!phantom.includes(prev.sid)) phantom.push(prev.sid);
    } else if (!phantom.includes(x.sid)) {
      phantom.push(x.sid);
    }
  }
  const real = [...dedup.values()].sort((a, b) => a.n - b.n);
  const rows = real.map((x) => seasonRow(x.sid, x.data));

  // 汇总
  const byScore = [...rows].sort((a, b) => b.段位分 - a.段位分 || b.场次 - a.场次);
  const best = byScore[0];
  const byCnt = [...rows].sort((a, b) => b.场次 - a.场次);
  const enough = rows.filter((x) => x.场次 >= 5);
  const byKd = [...(enough.length ? enough : rows)].sort((a, b) => b.KD - a.KD);
  const byRating = [...(enough.length ? enough : rows)].sort((a, b) => b.完美Rating - a.完美Rating);

  const totalMatches = rows.reduce((a, b) => a + b.场次, 0);
  if (phantom.length) {
    payload.已忽略的幽灵赛季 = `${phantom.sort().join(', ')}（完美平台对这些不存在的赛季会返回别赛季的数据副本，已剔除）`;
  }
  payload.汇总 = {
    打过天梯的赛季数: rows.length,
    总场次: totalMatches,
    段位分最高: `${best.赛季}（${best.段位分} 分，${best.场次} 场）`,
    段位分最高赛季完整数据: best,
    场次最多: `${byCnt[0].赛季}（${byCnt[0].场次} 场）`,
    'KD 最高（≥5 场）': `${byKd[0].赛季}（KD ${byKd[0].KD}）`,
    'Rating 最高（≥5 场）': `${byRating[0].赛季}（Rating ${byRating[0].完美Rating}）`,
    最近一个赛季: [...rows].sort((a, b) => Number(b.赛季.slice(1)) - Number(a.赛季.slice(1)))[0].赛季
  };
  payload.各赛季 = rows;
  payload.数据来源 = '完美世界竞技平台；只陈述返回内容，不要编造。段位分字段是 pvpScore。';
  return ok(payload);
}

async function toolMatches({ player, limit }) {
  const r = await resolveSteamId(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const token = readToken();
  const payload = { player: r.resolved || player, steamId: r.steamId };
  if (!token) {
    payload.需要配置 = NO_TOKEN_HINT;
    return ok(payload);
  }
  const res = await fetchMatchList(r.steamId, token, limit ?? 10);
  if (res.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }
  if (res.failed) {
    payload.查询失败 = res.message;
    return ok(payload);
  }
  if (!res.list.length) {
    payload.说明 = '没有查到近期对局。';
    return ok(payload);
  }
  payload.对局条数 = res.list.length;
  payload.对局 = res.list.map(shapeMatch);
  payload.数据来源 = '完美世界竞技平台（match/list，最多返回 10 条，不支持翻页）';
  return ok(payload);
}

/** 最近一把单局详情。 */
async function toolLastMatch({ player, season }) {
  const r = await resolveSteamId(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const token = readToken();
  const payload = { player: r.resolved || player, steamId: r.steamId, 解析方式: r.via };
  const wantSeason = normalizeSeason(season);
  if (season !== undefined && season !== null && String(season).trim() && !wantSeason) {
    payload.赛季参数有问题 = `看不懂「${season}」。用 S24 或 24 这种写法。`;
    return ok(payload);
  }
  if (wantSeason) payload.查询赛季 = wantSeason;
  if (!token) {
    payload.需要配置 = NO_TOKEN_HINT;
    return ok(payload);
  }

  // 先走 match/list（有完整 KDA/Rating/比分/地图）
  const res = await fetchMatchList(r.steamId, token, 10);
  if (res.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }
  if (res.failed) {
    payload.查询失败 = res.message;
    return ok(payload);
  }

  if (res.list.length) {
    const sorted = [...res.list].sort((a, b) => Number(b.timeStamp || 0) - Number(a.timeStamp || 0));
    const top = sorted[0];
    payload.最近一把 = shapeMatch(top);
    payload.原始字段 = top;
    // 有签名就顺手试一下单局详情（能拿到玩家列表等更细的数据）
    if (top.matchId) {
      const detail = await fetchMatchDetail(top.matchId, token);
      if (detail.data) {
        payload.单局详情 = detail.data;
        payload.签名的年龄秒 = detail.signAgeSec;
      } else if (detail.needSign || detail.signExpired) {
        payload.单局详情说明 = detail.message;
      }
    }
    payload.数据来源 = '完美世界竞技平台（match/list 的第一条，按 timeStamp 排序）';
    return ok(payload);
  }

  // match/list 只覆盖"最近几天"，所以想看更早/指定赛季的最后一把，只能退回 detailStats 的 scoreList。
  // scoreList 里每场有 matchId / time / score（段位分），但**没有地图和 KDA**。
  const stat = await fetchDetailStats(r.steamId, token, wantSeason);
  if (stat.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }
  if (stat.failed || !stat.data) {
    payload.说明 = '没有查到对局记录。';
    return ok(payload);
  }
  const d = stat.data;
  const scores = [...(d.scoreList || [])].sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
  payload.赛季 = d.seasonId;
  payload.说明 = '完美平台的 match/list 只覆盖最近几天的对局，这场更早，所以拿不到地图/KDA/比分；'
    + '下面是用赛季统计里的 scoreList 还原出的时间与段位分。';
  if (scores.length) {
    const last = scores[0];
    payload.该赛季最后一把 = {
      时间: last.time ? new Date(Number(last.time) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
      matchId: last.matchId ?? null,
      记录段位分: Number(last.score) || null
    };
    payload.该赛季场次 = d.cnt ?? null;
    payload.该赛季段位分 = Number(d.pvpScore) || null;
    payload.该赛季评价 = d.summary ?? null;
    // 该赛季全部场次的时间线
    payload.该赛季全部场次 = scores.slice(0, 30).map((x) => ({
      时间: x.time ? new Date(Number(x.time) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
      段位分: Number(x.score) || null
    }));
    // 赛季地图明细（有这些场的汇总）
    if (Array.isArray(d.hotMaps) && d.hotMaps.length) {
      payload.该赛季地图明细 = d.hotMaps.map((m) => ({
        地图: m.mapName,
        场次: Number(m.totalMatch) || 0,
        胜: Number(m.winCount) || 0,
        击杀: Number(m.totalKill) || 0,
        首杀: Number(m.firstKillNum) || 0,
        MVP: Number(m.matchMvpNum) || 0
      }));
    }
  } else {
    payload.该赛季无场次记录 = true;
  }
  payload.数据来源 = '完美世界竞技平台（detailStats 的 scoreList / hotMaps）';
  return ok(payload);
}

/** 今日 / 昨日战绩总结。传 date 可指定某一天。 */
async function toolDailySummary({ player, days, date }) {
  const r = await resolveSteamId(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const token = readToken();
  const payload = { player: r.resolved || player, steamId: r.steamId, 解析方式: r.via };
  if (!token) {
    payload.需要配置 = NO_TOKEN_HINT;
    return ok(payload);
  }

  const wanted = [];
  const dateArg = date === undefined || date === null ? '' : String(date).trim();
  if (dateArg) {
    const d = dateArg.replace(/\//g, '-');
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) {
      payload.参数有问题 = `date 要写成 YYYY-MM-DD，例如 ${localDateString(0)}。`;
      return ok(payload);
    }
    const [y, m, dd] = d.split('-');
    wanted.push(`${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`);
  } else {
    const n = Math.min(7, Math.max(1, Number(days) || 2)); // 1=只看今天，2=今天+昨天
    for (let i = 0; i < n; i++) wanted.push(localDateString(-i));
  }

  const res = await fetchMatchList(r.steamId, token, 10);
  if (res.loginExpired) {
    payload.token已过期 = '完美平台的 token 失效了，请重新获取。';
    return ok(payload);
  }
  if (res.failed) {
    payload.查询失败 = res.message;
    return ok(payload);
  }

  const buckets = new Map(wanted.map((d) => [d, []]));
  let earliest = null;
  for (const g of res.list) {
    const d = matchDate(g);
    if (!d) continue;
    if (!earliest || d < earliest) earliest = d;
    if (buckets.has(d)) buckets.get(d).push(g);
  }

  const today = localDateString(0);
  const yesterday = localDateString(-1);
  const label = (d) => (d === today ? `${d}（今天）` : d === yesterday ? `${d}（昨天）` : d);
  const summarize = (arr, dateLabel) => {
    if (!arr.length) {
      return { 日期: dateLabel, 场次: 0, 说明: '这天没有对局记录。' };
    }
    const sorted = [...arr].sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
    const wins = sorted.filter(isWin).length;
    const sum = (f) => sorted.reduce((a, g) => a + (Number(f(g)) || 0), 0);
    const kills = sum((g) => g.kill);
    const deaths = sum((g) => g.death);
    const assists = sum((g) => g.assist);
    const ratings = sorted.map((g) => Number(g.rating) || 0);
    const best = [...sorted].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0))[0];
    const worst = [...sorted].sort((a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0))[0];
    const first = sorted[0];
    const lastM = sorted[sorted.length - 1];
    const netScore = sorted.reduce((a, g) => a + (Number(g.pvpScoreChange) || 0), 0);
    const out = {
      日期: dateLabel,
      场次: sorted.length,
      胜负: `${wins} 胜 ${sorted.length - wins} 负`,
      胜率: `${((wins / sorted.length) * 100).toFixed(0)}%`,
      总KDA: `${kills}/${deaths}/${assists}`,
      场均击杀: Number((kills / sorted.length).toFixed(1)),
      场均死亡: Number((deaths / sorted.length).toFixed(1)),
      总KD: deaths ? Number((kills / deaths).toFixed(2)) : kills,
      平均Rating: Number((ratings.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)),
      最佳一场: best ? { 时间: best.startTime, 地图: best.mapName, 战绩: `${best.kill}/${best.death}/${best.assist}`, Rating: best.rating } : null,
      最差一场: worst ? { 时间: worst.startTime, 地图: worst.mapName, 战绩: `${worst.kill}/${worst.death}/${worst.assist}`, Rating: worst.rating } : null,
      时间跨度: `${first.startTime} ~ ${lastM.startTime}`,
      对局: sorted.map(shapeMatch)
    };
    if (netScore) out.段位分净变化 = netScore;
    return out;
  };
  function num(v) { return Number(v) || 0; }

  payload.总结 = wanted.map((d) => summarize(buckets.get(d), label(d)));
  payload.说明 = `完美平台的对局接口最多只返回最近 10 场，所以超过 10 场的日子只会统计到这 10 场里的部分。`;
  if (earliest) payload.数据覆盖到 = `${earliest} ~ ${res.list[0]?.startTime?.slice(0, 10) || ''}`;
  if (!res.list.length) payload.说明2 = '这个账号没有查到任何对局记录。';
  payload.数据来源 = '完美世界竞技平台（match/list，按 startTime 的日期分组）';
  return ok(payload);
}

// ── 注册 ─────────────────────────────────────────────────────────
const server = new McpServer({ name: 'cs-wmpvp-stats', version: '0.1.0' });
// ── 工具合并（2026-09-28）─────────────────────────────────────────────
// 下面每个 server.tool(...) 都先被**收集**起来，文件末尾统一暴露成一个入口
// （见最后的 __origTool 注册）。handler / 描述 / schema 一个都没改。
// 目的：工具定义每回合都进上下文，cs-wmpvp-stats 原来那几个工具加起来 ≈ 每回合几百 token。
const registeredTools = new Map();
const __origTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => {
  registeredTools.set(name, { description, schema, handler });
};


server.tool(
  'search_wmpvp_player',
  '只读搜索完美世界竞技平台（完美平台，国内 CS）玩家，按昵称或 SteamID64 返回候选（昵称/steamId/头像/天梯分）。群友只给了昵称时先用它确认是谁。**不需要 token。** '
    + '⚠️ 群友 @ 你（用你自己的昵称）时，那是在叫你，不是让你查那个人——别拿你自己的名字去搜完美。'
    + '若返回「名字极为相近」的多个候选，必须让群友确认是哪一个，绝不擅自选一个。',
  { keyword: z.string().describe('完美平台昵称，或 17 位 SteamID64') },
  async (args) => {
    try {
      return await toolSearch(args);
    } catch (error) {
      return err(`搜索失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_wmpvp_player_stats',
  '只读查询完美世界竞技平台（完美平台，国内 CS）玩家赛季统计：段位分/星级、赛季场次与胜率、完美 Rating、ADR、RWS、爆头率、KD、评价。群友问“他完美什么段位/完美战绩”时用它。不传 season 就是当前赛季；要查历史赛季（如“上赛季”）就传 season，例如 S24 或 24。需要先在 state/wmpvp-token.json 配置 token。',
  {
    player: z.string().describe('完美平台昵称，或 17 位 SteamID64'),
    season: z
      .union([z.string(), z.number()])
      .optional()
      .describe('赛季，例如 S24 或 24。不传 = 当前赛季。要“上赛季”就先看当前是 S几再减一。')
  },
  async (args) => {
    try {
      return await toolStats(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_wmpvp_player_season_history',
  '只读扫描完美世界竞技平台（完美平台，国内 CS）玩家的**历史各赛季**数据，并汇总出段位分最高的赛季、场次最多/KD 最高/Rating 最高的赛季。群友问“他历史最高什么段位/哪个赛季最强/上赛季打得怎么样/一共打了多少场”时用它。会比单赛季查询慢一点（逐赛季扫描，约 1 秒）。需要配置 token。',
  {
    player: z.string().describe('完美平台昵称，或 17 位 SteamID64'),
    fromSeason: z.number().optional().describe('从第几赛季开始扫，默认 1（即 S1）'),
    toSeason: z.number().optional().describe('扫到第几赛季，默认 30')
  },
  async (args) => {
    try {
      return await toolSeasonHistory(args);
    } catch (error) {
      return err(`扫描失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_wmpvp_player_matches',
  '只读查询完美世界竞技平台（完美平台，国内 CS）玩家的近期对局列表（最多最近 10 场，含地图/比分/胜负/KDA/Rating/MVP）。群友问“他完美最近打得怎么样”时用它。需要配置 token。',
  {
    player: z.string().describe('完美平台昵称，或 17 位 SteamID64'),
    limit: z.number().optional().describe('条数，默认 10（完美平台最多只返回 10 条）')
  },
  async (args) => {
    try {
      return await toolMatches(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_wmpvp_last_match',
  '只读查询完美世界竞技平台（完美平台，国内 CS）玩家**最近一把**单局战绩：地图、比分、胜负、KDA、Rating、四杀/五杀、MVP、时长、段位分变化。群友问“他最近这把打得怎么样/刚那把如何”时用它。若对方想看更早或某个赛季的最后一把，传 season（那时只有时间和段位分，没有地图/KDA）。需要配置 token。',
  {
    player: z.string().describe('完美平台昵称，或 17 位 SteamID64'),
    season: z
      .union([z.string(), z.number()])
      .optional()
      .describe('想看某个赛季的最后一把就传，例如 S24 或 24。不传 = 最近一把')
  },
  async (args) => {
    try {
      return await toolLastMatch(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_wmpvp_daily_summary',
  '只读查询完美世界竞技平台（完美平台，国内 CS）玩家**今天/昨天**的战绩总结：场次、胜负、总 KDA、场均击杀死亡、平均 Rating、最佳/最差一场、段位分净变化。群友问“他今天打得怎么样/昨天赢了几把/今天上了多少分”时用它。需要配置 token。',
  {
    player: z.string().describe('完美平台昵称，或 17 位 SteamID64'),
    days: z.number().optional().describe('统计最近几天，默认 2（今天+昨天），最大 7'),
    date: z.string().optional().describe('只统计指定某一天，格式 YYYY-MM-DD（传了它 days 就无效）')
  },
  async (args) => {
    try {
      return await toolDailySummary(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);


// ── 单一入口：action 分发 ──────────────────────────────────────────────
// 对外只暴露一个工具：用 action 选具体查询、参数照旧。
// 对外短名由原名去掉冗余前缀得到（get_wmpvp_player_stats → player_stats），
// 旧全名同时作为**别名**保留，人格卡/记忆里写过的老名字不会失效。
const ACTION_STRIP = /^(get_wmpvp_|search_wmpvp_)/;
const exposedActions = new Map();   // 对外短名 → 原工具
const actionAliases = new Map();    // 旧全名 / 短名 → 对外短名
for (const [orig, t] of registeredTools) {
  const short = orig.replace(ACTION_STRIP, '');
  const use = exposedActions.has(short) ? orig : short;   // 撞名就退回原名，绝不互相覆盖
  if (!exposedActions.has(use)) exposedActions.set(use, t);
  actionAliases.set(orig, use);
}
const actionNames = [...exposedActions.keys()];
// 各 action 的描述开头都是同一句「只读查询 XX 平台（…）玩家」：逐条重复纯属浪费 token，
// 这里按服务器剥掉这句套话（不许用"最长公共前缀"——有的写"只读搜索"有的写"只读查询"，
// 公共前缀只有"只读"两字，根本剥不动）。
const ACTION_BOILER = /^只读(?:查询|搜索|扫描)\s*完美世界竞技平台（完美平台，国内 CS）\s*(?:玩家)?的?[，,]?/;
const actionDescs = new Map(actionNames.map((n) => [n, String(exposedActions.get(n)?.description ?? '').replace(/\s+/g, ' ').trim()]));
const actionBrief = (n) => {
  let s = actionDescs.get(n) ?? '';
  const stripped = s.replace(ACTION_BOILER, '').trim();
  if (stripped.length >= 6) s = stripped;
  const first = s.split(/[。；;]/)[0] ?? '';
  return first.length > 46 ? first.slice(0, 46) + '…' : first;
};
// 参数表：按名字取**第一个**声明它的 schema（描述/枚举都更有用），一律 optional ——
// 真正的必填校验在下面按 action 取各自 schema 再做，报错也更准。
// action 用 z.string() 而不是 z.enum(actionNames)：z.enum 会在 SDK 层就把"旧工具全名"
// 这种别名拒掉（Invalid option），轮不到我们的 handler 去解析别名。合法值在工具描述里
// 逐条列着，写错会收到"未知 action，可用：…"。
const dispatchShape = { action: z.string().describe('要执行哪个查询；可选值见工具描述里的 action 清单') };
for (const t of exposedActions.values()) {
  for (const [k, v] of Object.entries(t.schema ?? {})) {
    if (k === 'action' || k in dispatchShape) continue;
    dispatchShape[k] = (typeof v?.optional === 'function' ? v.optional() : z.any().optional());
  }
}
__origTool(
  'query',
  'CS（完美世界竞技平台）只读查询。一个入口，用 action 选具体查询：\n'
  + actionNames.map((n) => `- action="${n}"：${actionBrief(n)}`).join('\n')
  + '\n一次只查一件事；参数按各 action 的说明给，缺必填会明确告诉你缺哪个（旧工具全名也能当 action 用）。',
  dispatchShape,
  async (args) => {
    const asked = args?.action;
    const key = exposedActions.has(asked) ? asked : actionAliases.get(asked);
    const t = key ? exposedActions.get(key) : null;
    if (!t) {
      return { content: [{ type: 'text', text: `未知 action「${asked}」。可用：${actionNames.join('、')}` }], isError: true };
    }
    const rest = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === 'action' || v === undefined || v === null) continue;
      rest[k] = v;
    }
    const parsed = z.object(t.schema ?? {}).safeParse(rest);
    if (!parsed.success) {
      const why = (parsed.error?.issues ?? [])
        .map((i) => `${(i.path ?? []).join('.') || '参数'}：${i.message}`).join('；');
      return { content: [{ type: 'text', text: `action=${key} 的参数不对：${why}` }], isError: true };
    }
    try {
      return await t.handler(parsed.data);
    } catch (error) {
      return { content: [{ type: 'text', text: `${key} 执行失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// DSH 换代时关掉 stdin（热重载/重启）时，MCP SDK 不保证本进程会退出，
// 会留下空闲僵尸进程（实测热重载一次就有两个）。stdin 一断就干净退出。
// 用 globalThis 取 process：审计测试会在没有 process 的 vm 沙箱里加载本文件。
const exitOnStdinClose = () => { try { globalThis.process?.exit(0); } catch {} };
globalThis.process?.stdin?.on?.('end', exitOnStdinClose);
globalThis.process?.stdin?.on?.('close', exitOnStdinClose);
// 注意：**不要**在这里 process.stdin.resume() —— 那会提前进入 flowing 模式，
// 把客户端刚发出的 initialize 请求吞掉（StdioServerTransport 自己去读 stdin）。

await server.connect(new StdioServerTransport());
