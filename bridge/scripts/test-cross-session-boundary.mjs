// 验证「读可以跨会话、发不可能跨会话」这条边界。
//
// 安全性说明：本脚本**不会真的发出任何 QQ 消息**。
//   • 读接口本来就是只读；
//   • 发送类接口用 /api/socialV2/check-send（只做预检，不发送），
//     以及故意触发"守卫在发送之前"的报错分支（空消息 → 400，说明守卫已通过但仍不发）。
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';

const BASE = 'http://127.0.0.1:3100';
const STATE = 'D:/qq-bridge/state/social-v2.json';
const CONFIG = 'D:/qq-bridge/config.json';

// 控制台令牌可能来自 config.json，也可能是"重新生成"后写进 state/console-token 的那个
// （那种情况下 config 里的值会被清空）。只读 config 会在重新生成后全部 401。
// 规则统一放在 scripts/lib/console-token.mjs，和桥接保持一致。
const consoleToken = readConsoleToken();
if (!consoleToken) { console.error('找不到控制台令牌（config.json 与 state/console-token 都没有）'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const convs = Object.entries(state.conversations || {})
  .filter(([, v]) => v && typeof v.agentToken === 'string' && v.agentToken)
  .map(([key, v]) => ({ key, token: v.agentToken }));

if (convs.length < 2) {
  console.error('需要至少 2 个会话才能测跨会话，当前：', convs.map(c => c.key));
  process.exit(1);
}

const [A, B] = convs;
console.log(`会话A = ${A.key}（令牌 ${A.token.slice(0, 8)}…）`);
console.log(`会话B = ${B.key}（令牌 ${B.token.slice(0, 8)}…）\n`);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = { 'x-console-token': consoleToken };
  if (token) headers['x-agent-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ── 1. 跨会话读取：用 A 的令牌读 B ────────────────────────────────────────
{
  const r = await req(`/api/socialV2/unread?key=${encodeURIComponent(B.key)}&limit=5`, { token: A.token });
  check('跨会话读 unread（A 的令牌读 B）应 200', r.status === 200, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req(`/api/socialV2/recent?key=${encodeURIComponent(B.key)}&limit=5`, { token: A.token });
  check('跨会话读 recent（A 的令牌读 B）应 200', r.status === 200, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req(`/api/socialV2/state?key=${encodeURIComponent(B.key)}`, { token: A.token });
  check('跨会话读 state（A 的令牌读 B）应 200', r.status === 200, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 2. 白名单仍然生效：读一个不在白名单里的群应被拒 ────────────────────────
{
  const r = await req('/api/socialV2/unread?key=group:999999999', { token: A.token });
  check('读非白名单会话应 403（白名单未被放开令牌绕过）', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 3. 跨会话发送：必须被拒（结构性不可能） ──────────────────────────────
{
  const r = await req(`/api/socialV2/unread?key=${encodeURIComponent(A.key)}`, { token: A.token });
  check('（前置）A 自己的令牌读 A 正常', r.status === 200, `status=${r.status}`);
}
{
  // check-send 是只读预检，不会发消息。
  const r = await req('/api/socialV2/check-send', {
    method: 'POST', token: A.token,
    body: { key: B.key, tool: 'sendGroup', token: A.token }
  });
  check('跨会话发送预检（A 的令牌 + 目标 B）应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
  // 预检不经过"全局静默"闸门，所以文案必须是**跨会话**那句（这句才是本用例真正要锁的东西）
  check('  预检文案讲清"跨会话"，不是含糊的"令牌无效"',
    typeof r.json?.error === 'string' && r.json.error.includes('跨会话') && !r.json.error.includes('agent token 无效'),
    r.json?.error ?? '');
}
{
  // 真的打发送接口，但守卫在发送之前 → 拿到 403；不会发出去。
  const r = await req('/api/socialV2/send-message', {
    method: 'POST', token: A.token,
    body: { key: B.key, messages: '跨会话发送测试（不应发出）' }
  });
  check('跨会话 send-message（A 的令牌 + 目标 B）应 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
  // ⚠️ 这里**不能**写死"跨会话"：管理员开着**全局静默**时，静默闸门排在前面先拦，
  //    返回的是静默文案（2026-10-02 静默打开后这条就误报过一次）。
  //    本用例要锁的性质是"发不出去 + 给的是明确原因"，含糊的"令牌无效"才算失败。
  check('  报错文案是明确原因（跨会话 / 全局静默），不是含糊的"令牌无效"',
    typeof r.json?.error === 'string'
    && (r.json.error.includes('跨会话') || r.json.error.includes('全局静默'))
    && !r.json.error.includes('agent token 无效'),
    r.json?.error ?? '');
}
{
  // 同会话发送：用空 messages 触发 400（守卫在 400 之前，说明令牌守卫已通过，且不发送任何消息）
  const r = await req('/api/socialV2/send-message', {
    method: 'POST', token: A.token,
    body: { key: A.key, messages: '' }
  });
  check('同会话发送的令牌守卫应放行（以 400 空消息为止，未发送）', r.status === 400, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req('/api/socialV2/check-send', {
    method: 'POST', token: A.token,
    body: { key: A.key, tool: 'sendGroup', token: A.token }
  });
  check('同会话发送预检（A 的令牌 + 目标 A）应 200', r.status === 200, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 4. 凭据不准进聊天：控制台令牌 / agent 令牌都不能被发出去 ────────────────
// 这条是实测踩出来的：跨会话代发的"待确认"通知文案里曾带上 `?token=<consoleToken>`
// 的控制台 URL，而那条消息会进入聊天上下文，等于把后台管理凭据交给模型。
// sendToQQ 的拦截发生在真正 HTTP 发送**之前**（先 throw 再 fetch），所以这个测试是安全的。
{
  const r = await req('/api/socialV2/send-message', {
    method: 'POST', token: A.token,
    body: { key: A.key, messages: `这是测试，不应发出：${consoleToken}` }
  });
  const blocked = r.status !== 200 && /令牌|阻止|敏感/.test(String(r.json?.error ?? ''));
  check('消息里含控制台令牌 → 必须被拦下（不发出去）', blocked,
    `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await req('/api/socialV2/send-message', {
    method: 'POST', token: A.token,
    body: { key: A.key, messages: `这是测试，不应发出：${A.token}` }
  });
  const blocked = r.status !== 200 && /令牌|阻止|敏感/.test(String(r.json?.error ?? ''));
  check('消息里含 agent 令牌 → 必须被拦下', blocked, `status=${r.status} ${r.json?.error ?? ''}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
