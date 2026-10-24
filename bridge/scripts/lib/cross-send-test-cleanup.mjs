// 跨会话代发相关测试的公共清理。
//
// 为什么需要：代发有"每来源每小时最多 N 条申请"的限流（默认 10），而几个测试套件
// 都用同一个来源会话反复造申请。如果只清"本次新建的"记录，之前跑挂在中途没清干净的
// 记录会一直占着配额，于是下次跑就全是 429 —— 看起来像功能坏了，其实是被自己的测试堵死。
//
// 所以按**消息特征**认领测试垃圾（而不是按时间/数量），既能把配额还回去，
// 又不会误删真实申请（比如用户自己让她发的那条）。
import fs from 'node:fs';

const CS_FILE = 'D:/qq-bridge/state/cross-send-requests.json';

/** 各测试脚本用的正文前缀。新增测试请沿用这些前缀，方便统一清理。 */
const TEST_PREFIXES = ['__selftest__', '__mode-test', 'dup-test', '通知开关自检', '【代发通道自检'];

export function isTestRequest(r) {
  const msg = String(r?.message ?? '');
  return TEST_PREFIXES.some((p) => msg.startsWith(p));
}

export function readCrossSendStore() {
  try { return JSON.parse(fs.readFileSync(CS_FILE, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return { requests: [] }; }
}

/** 删掉所有可识别的测试申请；返回 { before, removed, kept }。 */
export function cleanupTestRequests() {
  const store = readCrossSendStore();
  const all = Array.isArray(store.requests) ? store.requests : [];
  const kept = all.filter((r) => !isTestRequest(r));
  fs.writeFileSync(CS_FILE, JSON.stringify({ requests: kept }, null, 2), 'utf8');
  return { before: all.length, removed: all.length - kept.length, kept: kept.length };
}
