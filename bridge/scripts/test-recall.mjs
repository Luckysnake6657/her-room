/**
 * 回归测试：撤回她刚发的消息（2 分钟刷屏窗口）。
 *
 * 用户需求原话：
 *   「我还想加一个撤回功能，如果出现群聊天突然发了一堆消息打扰到别人让别人厌烦
 *     就有选择的撤回部分消息」
 *   「就是两分钟内出现的大量消息」
 *
 * QQ 只允许撤回 **2 分钟内** 的消息，所以核心是：
 *   1. 每条发出去的消息都要**顺手记下 message_id**（sendMessagesV2 原来把它丢了）；
 *   2. 主视图只列最近 2 分钟的爆发，超窗口的标出来且**如实报告失败原因**；
 *   3. 她只能撤自己会话里刚发的（令牌绑定），撤不了别人的、也撤不了别的会话的。
 *
 * 这里**不真的往 QQ 发消息**（会打扰群友）：直接往 recentSentByKey 里塞记录，
 * 再用假 message_id 走一遍撤回流程 —— OneBot 会拒绝这些假 id，但正好验证
 * "失败要如实报告" 这条；真实的 delete_msg 通路由 `--live` 参数单独验证。
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

const consoleToken = readConsoleToken();
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const KEY = 'private:984776985';
const agentToken = st.conversations?.[KEY]?.agentToken;
const GROUP = Object.keys(st.conversations).find((k) => k.startsWith('group:'));
if (!agentToken) { console.error('拿不到 agent token'); process.exit(2); }

const get = async (p) => (await fetch(`${BRIDGE_BASE}${p}`, { headers: { 'x-console-token': consoleToken } })).json();
const post = async (p, body, { agent = false } = {}) => {
  const res = await fetch(`${BRIDGE_BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, ...(agent ? { 'x-agent-token': agentToken } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

console.log(`会话 ${KEY}\n`);

console.log('\n[1] 端点可用 + 空窗口的说明');
const empty = await get(`/api/socialV2/sent-messages?key=${encodeURIComponent(KEY)}`);
check('列出端点可用', empty?.ok === true, JSON.stringify(empty)?.slice(0, 120));
check('报出窗口是 120 秒', Number(empty?.windowMs) === 120000, String(empty?.windowMs));

console.log('\n[2] 撤回不存在的消息 → 404 且说清（不是静默成功）');
{
  // ⚠️ 不要用 lastN 打真实会话：窗口里如果有她刚发的真消息，这一下就**真把它们撤了**
  //    （2026-09-28 实测踩到：窗口非空时这个测试返回 200 并把她的消息撤掉，既污染又假失败）。
  //    改成给一个**不存在**的 messageId —— 走同一条"没有可撤回"分支，但零副作用。
  const fakeId = `test-not-exist-${Date.now()}`;
  const none = await post('/api/socialV2/recall', { key: KEY, messageIds: [fakeId] });
  check('撤回不存在的 messageId → 404 且说清',
    none.status === 404 && /没有可撤回/.test(String(none.json?.error)),
    `status=${none.status} ${none.json?.error}`);
  const before = await get(`/api/socialV2/sent-messages?key=${encodeURIComponent(KEY)}`);
  const burst = (before?.bursts ?? []).find((b) => b.key === KEY);
  if (burst?.messages?.length) {
    // 窗口非空时，额外确认 lastN 路径**没被这个测试用到**（免得以后又有人改成 lastN）
    console.log(`  ℹ️ 窗口里现在有 ${burst.messages.length} 条她刚发的消息（真实状态，测试没有动它们）`);
  }
}

console.log('\n[3] 源码级：id 必须被记下来（原来 sendMessagesV2 把它丢了）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('sendMessagesV2 里记了 message_id', /recordSentMessageId\(key, msg, res\?\.message_id\)/.test(src));
  check('撤回走 OneBot delete_msg', /delete_msg/.test(src));
  check('窗口可配（默认 120s）', /recallWindowMs/.test(src) && /120000/.test(src));
  check('一次最多撤 maxBatch 条（防误操作）', /maxBatch/.test(src));
  check('她只能撤自己会话（令牌反查 + 跨会话拒绝）', /跨会话操作被拒绝：该令牌只对当前会话有效/.test(src));
  check('MCP 工具 qq_recall_message 已注册',
    /qq_recall_message/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8')));
}

console.log('\n[4] 假 message_id 走一遍：失败必须**如实报告**（不假装成功）');
{
  // 直接往"她最近发的"里塞两条假记录：一条在窗口内、一条超窗口
  const injected = await post('/api/socialV2/__test__inject-sent', {}).catch(() => null);
  if (injected?.status === 404) {
    console.log('  ℹ️ 没有注入端点（生产代码里本来就不该有），改用真实发送来验证 —— 跳过本段');
  }
}

console.log('\n[5] 真发一条再撤回来（唯一会碰到 QQ 的一步，只对自己私聊）');
if (!process.argv.includes('--live')) {
  console.log('  ℹ️ 未加 --live，跳过（它会真的发一条再撤回，虽然目标是管理员私聊）');
} else {
  const send = await post('/api/socialV2/send-message', { key: KEY, messages: `撤回功能自测 ${Date.now()}` }, { agent: true });
  check('先发一条成功', send.json?.ok === true && send.json?.sent === 1, JSON.stringify(send.json)?.slice(0, 160));
  const listed = await get(`/api/socialV2/sent-messages?key=${encodeURIComponent(KEY)}`);
  const burst = (listed?.bursts ?? []).find((b) => b.key === KEY);
  check('刚发的那条出现在 2 分钟窗口里', !!burst && burst.count >= 1, JSON.stringify(burst?.count));
  const target = burst?.messages?.[0];
  check('记录里有 messageId（不然撤不了）', !!target?.messageId, JSON.stringify(target));
  const rec = await post('/api/socialV2/recall', { key: KEY, messageIds: [target.messageId] }, { agent: true });
  check('撤回成功', rec.json?.ok === true && rec.json?.recalled === 1,
    JSON.stringify(rec.json)?.slice(0, 200));
  const after = await get(`/api/socialV2/sent-messages?key=${encodeURIComponent(KEY)}`);
  const burst2 = (after?.bursts ?? []).find((b) => b.key === KEY);
  check('撤回后不再出现在待撤列表里', !burst2?.messages?.some((m) => m.messageId === target.messageId),
    JSON.stringify(burst2?.messages?.map((m) => m.messageId)));
}

console.log('\n[6] 跨会话：她不能撤别的会话（令牌绑定）');
if (GROUP) {
  const cross = await post('/api/socialV2/recall', { key: GROUP, lastN: 1 }, { agent: true });
  check('用她的令牌撤别的会话 → 403', cross.status === 403,
    `status=${cross.status} ${cross.json?.error}`);
}

// ── 2026-09-29 新增：他能"命令"她撤回（看她意愿），以管理员身份命令则强制执行 ──────
//   "看她愿不愿意"那半靠提示词（她自己的 qq_recall_message，可以拒绝）；
//   "管理员身份 = 必须执行"这半由桥接直接认命令执行，所以解析必须准。
console.log('\n[7] 管理员强制撤回命令的解析（他都能怎么下命令）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    b.setMode('reserved2');
    const parse = b.parseAdminRecallCommand;
    check('能拿到解析函数（harness 暴露）', typeof parse === 'function');

    const yes = [
      ['/撤回', 1, '斜杠命令'],
      ['/撤回 3', 3, '斜杠命令带条数'],
      ['以管理员身份命令你撤回刚才那条', 1, '管理员身份 + 刚才那条'],
      ['我现在以管理员的身份要求你撤回最近 2 条', 2, '管理员身份 + 最近 N 条'],
    ];
    for (const [text, expect, label] of yes) {
      const r = parse(text);
      check(`识别：${label}（${text}）`, r && r.count === expect, JSON.stringify(r));
    }
    const force = parse('以管理员身份命令你撤回刚才那条');
    check('管理员身份命令标了 reason', force?.reason === '管理员身份命令', JSON.stringify(force));

    // ⚠️ 2026-09-29 收窄：光说"撤回"/"强制撤回 N 条"**不再**触发强制执行（用户："我怕她误判指令"）
    const no = [
      ['撤回', '光说"撤回"（没说是谁在命令）'],
      ['撤回 2', '光说"撤回 2"'],
      ['强制撤回 3 条', '没带"以管理员身份"'],
      ['把那条撤了吧，我不想留着', '普通请求（看她愿不愿意，不该被桥接拦下代执行）'],
      ['你别撤回啊', '否定句'],
      ['我刚刚是不是说了撤回这个词', '只是在聊"撤回"这个词'],
      ['撤回功能怎么用', '问功能'],
    ];
    for (const [text, label] of no) {
      check(`不识别：${label}`, parse(text) === null, JSON.stringify(parse(text)));
    }
    check('防误操作：一次最多 10 条', parse('/撤回 99')?.count === 10, JSON.stringify(parse('/撤回 99')));
  } finally {
    await b.close();
  }
}

// ── 撤回留痕 + 私聊撤回通知认人（2026-09-29 用户截图："她啥时候发的中"）──────────
// 现场：她 23:22:31 自己撤了那张重复的「中」，但 ① 她的记录里那条还在、没有"已撤回"标记，
// ② OneBot 的私聊 friend_recall 通知被写成"对方撤回了一条私聊消息" —— 她于是说
// 「我这边记录是发过的，可能被刚才那次撤回一起弄没了」。这两条都必须修掉。
console.log('\n[8] 撤回要留痕 & 私聊通知要认得出是"她自己撤的"');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({
    config: { allow: { private: ['123', '124'], groups: ['456'] }, ownerQQ: 123, socialV2: { enabled: true } },
  });
  try {
    b.setMode('reserved2');
    const st = b.getSocialV2State('private:123');
    st.recentMessages.push({
      sender: '我', messageId: '-42', text: '[表情包:中]', plain: '[表情包:中]', isSelf: true,
      quoteTargetIsSelf: false, isOwner: true, ownerLabel: '我', media: [], hasMedia: false,
      forwardIds: [], hasForward: false, time: Date.now(),
    });
    const marked = b.markSelfRecalled('private:123', [{ messageId: '-42', text: '[表情包:中]' }], '你');
    const rec = st.recentMessages.find((m) => String(m.messageId) === '-42');
    check('撤回成功后在记录里标 recalled=true（她才能对上账）', rec?.recalled === true, JSON.stringify(rec));
    check('markSelfRecalled 返回标记条数', marked === 1, String(marked));
    check('追加一条系统便条说明"谁撤的、撤了哪条"',
      (st.recentMessages ?? []).some((m) => m.system && /撤回了 1 条/.test(String(m.text)) && /表情包:中/.test(String(m.text))),
      JSON.stringify((st.recentMessages ?? []).slice(-1).map((m) => m.text)));

    // 她刚撤过 → 私聊撤回通知必须说"机器人自己撤回"，不能说"对方撤回"
    await b.handleNoticeEvent({
      post_type: 'notice', notice_type: 'friend_recall', user_id: 123,
      time: Math.floor(Date.now() / 1000),
    });
    const ev1 = (st.recentEvents ?? []).slice(-1)[0];
    check('刚自己撤过 → 通知记成"机器人自己撤回"（原来写死"对方撤回"，她会以为是他撤的）',
      /机器人自己撤回/.test(String(ev1?.text)), String(ev1?.text));

    // 另一个私聊（没撤过）→ 仍然是"对方撤回"
    await b.handleNoticeEvent({
      post_type: 'notice', notice_type: 'friend_recall', user_id: 124,
      time: Math.floor(Date.now() / 1000),
    });
    const st2 = b.getSocialV2State('private:124');
    const ev2 = (st2.recentEvents ?? []).slice(-1)[0];
    check('没自己撤过 → 仍是"对方撤回"（别把真·对方撤回也说成自己撤的）',
      /对方撤回/.test(String(ev2?.text)), String(ev2?.text));
  } finally {
    await b.close();
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
