// 把两处"会话繁忙 → 暂存"的重复逻辑替换为带兜底重试的 deferWakeReasonV2。
import fs from 'node:fs';

const p = 'D:/qq-bridge/src/bridge.js';
let src = fs.readFileSync(p, 'utf8');
const before = src;

// 第一处：sendWakePromptV2
const block1 = [
  '    if (isConversationBusyV2(key, st)) {',
  '      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];',
  '      const seq = st.lastUnreadSeq || 0;',
  '      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {',
  '        st.pendingWakeReasons.push({ reason, seq });',
  '        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。',
  '        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);',
  '      }',
  '      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);',
  '      return;',
  '    }',
].join('\n');

// 第二处：scheduleWakeV2（缩进相同，内容相同）
let count = 0;
while (src.includes(block1)) {
  src = src.replace(block1, '    if (isConversationBusyV2(key, st)) {\n      deferWakeReasonV2(key, st, reason);\n      return;\n    }');
  count++;
  if (count > 4) break;
}
console.log('替换的"繁忙"分支数量:', count);

if (src === before) throw new Error('没有替换任何内容');
fs.writeFileSync(p, src, 'utf8');
console.log('字节:', before.length, '->', src.length);

// 校验
const defs = [...src.matchAll(/function deferWakeReasonV2/g)].length;
const calls = [...src.matchAll(/deferWakeReasonV2\(key, st, reason\)/g)].length;
const oldLogs = [...src.matchAll(/会话繁忙，暂存唤醒原因/g)].length;
console.log(`deferWakeReasonV2 定义 ${defs} 处，调用 ${calls} 处，旧的直接日志残留 ${oldLogs} 处`);
console.log(defs === 1 && calls >= 2 ? '✅ 替换正确' : '❌ 检查替换结果');
