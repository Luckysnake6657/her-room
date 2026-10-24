// 看私聊会话最后发生了什么：是否有正在进行的 turn、最后一步停在哪个工具。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const dir = process.argv[2] || 'C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/session-194f27e8-13ad-4e33-b362-2c2b9cdd2e96';
// 目录里可能同时有 v3 和 v4（升级后 v3 冻结不再写），挑活的那个
const file = sessionFileIn(dir);
const buf = fs.readFileSync(file);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
}
let text = '';
for (let i = 0; i < offs.length; i++) {
  const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
  try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* skip */ }
}
const recs = [];
for (const l of text.split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }

console.log(`文件 ${buf.length} 字节，${offs.length} 帧，${recs.length} 条记录`);
console.log('\n=== 记录类型统计 ===');
const types = new Map();
for (const r of recs) types.set(r.type, (types.get(r.type) ?? 0) + 1);
console.log([...types.entries()].map(([k, v]) => `${k}×${v}`).join(', '));

console.log('\n=== 最后 18 条记录 ===');
const when = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN') : '?');
for (const r of recs.slice(-18)) {
  let extra = '';
  if (r.type === 'tool/call') {
    extra = String(r.data?.name ?? '').replace('mcp__snowluma__', '') + ' ' + JSON.stringify(r.data?.arguments ?? '').slice(0, 90);
  } else if (r.type === 'tool/result') {
    extra = r.data?.ok === false ? 'FAIL' : 'OK';
  } else if (r.type === 'step/start') {
    extra = `step ${r.data?.step ?? ''}`;
  } else if (r.type === 'turn/start') {
    extra = `turn ${r.data?.turn ?? ''}`;
  } else if (r.type === 'turn/end') {
    extra = `reason=${JSON.stringify(r.data?.reason ?? '')}`;
  } else if (r.type === 'assistant/message') {
    const u = r.data?.usage ?? {};
    extra = `in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0}`;
  } else if (r.type === 'agent/inbox/spliced') {
    extra = JSON.stringify(r.data ?? '').slice(0, 90);
  }
  console.log(`  ${when(r.time)} ${String(r.type).padEnd(22)} ${extra}`);
}

// 是否有未闭合的 turn
const starts = recs.filter((r) => r.type === 'turn/start').length;
const ends = recs.filter((r) => r.type === 'turn/end').length;
const stepStarts = recs.filter((r) => r.type === 'step/start').length;
const stepEnds = recs.filter((r) => r.type === 'step/end').length;
console.log('\n=== 闭合情况 ===');
console.log(`  turn: start ${starts} / end ${ends}  ${starts === ends ? '✅ 已闭合' : '⚠️ 有未闭合的 turn'}`);
console.log(`  step: start ${stepStarts} / end ${stepEnds}  ${stepStarts === stepEnds ? '✅ 已闭合' : '⚠️ 有未闭合的 step'}`);
