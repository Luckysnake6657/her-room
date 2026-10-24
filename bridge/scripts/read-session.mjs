/**
 * 读她（AI）的 DSH 会话日志 —— 排查"她到底怎么理解的"唯一硬证据。
 *
 * 为什么需要它：`state/social-v2.json` 只记消息，没有她的**推理**；而推理就在会话日志里
 * （`assistant/message` 的 `reasoning` 块）。2026-10-01 那个"你安慰她、她回你一句工作汇报"的疑问
 * 就是靠它定性的：她的推理显示**她理解对了**（"他在同情我被反爬挡住，我该自嘲一下"），
 * 只是那条话被连发闸门拒了、没送到。
 *
 * ⚠️ 坑：文件是**多帧拼接**的 zstd（每次 append 一个 frame），Node 的 `zstdDecompressSync`
 *    和流式解码**都只解第一帧**（解出来只有 210 字节的头部）→ 必须按帧魔数 `28 B5 2F FD`
 *    切分逐段解（bridge.js 里 `sessionHistoryRawBytes` 也是这么干的）。
 *    （这个脚本的前身是硬编码 session id + 全量 dump 的版本，2026-10-01 升级成按会话 key 定位、
 *      并能只打她的推理 / 调用 / 说话。）
 *
 * 用法：
 *   node scripts/read-session.mjs private:984776985          # 最近一轮
 *   node scripts/read-session.mjs private:984776985 60       # 最近 60 分钟
 *   node scripts/read-session.mjs session-02cf3378-... 30     # 直接给 sessionId
 *   node scripts/read-session.mjs private:984776985 60 推理   # 只看推理（推理|调用|说话）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS_DIR = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');

const arg = process.argv[2] ?? '';
const minutes = Number(process.argv[3]) || 0;
const only = process.argv[4] ?? '';

if (!arg) {
  console.log('用法: node scripts/read-session.mjs <sessionId|private:KEY|group:ID> [minutesBack] [推理|调用|说话]');
  process.exit(1);
}

/** 会话 key → sessionId（桥接把映射写在 state/sessions.json） */
function resolveSessionId(a) {
  if (a.startsWith('session-')) return a;
  try {
    return JSON.parse(fs.readFileSync('state/sessions.json', 'utf8')).sessions?.[a] ?? null;
  } catch { return null; }
}

function findSessionFile(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    // 别写死 v3：升级到 v4 后同一目录里 v3/v4 并存，v3 已经冻结不再追加，
    // 读它会一直给你升级前那份历史（"她最后一条消息"停在几天前）
    const f = sessionFileIn(path.join(SESSIONS_DIR, dir, sessionId));
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 多帧 zstd：按魔数切帧逐段解 */
function readEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')); } catch { /* 坏帧跳过 */ }
  }
  return out.join('').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const sessionId = resolveSessionId(arg);
if (!sessionId) { console.log(`找不到 ${arg} 对应的 sessionId（看 state/sessions.json）`); process.exit(1); }
const file = findSessionFile(sessionId);
if (!file) { console.log(`找不到会话文件：${sessionId}`); process.exit(1); }

const events = readEvents(file);
const T = (t) => new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const since = minutes > 0 ? Date.now() - minutes * 60000 : 0;

// 没给时间范围时只打最后一轮（从最后一条投递的提示词起）
let startSeq = 0;
if (!since) {
  const lastUser = [...events].reverse().find((e) => e.type === 'user/message');
  startSeq = lastUser?.seq ?? 0;
}

console.log(`文件: ${file}`);
console.log(`事件 ${events.length} 条${minutes ? `｜只看最近 ${minutes} 分钟` : '｜只看最后一轮'}\n`);

for (const e of events) {
  if (e.seq <= startSeq) continue;
  if (since && Number(e.time) < since) continue;
  if (e.type === 'user/message') {
    if (only && only !== '提示词') continue;
    const txt = (e.data?.content ?? []).map((b) => b.text ?? '').join('\n');
    console.log(`\n===== 【投递给她的提示词】 ${T(e.time)}（${txt.length} 字）=====\n${txt.slice(-700)}`);
  } else if (e.type === 'assistant/message') {
    for (const b of e.data?.message?.content ?? []) {
      const text = String(b.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (b.type === 'reasoning' && (!only || only === '推理')) console.log(`\n[推理] ${text}`);
      else if (b.type === 'text' && (!only || only === '说话')) console.log(`\n[说话] ${text}`);
    }
  } else if (e.type === 'tool/call') {
    if (only && only !== '调用') continue;
    const name = String(e.data?.name ?? '').replace(/^mcp__[a-z-]+__/, '');
    console.log(`[调用] ${name} ${String(e.data?.arguments ?? '').slice(0, 180)}`);
  } else if (e.type === 'tool/result') {
    if (only && only !== '调用') continue;
    const block = e.data?.message?.content?.[0];
    const txt = (block?.content ?? []).map((x) => x.text ?? '').join(' ').replace(/\s+/g, ' ');
    const bad = block?.isError === true || e.data?.message?.isError === true;
    console.log(`[结果${bad ? ' ⚠️失败' : ''}] ${txt.slice(0, 220)}`);
  }
}
