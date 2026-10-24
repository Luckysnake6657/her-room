// 真实端到端验证跨会话代发：申请 → 批准 → **真的发出一条消息**。
//
// ⚠️ 这个脚本会真的往 QQ 发消息，所以默认**什么都不做**，必须显式加
//    --i-know-this-sends 才会执行。不要把它放进自动测试套件。
//
// ⚠️ 目标必须显式指定 `--to`。**故意不再默认发到主人私聊**：
//    以前默认发私聊，结果每次调试都在用户的聊天窗口里留下测试消息（实测被用户投诉）。
//    测试不该在别人的聊天记录里拉屎，所以现在没有默认目标。
//
// 用法：node scripts/test-cross-send-live.mjs --i-know-this-sends --to group:1124778377
//
// 为什么还需要这个脚本：test-cross-send-approval.mjs 全部走 dryRun，
// 只验证到"校验通过、会发去哪"，没有覆盖真正的 sendMessagesV2 + 记入历史那一段。
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--i-know-this-sends');
const toArg = (() => {
  const i = args.indexOf('--to');
  return i >= 0 ? args[i + 1] : null;
})();

const BASE = 'http://127.0.0.1:3100';
const ROOT = 'D:/qq-bridge';
const consoleToken = readConsoleToken();
if (!consoleToken) { console.error('找不到控制台令牌'); process.exit(1); }
const target = toArg;

if (!CONFIRM || !target) {
  console.log('这是一次**会真的发出 QQ 消息**的测试，已跳过。');
  console.log('执行方式：node scripts/test-cross-send-live.mjs --i-know-this-sends --to group:群号');
  if (!target) console.log('（必须显式给 --to：没有默认目标，避免污染别人的私聊）');
  process.exit(0);
}

const convs = Object.entries(JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8')).conversations || {})
  .filter(([, v]) => v && typeof v.agentToken === 'string' && v.agentToken)
  .map(([key, v]) => ({ key, token: v.agentToken }));
const source = convs.find((c) => c.key !== target);
if (!source) { console.error('找不到可用的来源会话'); process.exit(1); }

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = { 'x-console-token': consoleToken };
  if (token) headers['x-agent-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const stamp = new Date().toLocaleTimeString('zh-CN');
const message = `【代发通道自检 ${stamp}】这条不是她自己发的，是桥接按"申请→管理员批准"流程代发的。看到它就说明跨会话代发全链路正常。`;

console.log(`来源会话：${source.key}`);
console.log(`目标会话：${target}`);
console.log(`待发内容：${message}\n`);

const created = await req('/api/socialV2/cross-send-request', {
  method: 'POST', token: source.token, body: { key: target, message }
});
console.log(`1) 申请：HTTP ${created.status}  id=${created.json?.requestId}  ${created.json?.error ?? ''}`);
if (created.status !== 200) process.exit(1);

const id = created.json.requestId;
const decided = await req('/api/socialV2/cross-send-decide', {
  method: 'POST', body: { id, approve: true }
});
console.log(`2) 批准：HTTP ${decided.status}  sent=${decided.json?.sent}  status=${decided.json?.request?.status}  ${decided.json?.error ?? ''}`);

const after = await req('/api/socialV2/cross-send-requests');
const rec = (after.json?.requests || []).find((r) => r.id === id);
console.log(`3) 记录：status=${rec?.status}  sentCount=${rec?.sentCount}  error=${rec?.error ?? '无'}`);

const ok = decided.status === 200 && decided.json?.sent === true && rec?.status === 'approved';
console.log(`\n${ok ? '✅ 跨会话代发全链路（申请→批准→真实发送）通过' : '❌ 全链路未通过'}`);
process.exit(ok ? 0 : 1);
