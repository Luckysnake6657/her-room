// 验证「跨会话代发 = 申请 → 人工批准」这套人在环里的设计。
//
// 安全前提：她（agent token）只能"申请"，**不能批准**。如果批准接口能用她的令牌调通，
// 她就能自己批准自己，整套约束等于不存在——所以这个测试的核心就是验证那条 403。
//
// 本脚本**不会真的往任何群里发消息**：
//   • 申请本身不发送（只是落一条待确认记录）；
//   • 批准走 dryRun=true，只做校验并回报"会发什么"，不发；
//   • 最后把测试产生的记录清掉，不留垃圾。
//
// ⚠️ 不要用 PowerShell 的 Get-Content/Set-Content 改这个文件：本机按 GBK 读会把中文写坏，
// 实测直接把文件写成了语法错误。要改就用编辑器或 edit 工具。
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';
import { cleanupTestRequests } from './lib/cross-send-test-cleanup.mjs';

const BASE = 'http://127.0.0.1:3100';
const STATE = 'D:/qq-bridge/state/social-v2.json';
const CS_FILE = 'D:/qq-bridge/state/cross-send-requests.json';

// 令牌可能在 config.json，也可能是重新生成后写进 state/console-token 的那个
const consoleToken = readConsoleToken();
if (!consoleToken) { console.error('找不到控制台令牌（config.json 与 state/console-token 都没有）'); process.exit(1); }

const convs = Object.entries(JSON.parse(fs.readFileSync(STATE, 'utf8')).conversations || {})
  .filter(([, v]) => v && typeof v.agentToken === 'string' && v.agentToken)
  .map(([key, v]) => ({ key, token: v.agentToken }));
if (convs.length < 2) { console.error('至少需要 2 个会话才能测跨会话'); process.exit(1); }

const [A, B] = convs;
console.log(`会话A(来源) = ${A.key}`);
console.log(`会话B(目标) = ${B.key}\n`);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function req(path, { method = 'GET', token, body } = {}) {
  // 注意：桥接对**所有**请求都有控制台令牌闸门，MCP 客户端也是同时带
  // x-console-token 和 x-agent-token 的（见 agentApi）。所以两个都要带，
  // 否则测出来全是 401，看着像功能坏了，其实是测试脚本漏了头。
  const headers = { 'x-console-token': consoleToken };
  if (token) headers['x-agent-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** 读待确认存储；文件还不存在（从没申请过）时返回空列表。 */
function readStore() {
  try { return JSON.parse(fs.readFileSync(CS_FILE, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return { requests: [] }; }
}

const beforeIds = new Set((readStore().requests || []).map((r) => r.id));

// 开跑前先清一次：上一次跑到一半挂掉时留下的"待确认"会占满 maxPendingPerSource，
// 导致本次**所有**申请请求直接 429 —— 看起来像功能坏了，其实是被自己的残留堵住了
// （实测自检里就因此假报过 4 个失败）。清理按正文前缀认领，不碰真实申请。
{
  const { removed, kept } = cleanupTestRequests();
  if (removed) console.log(`开跑前清理上次残留的测试申请 ${removed} 条（保留真实申请 ${kept} 条）`);
}

// 这套测试断言的是"申请会排成待确认、由控制台批准"，前提是**手动模式**。
// 管理员可能把代发设成了自动确认/自动拒绝 —— 那申请会直接发出/被拒，这里就会误报一堆失败。
// 所以：记住原模式 → 切成 manual 跑测试 → 结束时**还原**（绝不留下生产配置被改动）。
async function readDecision() {
  const r = await req('/api/socialV2/cross-send-requests');
  return r.json?.limits?.decision ?? 'manual';
}
const originalDecision = await readDecision();
{
  const r = await req('/api/socialV2/cross-send-mode', { method: 'POST', body: { decision: 'manual' } });
  if (!r.json?.ok) { console.error('无法切到 manual 模式，测试无法进行：' + (r.json?.error ?? '')); process.exit(1); }
  if (originalDecision !== 'manual') console.log(`（进入时是 ${originalDecision}，测试期间临时切到 manual，结束会还原）`);
}

/**
 * 硬保险：创建申请之前必须确认不在【自动确认】模式。
 * 踩过的坑：模式被别处改回自动确认后，测试创建的申请会被**直接发到真实群里**
 * （实测把 11 条 `__selftest__` / `dup-test` / `b2` 之类发进了用户的群）。
 * 宁可让测试失败，也不能污染别人的聊天。
 */
async function guardNotAutoApprove() {
  const d = await readDecision();
  if (d === 'auto-approve') {
    console.error('测试中止：当前是【自动确认】模式，创建申请会真的发出消息。请先切到 manual。');
    process.exit(1);
  }
}
await guardNotAutoApprove();

// ── 1. 她可以申请（用她自己的令牌，目标是别的会话）────────────────────────
let requestId = null;
const probe = `__selftest__ ${Date.now()}`;
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, message: probe }
  });
  requestId = r.json?.requestId ?? null;
  check('她用自己的令牌申请代发到别的会话 → 应 200', r.status === 200 && r.json?.ok === true,
    `status=${r.status} ${r.json?.error ?? ''} from=${r.json?.from ?? '?'}`);
  check('  来源必须由令牌反查（不能由她声明）', r.json?.from === A.key, `from=${r.json?.from}`);
}

// ── 2. 关键：她**不能**批准自己的申请 ─────────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-decide', {
    method: 'POST', token: A.token, body: { id: requestId, approve: true }
  });
  check('她用 agent token 调批准接口 → 必须 403（否则能自己批准自己）', r.status === 403,
    `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req('/api/socialV2/cross-send-requests', { token: A.token });
  check('她用 agent token 读待确认列表 → 必须 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 3. 她不能用申请接口发给自己所在的会话（那是普通发送）──────────────────
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: A.key, message: 'should be rejected' }
  });
  check('申请目标 = 她自己所在会话 → 应 400（提示直接用 send_message）', r.status === 400,
    `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 4. 白名单外目标必须被拒 ──────────────────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: 'group:999999999', message: 'nope' }
  });
  check('申请到非白名单会话 → 应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 5. 没有令牌 / 伪造令牌 不能申请 ──────────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', body: { key: B.key, message: 'anonymous' }
  });
  check('不带 agent token 申请 → 应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: 'deadbeef'.repeat(4), body: { key: B.key, message: 'forged' }
  });
  check('伪造 agent token 申请 → 应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 6. 控制台能看到这条待确认，且内容完整 ─────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-requests');
  const found = (r.json?.requests || []).find((x) => x.id === requestId);
  check('控制台能读到待确认列表', r.status === 200 && !!found,
    `pendingCount=${r.json?.pendingCount}`);
  check('  列表里带完整原文（批准前要能看清发什么）', found?.message === probe);
}

// ── 7. 控制台 dryRun 批准：走完整校验但不真发 ─────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-decide', {
    method: 'POST', body: { id: requestId, approve: true, dryRun: true }
  });
  check('控制台 dryRun 批准 → 应 200 且报告会发去哪里', r.status === 200 && r.json?.dryRun === true,
    `status=${r.status} wouldSendTo=${r.json?.wouldSendTo} sent=${r.json?.sent}`);
  check('  dryRun 不得真的发送', r.json?.sent === false, `sent=${r.json?.sent}`);
}

// ── 8. 控制台拒绝 ────────────────────────────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-decide', {
    method: 'POST', body: { id: requestId, approve: false }
  });
  check('控制台拒绝 → 应 200 且状态为 rejected', r.status === 200 && r.json?.request?.status === 'rejected',
    `status=${r.status} requestStatus=${r.json?.request?.status}`);
}
{
  const r = await req('/api/socialV2/cross-send-decide', {
    method: 'POST', body: { id: requestId, approve: true }
  });
  check('已处理的请求不能重复处理 → 应 400', r.status === 400, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 9. 重复申请同一条会复用（不产生第二条待确认）─────────────────────────
{
  const r1 = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, message: 'dup-test' }
  });
  const r2 = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, message: 'dup-test' }
  });
  check('重复提交同一条 → 复用原申请', r1.json?.requestId === r2.json?.requestId && r2.json?.reused === true,
    `id1=${r1.json?.requestId} id2=${r2.json?.requestId} reused=${r2.json?.reused}`);
  for (const id of [r1.json?.requestId, r2.json?.requestId].filter(Boolean)) {
    await req('/api/socialV2/cross-send-decide', { method: 'POST', body: { id, approve: false } });
  }
}

// ── 10. 敏感内容必须被拦 ────────────────────────────────────────────────
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, message: 'Authorization: Bearer sk-1234567890abcdefghijklmnop' }
  });
  check('待发内容含敏感信息 → 应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 11. 多气泡：1~3 条，一个气泡一条；超过 3 条要拒 ──────────────────────
{
  const probe3 = [`__selftest__ b1 ${Date.now()}`, 'b2', 'b3'];
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, messages: probe3 }
  });
  check('传 3 条（数组）→ 应 200', r.status === 200, `status=${r.status} ${r.json?.error ?? ''}`);
  check('  返回里带全部 3 条气泡', Array.isArray(r.json?.messages) && r.json.messages.length === 3,
    `messages=${JSON.stringify(r.json?.messages)}`);

  // 控制台列表要能看到全部气泡（而不只是第一条）
  const listed = await req('/api/socialV2/cross-send-requests');
  const found = (listed.json?.requests || []).find((x) => x.id === r.json?.requestId);
  check('  控制台列表里 3 条都在', JSON.stringify(found?.messages) === JSON.stringify(probe3),
    `messages=${JSON.stringify(found?.messages)}`);

  // dryRun 批准要回报"会发哪几条"
  const dry = await req('/api/socialV2/cross-send-decide', {
    method: 'POST', body: { id: r.json?.requestId, approve: true, dryRun: true }
  });
  check('  dryRun 回报会发的全部气泡，且不真发',
    dry.status === 200 && dry.json?.dryRun === true && Array.isArray(dry.json?.messages) && dry.json.messages.length === 3 && dry.json.sent === false,
    `status=${dry.status} sent=${dry.json?.sent} n=${dry.json?.messages?.length}`);
  await req('/api/socialV2/cross-send-decide', { method: 'POST', body: { id: r.json?.requestId, approve: false } });
}
{
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, messages: ['__selftest__ x1', 'x2', 'x3', 'x4'] }
  });
  check('传 4 条 → 应 400（上限 3 条）', r.status === 400, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  // 模型可能把数组序列化成 JSON 字符串（历史上踩过这类入参）
  const r = await req('/api/socialV2/cross-send-request', {
    method: 'POST', token: A.token, body: { key: B.key, messages: JSON.stringify([`__selftest__ j1 ${Date.now()}`, 'j2']) }
  });
  check('messages 传 JSON 字符串也能解析成 2 条', r.status === 200 && r.json?.messages?.length === 2,
    `status=${r.status} ${JSON.stringify(r.json?.messages)}`);
  if (r.json?.requestId) await req('/api/socialV2/cross-send-decide', { method: 'POST', body: { id: r.json.requestId, approve: false } });
}

// ── 清理：把所有可识别的测试申请都删掉，并还原进入时的决策模式 ───────────
// 不只清本次新建的：代发限流按来源每小时计数，历史遗留的测试记录会一直占配额，
// 下次跑就全变 429（看着像功能坏了）。按正文前缀认领，不碰真实申请。
{
  const { removed, kept } = cleanupTestRequests();
  console.log(`\n清理测试申请 ${removed} 条（保留真实申请 ${kept} 条）`);
}
{
  const r = await req('/api/socialV2/cross-send-mode', { method: 'POST', body: { decision: originalDecision } });
  check(`还原进入时的决策模式（${originalDecision}）`, r.json?.decision === originalDecision,
    `decision=${r.json?.decision}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
