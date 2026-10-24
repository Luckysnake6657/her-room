/**
 * 回归测试：唤醒兜底重试链路（"会话卡住"期间的行为）。
 *
 * 用户贴的日志（真实事故）：
 *   11:24:50 会话仍然繁忙，暂存唤醒原因 group:795894138（当前 atMention@seq600；已折叠 1 条）
 *   …每 60 秒一行，持续到 11:29…
 *   11:26:03 private:984776985 唤醒频率仍超限，暂存的唤醒继续等待（第 26 次重排）
 * 查下来两个真问题：
 *
 * 【bug 1】重试回调里**先判限流、后判繁忙**，而限流分支 return 时不动 pendingWakeRetryCount
 *   → "忙碌 + 限流"同时成立时，那个"连试 N 次就放弃并释放 busy 标记"的保险**永远不会触发**。
 *   实测 private 一边被限流重排 26 次、一边忙了 15 分钟，保险形同虚设。
 *   （sendWakePromptV2 里本来就是先判忙的，重试回调跟它不一致。）
 *
 * 【bug 2】日志节流间隔（60s）和重试间隔（60s）一样大 → 等于没节流，
 *   卡 15 分钟刷 15 行"会话仍然繁忙"，把日志环形缓冲冲掉一大块。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retryMs 调到最小（1000ms），否则测试要真等 60 秒
const bridge = await bridgeHarness({
  config: { socialV2: { enabled: true, wake: { retryMs: 1000, maxWakePerHour: 4, maxWakePerMinute: 1 } } },
});

try {
  bridge.setMode('reserved2');
  const { deferWakeReasonV2, isWakeRateLimited, getSocialV2State, v2TurnStartAt, wakeRetryMs, ensureSession, calls } = bridge;

  console.log('\n[1] 前置：retryMs 可配（不然测试没法跑）');
  check('wakeRetryMs() 读到了配置', wakeRetryMs() === 1000, String(wakeRetryMs()));

  const KEY = 'private:123';   // harness 白名单内的会话
  const sid = await ensureSession(KEY);
  const st = getSocialV2State(KEY);
  st.wakeConfig.batchWindowMs = 1000;
  // 造一条未读消息：重试成功后会检查"这条唤醒还需要吗"（没有未读就不再需要），
  // 所以没有未读的话它会正确地放弃——测试要真实验证"补上唤醒"，就得有未读
  st.lastUnreadSeq = 7;
  st.unread = [{ seq: 7, sender: '测试', text: '在吗' }];

  console.log('\n[2] 同时"忙 + 限流"时，必须走繁忙分支（保险才可能触发）');
  // 造"忙"：标记该会话有一个 turn 在跑
  v2TurnStartAt.set(sid, Date.now());
  // 造"限流"：最近一分钟已经唤醒过（maxWakePerMinute=1）
  st.wakeTimes = [Date.now()];
  check('前置：此刻确实处于限流', isWakeRateLimited(st) === true);
  check('前置：此刻确实判定为忙', bridge.isConversationBusyV2(KEY, st) === true);

  calls.prompts.length = 0;
  deferWakeReasonV2(KEY, st, 'atMention');
  await sleep(1500);   // 等一次兜底重试

  check('繁忙计数涨了（保险有希望触发）', (st.pendingWakeRetryCount || 0) >= 1,
    `pendingWakeRetryCount=${st.pendingWakeRetryCount}（旧代码这里是 0，被限流分支吞掉）`);
  check('限流重排计数没被当成本次的主因', (st.pendingWakeRateLimited || 0) === 0,
    `pendingWakeRateLimited=${st.pendingWakeRateLimited}`);
  check('唤醒原因仍然暂存着（没丢）',
    (st.pendingWakeReasons || []).some((r) => r && r.reason === 'atMention'),
    JSON.stringify(st.pendingWakeReasons));
  check('没有把唤醒投递出去（会话忙着，不能塞）', calls.prompts.length === 0, `prompts=${calls.prompts.length}`);
  check('记下了"第一次被推迟的时间"（恢复时要报卡了多久）', Number(st.pendingWakeFirstDeferredAt) > 0);

  console.log('\n[3] turn 结束后应自动补上唤醒，并清掉卡住相关的状态');
  v2TurnStartAt.delete(sid);
  st.wakeTimes = [];                 // 限流窗口也过去
  await sleep(1600);                 // 等下一次重试
  check('补上了唤醒（真的投递了）', calls.prompts.length > 0 || !!st.pendingWakeTimer,
    `prompts=${calls.prompts.length} pendingWakeTimer=${!!st.pendingWakeTimer}`);
  check('繁忙计数已清零', (st.pendingWakeRetryCount || 0) === 0, String(st.pendingWakeRetryCount));
  check('"卡住起始时间"已清零', !Number(st.pendingWakeFirstDeferredAt), String(st.pendingWakeFirstDeferredAt));

  console.log('\n[4] 日志节流间隔必须明显大于重试间隔（否则等于没节流）');
  {
    const src = (await import('node:fs')).readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    const m = /const DEFER_LOG_INTERVAL_MS = ([^;]+);/.exec(src);
    const expr = m?.[1] ?? '';
    check('节流间隔被写成"5 分钟"这种量级（不是 60s）',
      /5 \* 60 \* 1000|300000/.test(expr), `DEFER_LOG_INTERVAL_MS = ${expr}`);
    // 精确到"兜底重试那段回调内部"的顺序（文件里有两个 busy 判断，不能拿全文 indexOf 比）
    const retryBody = /st\.pendingWakeRetryTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, wakeRetryMs\(\)\)/.exec(src)?.[1] ?? '';
    const busyAt = retryBody.indexOf('isConversationBusyV2(key, st)');
    const rateAt = retryBody.indexOf('isWakeRateLimited(st,');
    check('重试回调里找到了这两处判断', busyAt > 0 && rateAt > 0, `busyAt=${busyAt} rateAt=${rateAt}`);
    check('重试里的繁忙判断在限流判断**之前**', busyAt > 0 && rateAt > 0 && busyAt < rateAt,
      '顺序反了的话"忙碌+限流"时保险又会被饿死');
  }

  console.log('\n[5] 长时间卡住要有"为什么"的线索（不能只说繁忙）');
  {
    const src = (await import('node:fs')).readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    check('会打出 turn 跑了多久 + 会话历史多大',
      /的 turn 已经跑了/.test(src) && /会话历史 .* MB/.test(src));
    check('恢复时会说"卡了约 N 分钟，现在补上"', /现在补上/.test(src));
  }
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
