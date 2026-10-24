// Hunt for the flag making the reserved2 conversation look permanently busy,
// and show what is still unread.
import fs from 'node:fs';

const raw = fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8');
const s = JSON.parse(raw);
const c = s.conversations['private:984776985'];

console.log('=== 可能被持久化的忙标记 ===');
for (const k of ['pendingWakeTimer', 'pendingWakeReasons']) {
  console.log(`${k}: ${k in c ? JSON.stringify(c[k]) + (k === 'pendingWakeTimer' ? '   <-- 若为 {} 则永真' : '') : '不存在'}`);
}

console.log('\n=== 全部字段 ===');
console.log(Object.keys(c).join(', '));

console.log('\n=== 未读队列 ===');
const u = c.unread ?? [];
console.log(`unread 条数: ${u.length}`);
for (const m of u) console.log(`  seq=${m.seq} "${m.text}"`);

console.log('\n=== 时间点 ===');
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : null);
console.log('lastIncomingAt :', fmt(c.lastIncomingAt));
console.log('lastWakeAt     :', fmt(c.wakeConfig?.lastWakeAt));
console.log('lastAiReplyAt  :', fmt(c.lastAiReplyAt));
console.log('lastActionAt   :', fmt(c.lastActionAt));
console.log('bootstrapSent  :', c.bootstrapSent);

console.log('\n=== 是否有任何字段是空对象（JSON 里的 {} 在 JS 里为真）===');
for (const [k, v] of Object.entries(c)) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
    console.log(`  ${k} = {}   <-- 可疑`);
  }
}
