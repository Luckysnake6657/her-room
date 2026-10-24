// Inspect the reserved2 wake scheduler state: why are new messages being deferred?
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const c = s.conversations['private:984776985'];

console.log('=== conversation keys ===');
console.log(Object.keys(c).join(', '));

console.log('\n=== wakeConfig ===');
console.log(JSON.stringify(c.wakeConfig, null, 2));

console.log('\n=== 其它可能与节流有关的字段 ===');
for (const [k, v] of Object.entries(c)) {
  if (k === 'recentMessages' || k === 'wakeConfig') continue;
  const str = JSON.stringify(v);
  console.log(`  ${k} = ${str?.slice(0, 220)}`);
}

console.log('\n=== 最近消息（seq / 时间 / 是否已读）===');
for (const m of c.recentMessages ?? []) {
  const t = m.time ? new Date(m.time).toLocaleTimeString('zh-CN') : '?';
  console.log(`  seq=${m.seq} ${t} read=${m.read ?? m.isRead ?? '?'} "${m.text}"`);
}

console.log('\n=== 全局键 ===');
console.log(Object.keys(s).join(', '));
console.log('paused =', s.paused);
