// 看某个会话的帧里"助手回答"长什么样（用来对齐提取逻辑）。
// 用法：node scripts/dump-reply-frames.mjs <sessionId前缀>
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
    // v3 在升级后已冻结：只认 v3 会一直看升级前的旧快照
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
const frames = [];
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try { frames.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')); } catch {}
}
console.log(`共 ${frames.length} 帧`);
const kinds = new Map();
for (const f of frames) {
  const m = /"(?:type|kind)"\s*:\s*"([^"]+)"/.exec(f);
  if (m) kinds.set(m[1], (kinds.get(m[1]) ?? 0) + 1);
}
console.log('帧类型分布:', JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)));
console.log('\n最后 6 帧（各截 500 字符）：');
for (const f of frames.slice(-6)) {
  console.log('─'.repeat(70));
  console.log(f.slice(0, 500));
}
