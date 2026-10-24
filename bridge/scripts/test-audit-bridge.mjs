import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

// 回归：记忆的"遗忘"是按重要性的**归档**，不是删除；注入要有预算。
//
// 用户的要求分两句，缺一不可：
//   ① "不重要的话题过段时间会遗忘，重要的记住很长一段时间" → 分级保鲜期；
//   ② "但是不能太健忘" → 过期**不能删**，要能查回来；注入也不能把重要的挤掉。
// 而且他说明了动机："主要是想节省点提示词，节省空间" —— 所以要真的省空间。
await test('memory expiry is importance-tiered, archives instead of deleting, and respects an inject budget', async (h) => {
  const now = Date.now();
  // ① 保鲜期分级：low < normal < high
  assert.ok(h.memoryTtlMs('low') < h.memoryTtlMs('normal'), 'low 应该比 normal 短');
  assert.ok(h.memoryTtlMs('normal') < h.memoryTtlMs('high'), 'normal 应该比 high 短');
  assert.equal(h.memoryTtlMs('garbage'), h.memoryTtlMs('normal'), '非法重要性按 normal 处理（不能因为写错就丢掉）');
  assert.equal(h.normalizeImportance('HIGH'), 'high', '大小写不敏感');

  // ② 过期 → 进归档，不删除
  const cm = {
    activeTopics: [
      { text: '随口提的琐事', importance: 'low', lastMentionAt: now - h.memoryTtlMs('low') - 1000 },
      { text: '普通话题', importance: 'normal', lastMentionAt: now - 1000 },
      { text: '他说明天要考试', importance: 'high', lastMentionAt: now - h.memoryTtlMs('low') - 1000 },
    ],
    pendingThoughts: [],
    memberImpressions: {},
    archived: [],
  };
  const r = h.pruneCoreMemory(cm, now);
  assert.equal(r.removed, 1, '只有 low 那条该过期');
  assert.equal(cm.activeTopics.length, 2, '活跃区剩两条');
  assert.equal(cm.archived.length, 1, '过期的那条要进归档（不能删掉）');
  assert.equal(cm.archived[0].text, '随口提的琐事', '归档内容必须原样保留');
  assert.ok(cm.archived[0].archivedAt > 0, '归档要记时间');
  assert.ok(cm.activeTopics.some((t) => t.text === '他说明天要考试'), 'high 的即使比 low 还旧也必须留着');
  assert.ok(!cm.activeTopics.some((t) => t.text === '随口提的琐事'), '过期的不能再留在活跃区');

  // ③ 注入预算：条目再多，注入的字符数也不能超预算
  h.cfg.socialV2 = { ...(h.cfg.socialV2 ?? {}), memory: { maxInjectChars: 300 } };
  const many = {
    activeTopics: Array.from({ length: 40 }, (_, i) => ({ text: `第${i}个话题${'啰嗦'.repeat(20)}`, importance: 'normal', lastMentionAt: now - i * 1000 })),
    pendingThoughts: Array.from({ length: 10 }, (_, i) => ({ text: `想法${i}${'废话'.repeat(20)}`, createdAt: now - i * 1000 })),
    memberImpressions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`人${i}`, { traits: ['标签一二三四五六七八九十'], interactionCount: i }])),
  };
  const injected = h.formatMemoryV2(many);
  assert.ok(injected.length <= 320, `注入长度必须受预算约束（实际 ${injected.length} 字符）`);
  assert.ok(injected.includes('第0个话题'), '最新的（分数最高）话题要带上');

  // ④ 预算不够时，先保 high 的
  const mixed = {
    activeTopics: [
      ...Array.from({ length: 8 }, (_, i) => ({ text: `低价值${i}${'水'.repeat(40)}`, importance: 'low', lastMentionAt: now - i * 1000 })),
      { text: '重要约定：明天九点考试', importance: 'high', lastMentionAt: now - 10 * 24 * 60 * 60 * 1000 },
    ],
    pendingThoughts: [], memberImpressions: {},
  };
  const mixedOut = h.formatMemoryV2(mixed);
  assert.ok(mixedOut.includes('重要约定：明天九点考试'), 'high 的记忆不能被 low 的挤掉');
  assert.ok(mixedOut.includes('★'), 'high 要标星，让人一眼看到');

  // ⑤ 预算设 0 = 完全不注入
  h.cfg.socialV2.memory.maxInjectChars = 0;
  assert.equal(h.formatMemoryV2(many), '', '预算 0 时不注入任何记忆');
});

// 回归：会话历史轮换（最大的省钱手段）+ 轮换后补"最近聊过什么"。
//
// 为什么是最大的：DSH 每个回合都要重发该会话的**全部历史**。实测私聊那个会话历史解开后
// 10.22 MB / 3270 个事件帧，而唤醒提示词里的黑话(1459 字符)+记忆(1401 字符)只是零头。
// 轮换能砍掉大头，代价是新会话没上下文 —— 所以必须补一段最近对话，否则她像失忆一样接不上话茬。
await test('session rotation targets the right file and seeds recent context', async (h) => {
  // ① 会话文件路径的目录名算法。DSH 把工作区路径压成
  //    `D:\qq-bridge\state\agents` → `--D-qq-bridge-state-agents--`
  //    （`:` 和 `\` 各换成一个 `-`，两边各包 `--`）。
  const dir = ['D:', 'qq-bridge', 'state', 'agents'].join('\\');
  assert.equal(h.sessionStorageSlug(dir), '--D-qq-bridge-state-agents--', '路径压缩算法必须和 DSH 实际目录名一致');
  assert.equal(h.sessionStorageSlug('/home/u/x'), '--home-u-x--', '正斜杠同样处理');

  // ② 轮换后补的上下文：要有"最近聊过什么"、要区分自己/对方、要截断、要禁止复述
  const now = Date.now();
  const seed = h.buildContextSeedLine({
    recentMessages: [
      { isSelf: false, sender: '张三', text: '在吗', time: now - 60000 },
      { isSelf: true, text: '嗯', time: now - 30000 },
      { isSelf: false, sender: '张三', text: 'x'.repeat(500), time: now },
    ],
  });
  assert.ok(seed.includes('最近聊过什么'), '要有明确的段落标题');
  // 2026-09-30：每行加了"（距今多久）" —— 起因是她把 12 分钟前聊的事说成了"上午那台服务器"
  assert.ok(/张三（(刚刚|\d+分钟前|\d+小时前)）：在吗/.test(seed), '要带发送者、可读时间和内容');
  assert.ok(/你（(刚刚|\d+分钟前|\d+小时前)）：嗯/.test(seed), '自己的话要标成"你"');
  assert.ok(seed.includes('括号里是距今多久'), '要说明括号的含义（否则她还是会按猜的来）');
  assert.ok(!seed.includes('x'.repeat(200)), '超长消息要截断（否则省下的 token 又加回来）');
  assert.ok(seed.includes('别复述'), '要禁止她复述这段上下文');
  assert.ok(seed.includes('别') && seed.includes('换了个会话'), '不许跟人提"我换了个会话"');
  // 空数据不产生空段
  assert.equal(h.buildContextSeedLine({ recentMessages: [] }), '');
  assert.equal(h.buildContextSeedLine({}), '');
  // 只取最后 N 条（不能把 200 条历史全塞回去）
  const many = Array.from({ length: 50 }, (_, i) => ({ isSelf: false, sender: 'S', text: `第${i}条`, time: now - i * 1000 }));
  const manySeed = h.buildContextSeedLine({ recentMessages: many });
  assert.ok(manySeed.includes('第49条'), '要包含最新的');
  assert.ok(!manySeed.includes('第0条'), '不能把整段历史又塞回去');
});

// 回归：唤醒限流必须"暂存重排"，绝不能把原因丢掉。
//
// 实测后果（用户原话就是"只回复了第一句"）：13:42:15 计划唤醒 private，
// 13:42:23 因 maxWakePerMinute 超限被**裸 return 丢弃** —— 那条消息再也没被回复。
// 限流的意思是"现在不行"，不是"这事算了"。这里测限流判定本身；
// "不许改回直接丢弃"由 self-check 的源码级断言守着。
await test('wake rate limiting defers instead of dropping the reason', async (h) => {
  const now = Date.now();
  h.cfg.socialV2 = {
    ...(h.cfg.socialV2 ?? {}),
    wake: { ...((h.cfg.socialV2 ?? {}).wake ?? {}), maxWakePerMinute: 1, maxWakePerHour: 6 },
  };
  assert.equal(h.isWakeRateLimited({ wakeTimes: [] }, now), false, '没有唤醒记录时不该限流');
  assert.equal(h.isWakeRateLimited({ wakeTimes: [now - 5000] }, now), true, '一分钟内已有 1 次 → 达到 maxWakePerMinute=1');
  assert.equal(h.isWakeRateLimited({ wakeTimes: [now - 5 * 60 * 1000] }, now), false, '5 分钟前那次不该占用"每分钟"额度');
  // 6 次都落在"一小时内"（别卡在 60 分钟边界上——`now - t < 3600000` 是严格小于，
  // 正好 60 分钟前的那次不算，写 (i+1)*10 分钟会只剩 5 次，测不出小时限流）
  const six = Array.from({ length: 6 }, (_, i) => now - (i + 1) * 5 * 60 * 1000);
  assert.equal(h.isWakeRateLimited({ wakeTimes: six }, now), true, '一小时内 6 次 → 达到 maxWakePerHour=6');
  h.cfg.socialV2.wake.maxWakePerMinute = 0;
  h.cfg.socialV2.wake.maxWakePerHour = 0;
  assert.equal(h.isWakeRateLimited({ wakeTimes: Array.from({ length: 50 }, () => now) }, now), false, '限流设为 0 表示不限制');
});

// 回归：同一条事件被重复投递时必须去重。
//
// 实测：同一条进群事件被 SnowLuma 投递了 4 次（21:17:46 两次、21:23:51、21:25:50），
// 记录时只挡了 15 秒内的重复，跨分钟的挡不住。不去重她会在提示词里
// 看到"阿奇进来了"四遍，像失忆；qq_social_state 里也会重复。
await test('duplicate notice deliveries are collapsed, newest wins', async (h) => {
  const now = Date.now();
  const out = h.dedupeEventList([
    { kind: 'increase', text: '阿奇(1) 被人邀请进来', at: now - 30 * 60 * 1000 },
    { kind: 'increase', text: '阿奇(1) 被人邀请进来', at: now - 10 * 60 * 1000 },
    { kind: 'increase', text: '阿奇(1) 被人邀请进来', at: now - 60 * 1000 },
    { kind: 'decrease', text: '阿奇(1) 退群了', at: now - 5 * 60 * 1000 },
  ]);
  assert.equal(out.length, 2, `重复的 increase 应合并成 1 条（实际 ${out.length}）`);
  // 最新的那条是 1 分钟前的 increase，所以它排第一；5 分钟前的 decrease 第二
  assert.equal(out[0].kind, 'increase', '应按时间从新到旧排序（最新的在前）');
  assert.equal(out[0].at, now - 60 * 1000, '保留的应是最新那条（不能留旧的）');
  assert.equal(out[1].kind, 'decrease', 'decrease 不能被 increase 吃掉（kind 不同）');
  // kind 不同、文本相同的不能互相吃掉
  assert.equal(h.dedupeEventList([{ kind: 'a', text: 'x', at: now }, { kind: 'b', text: 'x', at: now }]).length, 2);
  // 注意：harness 是把 bridge.js 跑在 vm 沙箱里的，返回的数组属于**另一个 realm**，
  // 直接 deepStrictEqual 比数组会因原型不同而失败（"same structure but not reference-equal"）。
  // 所以比长度和序列化结果，别比数组对象本身。
  assert.equal(h.dedupeEventList([]).length, 0);
  assert.equal(JSON.stringify(h.dedupeEventList([])), '[]');
});

// 回归：有人进群时，提示词要告诉她"谁进来了、怎么进来的"，但**不能**让她去刷欢迎。
//
// 背景：桥接原来只订阅 notice_type=notify（拍一拍），group_increase 事件被直接丢掉，
// 她对"有人进群"完全无感。测试没法等真人进群，所以验证纯函数那一层。
await test('group-increase notice line informs her without ordering a welcome', async (h) => {
  const now = Date.now();
  const inc = (o = {}) => ({ recentEvents: [{ kind: 'increase', text: '占位', at: now - 60 * 1000, ...o }] });
  let line = h.buildJoinNoticeLine(inc({ userId: '12345', name: '小明', subType: 'invite' }), now);
  assert.ok(line.includes('小明'), '要带出新人的名字');
  assert.ok(line.includes('12345'), '要带出 QQ 号（重名时靠它区分）');
  assert.ok(line.includes('被人邀请'), '要说明怎么进来的');
  assert.ok(line.includes('不用刻意欢迎'), '必须明确"不用刻意欢迎"，否则她会变成欢迎机器人');
  assert.ok(line.includes('随你'), '要把决定权交给她');

  line = h.buildJoinNoticeLine(inc({ userId: '999', subType: 'approve', at: now }), now);
  assert.ok(line.includes('自己申请'), 'approve 要说清是自己申请通过的');
  assert.ok(line.includes('999'), '没有昵称时要回退到 QQ 号');

  line = h.buildJoinNoticeLine(inc({ userId: '1', isSelfJoin: true, at: now }), now);
  assert.ok(line.includes('机器人自己'), '自己被拉进群要单独标注');
  assert.ok(!line.includes('不用刻意欢迎'), '这种场景不该套用"新人"措辞');

  // 超过 30 分钟就不再提（免得她几小时后突然对着"新人"打招呼）
  assert.equal(h.buildJoinNoticeLine(inc({ userId: '1', at: now - 31 * 60 * 1000 }), now), '');
  assert.equal(h.buildJoinNoticeLine({}, now), '');
  assert.equal(h.buildJoinNoticeLine(null, now), '');

  // 数据源必须只有 recentEvents 一个：以前另存过 st.lastGroupIncrease，
  // 但 saveSocialV2State 没持久化它，重启后进群那段就消失了（实测踩过）。
  // 这里放一份 lastGroupIncrease 确认它**不再**被采用。
  assert.equal(
    h.buildJoinNoticeLine({ lastGroupIncrease: { userId: '1', name: '旧字段', subType: 'invite', at: now } }, now),
    '', '不该再依赖 lastGroupIncrease —— 它没被持久化，是曾经的 bug 来源'
  );

  // ── 其它动态：只知情，**不主动提** ─────────────────────────────────
  // 用户明确要求："这几个只要知道就行了，如果没人特意提出来就别说这件事"
  const withOthers = h.buildJoinNoticeLine({
    recentEvents: [
      { kind: 'decrease', text: '张三 退群了', at: now - 5 * 60 * 1000 },
      { kind: 'ban', text: '李四 被禁言 10 分钟', at: now - 3 * 60 * 1000 },
      { kind: 'recall', text: '王五 撤回了一条群消息', at: now - 60 * 1000 },
      { kind: 'increase', text: '小明 被人邀请进来', at: now - 60 * 1000 },
    ],
  }, now);
  assert.ok(withOthers.includes('张三 退群了'), '动态要列出来（她得知道）');
  assert.ok(withOthers.includes('被禁言'), '禁言也要列');
  assert.ok(withOthers.includes('撤回了一条群消息'), '撤回也要列');
  assert.ok(withOthers.includes('除非有人明确提起'), '必须写明：没人提起就别说');
  assert.ok(withOthers.includes('不要主动说'), '必须明确禁止主动汇报群动态');
  assert.ok(!/^\s*【群里最近的动态[^]*小明 被人邀请进来/m.test(withOthers.split('【群里最近的动态')[1] || ''),
    'increase 已经在"刚有人进来"那段单独处理，不该在动态列表里重复出现');

  // 动态也有 30 分钟窗口
  const oldOnly = h.buildJoinNoticeLine({ recentEvents: [{ kind: 'decrease', text: '很久以前退群了', at: now - 40 * 60 * 1000 }] }, now);
  assert.equal(oldOnly, '', '超过 30 分钟的动态不该再提示');
});

// 回归：**只有进群会唤醒她**，其它动态一律"只知情、不主动提"。
//
// 用户的分寸：进群 → 可以唤醒她、由她自己决定要不要接一句；
// 其它（退群/禁言/撤回/加好友/掉线…）→ 只记录，没人提就当没发生。
// 一旦给这些也开唤醒，她就会变成播报群动态的机器人。
await test('only group_increase is wake-worthy; every other notice is record-only', async (h) => {
  const wakeWorthyKinds = new Set();
  const recordOnlyKinds = new Set();
  const cases = [
    { notice_type: 'group_increase', sub_type: 'invite', group_id: 1, user_id: '2' },
    { notice_type: 'group_decrease', sub_type: 'leave', group_id: 1, user_id: '2' },
    { notice_type: 'group_decrease', sub_type: 'kick', group_id: 1, user_id: '2', operator_id: '3' },
    { notice_type: 'group_decrease', sub_type: 'disband', group_id: 1 },
    { notice_type: 'group_ban', sub_type: 'ban', group_id: 1, user_id: '2', duration: 600 },
    { notice_type: 'group_ban', sub_type: 'lift_ban', group_id: 1, user_id: '2' },
    { notice_type: 'group_admin', sub_type: 'set', group_id: 1, user_id: '2' },
    { notice_type: 'group_recall', group_id: 1, user_id: '2', operator_id: '2' },
    { notice_type: 'friend_recall', user_id: '2' },
    { notice_type: 'friend_add', user_id: '2' },
    { notice_type: 'group_card', group_id: 1, user_id: '2', card: '新名片' },
    { notice_type: 'group_upload', group_id: 1, user_id: '2', file: { name: 'a.txt' } },
    { notice_type: 'essence', sub_type: 'add', group_id: 1, user_id: '2' },
    { notice_type: 'group_msg_emoji_like', group_id: 1, user_id: '2' },
    { notice_type: 'bot_offline', message: 'disconnected' },
  ];
  for (const ev of cases) {
    const d = h.describeNoticeEvent(ev);
    assert.ok(d, `${ev.notice_type}/${ev.sub_type ?? ''} 必须有描述（不能丢事件，否则她就不知情）`);
    if (d.wakeWorthy) wakeWorthyKinds.add(ev.notice_type);
    else recordOnlyKinds.add(ev.notice_type);
  }
  assert.deepEqual([...wakeWorthyKinds], ['group_increase'], '只有 group_increase 允许唤醒她');
  assert.ok(recordOnlyKinds.size >= 8, `其它类型都应是"只记录"（实际 ${recordOnlyKinds.size} 种）`);
  assert.ok(!recordOnlyKinds.has('group_increase'), 'group_increase 不能被归到只记录');

  // 「正在输入」没有任何信息量：应当直接丢（返回 null），不然会占满 recentEvents
  assert.equal(h.describeNoticeEvent({ notice_type: 'notify', sub_type: 'input_status', user_id: '2' }), null);
  // 拍一拍走专门逻辑，这里也要丢，避免被记两次
  assert.equal(h.describeNoticeEvent({ notice_type: 'notify', sub_type: 'poke', user_id: '2' }), null);
  // 未来 SnowLuma 新增的类型：不能丢，要记一条通用的（"全知情"）
  const unknown = h.describeNoticeEvent({ notice_type: 'brand_new_type', sub_type: 'x' });
  assert.ok(unknown && unknown.text.includes('brand_new_type'), '未知类型也要记录下来');
  assert.equal(unknown.wakeWorthy, false, '未知类型不许唤醒');
});

// 回归：跨会话回声——她必须知道"自己在别的会话说过什么"。
//
// 真实事故：她在 795894138 群说了「心虚才隐身呗」，80 秒后管理员在私聊问她，
// 她理直气壮否认："不是我发的，我这轮没有这个动作"——从私聊会话的视角字面是真的，
// 因为每个 QQ 会话是独立 DSH 会话，群会话的动作不在她上下文里。
await test('cross-session echo lists her own messages from other conversations', async (h) => {
  h.setMode('reserved2');
  h.cfg.allow = { private: [111], groups: [222] };
  h.cfg.deny = { private: [], groups: [] };

  const mine = h.getSocialV2State('private:111');
  mine.recentMessages = [{ isSelf: true, text: '我在私聊说的话', time: Date.now() }];
  const other = h.getSocialV2State('group:222');
  const now = Date.now();
  other.recentMessages = [
    { isSelf: true, text: '心虚才隐身呗', time: now - 60 * 1000 },
    { isSelf: false, text: '别人说的话，不该出现在回声里', time: now - 30 * 1000 },
  ];

  const echo = h.buildCrossSessionEchoLine('private:111');
  assert.ok(echo.includes('心虚才隐身呗'), '必须包含她在别的会话说过的话');
  assert.ok(echo.includes('222群'), '必须标明是在哪个会话说的');
  assert.ok(!echo.includes('我在私聊说的话'), '当前会话自己的话不该进回声（避免重复）');
  assert.ok(!echo.includes('别人说的话'), '别人的话不该进回声（那是一整个"我说过什么"的清单）');
  assert.ok(echo.includes('别否认自己做过的事'), '要明确告诉她：被问起时先看这里，别否认');

  // 太旧的（超过 90 分钟）不该进回声，避免长期噪声
  other.recentMessages = [{ isSelf: true, text: '很久以前说的', time: now - 3 * 60 * 60 * 1000 }];
  assert.equal(h.buildCrossSessionEchoLine('private:111'), '', '超过 90 分钟的不该出现');

  // ── 别的会话的"周边事件"也要跨会话告知 ─────────────────────────────
  // 实测事故：1124778377 群 21:17 有人进群，21:18 管理员在**私聊**问她，
  // 她答"看不见，那种系统提示我收不到"——事件其实收到了，只是记在群会话里。
  other.recentMessages = [];
  other.recentEvents = [{ kind: 'increase', text: '阿奇(3889699212) 被人邀请进来', at: now - 2 * 60 * 1000 }];
  const withEvents = h.buildCrossSessionEchoLine('private:111');
  assert.ok(withEvents.includes('阿奇(3889699212)'), '别的事件的进群信息必须跨会话可见，否则她只能靠猜');
  assert.ok(withEvents.includes('222群'), '要标明是哪个会话发生的');
  assert.ok(withEvents.includes('没人提起就不要主动说'), '跨会话事件同样要遵守"不主动提"');
  assert.ok(withEvents.includes('别说"我收不到"'), '要直接堵住"我收不到这种消息"这类凭空断言');
});

// 回归：孤儿 collector 不该把会话锁成"繁忙"。
//
// 真实故障（用户实测：私聊被锁 12～17 分钟、日志 418 行"暂存唤醒原因"）：
//   collector 是在**收到任意一帧**时创建的（回合结束后飘来的迟到帧也会创建它），
//   而 isConversationBusyV2 曾经把 `collectors.has(sid)` 直接当成"忙"。
//   于是这种**永远等不到 turn/end 的孤儿 collector** 会把会话锁死，
//   直到 11 分钟的孤儿清理才恢复。collector 只是累加器，它的存在不该等于忙。
await test('an orphan collector (no turn marker) must not keep a conversation busy', async (h) => {
  const key = 'group:1124778377';
  const sid = 'orphan-sid';
  h.state.sessions[key] = sid;

  // 有 collector、**没有** turn 标记 —— 就是"回合结束后飘来一帧"留下的形态
  h.collectors.set(sid, h.createTurnCollector());
  h.collectorLastEventAt.set(sid, Date.now());
  assert.equal(
    h.isConversationBusyV2(key, null), false,
    '孤儿 collector 不该让会话算忙（否则会锁死到 11 分钟自愈）'
  );

  // 反向确认：真有回合在跑时必须算忙
  h.v2TurnStartAt.set(sid, Date.now());
  assert.equal(h.isConversationBusyV2(key, null), true, '有 turn 标记时必须算忙');

  // 去掉 marker 后立刻恢复空闲（collector 仍在，说明判定不依赖它）
  h.v2TurnStartAt.delete(sid);
  assert.equal(h.isConversationBusyV2(key, null), false);
  assert.equal(h.collectors.has(sid), true, 'collector 应该还在（只是不影响忙碌判定）');
});

// 回归："会话永久繁忙"的死锁。
//
// 真实故障（用户实测：某群 busy 13.6 分钟不恢复，日志每 60s 一条"会话繁忙，暂存唤醒原因"）：
//   isConversationBusyV2 早期把"自愈"（reclaimStaleTurn）放在几个提前 return 的**后面**，
//   而 pendingWakeKeys / pendingWakeTimer / 队列这些"备用忙碌原因"恰恰是会话卡住时的必然产物。
//   于是每次检查都在前面 return true，自愈一次都执行不到，泄漏的 turn 标记永远不会被清。
//
// 这个测试离线复现那个状态：故意放一个早就过期的 turn 标记，**同时**置上 pendingWakeKeys
// （触发提前 return）。修复后必须仍然完成回收。
await test('stale turn marker is reclaimed even when pendingWake triggers an early return', async (h) => {
  const key = 'group:1124778377';
  const sid = 'stale-sid';
  h.state.sessions[key] = sid;
  // 10 分钟前的 turn：远超 STALE_TURN_MS（6 分钟）
  h.v2TurnStartAt.set(sid, Date.now() - 10 * 60 * 1000);
  // 关键：这个标记会让旧实现在回收之前就 return
  h.pendingWakeKeys.add(key);

  const busy = h.isConversationBusyV2(key, null);
  assert.equal(busy, true, 'pendingWakeKeys 仍然应该算忙（这一条本身没错）');
  assert.equal(
    h.v2TurnStartAt.has(sid), false,
    '即使 pendingWakeKeys 让判定提前 return，也必须先回收泄漏的 turn 标记（否则会话永久繁忙）'
  );

  // 反向确认：没有 pendingWakeKeys 时同样要回收
  h.v2TurnStartAt.set(sid, Date.now() - 10 * 60 * 1000);
  assert.equal(h.isConversationBusyV2(key, null), true);
  assert.equal(h.v2TurnStartAt.has(sid), false, '没有 pendingWakeKeys 时也要回收');

  // 新鲜的 turn 不能被误回收
  h.v2TurnStartAt.set(sid, Date.now() - 5000);
  assert.equal(h.isConversationBusyV2(key, null), true);
  assert.equal(h.v2TurnStartAt.has(sid), true, '5 秒前的 turn 属于正常回合，绝不能回收');
});

await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
if (failures) process.exitCode = 1;
