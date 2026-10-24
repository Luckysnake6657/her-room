// 查看跨会话代发的待确认队列（只读）。
import fs from 'node:fs';
const f = 'state/cross-send-requests.json';
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
console.log('顶层键:', Object.keys(d).join(', '));
const list = d.requests || d.items || d.pending || [];
const arr = Array.isArray(list) ? list : Object.values(list);
console.log(`记录数: ${arr.length}\n`);
const now = Date.now();
for (const r of arr) {
  const age = r.at || r.createdAt || r.time || 0;
  console.log(`- status=${r.status || '?'} | ${r.fromKey} → ${r.toKey} | ${age ? Math.round((now - age) / 1000) + 's 前' : ''}`);
  for (const m of (r.messages || r.bubbles || [])) console.log(`     「${String(m).slice(0, 80)}」`);
}
