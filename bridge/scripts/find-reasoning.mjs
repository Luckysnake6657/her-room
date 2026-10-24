// Locate every reasoning-chunks entry by path, then dump its shape.
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

const hits = [];
const walk = (o, path) => {
  if (o === null || typeof o !== 'object') return;
  if (o.type === 'reasoning-chunks') { hits.push({ path, node: o }); return; }
  for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
};
recs.forEach((r, i) => walk(r, `rec[${i}](${r.type})`));

console.log('reasoning-chunks 命中:', hits.length);
if (hits.length) {
  console.log('\n路径示例:', hits[0].path);
  console.log('\n=== 原始结构 ===');
  console.log(JSON.stringify(hits[0].node, null, 2).slice(0, 3000));
  console.log('\n=== 所有命中的字段名 ===');
  const keys = new Set();
  for (const h of hits) for (const k of Object.keys(h.node)) keys.add(k);
  console.log([...keys].join(', '));
  console.log('\n=== 各段长度 ===');
  for (const h of hits) {
    const node = h.node;
    const cand = node.text ?? node.delta ?? node.content ?? node.reasoning ?? node.data ?? '';
    const len = typeof cand === 'string' ? cand.length : JSON.stringify(cand ?? '').length;
    console.log(`  ${h.path}  -> ${len} 字符`);
  }
}
