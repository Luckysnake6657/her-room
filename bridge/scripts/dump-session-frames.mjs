// 把某个会话的全部帧导出来（逐帧解压），用于看清它的请求到底长什么样。
// 用法: node scripts/dump-session-frames.mjs <sessionId前缀> [最多打印多少字符]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const prefix = process.argv[2];
const maxChars = Number(process.argv[3]) || 700;

if (!prefix) { console.error('用法: node scripts/dump-session-frames.mjs <sessionId前缀>'); process.exit(1); }

let file = null;
for (const dir of fs.readdirSync(base)) {
  const sd = path.join(base, dir);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const sess of fs.readdirSync(sd)) {
    if (!sess.includes(prefix)) continue;
    // v3/v4 并存时挑活的那个（升级后 v3 冻结不再写）
    const f = sessionFileIn(path.join(sd, sess));
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (file) break;
}
if (!file) { console.error('找不到会话 ' + prefix); process.exit(1); }
console.log('文件:', file, '\n');

const buf = fs.readFileSync(file);
const starts = [];
let idx = buf.indexOf(MAGIC);
while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
  let text = '';
  try { text = zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'); } catch { continue; }
  console.log(`--- 帧 ${i + 1}/${starts.length} ---`);
  console.log(text.slice(0, maxChars));
  console.log('');
}
