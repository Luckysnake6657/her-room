// 完整打印某个会话里 assistant/message 帧（对齐回答提取逻辑）。
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
    // v3/v4 并存时挑活的那个，别写死 v3（升级后 v3 不再增长）
    const f = sessionFileIn(path.join(base, dir, s));
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (file) break;
}
if (!file) { console.error('找不到会话文件'); process.exit(1); }
const buf = fs.readFileSync(file);
const starts = [];
let i = buf.indexOf(MAGIC);
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  let s = '';
  try { s = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { continue; }
  if (!s.includes('"assistant/message"') && !s.includes('"turn/end"')) continue;
  console.log('='.repeat(72));
  try {
    const o = JSON.parse(s);
    console.log('type:', o.type);
    const msg = o.data?.message;
    if (msg?.content) {
      for (const part of msg.content) {
        console.log(`  [${part.type}] ${String(part.text ?? '').slice(0, 400)}`);
      }
    } else {
      console.log(JSON.stringify(o.data).slice(0, 900));
    }
  } catch { console.log(s.slice(0, 600)); }
}
