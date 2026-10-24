/**
 * 回归测试：被拦下的发送请求**不该消耗发送配额**，并且管理员能立刻清配额。
 *
 * 怎么发现的：`test-cross-session-boundary` 跑着跑着开始失败，报 `429 发送频率超限` ——
 * 但它那几条用例本来**应该**返回 403（消息里含令牌）。查下来：
 *   • 出站凭据守卫在 `sendToQQ` 里，而**限流在它之前** → 含令牌的请求先被限流拦成 429，
 *     调用方拿到的是"频率超限"而不是"你这消息里有令牌"；
 *   • 更糟的是配额是**发送前预占**的，被拦的尝试照样吃掉一次配额。
 * 后果（实测）：反复跑测试把**四个会话**的发送配额全耗光（`maxSendPerHour: 25`），
 * 她连正常回话都发不出去 —— 清配额时看到 private 的发送记录堆了 500 条。
 *
 * 这个测试打**真桥接**（因为要验真实配额），所以只做"应该被拒"的请求：
 * 不消耗配额、也不会有任何消息发到 QQ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const token = readConsoleToken();
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const key = 'private:984776985';
const agentToken = st.conversations?.[key]?.agentToken;
if (!agentToken) { console.error('拿不到 agent token'); process.exit(2); }

const api = async (p, body, { agent = true } = {}) => {
  const res = await fetch(`${BRIDGE_BASE}${p}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': token,
      // ⚠️ admin 类端点（如 clear-send-quota）带了 agent token 会被 403
      //    （adminOnlyV2Paths 的设计：带 agent token 的请求一律拒），所以按需给
      ...(agent ? { 'x-agent-token': agentToken } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
// 读某个会话当前窗口里的发送记录数（用清配额端点的返回值当"读数"，
// 因为那正好是我们要保住的量）
const quotaSnapshot = async () => {
  const r = await api('/api/socialV2/clear-send-quota', {}, { agent: false });
  return (r.json?.cleared ?? []).length;
};

console.log(`用会话 ${key}\n`);

console.log('\n[1] 含令牌的消息：必须是 403（不是 429），且不消耗配额');
// 先记基线（顺便清一次，避免历史残留干扰）
await quotaSnapshot();
// 制造一点"已用配额"是不必要的 —— 直接连发 3 条含令牌的消息，
// 如果它们消耗配额，清配额时就会看到记录。
for (let i = 0; i < 3; i++) {
  const r = await api('/api/socialV2/send-message', { key, messages: `这是测试不应发出：${token}` });
  check(`第 ${i + 1} 条：403 且原因写明是令牌（不是频率超限）`,
    r.status === 403 && /令牌/.test(String(r.json?.error ?? '')),
    `status=${r.status} ${r.json?.error}`);
}
const used = await quotaSnapshot();
check('三条被拦的请求**一条配额都没消耗**', used === 0, `cleared=${JSON.stringify(used)}`);

console.log('\n[2] 跨会话发送：也是 403，不吃配额');
{
  const other = Object.keys(st.conversations).find((k) => k !== key && k.startsWith('group:'));
  const r = await api('/api/socialV2/send-message', { key: other, messages: '跨会话测试（不应发出）' });
  check('跨会话应 403', r.status === 403, `status=${r.status} ${r.json?.error}`);
}
const used2 = await quotaSnapshot();
check('跨会话被拦也不吃配额', used2 === 0, `cleared=${JSON.stringify(used2)}`);

console.log('\n[3] 清配额端点本身可用（配额被历史/测试耗光时能立刻救回来）');
{
  const r = await api('/api/socialV2/clear-send-quota', {}, { agent: false });
  check('端点返回 ok', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  check('返回被清的会话列表', Array.isArray(r.json?.cleared), JSON.stringify(r.json?.cleared));
  const bad = await api('/api/socialV2/clear-send-quota', {}, { agent: true });
  check('带 agent token 调 admin 端点会被拒（她不能自己清配额）', bad.status === 403,
    `status=${bad.status} ${bad.json?.error}`);
}

console.log('\n[4] 源码级：预检必须在限流之前，且失败要退还额度');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const secretAt = src.indexOf('if (containsKnownSecret(message))');
  // 限流拒绝现在走统一助手 sendLimitError(...)，错误里带"还要等多久"（见 [5]）
  const rateAt = src.indexOf("sendLimitError(limitInfo, sendCfg) }, 429)", secretAt > 0 ? secretAt : 0);
  check('send-message：凭据预检在限流之前', secretAt > 0 && rateAt > 0 && secretAt < rateAt,
    `secretAt=${secretAt} rateAt=${rateAt}`);
  check('发送失败会退还预占额度（st.sendTimes.splice）', /st\.sendTimes\.splice\(reservedFrom\)/.test(src));
  check('有 containsKnownSecret 辅助函数', /function containsKnownSecret/.test(src));
}

console.log('\n[5] 限流被拒时必须说清"还要等多久"（她才知道别连着重试）');
{
  // 实测（2026-09-28 用户截图）：只说"请稍后再试"，她不知道等多久，
  // 就在"发失败→想一下→再发"里空转 5 分 55 秒。所以错误里必须有秒数 + 劝阻重试。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('有限流助手 sendRateLimitInfo', /function sendRateLimitInfo/.test(src));
  check('错误文案含剩余时间与"不要连着重试"',
    /不要连着重试/.test(src) && /retryAfterSec/.test(src) && /等\$\{waitTip\}再发/.test(src));
  const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const min = Number(cfgAll.socialV2?.send?.maxSendPerMinute);
  const hour = Number(cfgAll.socialV2?.send?.maxSendPerHour);
  check('每分钟上限够一次多气泡回复（≥6 条/分钟）', min >= 6, `maxSendPerMinute=${min}`);
  check('每小时上限够连续聊（≥100 条/小时）', hour >= 100, `maxSendPerHour=${hour}`);
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
