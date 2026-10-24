/**
 * 语料库缺口审计：**SnowLuma 网关日志 vs state/group-corpus.jsonl**。
 *
 * 为什么需要：语料库是靠桥接进程"收到消息就追加"来长的。桥接重启、进程被杀、
 * 网关断线这几段时间里，群里说过的话**不会自己补上** —— 而那些话正是风格卡、
 * 通用模版、情感训练语料要用的原料。以前没人量过这件事，所以"语料够不够"
 * 只能靠感觉。
 *
 * 做法：网关日志里每条入站事件都有一行（群/私聊都带发送者和内容），把它按
 * **分钟**分桶，和语料库的分桶对比。两边时间口径不同（日志到秒、语料是 epoch 毫秒；
 * 引用/表情的渲染文字也不完全一样），所以只比**条数**、不比文本 ——
 * 差得多才说明"这段时间的消息根本没进语料"。
 *
 * 用法：
 *   node scripts/corpus-gap-audit.mjs                # 最近 3 天
 *   node scripts/corpus-gap-audit.mjs 7              # 最近 7 天
 *   node scripts/corpus-gap-audit.mjs 3 --verbose    # 顺带列出缺口窗口里的原话
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = process.env.SNOWLUMA_LOG_DIR || 'D:/SnowLuma/logs';
const DAYS = Math.max(1, Number(process.argv[2]) || 3);
const VERBOSE = process.argv.includes('--verbose');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const GROUP_IDS = new Set((config.allow?.groups ?? []).map(String));
const OWNER = String(config.ownerQQ ?? '');
// 语料库里实际出现过的会话（gate 用），避免把"网关能看到但桥接不该收"的群算成缺口
const CORPUS = path.join(ROOT, 'state', 'group-corpus.jsonl');
const corpusKeys = new Set();
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { corpusKeys.add(JSON.parse(line).g); } catch { /* 坏行 */ }
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const days = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  days.push(ymd(d));
}

// ── 网关日志 → 每条入站消息 {minute, key, sender, text} ────────────────────
// 行格式：`HH:MM:SS OK    [botQQ] [Event] 群 [群名(群号)] | [昵称(QQ)]: ID:xxx 内容`
//          `HH:MM:SS OK    [botQQ] [Event] 私聊 [昵称(QQ)]: ID:xxx 内容`
const EVENT_RE = /^(\d{2}):(\d{2}):(\d{2})\s+OK\s+\[\d+\]\s+\[Event\]\s+(群|私聊)\s+\[(.+?)\((\d+)\)\](?:\s+\|\s+\[(.+?)\((\d+)\)\]:)?\s+ID:(-?\d+)\s?(.*)$/;

const logMsgs = [];
for (const day of days) {
  const file = path.join(LOG_DIR, `snowluma-${day}.log`);
  if (!fs.existsSync(file)) continue;
  const [y, m, dd] = day.split('-').map(Number);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const mm = EVENT_RE.exec(line);
    if (!mm) continue;
    const [, hh, mi, ss, kind, , id1, senderName, senderId, msgId, text] = mm;
    const gid = kind === '群' ? id1 : senderId;
    const key = kind === '群' ? `group:${gid}` : `private:${gid}`;
    if (kind === '群' && !GROUP_IDS.has(gid)) continue;      // 白名单外的群本来就不该进语料
    if (kind === '私聊' && gid !== OWNER) continue;          // 别人的私聊同理
    if (!corpusKeys.has(key)) continue;
    const t = new Date(y, m - 1, dd, Number(hh), Number(mi), Number(ss)).getTime();
    logMsgs.push({ t, key, sender: senderName || gid, text: String(text ?? '').trim(), msgId });
  }
}

// ── 语料库 → 分桶 ──────────────────────────────────────────────────────────
const corpusMsgs = [];
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (!r?.t || !r?.g) continue;
  if (!days.includes(ymd(new Date(r.t)))) continue;
  corpusMsgs.push({ t: Number(r.t), key: String(r.g), sender: String(r.s ?? ''), text: String(r.x ?? '') });
}

const bucketOf = (t) => Math.floor(t / 60000);          // 分钟桶
const logBuckets = new Map();
for (const m of logMsgs) {
  const b = bucketOf(m.t);
  if (!logBuckets.has(b)) logBuckets.set(b, []);
  logBuckets.get(b).push(m);
}
const corpusBuckets = new Map();
for (const m of corpusMsgs) {
  const b = bucketOf(m.t);
  corpusBuckets.set(b, (corpusBuckets.get(b) ?? 0) + 1);
}

// ── 按小时汇总 ─────────────────────────────────────────────────────────────
const hourKey = (t) => {
  const d = new Date(t);
  return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}`;
};
const byHour = new Map();
for (const m of logMsgs) {
  const k = hourKey(m.t);
  if (!byHour.has(k)) byHour.set(k, { log: 0, corpus: 0 });
  byHour.get(k).log++;
}
for (const m of corpusMsgs) {
  const k = hourKey(m.t);
  if (!byHour.has(k)) byHour.set(k, { log: 0, corpus: 0 });
  byHour.get(k).corpus++;
}

console.log(`=== 语料缺口审计（最近 ${DAYS} 天：${days[days.length - 1]} ~ ${days[0]}）===`);
console.log(`网关日志入站消息（限白名单会话）${logMsgs.length} 条｜语料库同期 ${corpusMsgs.length} 条`);
console.log(`按会话：${[...new Set(logMsgs.map((m) => m.key))].map((k) => `${k}=${logMsgs.filter((m) => m.key === k).length}`).join('  ')}`);

const rows = [...byHour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const bad = rows.filter(([, v]) => v.log - v.corpus >= 5);
console.log(`\n按小时对比（只列差的）：${bad.length ? '' : '✅ 每个小时语料都不少于日志（没有整段丢失）'}`);
for (const [k, v] of bad) console.log(`  ${k} 时  日志 ${String(v.log).padStart(4)} / 语料 ${String(v.corpus).padStart(4)}  差 ${v.log - v.corpus}`);

// 连续缺口窗口：日志有、语料几乎为空的连续分钟段
const gapMinutes = [...logBuckets.keys()].filter((b) => (corpusBuckets.get(b) ?? 0) === 0).sort((a, b) => a - b);
const windows = [];
for (const b of gapMinutes) {
  const last = windows[windows.length - 1];
  if (last && b - last.end <= 3) last.end = b;
  else windows.push({ start: b, end: b });
}
const fmt = (min) => {
  const d = new Date(min * 60000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const lostMinutes = gapMinutes.length;
const lostMsgs = gapMinutes.reduce((n, b) => n + logBuckets.get(b).length, 0);
console.log(`\n有日志但语料为空的分钟段：${windows.length} 段 / ${lostMinutes} 分钟 / 约 ${lostMsgs} 条消息`);
for (const w of windows.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 8)) {
  const n = [...logBuckets.entries()].filter(([b]) => b >= w.start && b <= w.end).reduce((s, [, v]) => s + v.length, 0);
  console.log(`  ${fmt(w.start)} → ${fmt(w.end)}（${w.end - w.start + 1} 分钟，${n} 条）`);
  if (VERBOSE) {
    for (const [, arr] of logBuckets) {
      for (const m of arr) {
        if (bucketOf(m.t) >= w.start && bucketOf(m.t) <= w.end) console.log(`      ${m.key} ${m.sender}: ${m.text.slice(0, 80)}`);
      }
    }
  }
}
console.log(`\n结论：${lostMsgs === 0 ? '✅ 语料库没有缺口' : `⚠️ 约 ${lostMsgs} 条群聊原话没进语料（多为桥接重启/掉线期间）——用 scripts/backfill-corpus-from-logs.mjs 可补`}`);
