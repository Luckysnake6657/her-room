/**
 * 从 SnowLuma 网关日志**补录**群语料到 state/group-corpus.jsonl。
 *
 * 为什么需要（2026-10-02）：语料库是"桥接进程收到消息就追加"长的，所以
 *   ① 桥接重启/掉线期间，② 「静默模式」开着期间（那时整条消息被 early-return 丢掉，
 *   见 feedLearning 的注释）—— 群里说过的话不会进语料。实测 10/2 20:02–20:42
 *   宁大CS2群 99 条发言只有 37 条进了库。而语料正是风格卡/通用模版/情感训练语料的原料。
 *
 * 网关日志是**独立的**那一路（SnowLuma 自己写的），所以能补回来。
 *
 * 安全性：
 *   • 只补 config.allow 里的群 + ownerQQ 私聊（跟语料库的收录范围一致）；
 *   • 跳过她自己发的消息（日志里 `[Event] [自身]` 那种直接不匹配）；
 *   • 按"分钟 + 文本"去重，已是幂等的（重复跑不会灌重）；
 *   • 默认 **--dry**：先只看会补多少条，确认了再加 `--write`。
 *
 * 用法：
 *   node scripts/backfill-corpus-from-logs.mjs                 # 最近 3 天，只看不写
 *   node scripts/backfill-corpus-from-logs.mjs 7 --write       # 最近 7 天，真写入
 *   node scripts/backfill-corpus-from-logs.mjs 1 --write --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = process.env.SNOWLUMA_LOG_DIR || 'D:/SnowLuma/logs';
const CORPUS = path.join(ROOT, 'state', 'group-corpus.jsonl');
const argv = process.argv.slice(2);
const DAYS = Math.max(1, Number(argv.find((a) => /^\d+$/.test(a))) || 3);
const WRITE = argv.includes('--write');
const VERBOSE = argv.includes('--verbose');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GROUP_IDS = new Set((config.allow?.groups ?? []).map(String));
const OWNER = String(config.ownerQQ ?? '');
const INCLUDE_PRIVATE = config.socialV2?.corpus?.includePrivate !== false;
const SELF_NAMES = new Set(['今晚吃兔兔', String(config.qqName ?? ''), String(config.socialV2?.selfName ?? '')]
  .map((x) => String(x).trim().toLowerCase()).filter(Boolean));

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const days = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  days.push(ymd(d));
}

// ── 已有语料：建"这条消息是不是已经在库里"的索引 ──────────────────────────
// 为什么不能只按文本比：**网关日志和语料库里的文字不是同一份渲染**，实测三种系统性差异——
//   ① 引用：日志 `[回复 [骨血8(1542409733)]: 原文] @xxx 我说的话`
//           语料 `[引用 骨血8（00:31，2分钟前）：原文]@骨血8 我说的话`
//   ② @点名：日志 `@120062152 待会儿耍不耍快速`（原始 QQ）
//           语料 `@我一直在哭#5696 待会儿耍不耍快速`（桥接解析成了群名片）
//   ③ 表情：日志 `[图片]`，语料 `[图片][伤心]`
// 只按文本做的第一版把**已在库里的 ~900 条**判成"缺失"（差点灌进去一堆重复；dry 模式救了一次）。
//
// 所以判据改成 **群 + 发送者 + 分钟（±2 分钟容差） + 正文尾部 6 个字**：
//   发送者两边都是同一个群名片（可靠）；正文尾部取"自己说的话"的尾巴（引用/@前缀都在前面，被切掉）。
//   容差是为了"投递延迟"：日志按网关收到的时间打点，语料按桥接处理的时间落盘，差一两分钟很正常。
const stripBrackets = (s) => {
  let t = String(s ?? '');
  for (let i = 0; i < 4; i++) t = t.replace(/\[[^\]]*\]/g, '');
  return t;
};
/** 去掉开头那个 `[回复 …]` / `[引用 …]` 块 —— 它可能嵌套括号，必须按配平找结尾。 */
const stripQuote = (s) => {
  let t = String(s ?? '');
  for (let guard = 0; guard < 4; guard++) {
    const m = /\[(回复|引用)/.exec(t);
    if (!m) break;
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < t.length; i++) {
      if (t[i] === '[') depth++;
      else if (t[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    t = end < 0 ? t.slice(0, m.index) : t.slice(0, m.index) + t.slice(end + 1);
  }
  return t;
};
const stripMentions = (s) => String(s ?? '').replace(/@\S{1,30}(?=\s|$)/g, '');
const stripPunct = (s) => String(s ?? '').replace(/[\s，。！？、~～…,.!?\[\]（）()「」:：;；]/g, '');
/** "自己说的那句话"的指纹：剥引用 → 剥@ → 剥方括号块 → 剥标点 → 取尾部 6 字
 *  • 正文为空 = 纯媒体消息 → 一律记成 `#媒体`：**两边的占位符不一样**！
 *    网关日志把自定义表情/贴纸打成 `[图片]`，而桥接渲染成 `[表情包]`（实测骨血8 今天 28 条
 *    "图片"里，绝大多数在库里是 `[表情包]`）——按具体占位符比会把它们全判成缺失（虚报 200+）。
 *  • 直接在原文上找第一个方括号会先撞到 `[引用 …]`，所以必须先剥引用再找。 */
const tailKey = (s) => {
  const noQuote = stripQuote(s);
  const body = stripPunct(stripMentions(stripBrackets(noQuote)));
  if (body.length >= 6) return body.slice(-6);
  if (body) return body;
  return '#媒体';
};
const corpusPool = new Map();           // `group|sender|tailKey` -> [分钟时间戳]（可消耗的池子）
const existingByDay = new Map();
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const k = `${r.g}|${String(r.s ?? '').trim()}|${tailKey(r.x)}`;
  if (!corpusPool.has(k)) corpusPool.set(k, []);
  corpusPool.get(k).push(Math.floor(Number(r.t) / 60000));
  const d = ymd(new Date(Number(r.t)));
  existingByDay.set(d, (existingByDay.get(d) ?? 0) + 1);
}
for (const arr of corpusPool.values()) arr.sort((a, b) => a - b);

/**
 * 贪心配对：这条日志消息在库里"有没有对应的那一条"。
 *
 * 为什么不能只判"存在与否"：`[图片]` 这种文本**一分钟内会出现很多次**（群友连着甩图），
 * 只判存在的话，一分钟里 3 张图配 1 条已有记录 → 另外 2 条永远判成"已存在"（漏补）；
 * 反过来只判文本又会重复灌。所以按**多重集合**配对：配对成功就消耗掉池子里那一条。
 */
const SKEW_MIN = 2;
const alreadyIn = (g, sender, x, minute) => {
  const arr = corpusPool.get(`${g}|${String(sender ?? '').trim()}|${tailKey(x)}`);
  if (!arr) return false;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === -1) continue;
    if (Math.abs(arr[i] - minute) <= SKEW_MIN) { arr[i] = -1; return true; }   // 消耗掉
  }
  return false;
};
const existing = new Set();
// ── 解析网关日志 ───────────────────────────────────────────────────────────
// `HH:MM:SS OK    [botQQ] [Event] 群 [群名(群号)] | [昵称(QQ)]: ID:xxx 内容`
// `HH:MM:SS OK    [botQQ] [Event] 私聊 [昵称(QQ)]: ID:xxx 内容`
// 她自己发的那些是 `[Event] [自身] …`，下面的正则**不匹配**，天然被排除。
const EVENT_RE = /^(\d{2}):(\d{2}):(\d{2})\s+OK\s+\[\d+\]\s+\[Event\]\s+(群|私聊)\s+\[(.+?)\((\d+)\)\](?:\s+\|\s+\[(.+?)\((\d+)\)\]:)?\s+ID:(-?\d+)\s?(.*)$/;

const toAdd = [];
const stat = { scanned: 0, skippedGroup: 0, skippedPrivate: 0, dup: 0, empty: 0, self: 0 };
for (const day of days) {
  const file = path.join(LOG_DIR, `snowluma-${day}.log`);
  if (!fs.existsSync(file)) continue;
  const [y, m, dd] = day.split('-').map(Number);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const mm = EVENT_RE.exec(line);
    if (!mm) continue;
    stat.scanned++;
    const [, hh, mi, ss, kind, , gid, nick, uid, , text] = mm;
    if (kind === '群' && !GROUP_IDS.has(gid)) { stat.skippedGroup++; continue; }
    if (kind === '私聊' && (gid !== OWNER || !INCLUDE_PRIVATE)) { stat.skippedPrivate++; continue; }
    const sender = String(nick || (kind === '私聊' ? '管理员' : gid)).trim();
    if (SELF_NAMES.has(sender.toLowerCase())) { stat.self++; continue; }
    const body = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) { stat.empty++; continue; }
    const t = new Date(y, m - 1, dd, Number(hh), Number(mi), Number(ss)).getTime();
    const key = kind === '群' ? `group:${gid}` : `private:${gid}`;
    const minute = Math.floor(t / 60000);
    if (alreadyIn(key, sender, body, minute)) { stat.dup++; continue; }
    // 同一批里也去重（同一个人同一分钟发了同样的话）
    const k = `${key}|${sender}|${tailKey(body)}|${minute}`;
    if (existing.has(k)) { stat.dup++; continue; }
    existing.add(k);
    toAdd.push({ t, g: key, s: sender.slice(0, 60), x: body.slice(0, 400) });
  }
}

const byDay = new Map();
for (const r of toAdd) {
  const d = ymd(new Date(r.t));
  byDay.set(d, (byDay.get(d) ?? 0) + 1);
}
console.log(`=== 语料补录（最近 ${DAYS} 天：${days[days.length - 1]} ~ ${days[0]}）===`);
console.log(`扫过日志事件 ${stat.scanned} 条｜不在白名单的群 ${stat.skippedGroup}｜不相关私聊 ${stat.skippedPrivate}｜她自己……（正则会跳过）｜空文本 ${stat.empty}`);
console.log(`日志里已经是语料里的（去重命中）${stat.dup} 条`);
console.log(`**待补录 ${toAdd.length} 条**`);
for (const d of [...byDay.keys()].sort()) console.log(`  ${d}: +${byDay.get(d)}（日志该天已有 ${existingByDay.get(d) ?? 0} 条）`);
if (VERBOSE) for (const r of toAdd.slice(0, 30)) console.log(`  ${r.g} ${r.s}: ${r.x.slice(0, 70)}`);

if (!toAdd.length) {
  console.log('\n✅ 没有要补的：语料库跟网关日志已经对齐。');
  process.exit(0);
}
if (!WRITE) {
  console.log('\n（--dry 模式：什么都没写。确认无误后加 --write 真写入。）');
  process.exit(0);
}

// 补录的行**按时间排序后**追加：语料是 append-only，风格卡按顺序分桶，乱序会让"最近 N 条"失真
toAdd.sort((a, b) => a.t - b.t);
const before = fs.statSync(CORPUS).size;
fs.appendFileSync(CORPUS, toAdd.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log(`\n✅ 已补录 ${toAdd.length} 条：${Math.round(before / 1024)}KB → ${Math.round(fs.statSync(CORPUS).size / 1024)}KB`);
console.log('   接下来：node scripts/corpus-gap-audit.mjs 复查缺口；风格卡到点会自动重建（也可强制重建）。');
