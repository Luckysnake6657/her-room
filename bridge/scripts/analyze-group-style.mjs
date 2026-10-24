/**
 * 群聊发言方式统计（管理员 2026-09-29：「总结一下群聊成员的发言方式的共同特点」）。
 *
 * 语料来源（都是真实群聊原文，只统计**群友**说的，排除机器人自己/系统提示）：
 *   ① state/slang.json           —— 黑话条目的 evidence（每条都带 sender + 原文）
 *   ② state/social-v2.json       —— 各会话的 recentMessages / unread
 *   ③ state/archived-group-*.json —— 群聊归档
 *   ④ state/_backup-xxx/social-v2.json —— 旧快照（更早的语料）
 *   ⑤ state/qq-activity.log      —— 活动日志里的消息预览（兜底，量小）
 *
 * 统计的口径都是"**一条消息**"，不是"一个词"。输出是给人看的报告，列表都截断。
 *
 * 用法：node scripts/analyze-group-style.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const AS_JSON = process.argv.includes('--json');

const BOT_NAMES = new Set(['今晚吃兔兔']);
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};

// ── 语料收集 ────────────────────────────────────────────────────────────────
const msgs = [];            // { text, sender, group, at, source }
const seen = new Set();     // 去重：同一句 + 同一人 + 同一群
const push = (sender, text, at, group, source) => {
  const t = String(text ?? '').trim();
  if (!t) return;
  if (!sender || BOT_NAMES.has(String(sender))) return;
  if (/^(系统|System)$/.test(String(sender))) return;
  // 时间戳单位归一化：slang 的 evidence 里混了「秒」和「毫秒」两种；实在不可信的当"没时间"
  let ts = Number(at) || 0;
  if (ts > 0 && ts < 1e12) ts *= 1000;
  if (ts < 1e11) ts = 0;
  const key = `${group}|${sender}|${t}`;
  if (seen.has(key)) return;      // slang 的 evidence 在不同条目里会重复出现
  seen.add(key);
  msgs.push({ text: t, sender: String(sender), group: String(group), at: ts, source });
};

// ① 黑话条目的 evidence
{
  const slang = readJson(path.join(STATE, 'slang.json'));
  const entries = slang ? Object.values(slang) : [];
  for (const e of entries) {
    for (const ev of e?.evidence ?? []) push(ev?.sender, ev?.text, ev?.time, ev?.key, 'slang');
  }
}
// ② 当前状态 + ④ 旧快照
const socialFiles = [path.join(STATE, 'social-v2.json'), path.join(STATE, 'social-v2.json.bak-before-core-memory')];
for (const dir of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
  if (dir.startsWith('_backup-')) socialFiles.push(path.join(STATE, dir, 'social-v2.json'));
}
for (const f of socialFiles) {
  const st = readJson(f);
  if (!st?.conversations) continue;
  const src = f.includes('_backup-') || f.includes('.bak-') ? 'snapshot' : 'live';
  for (const [key, conv] of Object.entries(st.conversations)) {
    if (!key.startsWith('group:')) continue;
    for (const m of [...(conv?.recentMessages ?? []), ...(conv?.unread ?? [])]) {
      if (!m || m.isSelf || m.system) continue;
      push(m.sender, m.text, m.time, key, src);
    }
  }
}
// ③ 群聊归档
for (const f of fs.readdirSync(STATE)) {
  if (!/^archived-group-\d+\.json$/.test(f)) continue;
  const arch = readJson(path.join(STATE, f));
  const list = Array.isArray(arch) ? arch : (arch?.messages ?? Object.values(arch ?? {}));
  const gkey = `group:${f.match(/\d+/)?.[0]}`;
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object' || m.isSelf || m.system) continue;
    push(m.sender, m.text, m.time, m.group ?? gkey, 'archive');
  }
}
// ⑤ 活动日志里的预览（形如 `[14:24:01] group:1054156254 [reserved2] 消息已入未读：[引用 …]正文`）
//    ⚠️ 桥接这里是 `textContent.slice(0, 80)`：超过 80 字的被截断，所以这批的长句统计偏低。
//    好处是**没经过任何筛选**（不像 slang 的 evidence 只收"含黑话候选"的句子），适合当"自然语料"对照。
{
  try {
    const lines = fs.readFileSync(path.join(STATE, 'qq-activity.log'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(group:\d+)\s+.*?消息已入未读：(.+)$/.exec(line.trim());
      if (!m) continue;
      push('(activity)', m[5], 0, m[4], 'activity');
      // 只有时间没有日期 → 不参与时间线 / 连发统计（at 保持 0）
    }
  } catch { /* 没有就算了 */ }
}

// ── 逐条打标 ────────────────────────────────────────────────────────────────
const stripQuote = (t) => t.replace(/^\[引用[^\]]*\]/, '').trim();
const CJK = /[\u4e00-\u9fff]/;
const PUNCT = /[。，、！？；：…～~!?,;]/;
const KAOMOJI = /(qwq|QwQ|QAQ|T_T|orz|awa|ovo|0v0|>_<|233|www|hhh|hh+|xswl|yjgj)/i;

const rows = msgs.map((m) => {
  const text = stripQuote(m.text);
  const body = text.replace(/\[(图片|表情|表情包|视频|语音|文件|转发消息)[^\]]*\]/g, '').trim();
  const media = /\[(图片|表情|表情包|视频|语音|文件|转发消息)/.test(text);
  const len = [...body].length;
  const emoji = /\p{Extended_Pictographic}/u.test(body);
  const tail = body.slice(-3);
  return {
    ...m, body, media, len, emoji,
    // "零标点"：整条消息里没有任何标点（连逗号都没有）
    noPunct: body.length > 0 && !PUNCT.test(body),
    // 句尾标点
    endPunct: /[。！？!?…~～]$/.test(body),
    endTilde: /[~～]$/.test(body),
    // 分裂式省略/拖音
    dots3: /(。。。|\.\.\.|…{2,})/.test(body),
    repeat: /(.)\1{2,}/u.test(body),
    qMark: /[?？]/.test(body),
    // ⚠️ 别叫 at：at 是这条消息的时间戳（下面 spread 进来的），原来这里覆盖了它，
    //    导致时间线/连发/复读统计全跑在"含 @"的少数消息上。
    hasAt: /@\S/.test(text),
    quote: /^\[引用/.test(m.text),
    latin: (body.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? []).map((x) => x.toLowerCase()),
    kaomoji: KAOMOJI.test(body),
    laugh: /(哈哈|嘿嘿|嘻嘻|233|hhh|www)/i.test(body),
    particle: (body.match(/(喵|啊|吧|呢|吗|哈|呀|哦|喔|嘞|啦|噢|诶|哎|嘛|咧)$/) ?? [])[1] ?? null,
    cjkLen: [...body].filter((c) => CJK.test(c)).length,
    // 括号注释：群里很常见（他的昵称就是"甘志恒好扫 一块一条，括号删了"）
    paren: /[（(][^）)]{1,20}[）)]/.test(body),
    // 纯反应：整条没有汉字、不超过 3 字符（？、6、。。。、wc、nb）
    pureReaction: body.length > 0 && body.length <= 3 && !CJK.test(body),
    echo: false,   // 复读（跨发送者一字不差）稍后单独一遍打标
  };
});
// 复读检测：3 分钟内**别人**发过一模一样的句子（群里"复读机"文化）
{
  const byGroup = new Map();
  for (const r of rows) {
    if (!r.at || !r.body) continue;
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].at - list[i].at <= 180000; j++) {
        if (list[j].body === list[i].body && list[j].sender !== list[i].sender) {
          list[i].echo = true; list[j].echo = true;
        }
      }
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const n = rows.length;
const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
const cnt = (fn) => rows.filter(fn).length;
const countBy = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); if (k === null || k === undefined || k === '') continue; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const top = (arr, k, size) => countBy(arr, k).slice(0, size);

const lens = rows.map((r) => r.len).sort((a, b) => a - b);
const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? 0;

/**
 * 同一套口径算一小撮关键指标 —— 用来对照"两类语料有没有偏差"：
 *  slang 那批只收过"含黑话候选"的句子（偏长、偏有梗），live/archive/activity 是没筛过的自然语料。
 */
const keyMetrics = (list) => {
  const m = list.length;
  const p = (x) => (m ? `${((x / m) * 100).toFixed(0)}%` : '-');
  const L = list.map((r) => r.len).sort((a, b) => a - b);
  return {
    条数: m,
    中位长度: L[Math.floor(L.length / 2)] ?? 0,
    '≤10字': p(list.filter((r) => r.len <= 10).length),
    零标点: p(list.filter((r) => r.noPunct).length),
    带at: p(list.filter((r) => r.hasAt).length),
    纯媒体: p(list.filter((r) => r.media).length),
    带emoji: p(list.filter((r) => r.emoji).length),
    用引用: p(list.filter((r) => r.quote).length),
  };
};
const slangRows = rows.filter((r) => r.source === 'slang');
const naturalRows = rows.filter((r) => r.source !== 'slang');

// 连发（同一个人 60 秒内连着说几条 = 一个 burst）
const bursts = [];
{
  const bySender = new Map();
  for (const r of rows.filter((x) => x.at)) {
    const k = `${r.group}|${r.sender}`;
    if (!bySender.has(k)) bySender.set(k, []);
    bySender.get(k).push(r);
  }
  for (const list of bySender.values()) {
    list.sort((a, b) => a.at - b.at);
    let size = 1;
    for (let i = 1; i < list.length; i++) {
      if (list[i].at - list[i - 1].at <= 60000) size++;
      else { bursts.push(size); size = 1; }
    }
    bursts.push(size);
  }
}
const avgBurst = bursts.length ? (bursts.reduce((a, b) => a + b, 0) / bursts.length) : 0;

// 高频词（CJK 2-gram，去掉 @、引用、媒体占位之后）
const bigrams = new Map();
for (const r of rows) {
  const clean = r.body.replace(/@\S+/g, '').replace(/\[[^\]]*\]/g, '').replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of clean.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2);
      bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
    }
  }
}
const topBigrams = [...bigrams.entries()].filter(([, c]) => c >= 4).sort((a, b) => b[1] - a[1]).slice(0, 45);
const topWords = [...countBy(rows.flatMap((r) => r.latin), (x) => x)].slice(0, 25);

// ── 输出 ────────────────────────────────────────────────────────────────────
const report = {
  语料: {
    消息数: n,
    发言人数: new Set(rows.map((r) => r.sender)).size,
    群数: new Set(rows.map((r) => r.group)).size,
    来源: countBy(rows, (r) => r.source).map(([k, v]) => `${k}:${v}`).join(' '),
    时间跨度: (() => {
      const t = rows.map((r) => r.at).filter((x) => x > 0);
      return t.length ? `${new Date(Math.min(...t)).toLocaleString('zh-CN')} → ${new Date(Math.max(...t)).toLocaleString('zh-CN')}` : '-';
    })(),
    每人条数: top(rows.filter((r) => r.sender !== '(activity)'), (r) => r.sender, 12).map(([k, v]) => `${k}:${v}`),
  },
  长度: {
    中位数: q(0.5), P25: q(0.25), P75: q(0.75), P90: q(0.9), 最长: lens[lens.length - 1] ?? 0,
    '≤4字': pct(cnt((r) => r.len <= 4)),
    '5-10字': pct(cnt((r) => r.len >= 5 && r.len <= 10)),
    '11-20字': pct(cnt((r) => r.len >= 11 && r.len <= 20)),
    '>20字': pct(cnt((r) => r.len > 20)),
  },
  标点: {
    完全没标点: pct(cnt((r) => r.noPunct)),
    句尾有标点: pct(cnt((r) => r.endPunct)),
    句尾波浪号: pct(cnt((r) => r.endTilde)),
    有问号: pct(cnt((r) => r.qMark)),
    三个点以上: pct(cnt((r) => r.dots3)),
    重复字符aaa: pct(cnt((r) => r.repeat)),
  },
  形态: {
    纯媒体_图或表情: pct(cnt((r) => r.media)),
    带emoji: pct(cnt((r) => r.emoji)),
    颜文字或梗笑: pct(cnt((r) => r.kaomoji)),
    哈哈哈类: pct(cnt((r) => r.laugh)),
    带at: pct(cnt((r) => r.hasAt)),
    用引用回复: pct(cnt((r) => r.quote)),
    括号注释: pct(cnt((r) => r.paren)),
    纯反应短条: pct(cnt((r) => r.pureReaction)),
    复读别人的话: pct(cnt((r) => r.echo)),
    '短+零标点': pct(cnt((r) => r.noPunct && r.len <= 10 && r.len > 0)),
  },
  句尾语气词: top(rows, (r) => r.particle, 14).map(([k, v]) => `${k}:${v}`),
  英文与缩写: topWords.map(([k, v]) => `${k}:${v}`),
  连发: { 平均一个burst几条: Number(avgBurst.toFixed(2)), burst总数: bursts.length, 单条burst占比: pct(bursts.filter((b) => b === 1).length) },
  高频二元词: topBigrams.map(([k, v]) => `${k}(${v})`),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`语料：${n} 条群友消息 / ${report.语料.发言人数} 人 / ${report.语料.群数} 个群（${report.语料.来源}）`);
  console.log(`时间跨度：${report.语料.时间跨度}`);
  {
    const ts = rows.map((r) => r.at).filter((x) => x > 0);
    console.log(`（其中 ${ts.length} 条带时间戳：${new Date(Math.min(...ts)).toLocaleString('zh-CN')} → ${new Date(Math.max(...ts)).toLocaleString('zh-CN')}；`
      + '活动日志那批只有时分秒、没有日期，不计入）');
  }
  console.log(`\n【长度】中位数 ${report.长度.中位数} 字（P25 ${report.长度.P25} / P75 ${report.长度.P75} / P90 ${report.长度.P90}，最长 ${report.长度.最长}）`);
  console.log(`  ≤4字 ${report.长度['≤4字']} ｜ 5-10字 ${report.长度['5-10字']} ｜ 11-20字 ${report.长度['11-20字']} ｜ >20字 ${report.长度['>20字']}`);
  console.log('\n【标点】');
  for (const [k, v] of Object.entries(report.标点)) console.log(`  ${k}: ${v}`);
  console.log('\n【形态】');
  for (const [k, v] of Object.entries(report.形态)) console.log(`  ${k}: ${v}`);
  console.log(`\n【连发】平均 ${report.连发.平均一个burst几条} 条/次，单条占比 ${report.连发.单条burst占比}`);
  console.log(`\n【句尾语气词】${report.句尾语气词.join('  ')}`);
  console.log(`\n【英文/缩写】${report.英文与缩写.join('  ')}`);
  console.log(`\n【高频二元词】${report.高频二元词.join('  ')}`);
  console.log(`\n【最活跃】${report.语料.每人条数.join('  ')}`);
  console.log('\n【两类语料对照】（slang 那批是"含黑话候选"的筛选样本，自然语料是没筛过的）');
  const a = keyMetrics(slangRows); const b2 = keyMetrics(naturalRows);
  const keys = Object.keys(a);
  console.log(`  ${'指标'.padEnd(10)}${'slang 筛选'.padEnd(14)}自然语料`);
  for (const k of keys) console.log(`  ${String(k).padEnd(10)}${String(a[k]).padEnd(14)}${b2[k]}`);
}

// 抽样：给总结配例子（短句 / 长句 / 引用 / 带表情 / 纯吐槽）
const sample = (label, filter, size = 6) => {
  const list = rows.filter(filter);
  const picked = [];
  for (let i = 0; i < size && list.length; i++) picked.push(list[Math.floor((i + 0.5) * list.length / size)]);
  console.log(`\n—— ${label}（共 ${list.length} 条）——`);
  for (const r of picked) console.log(`  ${r.sender}：${r.body.replace(/\n/g, ' ').slice(0, 60)}`);
};
if (!AS_JSON) {
  sample('短句（≤4 字）', (r) => r.len > 0 && r.len <= 4);
  sample('完全没标点', (r) => r.noPunct && r.len >= 5);
  sample('超过 20 字', (r) => r.len > 20, 5);
  sample('用引用回复', (r) => r.quote, 4);
}
