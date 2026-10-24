// CS（5E 对战平台）战绩查询 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 数据源：5E 的公开网页接口（免 token、免登录）：
//   1) arena.5eplay.com/api/search/player/1/16?keywords=<昵称>   按昵称搜人 → domain
//   2) gate.5eplay.com/userinterface/http/v1/userinterface/idTransfer   domain → uuid
//   3) gate.5eplay.com/crane/http/api/data/player/home?uuid=<uuid>      赛季数据（ELO/击杀/ADR…）
//   4) gate.5eplay.com/crane/http/api/data/match/list?uuid=<uuid>…      对局列表（地图/胜负/KDA/ELO）
//
// 为什么用 5E 而不是 Leetify/Steam：
//   国内 CS 玩家主要打 5E 和完美平台，Leetify 追踪的是 FACEIT/官方匹配，查不到国内对局；
//   而 Steam 官方 API 与 steamcommunity 在部分网络下不可达。
//
// 安全设计：
// - 只读；出网域名在代码里硬编码白名单，不接受任意 URL；参数做清洗与长度截断。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://view-arena.5eplay.com/';
const TIMEOUT_MS = Number(process.env.CS5E_TIMEOUT_MS) || 25000;

// 允许访问的域名白名单（顺序即解析链路）
const ALLOWED_HOSTS = new Set(['arena.5eplay.com', 'gate.5eplay.com']);

// domain → uuid 的接口用的是写死的 HMAC 签名（签名头只有 Accept-Language 和空的 Authorization），
// 所以可以照抄；这个签名与用户身份无关。
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

function sanitizeKeyword(input) {
  return String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function sanitizeUuid(input) {
  const s = String(input ?? '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : '';
}

function sanitizeDomain(input) {
  const s = String(input ?? '').trim();
  return /^[A-Za-z0-9_-]{2,40}$/.test(s) ? s : '';
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

async function call(url, opts = {}) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.host)) throw new Error(`域名不在白名单：${u.host}`);
  let res;
  try {
    res = await fetch(u, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: '*/*',
        ...(opts.headers || {})
      },
      body: opts.body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`请求 5E 失败：${error?.message ?? error}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.status !== 200) throw new Error(`5E 返回 HTTP ${res.status}`);
  return { json, text };
}

// ── 5E 接口封装 ────────────────────────────────────────────────────
async function search5e(keyword) {
  const { json } = await call(
    `https://arena.5eplay.com/api/search/player/1/16?keywords=${encodeURIComponent(keyword)}`
  );
  const list = json?.data?.user?.list ?? [];
  return list.map((p) => ({
    nickname: p.username ?? null,
    domain: p.domain ?? null,
    avatar: p.avatar_url ? `https://oss-arena.5eplay.com/${String(p.avatar_url).replace(/^\//, '')}` : null,
    gender: p.gender === 1 ? '男' : p.gender === 2 ? '女' : undefined
  }));
}

async function domainToUuid(domain) {
  const { json } = await call('https://gate.5eplay.com/userinterface/http/v1/userinterface/idTransfer', {
    method: 'POST',
    headers: ID_TRANSFER_HEADERS,
    body: JSON.stringify({ trans: { domain } })
  });
  const uuid = json?.data?.uuid;
  return typeof uuid === 'string' && sanitizeUuid(uuid) ? uuid : '';
}

/**
 * 把用户给的标识（昵称 / domain / uuid）解析成 uuid。
 *
 * 顺序很重要：**先按昵称搜索拿 domain，再换 uuid**。
 * 不能反过来"先把输入当 domain 试"——实测把昵称 `ropz` 直接丢给 idTransfer 会返回
 * 另一个账号的 uuid（idTransfer 对任意字符串都尝试解析），从而查到错误的人。
 * 只有昵称搜不到时，才把输入当作 domain 试一次。
 */
async function resolvePlayer(input) {
  const raw = sanitizeKeyword(input);
  if (!raw) return { error: '玩家标识是空的。' };

  // 直接就是 uuid
  const asUuid = sanitizeUuid(raw);
  if (asUuid) return { uuid: asUuid, resolved: raw, via: 'uuid' };

  // 先按昵称精确搜索
  let list = [];
  try {
    list = await search5e(raw);
  } catch {
    list = [];
  }
  const exact = list.filter((p) => p.nickname === raw);

  // 精确命中一个 → 用它（5E 允许同名，多个精确命中时交给调用方确认）
  if (exact.length === 1 && exact[0].domain) {
    const uuid = await domainToUuid(exact[0].domain);
    if (uuid) return { uuid, resolved: exact[0].nickname, via: 'nickname' };
  }
  if (exact.length > 1) {
    return {
      candidates: exact.slice(0, 8),
      total: exact.length,
      error: `5E 上有 ${exact.length} 个玩家都叫「${raw}」，需要对方给出个人主页链接里的 domain（形如 0817kggjivhk）才能确定是哪个。`
    };
  }

  // 昵称没精确命中：把输入当 domain 试（用户可能直接给了主页里的那串）
  const asDomain = sanitizeDomain(raw);
  if (asDomain) {
    try {
      const uuid = await domainToUuid(asDomain);
      if (uuid) return { uuid, resolved: raw, via: 'domain' };
    } catch {
      // 忽略，继续报"搜不到"
    }
  }

  // 有近似结果就列出来供参考
  if (list.length) {
    return {
      candidates: list.slice(0, 8),
      total: list.length,
      error: `5E 没有昵称恰好等于「${raw}」的玩家（搜索是精确匹配，区分大小写）。下面是相近结果，确认后可用 domain 查。`
    };
  }
  return {
    error:
      `5E 搜不到「${raw}」。搜索是精确匹配昵称，请注意大小写与特殊符号；` +
      '也可以让对方报 5E 个人主页链接里的那串 domain（形如 0817kggjivhk）。'
  };
}

/** 赛季数据：挑出有场次的赛季，翻译关键字段。 */
function shapeSeasonHome(home) {
  const out = { 当前赛季: home?.now_season ?? null, 上赛季: home?.before_season ?? null, 各模式: [] };
  const sd = home?.season_data;
  if (!sd || typeof sd !== 'object') return out;
  for (const item of Object.values(sd)) {
    if (!item || typeof item !== 'object') continue;
    const matches = Number(item.match_total) || 0;
    // 没有任何场次的模式跳过（接口会列出所有模式）
    if (!matches && !Number(item.kill)) continue;
    out.各模式.push({
      模式: item.name ?? String(item.match_type ?? ''),
      赛季: item.season ?? null,
      是否当前赛季: item.season_flag === 'now',
      场次: matches,
      胜: Number(item.win_match_total) || 0,
      负: Number(item.loss_match_total) || 0,
      平: Number(item.tie_total) || 0,
      胜率: matches ? `${((Number(item.win_match_total) || 0) / matches * 100).toFixed(1)}%` : undefined,
      ELO: item.elo !== undefined ? Number(item.elo) : undefined,
      段位等级: item.level_id || undefined,
      击杀: Number(item.kill) || 0,
      首杀: Number(item.first_kill) || 0,
      首死: Number(item.first_death) || 0,
      RWS: item.rws !== undefined ? Number(item.rws) : undefined,
      ADR: item.adr !== undefined ? Number(item.adr) : undefined,
      评分: item.rating !== undefined ? Number(item.rating) : undefined,
      // 5E 的 per_headshot 是**比值**（0.43 表示 43%），不是百分数；个别情况下也可能已是百分数。
      // 小于 1 时按比值处理，避免把 43% 显示成 0.43%。
      爆头率: (() => {
        const v = Number(item.per_headshot);
        if (!Number.isFinite(v) || v === 0) return undefined;
        const pct = v < 1 ? v * 100 : v;
        return `${pct.toFixed(1)}%`;
      })(),
      KPR: item.kpr !== undefined ? Number(item.kpr) : undefined,
      定级赛剩余: item.placement || undefined
    });
  }
  return out;
}

function shapeMatch(m) {
  const ts = Number(m.start_time) || 0;
  const dur = (Number(m.end_time) || 0) - ts;
  return {
    时间: ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : undefined,
    时间戳: ts || undefined,
    地图: m.map_name || m.map || undefined,
    模式: m.match_type === '9' ? '优先排位' : m.match_type === '1' ? '对战匹配' : m.match_type || undefined,
    结果: m.is_win === true ? '胜' : m.is_win === false ? '负' : undefined,
    比分: m.group1_all_score !== undefined ? `${m.group1_all_score}:${m.group2_all_score}` : undefined,
    击杀: Number(m.kill) || 0,
    死亡: Number(m.death) || 0,
    助攻: m.assist !== undefined ? Number(m.assist) : undefined,
    ADR: m.adr !== undefined ? Number(m.adr) : undefined,
    RWS: m.rws !== undefined ? Number(m.rws) : undefined,
    评分: m.rating !== undefined ? Number(m.rating) : undefined,
    回合数: m.round_total !== undefined ? Number(m.round_total) : undefined,
    ELO变化: m.change_elo !== undefined ? Number(m.change_elo) : undefined,
    ELO赛后: m.origin_elo !== undefined ? Number(m.origin_elo) : undefined,
    多杀: [1, 2, 3, 4, 5].map((n) => Number(m[`kill_${n}`]) || 0).some((v, i) => i > 0 && v)
      ? `1杀${m.kill_1 ?? 0}/2杀${m.kill_2 ?? 0}/3杀${m.kill_3 ?? 0}/4杀${m.kill_4 ?? 0}/5杀${m.kill_5 ?? 0}`
      : undefined,
    MVP: m.is_mvp === true ? '是' : undefined,
    SVP: m.is_svp === true ? '是' : undefined,
    首杀最多: m.is_most_first_kill === true ? '是' : undefined,
    时长分钟: dur > 0 ? Math.round(dur / 60) : undefined
  };
}

async function getPlayerHome(uuid) {
  const { json } = await call(`https://gate.5eplay.com/crane/http/api/data/player/home?uuid=${uuid}`);
  return json?.data ?? null;
}

async function getMatchList(uuid, { days = 30, limit = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - Math.max(1, Math.min(Number(days) || 30, 365)) * 86400;
  const url =
    'https://gate.5eplay.com/crane/http/api/data/match/list' +
    `?match_type=-1&page=1&date=0&start_time=${start}&end_time=${now}` +
    `&uuid=${uuid}&limit=${Math.max(1, Math.min(Number(limit) || 20, 50))}&cs_type=0`;
  const { json } = await call(url);
  const list = json?.data;
  return Array.isArray(list) ? list : [];
}

// ── 工具实现 ──────────────────────────────────────────────────────
async function toolSearch({ keyword }) {
  const clean = sanitizeKeyword(keyword);
  if (!clean) return err('昵称是空的。');
  const list = await search5e(clean);
  if (!list.length) {
    return ok({
      keyword: clean,
      total: 0,
      results: [],
      提示:
        '5E 搜索是精确匹配昵称，注意大小写与符号。也可以让对方直接给 5E 个人主页链接（里面有 domain，形如 0817kggjivhk）。'
    });
  }
  return ok({
    keyword: clean,
    total: list.length,
    results: list,
    提示: '把选中的 domain 或 nickname 交给 get_5e_player_stats / get_5e_player_matches 即可查战绩。'
  });
}

async function toolStats({ player, days, limit }) {
  const r = await resolvePlayer(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const home = await getPlayerHome(r.uuid);
  const payload = {
    player: r.resolved || player,
    uuid: r.uuid,
    解析方式: r.via,
    ...(home ? shapeSeasonHome(home) : { 说明: '这个 5E 账号没有公开的赛季数据。' })
  };
  if (home && r.via !== 'uuid') {
    // 顺手带上最近对局，省一次调用
    try {
      const ms = await getMatchList(r.uuid, { days: days ?? 30, limit: limit ?? 10 });
      if (ms.length) payload.最近对局 = ms.map(shapeMatch);
    } catch {}
  }
  payload.数据来源 = '5E 对战平台公开接口；只陈述返回内容，不要编造。';
  return ok(payload);
}

async function toolMatches({ player, days, limit }) {
  const r = await resolvePlayer(player);
  if (r.error && !r.candidates) return err(r.error);
  if (r.candidates) return ok({ 需要确认: r.error, candidates: r.candidates });

  const ms = await getMatchList(r.uuid, { days: days ?? 30, limit: limit ?? 20 });
  if (!ms.length) {
    return ok({ player: r.resolved || player, 说明: `最近 ${days ?? 30} 天没有 5E 对局记录。` });
  }
  const shaped = ms.map(shapeMatch);
  const wins = shaped.filter((m) => m.结果 === '胜').length;
  const lost = shaped.filter((m) => m.结果 === '负').length;
  return ok({
    player: r.resolved || player,
    uuid: r.uuid,
    统计: { 场次: shaped.length, 胜: wins, 负: lost, 胜率: shaped.length ? `${(wins / shaped.length * 100).toFixed(1)}%` : undefined },
    对局: shaped,
    数据来源: '5E 对战平台公开接口'
  });
}

// ── 注册 ─────────────────────────────────────────────────────────
const server = new McpServer({ name: 'cs-5e-stats', version: '0.1.0' });
// ── 工具合并（2026-09-28）─────────────────────────────────────────────
// 下面每个 server.tool(...) 都先被**收集**起来，文件末尾统一暴露成一个入口
// （见最后的 __origTool 注册）。handler / 描述 / schema 一个都没改。
// 目的：工具定义每回合都进上下文，cs-5e-stats 原来那几个工具加起来 ≈ 每回合几百 token。
const registeredTools = new Map();
const __origTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => {
  registeredTools.set(name, { description, schema, handler });
};


server.tool(
  'search_5e_player',
  '只读搜索 5E 对战平台（国内 CS）玩家，按昵称返回候选（昵称 + domain + 头像）。群友只给了 CS 昵称、或查不到时先用它确认是哪个人。',
  { keyword: z.string().describe('5E 昵称，例如 ropz（精确匹配，注意大小写）') },
  async (args) => {
    try {
      return await toolSearch(args);
    } catch (error) {
      return err(`搜索失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_5e_player_stats',
  '只读查询 5E 对战平台（国内 CS）玩家赛季战绩：ELO、段位等级、场次胜负、击杀/首杀、RWS/ADR/评分/爆头率，并附最近对局。群友说“查一下他 CS 战绩/5E 段位”时用它。',
  {
    player: z.string().describe('5E 昵称、个人主页 domain（形如 0817kggjivhk）或 uuid'),
    days: z.number().optional().describe('附带最近对局的回看天数，默认 30'),
    limit: z.number().optional().describe('附带最近对局条数，默认 10')
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
  'get_5e_player_matches',
  '只读查询 5E 对战平台（国内 CS）玩家的最近对局列表：地图、胜负比分、KDA、ADR、RWS、评分、ELO 变化、多杀。群友问“他最近打得怎么样/赢了几把”时用它。',
  {
    player: z.string().describe('5E 昵称、domain 或 uuid'),
    days: z.number().optional().describe('回看天数，默认 30'),
    limit: z.number().optional().describe('条数，默认 20，最大 50')
  },
  async (args) => {
    try {
      return await toolMatches(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);


// ── 单一入口：action 分发 ──────────────────────────────────────────────
// 对外只暴露一个工具：用 action 选具体查询、参数照旧。
// 对外短名由原名去掉冗余前缀得到（get_wmpvp_player_stats → player_stats），
// 旧全名同时作为**别名**保留，人格卡/记忆里写过的老名字不会失效。
const ACTION_STRIP = /^(get_5e_|search_5e_)/;
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
const ACTION_BOILER = /^只读(?:查询|搜索|扫描)\s*5E 对战平台（国内 CS）\s*(?:玩家)?的?[，,]?/;
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
  'CS（5E 对战平台）只读查询。一个入口，用 action 选具体查询：\n'
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
