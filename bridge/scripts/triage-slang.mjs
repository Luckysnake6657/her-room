/**
 * 黑话补课：把"排队等着学"的候选词筛一遍，挑出真的值得释义的。
 *
 * 背景（2026-09-29）：state/slang.json 里有 1092 条 candidate，其中 1049 条是
 * "只出现过 1 次、释义为空"的裸词 —— 提取器把它们记下来了，但从没跑过推理，
 * 所以既不能进提示词、也没法审核。全量跑推理又贵又吵（大部分是昵称/普通词）。
 *
 * 这个脚本做四件事：
 *   ① 用长期语料库 state/group-corpus.jsonl（1513+ 条真实群聊）**重数**每个词的真频次；
 *   ② 剔掉：群友昵称（含昵称片段）、只出现过 1 次的、常见普通词、格式不像词的；
 *   ③ 按频次排序输出短名单 state/slang-triage.json（带出处例句，方便你一眼判断）；
 *   ④ 可选：--run N 直接把前 N 条送进现有的 /api/slang/research 推理（分批 + 间隔）。
 *
 * 用法：
 *   node scripts/triage-slang.mjs              # 只筛，输出短名单
 *   node scripts/triage-slang.mjs --run 10     # 筛完顺手推理前 10 条
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'slang-triage.json');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1]) || 80;
const RUN = Number(process.argv[process.argv.indexOf('--run') + 1]) || 0;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// ── 语料 ────────────────────────────────────────────────────────────────────
const corpus = [];
for (const line of (fs.existsSync(path.join(STATE, 'group-corpus.jsonl'))
  ? fs.readFileSync(path.join(STATE, 'group-corpus.jsonl'), 'utf8')
  : '').split('\n')) {
  if (!line.trim()) continue;
  try { corpus.push(JSON.parse(line)); } catch { /* 坏行忽略 */ }
}
const freq = new Map();        // 词 -> 次数
const users = new Map();       // 词 -> Set(发送者)
const examples = new Map();    // 词 -> [例句]
const senders = new Set();     // 所有出现过的昵称（用来识别"这其实是人名"）
for (const r of corpus) {
  senders.add(String(r.s));
  const text = String(r.x ?? '');
  for (const m of text.matchAll(/[\u4e00-\u9fff]{2,6}|[A-Za-z]{2,8}/g)) {
    const w = m[0];
    freq.set(w, (freq.get(w) ?? 0) + 1);
    if (!users.has(w)) users.set(w, new Set());
    users.get(w).add(String(r.s));
    if (!examples.has(w)) examples.set(w, []);
    if (examples.get(w).length < 3) examples.get(w).push(`${r.s}：${text.slice(0, 50)}`);
  }
}

// ── 候选 ────────────────────────────────────────────────────────────────────
const slang = readJson(path.join(STATE, 'slang.json')) ?? {};
const candidates = Object.values(slang).filter((e) => e?.status === 'candidate');

// 常见普通词（不是黑话）：宁可漏，不要吵
const STOP = new Set(('我们 你们 他们 她们 什么 怎么 这个 那个 这样 那样 这些 那些 现在 时候 一个 一下 一起 一直 一样 因为 所以 但是 如果 应该 可能 觉得 感觉 知道 喜欢 真的 假的 直接 然后 还有 就是 不是 我要 你是 我是 都是 有点 出来 来了 给我 可以 没有 我的 你的 他的 一下 之前 之后 今天 明天 昨天 已经 还是 或者 而且 不过 其实 反正 居然 竟然 突然 马上 准备 开始 结束 问题 东西 事情 时间 地方 朋友 兄弟 姐妹 老师 同学 老板 大大 老哥 大哥 小姐姐 小哥哥 谢谢 抱歉 对不起 没事 好的 行吧 不错 厉害 加油 上号 下线 睡觉 吃饭 上课 下课 考试 作业 上班 下班 赚钱 花钱 '
  // 上面是通用词；下面是"跑过一遍之后补的"——整句/语气词/口头应声，不是黑话
  + '收到 看看 宝宝 跪下 亲亲 鹅鹅 我好绝望啊 我真要死了 什么水平 人家本来就傻 别逗傻子了 敢耍老子 谁是你的主人 满盘皆输 两只猫娘 没到手也不亏 何意味 算你狠 别骂我了 真不是人 有点东西 不是吧 真的假的 笑死 绝了 服了 麻了 牛啊 离谱').split(/\s+/).filter(Boolean));

const nicknameHit = (w) => {
  for (const s of senders) {
    if (!s || s === '(activity-log)') continue;
    const name = s.replace(/[#＃].*$/, '').trim();          // 去掉 #5268 这种后缀
    if (name === w) return name;
    if (name.includes(w) && w.length >= 2) return name;      // 昵称里的片段：老冯/冠宇…
  }
  return null;
};

const kept = [];
const dropped = { nickname: [], rare: [], generic: [], format: [] };
for (const e of candidates) {
  const w = String(e.content ?? '').trim();
  if (!w) continue;
  if (!/^([\u4e00-\u9fff]{2,6}|[A-Za-z]{2,8})$/.test(w)) { dropped.format.push(w); continue; }
  const nick = nicknameHit(w);
  if (nick) { dropped.nickname.push(`${w}（昵称：${nick}）`); continue; }
  const n = freq.get(w) ?? 0;
  if (n < 2) { dropped.rare.push(w); continue; }
  if (STOP.has(w)) { dropped.generic.push(w); continue; }
  kept.push({
    id: e.id, content: w, freq: n,
    users: [...(users.get(w) ?? [])].slice(0, 4),
    groupCount: new Set(corpus.filter((r) => String(r.x).includes(w)).map((r) => r.g)).size,
    examples: examples.get(w) ?? [],
    hasMeaning: !!String(e.meaning ?? '').trim(),
  });
}
kept.sort((a, b) => (b.freq - a.freq) || a.content.localeCompare(b.content));
const shortlist = kept.slice(0, LIMIT);

const report = {
  generatedAt: new Date().toISOString(),
  corpusLines: corpus.length,
  candidates: candidates.length,
  shortlistCount: shortlist.length,
  dropped: {
    nickname: dropped.nickname.length,
    rare: dropped.rare.length,
    generic: dropped.generic.length,
    format: dropped.format.length,
  },
  shortlist,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(`语料 ${corpus.length} 条 ｜ 候选 ${candidates.length} 条`);
console.log(`剔掉：昵称 ${dropped.nickname.length} ｜ 只出现 1 次 ${dropped.rare.length} ｜ 普通词 ${dropped.generic.length} ｜ 格式不像词 ${dropped.format.length}`);
console.log(`留下 ${shortlist.length} 条 → state/slang-triage.json\n`);
for (const k of shortlist.slice(0, 40)) {
  console.log(`  ${String(k.freq).padStart(3)}× ${k.content}${k.groupCount > 1 ? ` 〔${k.groupCount} 个群〕` : ''}  ${k.examples[0]?.slice(0, 46) ?? ''}`);
}

if (RUN > 0) {
  const token = fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim();
  const ids = shortlist.slice(0, RUN).map((k) => k.id);
  const CHUNK = 8;
  console.log(`\n提交推理：${ids.length} 条（每批 ${CHUNK} 条，批间隔 8 秒）`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const res = await fetch('http://127.0.0.1:3100/api/slang/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ ids: batch }),
    });
    const j = await res.json().catch(() => null);
    console.log(`  第 ${i / CHUNK + 1} 批：${res.status} ${JSON.stringify(j)}`);
    if (i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, 8000));
  }
  console.log('推理是异步的（跑在"QQ 黑话学习"会话里，要联网查），跑完去看 state/slang.json 里这些词的 meaning。');
}
