// 量 DSH 会话历史的真实体积与消息条数。
//
// 为什么要专门写：会话历史是**多帧拼接**的（v3 一行一帧；v4 一大块一帧、一帧含很多行），
// zlib.zstdDecompressSync 只解第一帧，于是会得到"0.00 MB / 1 条"这种假结果。
// 正确做法是按 zstd 帧魔数（28 B5 2F FD）切开逐帧解。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');

/** 按帧魔数切分并逐帧解压，返回 { rawBytes, frames, failed }。 */
function measure(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let idx = buf.indexOf(MAGIC);
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
  if (!starts.length) return null;
  let rawBytes = 0, frames = 0, failed = 0;
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      rawBytes += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).length;
      frames++;
    } catch { failed++; }
  }
  return { rawBytes, frames, failed, compressed: buf.length };
}

const rows = [];
for (const dir of fs.readdirSync(base).filter((d) => d.includes('qq-bridge'))) {
  const sd = path.join(base, dir);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const sess of fs.readdirSync(sd)) {
    // 升级后目录里可能同时有 v3（已冻结）和 v4，要量的是活的那个
    const f = sessionFileIn(path.join(sd, sess));
    if (!fs.existsSync(f)) continue;
    const m = measure(f);
    if (m) rows.push({ sess, ...m });
  }
}
rows.sort((a, b) => b.rawBytes - a.rawBytes);
console.log('=== DSH 会话历史（解开后的真实体积）===');
let total = 0;
for (const r of rows) {
  total += r.rawBytes;
  console.log(`  ${r.sess.slice(0, 20)}…  解开 ${(r.rawBytes / 1024 / 1024).toFixed(2)} MB  帧/消息 ${r.frames} 条` + (r.failed ? `  (解压失败 ${r.failed})` : ''));
}
console.log(`\n  合计 ${(total / 1024 / 1024).toFixed(2)} MB，共 ${rows.length} 个会话`);

// 粗估 token：JSON 里大量重复结构，按 3 字符/token 保守估（中文更接近 1-1.5 字符/token）
console.log(`  按 3 字符/token 粗估：约 ${(total / 3 / 1000).toFixed(0)}k token 的历史总量`);
console.log('  注意：每回合只重发"当前会话"的历史，所以要看单个会话的量。');
