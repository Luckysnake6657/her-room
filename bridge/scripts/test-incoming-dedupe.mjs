/**
 * 回归测试：同一条消息被重复推送时只处理第一次。
 *
 * 真实事故（**她自己报的**，`state/feedback.json`）：
 *   「同一条私聊表情被推了三遍：seq 744/745/746 内容相同（E7871B54…jpg），
 *     messageId 都是 -961536121，时间只差几十毫秒。对方说他只发了一次，
 *     看形态像桥接侧重复投递」
 * 群里她也说过：「发三遍干嘛，手抽了？」→「那是我这边收重了」→
 *   「3条messageId一模一样，估计桥接重复推了一遍」
 *
 * 注意：**seq 是不同的**（744/745/746），所以按 seq 去重没用 —— 必须按 messageId。
 * 真·连发两条相同内容的消息 messageId 不同，不会被误杀（下面有对应用例）。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = await bridgeHarness({
  config: { socialV2: { enabled: true, wake: { retryMs: 1000, maxDirectWakePerHour: 30, maxDirectWakePerMinute: 3 } } },
});

try {
  bridge.setMode('reserved2');
  const { handleIncoming, getSocialV2State, calls, seenIncomingRefs } = bridge;
  const KEY = 'private:123';
  const st = getSocialV2State(KEY);
  st.wakeConfig.batchWindowMs = 1000;

  // 复刻事故里的那条：同一张表情、同一个 messageId、seq 递增
  const makeEvent = (messageId, seq) => ({
    self_id: 999,
    user_id: 123,
    message_id: messageId,
    message_seq: seq,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'image', data: { file: 'E7871B54CB16BD9E84109AD0627AD157.jpg', file_id: 'F1' } }],
  });

  console.log('\n[1] 同一条消息推三遍（seq 744/745/746，messageId 相同）→ 只处理一次');
  calls.prompts.length = 0;
  const unreadBefore = (st.unread ?? []).length;
  const recentBefore = (st.recentMessages ?? []).length;
  await handleIncoming('private', 123, makeEvent(-961536121, 744), bridge.cfg);
  await handleIncoming('private', 123, makeEvent(-961536121, 745), bridge.cfg);
  await handleIncoming('private', 123, makeEvent(-961536121, 746), bridge.cfg);
  await sleep(1500);

  // 注意：未读的 seq 是**桥接自己分配**的（递增），不是事件里的 744/745/746，
  // 所以只能按"增量"断言 —— 原来按 744/745/746 过滤会永远数到 0，等于没测。
  const unreadDelta = (st.unread ?? []).length - unreadBefore;
  const recentDelta = (st.recentMessages ?? []).length - recentBefore;
  check('未读只增加了 1 条（不是 3 条）', unreadDelta === 1, `未读 +${unreadDelta}`);
  check('recentMessages 只增加了 1 条', recentDelta === 1, `recent +${recentDelta}`);
  check('去重表里记了这个 messageId', seenIncomingRefs.get(KEY)?.has('-961536121') === true);
  // 只推一次的话，唤醒也只该有一次
  const deliveries = calls.prompts.filter((p) => JSON.stringify(p).includes('-961536121') || true).length;
  check('唤醒投递不超过 1 次', deliveries <= 1, `deliveries=${deliveries}`);

  console.log('\n[2] 真的连发两条相同内容 → messageId 不同，两条都要处理');
  const before = (st.recentMessages ?? []).length;
  await handleIncoming('private', 123, makeEvent(-111111111, 800), bridge.cfg);
  await handleIncoming('private', 123, makeEvent(-222222222, 801), bridge.cfg);
  await sleep(300);
  const after = (st.recentMessages ?? []).length;
  check('两条不同 messageId 的相同内容都进了 recentMessages', after - before === 2, `+${after - before}`);

  console.log('\n[3] 去重是按会话隔离的（不会把别的会话的同 id 消息吃掉）');
  const beforeG = (getSocialV2State('group:456').recentMessages ?? []).length;
  await handleIncoming('group', 456, { ...makeEvent(-961536121, 900), user_id: 777 }, bridge.cfg);
  const afterG = (getSocialV2State('group:456').recentMessages ?? []).length;
  check('群里同一个 messageId 仍然会处理（不同会话各自去重）', afterG - beforeG === 1, `+${afterG - beforeG}`);

  console.log('\n[4] 没有 messageId 时不去重（宁可重复也不能丢）');
  const noId = { self_id: 999, user_id: 123, message_seq: 950, message: [{ type: 'text', data: { text: '没有id的消息' } }] };
  const beforeN = (st.recentMessages ?? []).length;
  await handleIncoming('private', 123, { ...noId }, bridge.cfg);
  await handleIncoming('private', 123, { ...noId }, bridge.cfg);
  await sleep(300);
  const afterN = (st.recentMessages ?? []).length;
  check('没有 messageId 时两条都处理（不冒险误杀）', afterN - beforeN === 2, `+${afterN - beforeN}`);

  console.log('\n[5] 去重表有界（不会无限长）');
  for (let i = 0; i < 260; i++) {
    await handleIncoming('private', 123, { ...makeEvent(-300000000 - i, 1000 + i), message: [{ type: 'text', data: { text: `x${i}` } }] }, bridge.cfg);
  }
  check('表大小被限制在 200 以内', (seenIncomingRefs.get(KEY)?.size ?? 0) <= 200,
    `size=${seenIncomingRefs.get(KEY)?.size}`);

  console.log('\n[6] 日志要说明"重复推送被忽略"（不然排查时看不出）');
  {
    const src = (await import('node:fs')).readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    check('有明确的去重日志', /重复推送已忽略/.test(src));
    // ⚠️ 锚点别绑死某一句变量声明：2026-10-16 加了"文件回声"判定后，
    //    文件收集那段从 `incomingFiles = (Array.isArray(...))` 改成了 `rawFiles`，
    //    旧锚点 indexOf 变成 -1 直接假红（行为其实没坏）。
    //    改成绑"取文件段"这个语义锚点：它现在写作 `const rawFiles = (Array.isArray(event.message)`。
    const iDedupe = src.indexOf('重复推送已忽略');
    const iCollect = src.indexOf('.filter((s) => s?.type === \'file\')');
    check('去重发生在下载文件之前（省掉重复下载）', iDedupe > 0 && iCollect > iDedupe,
      `重复推送已忽略@${iDedupe}，取文件段@${iCollect}（顺序反了的话重复推送仍会重新下载一遍文件）`);
  }
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
