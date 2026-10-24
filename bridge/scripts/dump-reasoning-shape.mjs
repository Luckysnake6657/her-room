// Dump the raw shape of one reasoning-chunks entry so we can read its text.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

// v3/v4 并存时挑活的那个，别写死 v3（升级后 v3 不再增长）
const file = sessionFileIn('C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/session-84a3bb26-2819-4892-b770-15f8264290ee');
const buf = fs.readFileSync(file);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
let text = '';
for (let i = 0; i < offs.length; i++) {
  const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
  try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* skip */ }
}
const recs = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const msg = recs.find((r) => r.type === 'assistant/message' && (r.data?.stream ?? []).some((s) => s?.chunk?.type === 'reasoning-chunks'));
console.log('找到含 reasoning-chunks 的消息, stream 条目数:', msg.data.stream.length);

for (const s of msg.data.stream) {
  const c = s?.chunk;
  if (!c) continue;
  if (c.type === 'reasoning-chunks') {
    console.log('\n=== reasoning-chunks 原始条目 ===');
    console.log(JSON.stringify(c, null, 2).slice(0, 2500));
  }
  if (c.type === 'text-chunks') {
    console.log('\n=== text-chunks 原始条目（对照）===');
    console.log(JSON.stringify(c, null, 2).slice(0, 800));
  }
}
