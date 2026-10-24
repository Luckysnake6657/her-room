// 看某个会话里"那一轮 turn 到底在干什么"：帧类型分布 + 工具调用次数/耗时。
// 用法：node scripts/probe-turn-tools.mjs <sessionId前缀>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const prefix = process.argv[2] || '';
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
let file = '';
for (const dir of fs.readdirSync(base)) {
  if (!dir.includes('qq-bridge')) continue;
  for (const s of fs.readdirSync(path.join(base, dir))) {
    if (prefix && !s.includes(prefix)) continue;
    // 升级后 v3 冻结：只认 v3 会看到"turn 从来没结束"这种假结论
    const f = sessionFileIn(path.join(base, dir, s));
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (file) break;
}
if (!file) { console.error('找不到会话'); process.exit(1); }
const buf = fs.readFileSync(file);
const starts = [];
let i = buf.indexOf(MAGIC);
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
// ⚠️ 一个 zstd 帧里可能装**多行** JSONL（实测第 2 帧就装了 3 个对象）。
//    所以必须按行切、逐行 parse —— 直接 JSON.parse(整帧) 会漏掉绝大多数帧，
//    得出"0 个 turn/end"这种错误结论（我自己先踩过）。
const events = [];
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  let text = '';
  try { text = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* 非 JSON 行忽略 */ }
  }
}
const types = new Map();
const tools = [];
let minT = Infinity;
let maxT = 0;
for (const o of events) {
  types.set(o.type ?? '?', (types.get(o.type ?? '?') ?? 0) + 1);
  if (o.time) { minT = Math.min(minT, o.time); maxT = Math.max(maxT, o.time); }
  const s = JSON.stringify(o.data ?? {});
  const nameMatch = /"(?:name|toolName|tool)":"([^"]+)"/.exec(s);
  if (o.type && /tool/i.test(o.type)) tools.push(`${new Date(o.time || 0).toLocaleTimeString('zh-CN', { hour12: false })}  ${o.type}  ${nameMatch?.[1] ?? ''}`);
}
console.log(`共 ${events.length} 个事件（${starts.length} 个 zstd 帧）`);
console.log('帧类型分布（前 16）：');
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`  ${String(n).padStart(5)}  ${t}`);
if (minT < Infinity) {
  console.log(`\n时间跨度: ${new Date(minT).toLocaleString('zh-CN')} → ${new Date(maxT).toLocaleString('zh-CN')}`
    + `（${Math.round((maxT - minT) / 60000)} 分钟）`);
}
if (tools.length) {
  console.log(`\n工具相关帧（${tools.length} 条，显示前 12）：`);
  for (const t of tools.slice(0, 12)) console.log('  ' + t);
}

// 每个 turn 的耗时 / 步数 / 工具次数 —— 判断"卡 15 分钟"到底是卡住还是在干活
const turns = new Map();
for (const o of events) {
  const n = o.data?.turn;
  if (!n) continue;
  if (!turns.has(n)) turns.set(n, { start: 0, end: 0, steps: 0, tools: 0, reason: '' });
  const t = turns.get(n);
  if (o.type === 'turn/start') t.start = o.time;
  if (o.type === 'turn/end') { t.end = o.time; t.reason = o.data?.reason?.kind ?? ''; }
  if (o.type === 'step/start') t.steps++;
  if (o.type === 'tool/call') t.tools++;
}
console.log('\n每个 turn 的耗时（这就是"会话繁忙"的真相）：');
const rows = [...turns.entries()].sort((a, b) => a[0] - b[0]);
for (const [n, t] of rows) {
  const dur = t.start && t.end ? Math.round((t.end - t.start) / 1000) : 0;
  console.log(`  turn ${n}: ${String(dur).padStart(5)}s  ${String(t.steps).padStart(3)} 步  ${String(t.tools).padStart(3)} 次工具  ${t.reason}`
    + `${t.start ? `  (${new Date(t.start).toLocaleTimeString('zh-CN', { hour12: false })} → ${t.end ? new Date(t.end).toLocaleTimeString('zh-CN', { hour12: false }) : '未结束'})` : ''}`);
}
const totalTools = rows.reduce((n, [, t]) => n + t.tools, 0);
const totalSteps = rows.reduce((n, [, t]) => n + t.steps, 0);
console.log(`\n合计 ${totalSteps} 步 / ${totalTools} 次工具调用；平均每步 ${rows.length ? Math.round(rows.reduce((n, [, t]) => n + (t.end - t.start), 0) / Math.max(1, totalSteps) / 1000) : 0}s`);

// 哪一步最慢：按**事件顺序**配对 tool/call → 下一个 tool/result
// （callId 字段名在不同 DSH 版本不一样，按顺序配更稳）
const toolStats = new Map();
for (let k = 0; k < events.length; k++) {
  if (events[k].type !== 'tool/call') continue;
  const s = JSON.stringify(events[k].data ?? {});
  const name = /"(?:name|toolName|tool)":"([^"]+)"/.exec(s)?.[1] ?? '?';
  let res = null;
  for (let j = k + 1; j < events.length; j++) {
    if (events[j].type === 'tool/result') { res = events[j]; break; }
    if (events[j].type === 'tool/call') break;   // 没等到结果就换下一个了
  }
  if (!res) continue;
  const ms = (res.time || 0) - (events[k].time || 0);
  const cur = toolStats.get(name) ?? { n: 0, total: 0, max: 0 };
  cur.n++; cur.total += ms;
  cur.max = Math.max(cur.max, ms);
  toolStats.set(name, cur);
}
const slow = [...toolStats.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
if (slow.length) {
  console.log('\n工具耗时排行（总耗时 / 次数 / 最慢一次）：');
  for (const [name, s] of slow) {
    console.log(`  ${String(Math.round(s.total / 1000)).padStart(5)}s  ${String(s.n).padStart(3)} 次  最慢 ${String(Math.round(s.max / 1000)).padStart(4)}s  ${name}`);
  }
}

