// 检查各会话的 agentToken 与最近一次唤醒注入的令牌是否一致
import fs from 'node:fs';

const p = 'D:/qq-bridge/state/social-v2.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const convs = j.conversations || {};
console.log(`会话数: ${Object.keys(convs).length}\n`);

console.log('=== 各会话 agentToken ===');
for (const [key, st] of Object.entries(convs)) {
  const t = st?.agentToken;
  const wake = st?.wake || {};
  console.log(`  ${key}`);
  console.log(`     agentToken: ${t ? t.slice(0, 16) + '…' + t.slice(-4) + ` (len=${t.length})` : '(无)'}`);
  console.log(`     pendingWakeReasons: ${(st?.pendingWakeReasons || []).length}`);
  console.log(`     更新: ${st?.updatedAt || '-'}`);
}

// 看看有没有重复令牌（复制状态导致的）
const toks = Object.entries(convs).map(([k, st]) => [k, st?.agentToken]).filter(([, t]) => t);
const dup = new Map();
for (const [k, t] of toks) {
  if (!dup.has(t)) dup.set(t, []);
  dup.get(t).push(k);
}
console.log('\n=== 令牌是否唯一 ===');
let dupCount = 0;
for (const [t, ks] of dup) {
  if (ks.length > 1) { dupCount++; console.log(`  ⚠️ 重复令牌 ${t.slice(0, 12)}… → ${ks.join(', ')}`); }
}
if (!dupCount) console.log('  ✅ 无重复');

// 目标群
const target = convs['group:1054156254'];
console.log('\n=== group:1054156254 详情 ===');
if (target) {
  console.log('  ' + JSON.stringify({
    agentToken: target.agentToken ? target.agentToken.slice(0, 16) + '…' : null,
    sessionId: target.sessionId,
    pendingWakeReasons: (target.pendingWakeReasons || []).length,
    keys: Object.keys(target),
  }, null, 2));
} else {
  console.log('  ❌ 该会话不在 social-v2.json 里');
  console.log('  现有会话键: ' + Object.keys(convs).join(', '));
}
