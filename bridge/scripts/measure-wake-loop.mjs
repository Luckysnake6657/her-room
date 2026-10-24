/**
 * 量"她一轮里调了几次 qq_wait_for_messages / 有没有被 mark_read 拒" —— 2026-10-01 那个空转问题的尺子。
 *
 * 背景：wait 调用 = 一个完整的模型请求。实测最坏的一轮：
 *   OW 群 3 轮 / 20 次 wait / 44 分钟；私聊 9 轮 / 90 次 wait / 410 分钟。
 * 修法见 QUICKSTART「她一轮里调 20 次 wait」一节。改完之后用这个脚本对比：
 *   **每个 turn 的平均 wait 次数**应该从 7~10 降到 1~3。
 *
 * 用法：
 *   node scripts/measure-wake-loop.mjs            # 全部会话
 *   node scripts/measure-wake-loop.mjs 60         # 只看最近 60 分钟内的轮次
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS_DIR = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const minutes = Number(process.argv[2]) || 0;

function readEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { /* 坏帧 */ }
  }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function findFile(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    // 写死 v3 会数到升级前那份冻结的历史：wait 次数/轮次从此不再变化
    const f = sessionFileIn(path.join(SESSIONS_DIR, dir, sessionId));
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const map = JSON.parse(fs.readFileSync('state/sessions.json', 'utf8')).sessions ?? {};
const T = (t) => new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const since = minutes > 0 ? Date.now() - minutes * 60000 : 0;

// 工具日志里 mark_read 被拒的次数（同一个"观察没满足"的症状）
let markReadBlocked = 0;
try {
  for (const line of fs.readFileSync('state/tool-calls.jsonl', 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'result' || e.ok !== false) continue;
    if (!/mark_read/.test(String(e.tool ?? ''))) continue;
    if (since && Date.parse(e.time) < since) continue;
    markReadBlocked++;
  }
} catch { /* 没日志就算了 */ }

let any = false;
for (const [key, sid] of Object.entries(map)) {
  const file = sid && findFile(sid);
  if (!file) continue;
  const ev = readEvents(file);
  const turns = ev.filter((e) => e.type === 'turn/start' && (!since || Number(e.time) >= since));
  if (!turns.length) continue;
  any = true;
  const waits = ev.filter((e) => e.type === 'tool/call' && /qq_wait_for_messages/.test(String(e.data?.name ?? ''))
    && (!since || Number(e.time) >= since));
  const perTurn = (waits.length / turns.length).toFixed(1);
  const lastAt = turns.at(-1).time;
  const immediate = ev.filter((e) => e.type === 'tool/result' && Number(e.time) >= (since || 0));
  console.log(`${key}`);
  console.log(`  轮次 ${turns.length}｜wait ${waits.length}｜**场均 ${perTurn} 次**｜最近一轮 ${T(lastAt)}`);
  // 区分"立即返回"和"真的等了"：立即返回的路以前不计入观察，是空转的来源
  let imm = 0;
  for (const e of immediate) {
    const txt = (e.data?.message?.content?.[0]?.content ?? []).map((x) => x.text ?? '').join('');
    if (/"reason":\s*"unseen-unread"/.test(txt)) imm++;
  }
  if (imm) console.log(`  其中"有未看过消息→立即返回"的 ${imm} 次（**以前这条路不算观察，就是空转的来源**）`);
}
if (!any) console.log('（这段时间没有轮次）');
console.log(`\nmark_read 被"观察没满足"拒掉的次数: ${markReadBlocked}${minutes ? `（最近 ${minutes} 分钟）` : '（全量日志）'}`);
console.log('参考：修之前最坏 场均 7~10 次；修完应该降到 1~3 次。');
