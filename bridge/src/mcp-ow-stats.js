// 守望先锋2 战绩查询 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具：查询玩家公开生涯数据，没有任何本地文件/命令/写操作。
// - 所有出网请求都走 safe-fetch.js 的 safeFetch（SSRF 防护、重定向逐跳校验、字节限量）。
// - 只访问固定白名单域名 overfast-api.tekrop.fr，玩家名做清洗与长度截断，不接受任意 URL。
// - 数据来源是社区抓取站 OverFast（暴雪官方早已下线玩家生涯端点）；查不到只如实说查不到。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'https://overfast-api.tekrop.fr';
const API_HOST = 'overfast-api.tekrop.fr';
const FETCH_MAX_CHARS = 900000;

// ── 角色 / 段位中文化 ──────────────────────────────────────────────
const ROLE_CN = { tank: '坦克', damage: '输出', support: '支援', open: '开放' };
const DIVISION_CN = {
  bronze: '青铜', silver: '白银', gold: '黄金', platinum: '白金',
  diamond: '钻石', master: '大师', grandmaster: '宗师', champion: '冠军',
  unranked: '未定级',
};
const TIER_CN = { 1: 'V', 2: 'IV', 3: 'III', 4: 'II', 5: 'I' };

// 英雄 key 的中文别名（群友习惯叫法 + 官方译名），用于中文名查英雄。
const HERO_ALIAS = {
  '莱因哈特': 'reinhardt', '大锤': 'reinhardt', '莱因': 'reinhardt',
  '查莉娅': 'zarya', '毛妹': 'zarya',
  '禅雅塔': 'zenyatta', '和尚': 'zenyatta', '师父': 'zenyatta',
  '安娜': 'ana',
  '卡西迪': 'cassidy', '麦克雷': 'cassidy', '天王老子': 'cassidy',
  '路霸': 'roadhog', '猪': 'roadhog',
  '巴蒂斯特': 'baptiste', '巴蒂': 'baptiste',
  '莫伊拉': 'moira',
  '奥丽莎': 'orisa',
  '温斯顿': 'winston', '猩猩': 'winston',
  '士兵76': 'soldier-76', '士兵：76': 'soldier-76', '76': 'soldier-76',
  'D.VA': 'dva', 'dva': 'dva', 'd.va': 'dva', '机甲': 'dva',
  '卢西奥': 'lucio', 'DJ': 'lucio',
  '天使': 'mercy', 'mercy': 'mercy',
  '猎空': 'tracer', '闪光': 'tracer',
  '雾子': 'kiriko',
  '半藏': 'hanzo',
  '布丽吉塔': 'brigitte', '锤妹': 'brigitte',
  '死神': 'reaper',
  '西格玛': 'sigma',
  '黑百合': 'widowmaker', '寡妇': 'widowmaker',
  '法老之鹰': 'pharah', '法拉': 'pharah',
  '托比昂': 'torbjorn', '托比': 'torbjorn',
  '堡垒': 'bastion',
  '秩序之光': 'symmetra', '阿三': 'symmetra',
  '源氏': 'genji',
  '狂鼠': 'junkrat',
  '黑影': 'sombra',
  '末日铁拳': 'doomfist', '铁拳': 'doomfist',
  '艾什': 'ashe',
  '破坏球': 'wrecking-ball', '球': 'wrecking-ball',
  '回声': 'echo',
  '渣客女王': 'junker-queen', '女王': 'junker-queen',
  '索杰恩': 'sojourn',
  '拉玛刹': 'ramattra',
  '生命之梭': 'lifeweaver', '花男': 'lifeweaver',
  '伊拉锐': 'illari',
  '毛加': 'mauga',
  '探奇': 'venture',
  '朱诺': 'juno',
  '哈扎德': 'hazard',
  '弗蕾娅': 'freja',
  '斩仇': 'vendetta',
  '无漾': 'wuyang',
  '骇灾': 'hazard',
};

// ── 输入清洗 ──────────────────────────────────────────────────────
function sanitizeName(input) {
  let s = String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[＃﹟]/g, '-') // 全角井号
    .replace(/[－—–‐]/g, '-') // 各种破折号当分隔符
    .replace(/\s+/g, '')
    .trim();
  // 常见写法 name#1234 / name-1234 都能过；OverFast 要的是 name-1234。
  s = s.replace(/#/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40);
}

function sanitizeHero(input) {
  const s = String(input ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 24);
  if (!s) return '';
  const alias = HERO_ALIAS[s] || HERO_ALIAS[s.toUpperCase()] || HERO_ALIAS[s.toLowerCase()];
  if (alias) return alias;
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// ── HTTP ─────────────────────────────────────────────────────────
async function apiGet(pathAndQuery) {
  const url = new URL(pathAndQuery, API_BASE);
  if (url.host !== API_HOST) throw new Error('只允许访问 OverFast 官方域名');
  const res = await safeFetch(url.toString(), FETCH_MAX_CHARS);
  if (res.statusCode === 404) return { notFound: true };
  if (res.statusCode === 429) throw new Error('查询太频繁了，过一会儿再试');
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`OverFast 返回 HTTP ${res.statusCode}`);
  }
  try {
    return { data: JSON.parse(res.body) };
  } catch {
    throw new Error('OverFast 返回内容不是合法 JSON');
  }
}

// ── 数据整形 ──────────────────────────────────────────────────────
function fmtDuration(seconds) {
  const s = Number(seconds) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h <= 0) return `${m} 分钟`;
  if (m <= 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分`;
}

function fmtRank(entry) {
  if (!entry) return null;
  const division = DIVISION_CN[entry.division] || entry.division || '未知';
  const tier = entry.tier ? ` ${TIER_CN[entry.tier] || entry.tier}` : '';
  return `${division}${tier}`;
}

/** 从竞技数据里挑出有段位的位置，按段位从高到低排。 */
function competitiveDigest(summary) {
  const comp = summary?.competitive || {};
  const out = {};
  for (const platform of ['pc', 'console']) {
    const group = comp[platform];
    if (!group) continue;
    const roles = {};
    for (const [role, entry] of Object.entries(group)) {
      // season 是数字字段，不是位置。
      if (role === 'season' || !entry || typeof entry !== 'object') continue;
      const r = fmtRank(entry);
      if (r) roles[ROLE_CN[role] || role] = r;
    }
    if (Object.keys(roles).length) {
      if (typeof group.season === 'number') roles['赛季'] = group.season;
      out[platform === 'pc' ? 'PC' : '主机'] = roles;
    }
  }
  if (!Object.keys(out).length) {
    out['PC'] = { 说明: '本赛季没有可读的定级数据（没打，或档案里没公开）' };
  }
  return out;
}

function statMap(careerStats) {
  const map = new Map();
  if (!Array.isArray(careerStats)) return map;
  // 只认 [{category, stats:[...]}] 形状；少数英雄返回空数组或异常结构时自然得到空 Map。
  for (const cat of careerStats) {
    if (!Array.isArray(cat?.stats)) continue;
    for (const st of cat?.stats || []) {
      if (st && st.key && !map.has(st.key)) map.set(st.key, st.value);
    }
  }
  return map;
}

function pickCore(map) {
  const get = (k) => (map.has(k) ? map.get(k) : undefined);
  const out = {};
  const put = (label, v, suffix = '') => {
    if (v !== undefined && v !== null && v !== '') out[label] = `${v}${suffix}`;
  };
  put('总游戏时长', get('time_played') !== undefined ? fmtDuration(get('time_played')) : undefined);
  put('总场次', get('games_played'));
  put('胜场', get('games_won'));
  put('负场', get('games_lost'));
  put('胜率', get('win_percentage'), '%');
  put('总击杀', get('eliminations'));
  put('总死亡', get('deaths'));
  put('最终击杀', get('final_blows'));
  put('单挑击杀', get('solo_kills'));
  put('总伤害', get('all_damage_done'));
  put('英雄伤害', get('hero_damage_done'));
  put('总治疗', get('healing_done'));
  put('助攻', get('assists'));
  put('目标点击杀', get('objective_kills'));
  put('每10分钟击杀', get('eliminations_avg_per_10_min'));
  put('每10分钟死亡', get('deaths_avg_per_10_min'));
  put('每10分钟伤害', get('all_damage_done_avg_per_10_min'));
  put('每10分钟治疗', get('healing_done_avg_per_10_min'));
  put('每条命击杀', get('eliminations_per_life'));
  put('武器命中率', get('weapon_accuracy'), '%');
  put('暴击命中率', get('critical_hit_accuracy'), '%');
  put('获得最佳', get('cards'));
  return out;
}

/** 按游玩时长排序取英雄榜。 */
function heroRanking(modeData, limit) {
  const cmp = modeData?.heroes_comparisons?.time_played?.values;
  if (!Array.isArray(cmp)) return [];
  const list = [];
  for (const v of cmp) {
    if (!v?.hero || typeof v.value !== 'number' || v.value <= 0) continue;
    const stats = statMap(modeData?.career_stats?.[v.hero]);
    // 个别英雄的 career_stats 是数组而非对象，statMap 已做保护。
    const played = stats.get('time_played');
    list.push({
      hero: v.hero,
      时长: fmtDuration(v.value),
      时长秒: v.value,
      场次: stats.get('games_played'),
      胜率: stats.get('win_percentage') !== undefined ? `${stats.get('win_percentage')}%` : undefined,
      击杀: stats.get('eliminations'),
      死亡: stats.get('deaths'),
      武器命中率: stats.get('weapon_accuracy') !== undefined ? `${stats.get('weapon_accuracy')}%` : undefined,
      暴击命中率: stats.get('critical_hit_accuracy') !== undefined ? `${stats.get('critical_hit_accuracy')}%` : undefined,
      每10分钟击杀: stats.get('eliminations_avg_per_10_min'),
      每10分钟死亡: stats.get('deaths_avg_per_10_min'),
      每10分钟伤害: stats.get('all_damage_done_avg_per_10_min'),
      每10分钟治疗: stats.get('healing_done_avg_per_10_min'),
      原始时长: played !== undefined ? fmtDuration(played) : undefined,
    });
  }
  list.sort((a, b) => b.时长秒 - a.时长秒);
  return list.slice(0, limit);
}

function profileBrief(p) {
  if (!p) return undefined;
  return {
    name: p.username || p.name,
    player_id: p.player_id,
    title: p.title || undefined,
    头像: p.avatar || undefined,
  };
}

/**
 * 判断输入是不是已收录的 player_id（形如 十六进制%7C十六进制）。
 * 注意：真实 BattleTag 的数字部分不是索引，`名字-数字` 不一定是有效的 player_id，
 * 所以统一走 /players?name= 确认，拿到 player_id 再查详情，唯一匹配就直接用。
 */
function looksLikePlayerId(s) {
  return /^[0-9a-fA-F]{8,}(%7C|\|)[0-9a-fA-F]{8,}$/.test(s);
}

function modeBlock(data, mode) {
  const block = data?.stats?.pc?.[mode];
  if (!block) return null;
  return {
    模式: mode === 'competitive' ? '竞技' : '快速',
    总览: pickCore(statMap(block.career_stats?.['all-heroes'])),
    英雄榜: heroRanking(block, 15),
  };
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * 把用户给的玩家标识解析成查详情用的 player_id / BattleTag。
 * 已经是 player_id 就直接用；否则按名字搜索确认。
 * 返回 { profileId, note } 或 { error } 或 { candidates }。
 */
async function resolvePlayer(input) {
  if (looksLikePlayerId(input)) return { profileId: input };
  const { data } = await apiGet(`/players?name=${encodeURIComponent(input)}`);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    return { error: `没搜到玩家「${input}」。让对方确认完整 BattleTag（形如 名字-1234），或者他的生涯档案是不是设成了私密。` };
  }
  // OverFast 是按名字模糊匹配的，且默认只回 20 条，total 才是真实条数。
  const total = Number(data?.total) || results.length;
  if (total > 1) {
    return {
      candidates: `搜「${input}」出来 ${total} 个玩家（下面只列前 ${Math.min(results.length, 8)} 个），必须让群友报完整 BattleTag（名字-数字）才能确定是哪个，不要随便挑一个当答案。`,
      list: results.slice(0, 8).map(profileBrief),
    };
  }
  return {
    profileId: results[0].player_id || results[0].username || input,
    note: `按名字「${input}」只匹配到唯一一个玩家，已自动使用。`,
  };
}

// ── 工具实现 ──────────────────────────────────────────────────────
async function searchPlayer({ name }) {
  const clean = sanitizeName(name);
  if (!clean) return err('玩家名是空的，没法查。');
  const { data, notFound } = await apiGet(`/players?name=${encodeURIComponent(clean)}`);
  if (notFound) return ok({ query: clean, total: 0, results: [] });
  const results = Array.isArray(data?.results) ? data.results.map(profileBrief) : [];
  return ok({
    query: clean,
    total: data?.total ?? results.length,
    results,
    提示: results.length
      ? '用 player_id 或完整 BattleTag（名字-数字）再调 get_player_stats 拿详细战报。'
      : '没搜到这个玩家。可能是名字打错，或者对方生涯档案设成了私密；可以让对方自己在游戏里把「生涯档案」设为公开。',
  });
}

async function getPlayerStats({ player, mode = 'all' }) {
  const clean = sanitizeName(player);
  if (!clean) return err('玩家标识是空的，没法查。');

  const resolved = await resolvePlayer(clean);
  if (resolved.error) return err(resolved.error);
  if (resolved.candidates) return ok({ 需要确认: resolved.candidates, candidates: resolved.list });

  const { data, notFound } = await apiGet(`/players/${encodeURIComponent(resolved.profileId)}`);
  if (notFound) {
    return err(`查不到「${clean}」的生涯数据（OverFast 没收录，或该档案是私密）。不要编造数据。`);
  }

  const summary = data?.summary || {};
  const payload = {
    profile: profileBrief(summary),
    数据更新时间: summary.last_updated_at
      ? new Date(summary.last_updated_at * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : undefined,
    竞技段位: competitiveDigest(summary),
    备注: resolved.note,
  };

  const wanted = mode === 'all' ? ['quickplay', 'competitive'] : [mode];
  for (const m of wanted) {
    const block = modeBlock(data, m);
    if (block) payload[block.模式] = { 总览: block.总览, 英雄榜: block.英雄榜 };
  }

  if (!payload.快速 && !payload.竞技) {
    payload.说明 = '这个账号没有公开可读的生涯数据（档案可能设成了私密，或从没打过这个模式）。';
  }
  payload.数据来源 = 'OverFast（社区抓取暴雪生涯页，非官方接口）；只读展示，不要编造未出现的字段。';
  return ok(payload);
}

async function getHeroStats({ player, hero, mode = 'quickplay' }) {
  const clean = sanitizeName(player);
  const heroKey = sanitizeHero(hero);
  if (!clean) return err('玩家标识是空的，没法查。');
  if (!heroKey) return err('英雄名是空的，没法查。');

  const resolved = await resolvePlayer(clean);
  if (resolved.error) return err(resolved.error);
  if (resolved.candidates) return ok({ 需要确认: resolved.candidates, candidates: resolved.list });

  const { data, notFound } = await apiGet(`/players/${encodeURIComponent(resolved.profileId)}`);
  if (notFound) return err(`查不到「${clean}」的生涯数据。`);

  const modeData = data?.stats?.pc?.[mode];
  const stats = modeData?.career_stats?.[heroKey];
  const heroName = data?.summary?.username || clean;
  const modeCn = mode === 'competitive' ? '竞技' : '快速';
  if (!stats) {
    const ranking = heroRanking(modeData, 100).map((h) => h.hero);
    return err(
      `「${heroName}」在${modeCn}里没有 ${heroKey} 的数据。` +
        (ranking.length ? `他玩过的英雄有：${ranking.slice(0, 20).join(', ')}` : '')
    );
  }

  const rankList = modeData?.heroes_comparisons?.time_played?.values || [];
  const rankIdx = rankList.findIndex((v) => v.hero === heroKey);
  const categories = {};
  for (const cat of stats) {
    const label = cat?.label || cat?.category;
    const items = {};
    for (const st of cat?.stats || []) {
      if (!st?.key || items[st.key] !== undefined) continue;
      items[st.label || st.key] = st.value;
    }
    if (Object.keys(items).length) categories[label] = items;
  }

  return ok({
    profile: { name: heroName, player_id: resolved.profileId },
    英雄: heroKey,
    模式: modeCn,
    该英雄时长: rankIdx >= 0 ? fmtDuration(rankList[rankIdx].value) : undefined,
    该英雄时长排名: rankIdx >= 0 ? `第 ${rankIdx + 1} / ${rankList.length}（按时长）` : undefined,
    详细数据: categories,
    数据来源: 'OverFast；原文标签是英文，转述时用中文习惯说法，不要改数字。',
  });
}

// ── 注册 ─────────────────────────────────────────────────────────
const server = new McpServer({ name: 'ow-stats', version: '0.1.0' });
// ── 工具合并（2026-09-28）─────────────────────────────────────────────
// 下面每个 server.tool(...) 都先被**收集**起来，文件末尾统一暴露成一个入口
// （见最后的 __origTool 注册）。handler / 描述 / schema 一个都没改。
// 目的：工具定义每回合都进上下文，ow-stats 原来那几个工具加起来 ≈ 每回合几百 token。
const registeredTools = new Map();
const __origTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => {
  registeredTools.set(name, { description, schema, handler });
};


server.tool(
  'search_player',
  '只读搜索守望先锋2玩家，返回候选玩家的 player_id 与名字。当群友只报了名字、没给完整 BattleTag 时先用它确认是哪个人。不执行任何本地操作。',
  { name: z.string().describe('玩家名或 BattleTag，例如 TeKrop 或 TeKrop-2217') },
  async (args) => {
    try {
      return await searchPlayer(args);
    } catch (error) {
      return err(`搜索失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_player_stats',
  '只读查询守望先锋2玩家生涯战绩（竞技段位、快速/竞技总览、最常玩英雄榜）。群友说"查一下某人的战绩/段位/OW数据"时用它。需要 BattleTag（名字-数字）或 search_player 给的 player_id。',
  {
    player: z.string().describe('BattleTag（形如 TeKrop-2217）或 search_player 返回的 player_id'),
    mode: z.enum(['all', 'quickplay', 'competitive']).optional().describe('查哪个模式，默认 all（快速+竞技）'),
  },
  async (args) => {
    try {
      return await getPlayerStats(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);

server.tool(
  'get_hero_stats',
  '只读查询某个玩家某个英雄的详细数据（时长、场次、胜率、命中率、每10分钟击杀/伤害/治疗等）。群友追问"他源氏怎么样""麦克雷命中率多少"时用它。hero 支持中文名或英文 key。',
  {
    player: z.string().describe('BattleTag（形如 TeKrop-2217）或 player_id'),
    hero: z.string().describe('英雄名，中文或英文都行，例如 源氏 / genji / 天使 / mercy'),
    mode: z.enum(['quickplay', 'competitive']).optional().describe('查哪个模式，默认 quickplay'),
  },
  async (args) => {
    try {
      return await getHeroStats(args);
    } catch (error) {
      return err(`查询失败：${error?.message ?? error}`);
    }
  }
);


// ── 单一入口：action 分发 ──────────────────────────────────────────────
// 对外只暴露一个工具：用 action 选具体查询、参数照旧。
// 对外短名由原名去掉冗余前缀得到（get_wmpvp_player_stats → player_stats），
// 旧全名同时作为**别名**保留，人格卡/记忆里写过的老名字不会失效。
const ACTION_STRIP = /^(get_|search_)/;
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
const ACTION_BOILER = /^只读(?:查询|搜索|扫描)\s*守望先锋2\s*(?:玩家)?的?[，,]?/;
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
  '守望先锋2（国际服，OverFast）只读查询。一个入口，用 action 选具体查询：\n'
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
