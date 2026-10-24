// 验证兜底重试计时器"只武装一次、不被新消息重置"的修复。
import fs from 'node:fs';

const b = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
const i = b.indexOf('function deferWakeReasonV2');
if (i < 0) { console.log('❌ 找不到 deferWakeReasonV2'); process.exit(1); }
const seg = b.slice(i, i + 2600);

const checks = [
  ['只有一处武装计时器（if (!st.pendingWakeRetryTimer)）', (seg.match(/if \(!st\.pendingWakeRetryTimer\)/g) || []).length === 1],
  ['含"绝不重置"说明注释', seg.includes('绝不在每条新消息进来时重置')],
  ['计时器触发时会自清', seg.includes('st.pendingWakeRetryTimer = null;')],
  ['仍忙时重新挂表（不递归）', seg.includes('deferWakeReasonV2(key, st, reason);')],
  ['只在仍有未读时才重试', seg.includes('stillRelevant')],
];

let ok = 0;
for (const [name, pass] of checks) {
  if (pass) ok++;
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
}
console.log(`\n${ok}/${checks.length} 通过`);
