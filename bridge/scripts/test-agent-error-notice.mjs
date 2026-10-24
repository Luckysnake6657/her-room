/**
 * 回归：**agent 报错不许发进出事的会话**（2026-10-02 事故）。
 *
 * 现场（管理员截图）：今天凌晨 03:49~05:22，两个群里各出现若干条
 *   `⚠️ agent 处理出错：SSE stream ended without [DONE]`
 * —— 这是**她账号在群里刷系统报错**（截图里 4 条：04:35 / 04:51 / 05:06 / 05:22），
 *   既破人设、又像机器人坏了；而且同类错误十几分钟一条，纯打扰。
 *   根因：报错分支里直接 `sendToQQ(key, '⚠️ agent 处理出错：…')`，key 是出事的会话（可能是群）。
 *
 * 修法两条：
 *   ① 只通知**管理员私聊**（他才是能修的人），同类错误 10 分钟折叠一次（只累计次数）；
 *   ② 瞬时错误（SSE 断流/超时/502…）+ 这一轮**没把用户晾着** → 补一次唤醒
 *      （那轮等于没发生、用户还在等回答）；同会话 10 分钟最多补一次。
 *
 * 2026-10-10 补充（真机踩到的漏）：她先回了两句，之后那一步**模型自己生成坏了**
 *   （`MALFORMED_RESPONSE: tool input is invalid JSON` —— 她把 messages 的值忘了加引号），
 *   而管理员在她回话之后又发了一条消息、那条正好被这一轮"吃掉"。旧规则看到"这一轮发过消息"
 *   就不补唤醒 → 管理员最后那句话没人回，而且没有任何机制会再捞它。
 * 所以：
 *   • `MALFORMED_RESPONSE` / `tool input is invalid JSON` 归入瞬时错误（采样事故，重试一次基本就好）；
 *   • 判定条件从"这一轮没发过"改成"**没发过，或者虽然发过但吃掉了一条没被回答的消息**"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');

const GKEY = 'group:456';          // 出事的会话 = 一个群（绝不能往这里发报错）
// 补唤醒的节流是**按会话**记 10 分钟的，所以每一条"应该补"的断言都得用干净会话，否则互相干扰。
const GKEY_MALFORMED = 'group:457';
const GKEY_CONSUMED = 'group:458';
const GKEY_NOT_TRANSIENT = 'group:459';
const OWNER_KEY = 'private:123';   // harness 的 ownerQQ = 123

const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123 } });
try {
  h.setMode('reserved2');
  const sentTo = (id) => h.calls.sent.filter((s) => String(s.id) === String(id)).map((s) => s.text);
  const st = h.getSocialV2State(GKEY);
  st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };

  console.log('\n[1] 报错 → 只发管理员私聊，**绝不进出事的群**');
  const r1 = await h.notifyAgentError(GKEY, 'SSE stream ended without [DONE]', false);
  console.log('    发给群的消息:', JSON.stringify(sentTo(456)));
  console.log('    发给管理员的消息:', JSON.stringify(sentTo(123)));
  check('出事的群**一条都没发**', sentTo(456).length === 0, JSON.stringify(sentTo(456)));
  check('管理员收到了一条（带"技术错误·仅你可见"）',
    sentTo(123).length === 1 && /技术错误·仅你可见/.test(sentTo(123)[0]) && /SSE stream ended/.test(sentTo(123)[0]));
  check('返回值：通知了 / 没折叠 / 补了唤醒', r1.notified === true && r1.folded === 0 && r1.retried === true, JSON.stringify(r1));

  console.log('\n[2] 同类错误 10 分钟内再发生 → 折叠，不再打扰');
  const r2 = await h.notifyAgentError(GKEY, 'SSE stream ended without [DONE]', false);
  const r3 = await h.notifyAgentError(GKEY, 'SSE stream ended without [DONE]', false);
  check('不再发第二条', sentTo(123).length === 1, JSON.stringify(sentTo(123)));
  check('群依旧干净', sentTo(456).length === 0);
  check('折叠次数在涨（3 次都记到了）', r2.folded === 2 && r3.folded === 3, `${r2.folded}, ${r3.folded}`);

  console.log('\n[3] 换一条不同的错误 → 允许再通知一次（不同错误不折叠）');
  const r4 = await h.notifyAgentError(GKEY, 'HTTP 400 INVALID_REQUEST', false);
  check('新错误通知了', r4.notified === true && sentTo(123).length === 2, JSON.stringify(sentTo(123).length));
  check('400 不算瞬时 → 不补唤醒', r4.retried === false, JSON.stringify(r4));

  console.log('\n[4] 已发过消息的回合报错，且没有吃掉别人的消息 → **不补唤醒**（避免重复回复）');
  const r5 = await h.notifyAgentError(GKEY, 'SSE stream ended without [DONE]', true, false);
  check('不补唤醒', r5.retried === false, JSON.stringify(r5));

  console.log('\n[4b] 模型这一步生成坏了（MALFORMED_RESPONSE）→ 算瞬时错误，可以补唤醒');
  // 真机现场：`DeepSeek Messages stream: tool input is invalid JSON`
  const r6 = await h.notifyAgentError(GKEY_MALFORMED, 'DeepSeek Messages stream: tool input is invalid JSON', false);
  check('认得出这是可重试的采样事故', r6.retried === true, JSON.stringify(r6));

  console.log('\n[4c] 发过消息 **但吃掉了一条没被回答的消息** → 也必须补（2026-10-10 的漏）');
  const r7 = await h.notifyAgentError(GKEY_CONSUMED, 'DeepSeek Messages stream: tool input is invalid JSON', true, true);
  check('补了唤醒', r7.retried === true, JSON.stringify(r7));

  console.log('\n[4d] 同一条消息被吃掉，但错误不是瞬时类（400）→ 仍不补（重试也没用）');
  const r8 = await h.notifyAgentError(GKEY_NOT_TRANSIENT, 'HTTP 400 INVALID_REQUEST', true, true);
  check('不补唤醒', r8.retried === false, JSON.stringify(r8));

  console.log('\n[4e] 10 分钟节流：同一会话不会连环补');
  const r9 = await h.notifyAgentError(GKEY_MALFORMED, 'DeepSeek Messages stream: tool input is invalid JSON', false);
  check('节流内不再补', r9.retried === false, JSON.stringify(r9));

  console.log('\n[5] 唤醒原因文案：告诉她"是我这边断了"，别让她以为对方没说话');
  const prompt = h.buildWakePromptV2(GKEY, 'agentErrorRetry');
  check('有专门文案', /技术故障/.test(prompt) && /回复流被掐断/.test(prompt), prompt.slice(-260));
  check('并提醒别重复已发出去的内容', /别重复你已经发出去的内容/.test(prompt));

  console.log('\n[6] 源码级：报错分支不许再往会话里 sendToQQ');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check("没有 `sendToQQ(key, \`⚠️ agent 处理出错` 这种写法", !/sendToQQ\(key, `⚠️ agent 处理出错/.test(src));
  check('aborted 也不再往会话里发"已停止"', !/sendToQQ\(key, '⏹️ 已停止'\)/.test(src));

  console.log('\n[7] 同类的运维文案也走"只通知管理员"（敏感信息拦截 / 消息未被接受）');
  check('没有往会话里发"疑似包含敏感信息被拦截"', !/sendToQQ\(key, '⚠️ 本条回复因疑似包含敏感信息/.test(src));
  check('没有往会话里发"消息未被接受"', !/sendToQQ\(key, `⚠️ 消息未被接受/.test(src));
  check('有 notifyOwnerOnly 这个统一出口', /async function notifyOwnerOnly\(key, text\)/.test(src));
  check('notifyOwnerOnly 真的发到管理员私聊', /const ownerKey = `private:\$\{cfg\.ownerQQ\}`/.test(src));
  // 端到端：直接调它，看出事的群收不到、管理员收到
  const before456 = h.calls.sent.filter((s) => String(s.id) === '456').length;
  const before123 = h.calls.sent.filter((s) => String(s.id) === '123').length;
  await h.notifyOwnerOnly(GKEY, '⚠️ 测试用的运维文案');
  const after456 = h.calls.sent.filter((s) => String(s.id) === '456').length;
  const after123 = h.calls.sent.filter((s) => String(s.id) === '123').length;
  check('群 +0 条、管理员 +1 条', after456 === before456 && after123 === before123 + 1, `456: ${before456}→${after456}, 123: ${before123}→${after123}`);
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
