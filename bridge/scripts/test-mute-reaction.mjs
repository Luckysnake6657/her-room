/**
 * 回归测试：被禁言期间不唤醒她，解禁后叫她"对禁言说两句"。
 *
 * 用户的原话（两段，合起来才是完整需求）：
 *   1. "group:1054156254暂时被禁言了" —— 触发我意识到禁言期间唤醒她是纯浪费：
 *      她根本发不出去，但唤醒一次照样要把整个会话历史重发一遍（一次完整 turn 的钱）。
 *   2. "禁言结束后不用处理，就禁言这件事发表一下看法就行了" —— 我第一版做成了
 *      "把禁言期间积压的消息攒起来、解禁后逐条消化"，用户明确否掉了这个方向。
 *
 * 所以这里锁死：
 *   • 禁言期间 scheduleWakeV2 不投递，把原因暂存（**不能丢**）；
 *   • 只有"禁机器人的禁言"才算，别人被禁言不影响她；
 *   • 解禁后用 `unmuted` 这个理由唤醒，提示词明确写"不用回去处理积压消息"；
 *   • 解禁时**清掉**暂存的唤醒原因，避免变成"解禁后回一堆旧消息"。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const SELF = 88888888;      // 机器人自己
const GROUP = 456;          // harness 配置里白名单内的群
const KEY = `group:${GROUP}`;

const bridge = await bridgeHarness({ config: { socialV2: { enabled: true, wake: { preSleepWaitEnabled: false } } } });

const mkBan = (over = {}) => ({
  notice_type: 'group_ban', sub_type: 'ban',
  group_id: GROUP, user_id: SELF, operator_id: 999, duration: 600,
  self_id: SELF, ...over,
});

try {
  bridge.setMode('reserved2');
  const { describeNoticeEvent, handleNoticeEvent, isMutedV2, getSocialV2State, scheduleWakeV2 } = bridge;
  const st = getSocialV2State(KEY);

  console.log('\n[1] 禁言事件的结构化字段');
  const ban = describeNoticeEvent(mkBan());
  check('kind=ban', ban.kind === 'ban');
  check('识别出"禁的是机器人自己"', ban.isSelf === true, JSON.stringify(ban));
  check('不是解除禁言', ban.isLift === false);
  check('带上禁言时长 600 秒', ban.duration === 600);
  const otherBan = describeNoticeEvent(mkBan({ user_id: 12345 }));
  check('别人被禁言时 isSelf=false', otherBan.isSelf === false, JSON.stringify(otherBan));
  const lift = describeNoticeEvent(mkBan({ sub_type: 'lift_ban' }));
  check('解除禁言事件 isLift=true', lift.isLift === true);

  console.log('\n[2] 收到"自己被禁言"后进入禁言状态');
  // 唤醒是走"合并窗口"定时器投递的（batchWindowMs，最短 1000ms）。
  // 测试里调到最短，免得为了等 8 秒白等。
  st.wakeConfig.batchWindowMs = 1000;
  await handleNoticeEvent(mkBan());
  check('记录了 mutedUntil', Number(st.mutedUntil) > Date.now(), `mutedUntil=${st.mutedUntil}`);
  check('isMutedV2() 为真', isMutedV2(st) === true);
  check('挂上了"解禁后要叫她"的标记', st.pendingUnmuteWake === true);
  check('排了兜底定时器（防 lift_ban 事件丢失）', !!st.muteLiftTimer);

  console.log('\n[3] 禁言期间不投递（省钱），但原因必须暂存不能丢');
  const promptsBefore = bridge.calls.prompts.length;
  scheduleWakeV2(KEY, 'atMention');
  await new Promise((r) => setTimeout(r, 1400)); // 等合并窗口过去，看它投不投
  check('没有投递任何 prompt（省下一次完整 turn）', bridge.calls.prompts.length === promptsBefore,
    `prompts ${promptsBefore} -> ${bridge.calls.prompts.length}`);
  const stashed = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons : [];
  check('唤醒原因被暂存下来（没有丢）', stashed.some((r) => r && r.reason === 'atMention'),
    JSON.stringify(stashed));
  check('暂存的原因是 muted 类型', stashed.some((r) => r && r.kind === 'muted'));

  console.log('\n[4] 别人被禁言不影响她');
  const stOther = getSocialV2State('group:789'); // 不在白名单，但状态对象仍可取
  stOther.mutedUntil = 0;
  stOther.pendingUnmuteWake = false;
  check('对非自己禁言不设 mutedUntil（当前会话仍是自己的那次）', isMutedV2(st) === true);

  console.log('\n[5] 解禁 → 叫她"对禁言这件事说两句"（而不是消化积压）');
  bridge.calls.prompts.length = 0;
  await handleNoticeEvent(mkBan({ sub_type: 'lift_ban' }));
  await new Promise((r) => setTimeout(r, 1400)); // 解禁唤醒同样走合并窗口
  check('mutedUntil 已清零', !Number(st.mutedUntil));
  check('isMutedV2() 变假', isMutedV2(st) === false);
  check('"解禁后叫她"的标记已消费', st.pendingUnmuteWake === false);
  check('解禁时清掉了暂存的积压唤醒（用户要求：不消化积压）',
    !Array.isArray(st.pendingWakeReasons) || st.pendingWakeReasons.length === 0,
    JSON.stringify(st.pendingWakeReasons));
  const allText = JSON.stringify(bridge.calls.prompts);
  check('确实投递了一次唤醒', bridge.calls.prompts.length > 0, `prompts=${bridge.calls.prompts.length}`);
  check('唤醒提示词是「解禁了」那一支', allText.includes('【解禁了】'));
  check('提示词明确说不用处理积压消息',
    allText.includes('不用回去处理') || allText.includes('不用逐条补回'));
  check('提示词要求她就禁言说一句/发表看法',
    allText.includes('被禁言') && (allText.includes('说一句') || allText.includes('看法')),
    allText.slice(0, 200));

  console.log('\n[6] 重复推送同一条禁言事件不会重复延长');
  {
    const st2 = getSocialV2State(KEY);
    st2.mutedUntil = 0;
    st2.pendingUnmuteWake = false;
    await handleNoticeEvent(mkBan());
    const first = Number(st2.mutedUntil);
    await handleNoticeEvent(mkBan()); // 15 秒内重复
    check('15 秒内的重复推送被去重（不重置计时）', Number(st2.mutedUntil) === first,
      `${first} -> ${st2.mutedUntil}`);
    bridge.clearMuteStateV2(st2);
    check('clearMuteStateV2 能收干净', !Number(st2.mutedUntil) && st2.pendingUnmuteWake === false && !st2.muteLiftTimer);
  }

  console.log('\n[7] 解禁后没有待办标记时，不会凭空唤醒');
  {
    const st3 = getSocialV2State(KEY);
    st3.mutedUntil = 0;
    st3.pendingUnmuteWake = false;
    bridge.calls.prompts.length = 0;
    bridge.triggerUnmuteWakeV2(KEY, st3, 0);
    await new Promise((r) => setTimeout(r, 30));
    check('没有 pendingUnmuteWake 就不会触发解禁唤醒', bridge.calls.prompts.length === 0,
      `prompts=${bridge.calls.prompts.length}`);
  }
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
