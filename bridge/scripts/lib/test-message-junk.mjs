// 测试垃圾消息的统一识别规则。
//
// 单独放一个模块是因为有两处都要用：
//   • recall-test-messages.mjs（从 QQ 撤回）
//   • purge-test-messages-from-state.mjs（从桥接状态里删掉）
// 两处规则必须一致，否则会出现"QQ 里撤了、状态里还留着"或者反过来的错位。
//
// 这些字符串都是测试自己造的，正常聊天不会出现。裸短消息（b2/j2…）只在**整条完全相等**
// 时才算命中——不能用 includes，否则群里任何含 "b2" 的正常发言都会被误删。
export const JUNK_SUBSTRINGS = [
  '【代发待确认】',
  '这是测试，不应发出',
  '【代发通道自检',
  '__selftest__',
  '__mode-test',
  'dup-test',
  '通知开关自检',
];
export const JUNK_EXACT = new Set(['b1', 'b2', 'b3', 'j1', 'j2', 'x1', 'x2', 'x3', 'x4']);

export function isTestMessage(text) {
  const t = String(text ?? '');
  if (JUNK_SUBSTRINGS.some((n) => t.includes(n))) return true;
  return JUNK_EXACT.has(t.trim());
}
