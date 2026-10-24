/**
 * 回归测试：唤醒限流必须分档 —— "有人直接找她"不该被"省成本"的限流挡住。
 *
 * 真实事故（用户截图）：18:59 发了个 7.77MB 的文件，19:01 她回了个表情，
 * 然后 19:18、19:21、19:24、19:28 连喊「人呢」「跑哪去了」——**十几分钟没有回音**。
 * 查会话帧：那一轮 turn 是 19:31:11 才开始的，而 18:30:58 那次唤醒正好在
 * 19:30:58 滑出"最近一小时"窗口 —— 也就是说**用户的消息被限流压了 13 分钟**。
 * （`maxWakePerHour: 4` 是上次"降频"时调下来的，限流本意是"别自己刷屏"，
 *   结果把"别人叫她"也一起限掉了。）
 *
 * 现在分两档：
 *   有人直接找她（私聊 / @ / 提问 / 点名 / 关键词 / 指定成员）→ maxDirectWakePerMinute/Hour
 *   她自己回访（replyCheck/proactiveCheck/timeout）与概率唤醒/anyMessage → maxWakePerMinute/Hour
 * 宽松档不是无限：仍然防住消息洪水把她唤醒成百上千次。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const bridge = await bridgeHarness({
  config: {
    socialV2: {
      enabled: true,
      wake: {
        maxWakePerMinute: 1, maxWakePerHour: 4,
        maxDirectWakePerMinute: 3, maxDirectWakePerHour: 30,
        retryMs: 1000,
      },
    },
  },
});

try {
  bridge.setMode('reserved2');
  const { isDirectWakeV2, wakePriorityV2, isWakeRateLimited, getSocialV2State, ensureSession, sendWakePromptV2 } = bridge;

  console.log('\n[1] 分类：谁是"直接找她"');
  check('私聊一律算直接（哪怕原因是概率）', isDirectWakeV2('private:123', 'probability') === true);
  check('私聊 + 回访也算直接（一对一，就是有人在跟她说话）', isDirectWakeV2('private:123', 'replyCheck') === true);
  for (const r of ['atMention', 'question', 'nameMention', 'keyword:小鲸鱼', 'speaker:某人']) {
    check(`群里 ${r} 算直接`, isDirectWakeV2('group:456', r) === true);
  }
  for (const r of ['probability', 'replyCheck', 'proactiveCheck', 'timeout', 'anyMessage', 'groupIncrease']) {
    check(`群里 ${r} 不算直接（是她自己回访/概率/被动的）`, isDirectWakeV2('group:456', r) === false);
  }

  console.log('\n[2] 严格档满额时，直接唤醒必须仍能通过（这就是用户"人呢"没人理的根因）');
  const st = getSocialV2State('group:456');
  const now = Date.now();
  // 造"这一小时已经唤醒 4 次"
  st.wakeTimes = [now - 60000, now - 50000, now - 40000, now - 30000];
  st.directWakeTimes = [];
  check('前置：她自己的回访/概率唤醒确实被限住了', isWakeRateLimited(st, now, false) === true);
  check('有人 @ 她 → 不被限（宽松档）', isWakeRateLimited(st, now, true) === false);
  check('私聊消息 → 不被限', isWakeRateLimited(getSocialV2State('private:123'), now, true) === false);

  console.log('\n[3] 宽松档也有上限（防消息洪水把她唤醒成百上千次）');
  const st2 = getSocialV2State('private:123');
  st2.wakeTimes = [];
  st2.directWakeTimes = [now - 30000, now - 20000, now - 10000];  // 3 次 = maxDirectWakePerMinute
  check('一分钟内第 4 次直接唤醒会被限住', isWakeRateLimited(st2, now, true) === true);
  st2.directWakeTimes = [];
  const many = Array.from({ length: 30 }, (_, i) => now - i * 60000);  // 30 次（跨一小时）
  st2.directWakeTimes = many;
  check('一小时内超过 maxDirectWakePerHour 会被限住', isWakeRateLimited(st2, now, true) === true);
  st2.directWakeTimes = [now - 3600000 - 1000];   // 全在一小时之外
  check('窗口滑过之后恢复', isWakeRateLimited(st2, now, true) === false);

  console.log('\n[4] 真的投递时，直接唤醒要记到 directWakeTimes 里（不然宽松档永远为空）');
  const KEY = 'group:456';
  const st3 = getSocialV2State(KEY);
  st3.wakeTimes = [];
  st3.directWakeTimes = [];
  st3.wakeConfig.batchWindowMs = 1000;
  await ensureSession(KEY);
  await sendWakePromptV2(KEY, 'atMention');
  check('直接唤醒被记入 directWakeTimes', (st3.directWakeTimes || []).length === 1,
    JSON.stringify(st3.directWakeTimes));
  check('同时也在总 wakeTimes 里（总账不能丢）', (st3.wakeTimes || []).length === 1);
  const st4 = getSocialV2State(KEY);
  st4.directWakeTimes = [];
  st4.wakeTimes = [];
  // 上一次投递会把会话标成"忙"（pendingWakeKeys 租约 + v2TurnStartAt；
  // harness 里没有 turn/end 事件来释放），忙的时候唤醒会被 defer、轮不到记账 ——
  // 这里手动清干净，专门验"记账记在哪一档"
  const sid2 = await ensureSession(KEY);
  bridge.v2TurnStartAt.delete(sid2);
  bridge.pendingWakeKeys.delete(KEY);
  bridge.clearPendingWake(KEY);
  bridge.disarmPendingWakeLease(KEY);
  await sendWakePromptV2(KEY, 'replyCheck');
  check('非直接唤醒**不**记入 directWakeTimes', (st4.directWakeTimes || []).length === 0,
    JSON.stringify(st4.directWakeTimes));
  check('但记入总 wakeTimes', (st4.wakeTimes || []).length === 1, JSON.stringify(st4.wakeTimes));

  console.log('\n[5] 优先级表与分档判据必须一致（>=60 才算直接）');
  check('priority: atMention(90) 直接', wakePriorityV2('atMention') >= 60 && isDirectWakeV2('group:456', 'atMention'));
  check('priority: keyword(60) 正好在门槛上，算直接', wakePriorityV2('keyword') === 60 && isDirectWakeV2('group:456', 'keyword'));
  check('priority: anyMessage(50) 低于门槛，不算直接', wakePriorityV2('anyMessage') === 50 && !isDirectWakeV2('group:456', 'anyMessage'));
  check('priority: replyCheck(40) 不算直接', wakePriorityV2('replyCheck') === 40 && !isDirectWakeV2('group:456', 'replyCheck'));
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
