// Show how state (memory, context, wake config) is scoped across conversations.
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const sessions = JSON.parse(fs.readFileSync('D:/qq-bridge/state/sessions.json', 'utf8'));

console.log('=== 会话映射（sessions.json）===');
for (const [k, v] of Object.entries(sessions.sessions ?? {})) console.log(`  ${k}  ->  ${v}`);
console.log('  （每个 key = 一个独立 DSH 会话，上下文历史互不可见）');

console.log('\n=== 各会话的独立状态（social-v2.json）===');
for (const [key, c] of Object.entries(s.conversations ?? {})) {
  console.log(`\n[${key}]`);
  console.log(`  recentMessages   : ${(c.recentMessages ?? []).length} 条`);
  console.log(`  unread           : ${(c.unread ?? []).length} 条`);
  console.log(`  activeTopics     : ${JSON.stringify(c.activeTopics ?? [])}`);
  console.log(`  pendingThoughts  : ${JSON.stringify(c.pendingThoughts ?? [])}`);
  console.log(`  memberImpressions: ${JSON.stringify(Object.keys(c.memberImpressions ?? {}))}`);
  console.log(`  agentToken       : ${c.agentToken ? c.agentToken.slice(0, 8) + '…' : '(无)'}  <- 每会话独立令牌`);
  console.log(`  wakeConfig       : mode=${c.wakeConfig?.mode} anyMessage=${c.wakeConfig?.triggers?.anyMessage} 概率=${c.wakeConfig?.triggers?.probability}`);
}

console.log('\n=== 结论 ===');
const keys = Object.keys(s.conversations ?? {});
console.log(`当前有 ${keys.length} 个会话状态对象：${keys.join(', ')}`);
console.log('每个对象各自持有：最近消息、表情偏好、唤醒配置、记忆（话题/想法/印象）、独立 agent token');
console.log('=> 群聊之间、群聊与私聊之间，记忆与上下文都是隔离的。');
