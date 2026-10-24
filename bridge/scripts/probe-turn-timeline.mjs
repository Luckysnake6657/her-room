// 看某个会话最后若干帧的类型 + 时间，用来判断"turn 到底结束了没有"。
// 用法：node scripts/probe-turn-timeline.mjs <sessionId前缀> [尾部帧数]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const prefix = process.argv[2] || '';
const tail = Number(process.argv[3]) || 24;
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');

let file = '';
for (const dir of fs.readdirSync(base)) {
  if (!dir.includes('qq-bridge')) continue;
  for (const s of fs.readdirSync(path.join(base, dir))) {
    if (prefix && !s.includes(prefix)) continue;
    // v3/v4 并存时挑活的那个，别写死 v3（升级后 v3 不再增长）
    const f = sessionFileIn(path.join(base, dir, s));
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (file) break;
}
if (!file) { console.error('找不到会话文件'); process.exit(1); }
console.log('会话文件:', file.replace(process.env.USERPROFILE, '~'));
const buf = fs.readFileSync(file);
const starts = [];
let i = buf.indexOf(MAGIC);
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
const frames = [];
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try {
    const s = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
    let type = '?', time = 0, extra = '';
    try {
      const o = JSON.parse(s);
      type = o.type ?? '?';
      time = o.time ?? 0;
      if (type === 'turn/end') extra = `reason=${o.data?.reason?.kind} ${o.data?.reason?.error?.message ?? ''}`;
      if (type === 'step/start') extra = `turn=${o.data?.turn} step=${o.data?.step}`;
      if (type === 'assistant/message') extra = `turn=${o.data?.turn} step=${o.data?.step} parts=${o.data?.message?.content?.length ?? 0}`;
      if (type === 'tool/start' || type === 'tool/end') extra = o.data?.name ?? o.data?.callId ?? '';
    } catch {}
    frames.push({ type, time, extra });
  } catch {}
}
console.log(`共 ${frames.length} 帧，下面是尾部 ${tail} 帧：\n`);
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '        -        ');
for (const f of frames.slice(-tail)) {
  console.log(`${fmt(f.time)}  ${String(f.type).padEnd(22)} ${f.extra}`);
}
const ends = frames.filter((f) => f.type === 'turn/end');
console.log(`\nturn/end 帧数量: ${ends.length}`);
if (ends.length) {
  const last = ends[ends.length - 1];
  console.log(`最后一个 turn/end: ${fmt(last.time)}  ${last.extra}`);
}
const startsCount = frames.filter((f) => f.type === 'step/start').length;
console.log(`step/start 帧数量: ${startsCount}`);
