// 查看并（可选）更新现有群会话的唤醒配置。
// 全局默认值只影响新会话；已存在的会话各自存了确认过的 wakeConfig。
import fs from 'node:fs';

const stateFile = 'D:/qq-bridge/state/social-v2.json';
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const key = process.argv[2] ?? 'group:1124778377';
const st = state.conversations?.[key];

if (!st) {
  console.log(`会话 ${key} 不存在`);
  process.exit(0);
}

console.log(`=== [${key}] 当前唤醒配置 ===`);
console.log(JSON.stringify(st.wakeConfig, null, 2));
console.log('\nagentToken:', st.agentToken ? '(存在，长度 ' + st.agentToken.length + ')' : '(无)');
