// 从 DSH 会话帧里挖出真实报错（桥接只把它发到 QQ，没落日志，所以只能回源找）。
//
// 会话历史是多个 zstd 帧拼接的，各帧独立压缩。
// 必须按帧魔数切开逐帧解，`zstdDecompressSync(整个文件)` 只会给你第一帧。
// ⚠️ 帧的粒度随格式变过：v3 一行一帧；v4（0.2.0 起）一大块一帧、一帧里含很多行 JSONL
//    —— 所以按"帧"当一条记录用是不对的，见下面按行拆的地方。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const NEEDLES = ['DeepSeek API error', 'HTTP 400', 'maximum context', 'context length', 'invalid_request', 'tool_calls'];

function frames(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let idx = buf.indexOf(MAGIC);
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')); } catch {}
  }
  return out;
}

const hits = [];
for (const dir of fs.readdirSync(base).filter((d) => d.includes('qq-bridge'))) {
  const sd = path.join(base, dir);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const sess of fs.readdirSync(sd)) {
    // v3/v4 并存时挑活的那个（升级后 v3 冻结，扫它永远看不到新报错）
    const f = sessionFileIn(path.join(sd, sess));
    if (!fs.existsSync(f)) continue;
    const fs2 = frames(f);
    fs2.forEach((line, i) => {
      if (!NEEDLES.some((n) => line.includes(n))) return;
      hits.push({ sess, i, total: fs2.length, line });
    });
  }
}

console.log(`命中 ${hits.length} 帧\n`);
// 只看最新的几条（会话文件是按时间追加的，靠后的即较新）
for (const h of hits.slice(-8)) {
  console.log(`--- ${h.sess.slice(0, 20)}… 第 ${h.i + 1}/${h.total} 帧 ---`);
  let obj = null;
  try { obj = JSON.parse(h.line); } catch {}
  const text = obj ? JSON.stringify(obj) : h.line;
  console.log(text.slice(0, 900));
  console.log('');
}
