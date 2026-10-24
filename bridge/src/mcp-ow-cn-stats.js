// 守望先锋国服（CN）战绩查询 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 为什么单独一个服务器：
//   mcp-ow-stats.js 走 OverFast（社区抓暴雪**国际服**生涯页），拿不到国服数据。
//   国服数据只在网易大神（Dashen）侧，所以这里改为调用本地部署的 Overstats 服务
//   （D:\Overstats），由它用你自己的大神凭据去上游取数。
//
// 安全设计：
// - 只读工具：查询玩家公开战绩，无本地文件/命令/写操作，不接受任意 URL
//   （上游固定 127.0.0.1:18080，是本机 Overstats 服务）。
// - 玩家 ID 做清洗与长度截断；出网只打本机回环。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';

const UPSTREAM = process.env.OVERSTATS_BASE || 'http://127.0.0.1:18080';
const TIMEOUT_MS = Number(process.env.OVERSTATS_TIMEOUT_MS) || 90000;
// GUID -> 中文名的映射表（Overstats 自己下发的 query_tool.json）。
// 只读一次并缓存；文件缺失时降级为显示 GUID，不影响主流程。
const QUERY_TOOL_JSON = process.env.OVERSTATS_QUERY_TOOL || 'D:/Overstats/overstats/res/query_tool.json';
const guidNames = { hero: new Map(), map: new Map() };
let guidMapsLoaded = false;

function loadGuidMaps() {
  if (guidMapsLoaded) return;
  guidMapsLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(QUERY_TOOL_JSON, 'utf8'));
    for (const h of j.heroList || []) {
      const guid = String(h.heroGuid || h.guid || h.id || '');
      if (guid && h.name) guidNames.hero.set(guid, h.name);
    }
    for (const m of j.mapList || []) {
      const guid = String(m.guid || m.mapGuid || m.id || '');
      if (guid && m.name) guidNames.map.set(guid, m.name);
    }
  } catch {
    // 映射表读不到就用 GUID 原样展示，不阻断查询
  }
}

const heroName = (guid) => guidNames.hero.get(String(guid || '')) || undefined;
const mapName = (guid) => guidNames.map.get(String(guid || '')) || undefined;


function sanitizePlayer(input) {
  return String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[＃﹟]/g, '#')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 40);
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

async function callOverstats(path, payload) {
  let res;
  try {
    res = await fetch(`${UPSTREAM}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/ECONNREFUSED|fetch failed|timed out|timeout/i.test(msg)) {
      throw new Error(
        '国服查询服务（Overstats）没有在运行。需要在 D:\\Overstats\\Overstats-main 下启动 `python run.py`（监听 127.0.0.1:18080）。'
      );
    }
    throw new Error(`国服查询服务请求失败：${msg}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`国服查询服务返回了非 JSON（HTTP ${res.status}）`);
  }
  return { httpStatus: res.status, data };
}

/** 把 Overstats 的错误码翻成机器人能直接说给群友听的话。 */
function explainError(data) {
  const code = String(data?.error || '');
  const details = data?.details || {};
  if (code === 'bnet_not_found') {
    return {
      error: '国服查不到这个 ID',
      hint:
        '多半是 ID 大小写或 # 后面的数字不对（大神搜索区分大小写，务必用完整的 名字#数字）。' +
        '也可能是对方没在大神绑定过战网，或没打过排位。让对方确认后重试。' +
        '注意：这个工具只查国服（网易大神），查国际服要用另一个工具。',
      upstreamCode: details.upstream_code,
    };
  }
  if (code === 'missing_target') {
    return { error: '没给玩家 ID', hint: '需要 bnet_id，形如 名字#12345。' };
  }
  if (code === 'auto_route_not_configured') {
    return { error: '该功能未配置', hint: '需要 ANALYSIS_BASE_URL / ANALYSIS_API_KEY，本部署未开启。' };
  }
  return { error: data?.message || code || '未知错误', hint: data?.hint || '', details };
}

// ── 工具实现 ──────────────────────────────────────────────────────
async function getCnPlayerStats({ player, season }) {
  const clean = sanitizePlayer(player);
  if (!clean) return err('玩家 ID 是空的，没法查。');
  if (!clean.includes('#')) {
    return err(
      `国服查询需要完整 ID（形如 名字#12345），只给「${clean}」不够——大神那边必须带 # 和后面的数字。让对方补全。`
    );
  }
  const payload = { bnet_id: clean };
  if (season) payload.season = season;

  const { data } = await callOverstats('/api/v2/dashen-profile', payload);
  if (!data?.ok) {
    const e = explainError(data);
    return ok({ 查询失败: true, player: clean, ...e, 数据来源: '网易大神（经本地 Overstats）' });
  }

  const card = data.profile_card?.data || {};
  const sport = data.sport?.data || {};
  const out = {
    player: clean,
    解析到: data.resolved?.full_id || clean,
    昵称: card.name,
    等级: card.level,
    头衔: card.title || undefined,
    国服总时长小时: card.gameTime,
    各位置战绩: (sport.guideCountData || []).map((r) => ({
      // 大神侧实际用 healer / dps / tank / open；damage 与 support 是别处的别名，一并兜住。
      位置:
        { tank: '坦克', dps: '输出', damage: '输出', healer: '支援', support: '支援', open: '开放' }[
          String(r.roleType || '').toLowerCase()
        ] || r.roleType,
      段位: r.lastRankInfo?.rank_name
        ? `${r.lastRankInfo.rank_name}${r.lastRankInfo.rank_sub_tier ? ` ${r.lastRankInfo.rank_sub_tier}` : ''}`
        : undefined,
      分数: r.lastRankInfo?.rankScore,
      场次: r.matchSum,
      胜率: r.winRate !== undefined ? `${r.winRate}%` : undefined,
    })),
    数据来源: '网易大神（经本地 Overstats）；这是国服数据，和国际服是两套。只陈述返回内容，不要编造。',
  };
  return ok(out);
}

/** 把一方对局整理成机器人好念的形式；GUID 翻中文名，翻不到就省略。 */
function shapeMatch(m) {
  const ts = Number(m.beginTs || m.rankInfo?.ts || 0) || null;
  const result =
    typeof m.teamScore === 'number' && typeof m.opponentScore === 'number'
      ? m.teamScore > m.opponentScore
        ? '胜'
        : m.teamScore < m.opponentScore
          ? '负'
          : '平'
      : undefined;
  return {
    时间: ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : undefined,
    时间戳: ts || undefined,
    英雄: heroName(m.heroGuid),
    位置: { tank: '坦克', dps: '输出', damage: '输出', healer: '支援', support: '支援', open: '开放' }[
      String(m.roleType || '').toLowerCase()
    ] || m.roleType,
    地图: mapName(m.mapGuid),
    模式: m.instanceType === 'IT_RANKED' ? '排位' : m.instanceType || undefined,
    结果: result,
    比分: result ? `${m.teamScore}:${m.opponentScore}` : undefined,
    击杀: m.kill,
    死亡: m.death,
    助攻: m.assist,
    英雄伤害: m.heroDamage,
    治疗: m.cure, 
    承伤: m.resistDamage,
    本场最佳: m.killMax ? '击杀最高' : m.heroDamageMax ? '伤害最高' : m.cureMax ? '治疗最高' : m.resistDamageMax ? '承伤最高' : undefined,
    段位: m.rankInfo?.rank_name
      ? `${m.rankInfo.rank_name}${m.rankInfo.rank_sub_tier ? ` ${m.rankInfo.rank_sub_tier}` : ''}`
      : undefined,
    分数: m.rankInfo?.rankScore,
  };
}

/** 取原始对局列表（做校验 + 错误翻译）。 */
async function fetchCnMatches(clean) {
  const { data } = await callOverstats('/api/v2/dashen-match', { bnet_id: clean });
  if (!data?.ok) return { error: explainError(data) };
  const list = data.matches || data.list || data.data || [];
  return { raw: Array.isArray(list) ? list : [] };
}

async function getCnPlayerMatches({ player, limit }) {
  const clean = sanitizePlayer(player);
  if (!clean || !clean.includes('#')) {
    return err('需要完整国服 ID（形如 名字#12345）。');
  }
  loadGuidMaps();
  const { raw, error } = await fetchCnMatches(clean);
  if (error) return ok({ 查询失败: true, player: clean, ...error });

  const shaped = raw.map(shapeMatch).filter((m) => m.时间戳);
  shaped.sort((a, b) => b.时间戳 - a.时间戳);
  const take = limit || 10;
  return ok({
    player: clean,
    可读对局总数: shaped.length,
    返回条数: Math.min(take, shaped.length),
    最近战绩: shaped.slice(0, take).map(({ 时间戳, ...rest }) => rest),
    数据来源: '网易大神（经本地 Overstats）',
  });
}

/**
 * 按"今天 / 昨天"取国服对局——这是最常用的问法（"他今天打得怎么样"）。
 * daysBack=1 表示今天+昨天；也可以传 2~7 天。
 */
async function getCnRecentMatches({ player, daysBack = 1, limit = 20 }) {
  const clean = sanitizePlayer(player);
  if (!clean || !clean.includes('#')) {
    return err('需要完整国服 ID（形如 名字#12345）。');
  }
  loadGuidMaps();
  const { raw, error } = await fetchCnMatches(clean);
  if (error) return ok({ 查询失败: true, player: clean, ...error });

  const shaped = raw.map(shapeMatch).filter((m) => m.时间戳);
  if (!shaped.length) {
    return ok({ player: clean, 说明: '这个账号近期没有可读的对局记录。' });
  }

  // 以数据里最新一局的日期为基准，避免"跨零点还在打"被算成昨天而丢掉刚打完的。
  const times = shaped.map((m) => m.时间戳);
  const latest = Math.max(...times);
  const dayMs = 86400000;
  const latestDayStart = new Date(latest).setHours(0, 0, 0, 0);
  const spanDays = Math.max(1, Math.min(Number(daysBack) || 1, 7)) + 1; // 今天 + 往前 N 天
  const from = latestDayStart - (spanDays - 1) * dayMs;

  const inRange = shaped
    .filter((m) => m.时间戳 >= from)
    .sort((a, b) => b.时间戳 - a.时间戳);

  // 按天分组，方便机器人分天叙述
  const byDay = {};
  for (const m of inRange) {
    const d = new Date(m.时间戳);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (byDay[key] = byDay[key] || []).push(m);
  }

  const daySummaries = Object.entries(byDay)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, ms]) => {
      const wins = ms.filter((m) => m.结果 === '胜').length;
      return {
        日期: day,
        场次: ms.length,
        胜: wins,
        负: ms.filter((m) => m.结果 === '负').length,
        英雄场次: Object.entries(
          ms.reduce((acc, m) => ((acc[m.英雄 || '未知'] = (acc[m.英雄 || '未知'] || 0) + 1), acc), {})
        )
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}×${c}`),
        对局: ms.slice(0, Number(limit) || 20).map(({ 时间戳, ...rest }) => rest),
      };
    });

  return ok({
    player: clean,
    基准日期: new Date(latest).toLocaleDateString('zh-CN'),
    覆盖范围: `最近 ${spanDays} 天（以最新一局为准）`,
    原始可读对局数: shaped.length,
    按天汇总: daySummaries,
    提示: '叙述时以"今天/昨天"为主，只说这里返回的内容；没有对局的天不用提。',
    数据来源: '网易大神（经本地 Overstats）',
  });
}

// ── 注册 ─────────────────────────────────────────────────────────
const server = new McpServer({ name: 'ow-cn-stats', version: '0.1.0' });
// ── 工具合并（2026-09-28）─────────────────────────────────────────────
// 下面每个 server.tool(...) 都先被**收集**起来，文件末尾统一暴露成一个入口
// （见最后的 __origTool 注册）。handler / 描述 / schema 一个都没改。
// 目的：工具定义每回合都进上下文，ow-cn-stats 原来那几个工具加起来 ≈ 每回合几百 token。
const registeredTools = new Map();
const __origTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => {
  registeredTools.set(name, { description, schema, handler });
};


server.tool(
  'get_cn_player_stats',
  '只读查询守望先锋【国服】玩家战绩（网易大神数据源，经本地 Overstats 服务）。当群友报的是国服 ID（形如 名字#1234）或国际服工具查不到时用它。必须提供完整 ID 含 # 和数字。',
  {
    player: z.string().describe('国服完整 ID，形如 随缘居士#5729'),
    season: z.number().optional().describe('赛季号，可选'),
  },
  async (args) => {
    try {
      return await getCnPlayerStats(args);
    } catch (error) {
      return err(`国服查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_cn_player_matches',
  '只读查询守望先锋【国服】玩家最近的对局列表（网易大神数据源），含地图/英雄中文名、胜负、KDA。群友问“他最近几把打得怎么样”时用它。',
  {
    player: z.string().describe('国服完整 ID，形如 随缘居士#5729'),
    limit: z.number().optional().describe('取多少场，默认 10'),
  },
  async (args) => {
    try {
      return await getCnPlayerMatches(args);
    } catch (error) {
      return err(`国服查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_cn_recent_matches',
  '只读查询守望先锋【国服】玩家【今天和昨天】的对局，按天汇总（场次、胜负、用了哪些英雄、每局明细）。群友问“他今天打得怎么样/昨天赢了几把/最近在玩什么”时优先用它。',
  {
    player: z.string().describe('国服完整 ID，形如 随缘居士#5729'),
    daysBack: z.number().optional().describe('往前看几天，默认 1（今天+昨天），最大 7'),
    limit: z.number().optional().describe('每天最多返回几局明细，默认 20'),
  },
  async (args) => {
    try {
      return await getCnRecentMatches(args);
    } catch (error) {
      return err(`国服查询失败：${error?.message ?? error}`);
    }
  }
);


// ── 单一入口：action 分发 ──────────────────────────────────────────────
// 对外只暴露一个工具：用 action 选具体查询、参数照旧。
// 对外短名由原名去掉冗余前缀得到（get_wmpvp_player_stats → player_stats），
// 旧全名同时作为**别名**保留，人格卡/记忆里写过的老名字不会失效。
const ACTION_STRIP = /^get_cn_/;
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
const ACTION_BOILER = /^只读(?:查询|搜索|扫描)\s*守望先锋【国服】\s*(?:玩家)?的?[，,]?/;
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
  '守望先锋【国服】（网易大神，经本地 Overstats）只读查询。一个入口，用 action 选具体查询：\n'
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
