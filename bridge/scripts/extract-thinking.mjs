// Extract the model's reasoning ("thinking") and its visible replies from a DSH
// session dump, so we can see WHY it said what it said.
import fs from 'node:fs';

const dumpPath = process.argv[2] ?? 'D:/deepseekharness/session-dump.jsonl';
const lines = fs.readFileSync(dumpPath, 'utf8').split('\n').filter((l) => l.trim());

const recs = [];
for (const l of lines) {
  try { recs.push(JSON.parse(l)); } catch { /* skip */ }
}

// Discover where reasoning text lives.
console.log('=== assistant/message 的字段结构 ===');
const first = recs.find((r) => r.type === 'assistant/message');
if (first) {
  console.log('keys:', Object.keys(first).join(', '));
  const dump = (o, depth = 0, prefix = '') => {
    if (depth > 3 || !o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const t = Array.isArray(v) ? 'array' : typeof v;
      console.log(`${'  '.repeat(depth + 1)}${prefix}${k}: ${t}${typeof v === 'string' ? ' = ' + JSON.stringify(v.slice(0, 70)) : ''}`);
      if (t === 'object' || t === 'array') dump(Array.isArray(v) ? v[0] : v, depth + 1, Array.isArray(v) ? '[0].' : '');
    }
  };
  dump(first);
}

console.log('\n=== 所有含 reasoning / thinking 字段的记录 ===');
const textOf = (v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
  if (v && typeof v === 'object') return Object.values(v).map(textOf).filter(Boolean).join('\n');
  return '';
};
let found = 0;
for (const r of recs) {
  const s = JSON.stringify(r);
  if (!/"reasoning"|"thinking"|"reasoningText"/.test(s)) continue;
  found++;
  console.log(`\n--- ${r.type} @ ${r.time ? new Date(r.time).toLocaleTimeString('zh-CN') : '?'} ---`);
  const walk = (o, path = '') => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/reasoning|thinking/i.test(k) && v) {
        console.log(`[${path}${k}]`);
        console.log(textOf(v).slice(0, 3000));
      } else if (typeof v === 'object') walk(v, `${path}${k}.`);
    }
  };
  walk(r);
}
console.log(`\n命中记录数: ${found}`);
