/**
 * 便签回声率（交接 next-session 里那条验收：10-23 之后看，<30% 正常 / ≥30% 要调）。
 *
 * 判据原话：
 *   抽 20 次"注入了便签"的唤醒，看便签里的原话 和 她本轮输出 的语义相似度；
 *   "高度相似"（同一件事、同样的说法）的比例 = 回声率。
 *
 * 数据来源（两处都要，缺一不可）：
 *   • state/bridge.log     —— 唤醒时刻（`[reserved2] 唤醒 key（reason）`）和便签存储（`[handoff] ... 记下 N 句：...`）。
 *                             **日志是 UTC 且每行不带日期** —— 这里从最后一行（≈现在）往回推日期，见 inferDays()。
 *   • state/tool-calls.jsonl —— 她发出的消息正文（ISO UTC，带 args.messages）。
 *
 * 匹配规则：对每个 idleTime/proactiveCheck/timeout 唤醒，取它**之前最近一次**同 key 的 handoff 当注入的便签，
 * 取唤醒后到下个唤醒前她发的消息当本轮输出。bigram 重合率 ≥ 0.5 记为"高度相似"。
 *
 * 用法：node scripts/echo-rate.mjs [--verbose]
 */
import fs from 'node:fs';

const ROOT = 'D:/qq-bridge';
const LOG = `${ROOT}/state/bridge.log`;
const CALLS = `${ROOT}/state/tool-calls.jsonl`;
const VERBOSE = process.argv.includes('--verbose');

const pad = (n) => String(n).padStart(2, '0');
const toIsoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const toMs = (ts) => Date.parse(ts);

// ── 1. 解析日志行（2026-10-23 起每行带日期；旧格式行跳过） ──
const allRows = [];
for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const m = /^(?:(\d{4}-\d{2}-\d{2}) )?(\d\d):(\d\d):(\d\d) \[bridge\] (.*)$/.exec(line);
  if (!m) continue;
  allRows.push({ date: m[1] || '', sec: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]), hms: `${m[2]}:${m[3]}:${m[4]}`, body: m[5] });
}
const rows = allRows.filter((r) => r.date);          // 只统计带日期的新格式（跨天不再靠猜）
if (!rows.length) {
  console.error('日志里没有带日期的行（2026-10-23 之前的旧格式不支持，等新日志攒起来再跑）');
  process.exit(1);
}
const skippedOld = allRows.length - rows.length;
if (skippedOld) console.log(`（跳过 ${skippedOld} 行旧格式日志：无日期）`);

// ── 2. 日期直接取自行内（2026-10-23 加日期后不再需要"反向推断"） ──
const tsOf = (i) => `${rows[i].date}T${rows[i].hms}Z`;
const first = tsOf(0);
const last = tsOf(rows.length - 1);

// ── 3. 事件 ──
const events = [];
rows.forEach((r, i) => {
  let x;
  if ((x = /^\[handoff\] (\S+) 记下 (\d+) 句：(.*)$/.exec(r.body))) {
    events.push({ type: 'handoff', key: x[1], lines: x[3].split(' / ').map((s) => s.trim()).filter(Boolean), ts: tsOf(i) });
  } else if ((x = /^\[reserved2\] 唤醒 (\S+)（([^）]*)）/.exec(r.body))) {
    events.push({ type: 'wake', key: x[1], reason: x[2], ts: tsOf(i) });
  }
});

// ── 4. 她发出的消息（tool-calls） ──
const sends = [];
for (const line of fs.readFileSync(CALLS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'call' || !/qq_send_message|qq_send_burst|qq_reply/.test(o.tool || '')) continue;
  let a;
  try { a = JSON.parse(o.args || '{}'); } catch { continue; }
  const raw = a.messages ?? a.message ?? '';
  const texts = Array.isArray(raw) ? raw : [raw];
  const joined = texts.map((t) => String(t ?? '')).filter(Boolean).join(' / ');
  if (joined) sends.push({ key: o.key, ts: o.time, text: joined });
}

// ── 5. 匹配 ──
function bigrams(s) {
  const t = String(s).replace(/[\s\p{P}\p{S}]/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}

const INJECT = new Set(['idleTime', 'proactiveCheck', 'timeout']);
const wakes = events.filter((e) => e.type === 'wake' && INJECT.has(e.reason));
const handoffs = events.filter((e) => e.type === 'handoff');
const samples = [];
const skipped = { noHandoff: 0, noOutput: 0 };
for (let i = 0; i < wakes.length; i++) {
  const w = wakes[i];
  const prev = handoffs.filter((h) => h.key === w.key && toMs(h.ts) <= toMs(w.ts)).pop();
  if (!prev) { skipped.noHandoff++; continue; }
  const nextWake = wakes.slice(i + 1).find((x) => x.key === w.key);
  const end = nextWake ? toMs(nextWake.ts) : toMs(w.ts) + 10 * 60 * 1000;
  const outs = sends.filter((s) => s.key === w.key && toMs(s.ts) > toMs(w.ts) && toMs(s.ts) < end);
  if (!outs.length) { skipped.noOutput++; if (VERBOSE) console.log(`(无输出) ${w.ts} ${w.key} ${w.reason} 便签=${prev.lines.join(' / ')}`); continue; }
  const note = prev.lines.join(' / ');
  const out = outs.map((s) => s.text).join(' / ');
  samples.push({ ts: w.ts, reason: w.reason, key: w.key, note, out, ov: overlap(note, out) });
}

// ── 6. 输出 ──
console.log(`日志覆盖：${first} → ${last}`);
console.log(`唤醒 ${events.filter((e) => e.type === 'wake').length} 次；其中注入类（idle/proactive/timeout）${wakes.length} 次；handoff 记录 ${handoffs.length} 条`);
console.log(`有效样本（注入了便签 + 她开了口）：${samples.length}；跳过：无便签 ${skipped.noHandoff} / 没开口 ${skipped.noOutput}\n`);
for (const s of samples) {
  console.log(`[${s.ts}] ${s.reason} ${s.key} 重合=${(s.ov * 100).toFixed(0)}%`);
  console.log(`  便签: ${s.note}`);
  console.log(`  输出: ${s.out.length > 300 ? s.out.slice(0, 300) + '…' : s.out}`);
  console.log('');
}
const hi = samples.filter((s) => s.ov >= 0.5).length;
const denomAll = wakes.length - skipped.noHandoff;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) : '—');
console.log(`高度相似(≥0.5)：${hi}/${samples.length}（只算开了口的）= ${pct(hi, samples.length)}%`);
console.log(`按全部"注入了便签"的唤醒算：${hi}/${denomAll} = ${pct(hi, denomAll)}%`);
console.log('判据：<30% 正常继续；≥30% 依次 ① 去掉提示语里暗示"接着说"的措辞 ② 砍到只存 1 句。');
if (samples.length < 10) console.log('⚠️ 样本不足 10，先别下结论——多跑几天再算。');
