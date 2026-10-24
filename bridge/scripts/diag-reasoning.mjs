// Diagnose why reasoning text isn't being printed: inspect the chunk keys and
// the path to each reasoning-chunks entry.
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

// Replicate show-thinking.mjs traversal exactly, but print what it sees.
for (const [i, r] of recs.entries()) {
  if (r.type !== 'assistant/message') continue;
  const stream = r.data?.stream;
  console.log(`\nrec[${i}] assistant/message  data keys=[${Object.keys(r.data ?? {}).join(',')}]  stream=${Array.isArray(stream) ? stream.length : typeof stream}`);
  if (!Array.isArray(stream)) continue;
  for (const [j, s] of stream.entries()) {
    const c = s?.chunk;
    if (!c) { console.log(`   stream[${j}] 无 chunk, 字段=[${Object.keys(s ?? {}).join(',')}]`); continue; }
    if (c.type !== 'reasoning-chunks') continue;
    console.log(`   stream[${j}] chunk.type=${c.type} keys=[${Object.keys(c).join(',')}]`);
    console.log(`      texts 是数组? ${Array.isArray(c.texts)}  长度=${Array.isArray(c.texts) ? c.texts.length : 'n/a'}`);
    if (Array.isArray(c.texts)) {
      const joined = c.texts.join('');
      console.log(`      拼接后 ${joined.length} 字符:`);
      console.log('      ' + joined.replace(/\n/g, '\n      ').slice(0, 900));
    }
  }
}
