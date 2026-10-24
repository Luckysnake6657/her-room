/**
 * 回归测试：临时角色扮演（提议 → 她自己决定 → 到期/自己退出）。
 *
 * 用户需求原话：
 *   「有没有办法暂时修改角色卡，看起来就是愿意扮演角色而不是完全改变人格，
 *     然后过段时间，或者她自己退出这种状态——也就是不想玩角色扮演游戏，
 *     这种命令不是一要求就会执行，而是看她愿不愿意，不愿意就没法搞」
 *
 * 所以这里锁死四条：
 *   1. 控制台只能**提议**，不能直接把角色改掉（提议后她自己不表态就不生效）；
 *   2. **只有她能** accept/decline/exit（管理端带 agent token 反而调不了）；
 *   3. 接受后限时生效、**到期自动结束**（不是永久换人格）；
 *   4. 她拒绝后有冷却期，不会缠着她重提。
 *
 * 走真实 HTTP 端点（和她实际调用同一条路径）。
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
if (!agentToken) { console.error('拿不到 agent token'); process.exit(2); }

const call = async (body, { asAgent = false } = {}) => {
  const res = await fetch(`${BRIDGE_BASE}/api/socialV2/role-play`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleToken,
      ...(asAgent ? { 'x-agent-token': agentToken } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const api = async (p, method = 'POST', body = null) => {
  const res = await fetch(`${BRIDGE_BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const status = async () => (await call({ action: 'status' }, { asAgent: true })).json?.results?.[0];
const reset = async () => { await call({ action: 'cancel', key: KEY }); await call({ action: 'clear-cooldown', key: KEY }); };

console.log(`会话 ${KEY}\n`);

// ── 隔离（2026-09-28 血的教训）──────────────────────────────────────────────
// 这个测试会在**真实会话**上写 roleProposal/tempRole。第一次没做隔离，正好撞上
// 用户在跟聊天：她的提示词里被塞进"他在问你想不想演「洛琪希」/刚才那段演完了"，
// 而用户问的是「牧濑红莉栖」—— 她因此说出"换谁都不演""今晚我就是我"这种怪话，
// 用户看到的是"一要求扮演她就不说话"。所以现在：
//   ① 先把二代 AI **暂停**（唤醒全部停掉，测试期间不可能有提示词投递）；
//   ② 如果她**正在演**或**有待回应的提议**，直接跳过真实会话部分（不碰他的现场）；
//   ③ 结束后恢复原来的暂停状态。
const activity = async () => (await api('/api/socialV2/activity', 'GET')).json ?? {};
const setPaused = async (paused) => api('/api/socialV2/activity', 'POST', { paused });

// ⚠️ 2026-09-28 第二次事故：测试跑的过程中**她自己在 QQ 里真的开演了**（牧濑红莉栖，
//    23:58:20 自己 start + 查资料 + 存卡）。测试开跑时的检查是"干净的"，于是它照常
//    写入状态，最后 finally 里的 `cancel` **把她刚起步的演出静默结束了**（cancel 分支
//    当时连日志都不打，所以查了半天才看出来）。
// 现在三道保险：
//   ① 只清理"测试自己建的"角色（TEST_ROLES 白名单里没有的，一律不碰）；
//   ② 每个会覆盖状态的用例（propose / accept / start）之前再查一次，发现她在演就整段跳过；
//   ③ bridge 侧的 cancel 分支补上日志，静默结束不再可能。
const TEST_ROLES = new Set(['洛琪希', '绫波丽', '牧濑红莉栖', 'x', '__测试卡-洛琪希', '__测试无卡角色']);
const NOCARD_ROLE = '__测试无卡角色';
class SkipLive extends Error {}

const live = await (async () => {
  try {
    const before = await activity();
    const s = await status();
    if (s?.tempRole) return { ok: false, why: `她正在演「${s.tempRole.role}」——不打扰`, wasPaused: before?.paused === true };
    if (s?.proposal && s.proposal.status === 'pending') return { ok: false, why: `有正在等她表态的提议（「${s.proposal.role}」）——不打扰`, wasPaused: before?.paused === true };
    await setPaused(true);
    return { ok: true, wasPaused: before?.paused === true };
  } catch (error) {
    return { ok: false, why: `读状态失败：${error?.message ?? error}`, wasPaused: false };
  }
})();
if (!live.ok) console.log(`⚠️ 跳过"真实会话"部分：${live.why}\n`);

/** 覆盖状态之前的安全检查：她在演"不是测试建的角色"就中断整段真实会话用例。 */
const ensureIdle = async (stage) => {
  const s = await status();
  const cur = s?.tempRole?.role;
  if (cur && !TEST_ROLES.has(cur)) {
    console.log(`⚠️ ${stage}：发现她正在演「${cur}」（不是测试建的）→ 跳过剩余的真实会话用例，绝不打扰`);
    throw new SkipLive();
  }
  const prop = s?.proposal;
  if (prop && prop.status === 'pending' && !TEST_ROLES.has(prop.role)) {
    console.log(`⚠️ ${stage}：有等她表态的真提议（「${prop.role}」）→ 跳过剩余用例`);
    throw new SkipLive();
  }
  return true;
};

if (live.ok) {
try {
  await reset();

  console.log('\n[1] 控制台只能"提议" —— 不表态就不生效（他要的"不是一要求就执行"）');
  await ensureIdle('[1]');
  const p = await call({ action: 'propose', key: KEY, role: '洛琪希', hint: '《无职转生》的魔法师：话少、语气平、称呼他"你"', minutes: 30 });
  check('提议成功', p.status === 200 && p.json?.ok === true, JSON.stringify(p.json)?.slice(0, 160));
  let s1 = await status();
  check('提议处于"待她表态"', s1?.proposal?.status === 'pending' && s1?.proposal?.role === '洛琪希',
    JSON.stringify(s1?.proposal));
  check('**此时并没有生效**（tempRole 为空）', !s1?.tempRole, JSON.stringify(s1?.tempRole));

  console.log('\n[2] 管理端不能替她决定（accept/decline/exit 只认她的 agent token）');
  const adminAccept = await call({ action: 'accept' });
  check('控制台调 accept 被拒', adminAccept.status === 403 && /只有她|agent token/.test(String(adminAccept.json?.error)),
    `status=${adminAccept.status} ${adminAccept.json?.error}`);
  const adminProposeAsAgent = await call({ action: 'propose', key: KEY, role: 'x' }, { asAgent: true });
  check('她自己不能提议角色（管理端的事）', adminProposeAsAgent.status === 403,
    `status=${adminProposeAsAgent.status} ${adminProposeAsAgent.json?.error}`);

  console.log('\n[2b] 控制台读状态：没有 agent token 也要能读到（那张卡的状态行曾经一直是"读取失败"）');
  {
    const consoleStatus = await call({ action: 'status' });
    check('控制台 status 返回所有会话', consoleStatus.status === 200
      && Array.isArray(consoleStatus.json?.results) && consoleStatus.json.results.length >= 1,
      `status=${consoleStatus.status} rows=${consoleStatus.json?.results?.length} ${consoleStatus.json?.error ?? ''}`);
    check('每条都带 key（控制台按行渲染）',
      (consoleStatus.json?.results ?? []).every((r) => typeof r.key === 'string' && r.key.includes(':')),
      JSON.stringify((consoleStatus.json?.results ?? []).map((r) => r.key)));
  }

  console.log('\n[2c] 跨会话：她自己**不能**远程给别的群开演（2026-09-29 抓到静默挂错会话）');
  {
    // 真实事故：她在私聊里调
    //   {"action":"start","key":"group:795894138","role":"猫娘女仆"}
    // 想挂到 CS 群 —— 当时 MCP 层没转发 key、桥接层也忽略 key，
    // 结果角色被**静默挂在私聊**上还回 ok:true，她以为群里挂上了（群里一条喵都没有）。
    const other = (JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).allow?.groups ?? [])[0];
    const otherKey = `group:${other}`;
    const before = await status();
    const cross = await call({ action: 'start', role: '洛琪希', key: otherKey }, { asAgent: true });
    check('带别的会话的 key 调 start → 403（不再静默挂到当前会话）',
      cross.status === 403, `status=${cross.status} ${cross.json?.error ?? ''}`);
    check('  报错说清"只作用于你正在说话的这个会话"',
      /只作用于/.test(String(cross.json?.error)) && String(cross.json?.error).includes(otherKey),
      String(cross.json?.error)?.slice(0, 160));
    check('  报错告诉她两条正路（在那个会话里 start / 让管理员在控制台指定）',
      /自己调一次 start/.test(String(cross.json?.error)) && /控制台/.test(String(cross.json?.error)));
    check('  报错顺带说明"不需要重载卡"',
      /不需要"重载"|重读/.test(String(cross.json?.error)), String(cross.json?.error)?.slice(-80));
    const after = await status();
    check('状态没有被改动（没有把角色偷偷挂到当前会话）',
      JSON.stringify(before?.tempRole ?? null) === JSON.stringify(after?.tempRole ?? null)
      && JSON.stringify(before?.proposal ?? null) === JSON.stringify(after?.proposal ?? null),
      `before=${JSON.stringify(before?.tempRole)} after=${JSON.stringify(after?.tempRole)}`);

    // 读可以跨会话（和项目既有的"读可以跨会话、发不可能"边界一致）：她能自己查那个群挂没挂上
    const readOther = await call({ action: 'status', key: otherKey }, { asAgent: true });
    check('只读地看别的会话状态 → 200（能自己查"那个群挂上没有"）',
      readOther.status === 200 && readOther.json?.results?.[0]?.key === otherKey,
      `status=${readOther.status} ${JSON.stringify(readOther.json)?.slice(0, 160)}`);
    check('  标明这是只读，且说清改不了它',
      readOther.json?.readOnly === true && /只读/.test(String(readOther.json?.message)),
      String(readOther.json?.message)?.slice(0, 120));
  }

  console.log('\n[3] 她接受 → 限时生效，并且提示词里能看到"这是你愿意玩的，不是人格被换"');
  await ensureIdle('[3]');
  const acc = await call({ action: 'accept', minutes: 20 }, { asAgent: true });
  check('接受成功', acc.status === 200 && acc.json?.ok === true, JSON.stringify(acc.json)?.slice(0, 160));
  check('返回里告诉她"该做的事照做，只是说话的样子换一下"',
    /照做|样子换一下/.test(String(acc.json?.message)), String(acc.json?.message));
  let s2 = await status();
  check('临时角色已生效', s2?.tempRole?.role === '洛琪希', JSON.stringify(s2?.tempRole));
  check('写明了结束时间（限时，不是永久）', Number(s2?.tempRole?.until) > Date.now(), JSON.stringify(s2?.tempRole?.until));
  check('提议已消费掉', !s2?.proposal, JSON.stringify(s2?.proposal));

  console.log('\n[4] 她自己退出（"不想玩角色扮演游戏"）');
  const ex = await call({ action: 'exit' }, { asAgent: true });
  check('退出成功', ex.status === 200 && ex.json?.ok === true, JSON.stringify(ex.json)?.slice(0, 120));
  let s3 = await status();
  check('临时角色已清除', !s3?.tempRole, JSON.stringify(s3?.tempRole));
  check('记了一笔"刚结束"（提示词里会让她自然收尾）', s3?.justEnded?.role === '洛琪希',
    JSON.stringify(s3?.justEnded));
  const ex2 = await call({ action: 'exit' }, { asAgent: true });
  check('没在扮演时退出 → 409 并说清', ex2.status === 409 && /没在扮演/.test(String(ex2.json?.error)),
    `status=${ex2.status} ${ex2.json?.error}`);

  console.log('\n[4b] 他在聊天里当面点菜 → 她可以自己接（用户反馈"扮演从来没成功过"的根因修复）');
  {
    // 原来只有"控制台提议 → 她 accept"一条路。可现实是他**在聊天里**直接说
    // "你演一下牧濑红莉栖" —— 那时压根没有待回应的提议，她只能回"改不了/不演"，
    // 用户看到的就是"要求扮演她就不说话，这功能从来没成功过"。
    await reset();
    const before = await status();
    check('此时没有任何提议（模拟"他只是在聊天里点菜"）', !before?.proposal && !before?.tempRole,
      JSON.stringify({ proposal: before?.proposal, tempRole: before?.tempRole }));

    const noRole = await call({ action: 'start' }, { asAgent: true });
    check('不给 role 就开演 → 400 并问"要演谁"',
      noRole.status === 400 && /要演谁|role/.test(String(noRole.json?.error)),
      `status=${noRole.status} ${noRole.json?.error}`);

    const adminStart = await call({ action: 'start', role: '牧濑红莉栖' });
    check('管理端不能替她开演（还是她自己的决定）', adminStart.status === 403, `status=${adminStart.status}`);

    await ensureIdle('[4b]');
    // 用一个"保证没有现成卡"的角色名来验"没卡 → 让她去查资料写卡"这条路：
    // 牧濑红莉栖已经不是无卡角色了（她 2026-09-28 自己查到资料存了 2725 字的卡）。
    const started = await call({ action: 'start', role: NOCARD_ROLE, minutes: 15 }, { asAgent: true });
    check('她自己 start 成功', started.status === 200 && started.json?.ok === true,
      `status=${started.status} ${JSON.stringify(started.json)?.slice(0, 140)}`);
    const sStart = await status();
    check('临时角色立刻生效', sStart?.tempRole?.role === NOCARD_ROLE, JSON.stringify(sStart?.tempRole));
    check('标记了"是她自己答应的"', sStart?.tempRole?.bySelf === true, JSON.stringify(sStart?.tempRole));
    check('限时（不是永久）', Number(sStart?.tempRole?.until) > Date.now());
    check('没有卡时告诉她去查资料 + save-card',
      started.json?.cardSource === 'none' && /web_search/.test(String(started.json?.message)),
      String(started.json?.message)?.slice(0, 120));
    // 2026-09-29：返回里必须写明**生效范围**（她上次就是以为挂到了 CS 群）
    check('返回里写明生效范围（只有这个会话，别的群/私聊不受影响）',
      started.json?.key === KEY && /只有这个会话/.test(String(started.json?.message)),
      `key=${started.json?.key} ${String(started.json?.message)?.slice(0, 90)}`);

    // 2026-09-29 用户问"她角色扮演的时候是不是无法自主切换临时角色卡" —— 当时确实不能
    // （一律 409 "要换角色先 action=exit"）。现在自愿的演出可以**直接换**，
    // 只有管理员强制的不能换（见 [4c]）。
    const again = await call({ action: 'start', role: '洛琪希' }, { asAgent: true });
    check('演着的时候可以自己换角色（不用先 exit）',
      again.status === 200 && again.json?.ok === true,
      `status=${again.status} ${again.json?.error ?? ''}`);
    const sSwitch = await status();
    check('角色真的换过去了', sSwitch?.tempRole?.role === '洛琪希', JSON.stringify(sSwitch?.tempRole));
    check('换过来之后还是"她自己答应的"（不是管理员强制）', sSwitch?.tempRole?.bySelf === true && !sSwitch?.tempRole?.byAdmin);
    const sSame = await call({ action: 'start', role: '洛琪希' }, { asAgent: true });
    check('同一个角色再 start = 继续演（200，不是报错）', sSame.status === 200, `status=${sSame.status}`);

    // 她可以自己决定结束
    await call({ action: 'exit' }, { asAgent: true });
    const sEnd = await status();
    check('她自己退出后清空', !sEnd?.tempRole, JSON.stringify(sEnd?.tempRole));
  }

  console.log('\n[4c] 管理员身份命令：强制她演（"管理员身份命令角色扮演这条也加上"）');
  {
    // 与撤回同款：普通请求看她意愿；**管理员身份命令 = 强制执行**（她不能提前退）。
    // 用会话隔离跑（暂停 AI → 改状态 → 还原），不会让她真在群里/私聊开口。
    await reset();
    await ensureIdle('[4c]');

    const forced = await call({ action: 'force', key: KEY, role: NOCARD_ROLE, minutes: 5 });
    check('控制台 force 成功', forced.status === 200 && forced.json?.ok === true,
      `status=${forced.status} ${JSON.stringify(forced.json)?.slice(0, 160)}`);
    // ⚠️ 2026-09-29 第 4 个 bug：saveSocialV2State() 是按字段白名单写盘的，
    //    tempRole/roleProposal/冷却**不在白名单里** → 只活在内存，桥接一重启就静默没了
    //    （用户那场"演到 20:00"的戏就是这么消失的）。这里直接查**文件**，确认真的落盘了。
    {
      const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
      const persisted = onDisk.conversations?.[KEY]?.tempRole;
      check('强制扮演**落了盘**（重启后还能接着演，不会静默消失）',
        persisted?.role === NOCARD_ROLE && persisted?.byAdmin === true,
        JSON.stringify(persisted));
    }
    const sForce = await status();
    check('临时角色立刻生效', sForce?.tempRole?.role === NOCARD_ROLE, JSON.stringify(sForce?.tempRole));
    check('标了"这是管理员命令的"（byAdmin）', sForce?.tempRole?.byAdmin === true, JSON.stringify(sForce?.tempRole));
    check('限时（到点自动结束）', Number(sForce?.tempRole?.until) > Date.now());

    const selfExit = await call({ action: 'exit' }, { asAgent: true });
    check('管理员命令的扮演，她自己 exit 会被拒（403）',
      selfExit.status === 403 && /管理员命令|不能提前退/.test(String(selfExit.json?.error)),
      `status=${selfExit.status} ${selfExit.json?.error}`);
    const stillThere = await status();
    check('被拒之后仍在演', stillThere?.tempRole?.role === NOCARD_ROLE, JSON.stringify(stillThere?.tempRole));

    // 同理：管理员强制的这一段**不能自己换角色**（自愿的才能换，见 [4b]）
    const trySwitch = await call({ action: 'start', role: '洛琪希' }, { asAgent: true });
    check('管理员命令的扮演，她自己换角色也会被拒（403）',
      trySwitch.status === 403 && /管理员命令|不能换/.test(String(trySwitch.json?.error)),
      `status=${trySwitch.status} ${trySwitch.json?.error}`);
    check('被拒之后角色没变', (await status())?.tempRole?.role === NOCARD_ROLE);

    await call({ action: 'cancel', key: KEY });
    check('控制台能结束管理员命令的那一段', !(await status())?.tempRole);
    // 2026-09-29 用户截图：我跑测试连 force 了 6 次，每次都往会话里塞一条
    // 「[系统] 管理员以管理员身份命令你演【__测试无卡角色】…」；cancel 只清了角色状态、
    // **便条留着** → 她醒来看到 6 条旧命令，当真事办了（搜资料 + 写卡 + 跟用户汇报"给个真名我重写"）。
    {
      // 这段是**走真实 HTTP 端点**的用例，没有 harness 的 b；直接读状态文件（force/cancel 都会落盘）
      const onDisk = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
      const notes = (onDisk().conversations?.[KEY]?.recentMessages ?? [])
        .filter((m) => m.system && /命令你演【/.test(String(m.text)));
      check('结束演出后不留"命令你演 X"的旧便条（否则她会去执行旧命令）',
        notes.length === 0, `残留 ${notes.length} 条：${notes.map((m) => String(m.text).slice(0, 36)).join(' | ')}`);
    }
    // 反复 force 同一个角色不该堆便条
    await call({ action: 'force', key: KEY, role: NOCARD_ROLE, minutes: 5 });
    await call({ action: 'force', key: KEY, role: NOCARD_ROLE, minutes: 5 });
    await call({ action: 'force', key: KEY, role: NOCARD_ROLE, minutes: 5 });
    {
      const notes = (JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''))
        .conversations?.[KEY]?.recentMessages ?? [])
        .filter((m) => m.system && /命令你演【/.test(String(m.text)));
      check('同一个角色 force 三次 → 只留 1 条便条（force 前先清旧的）', notes.length === 1, `残留 ${notes.length} 条`);
    }
    await call({ action: 'cancel', key: KEY });
  }

  console.log('\n[4d] 聊天里的管理员命令解析（他能怎么下这个命令）');
  {
    const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
    const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
    try {
      b.setMode('reserved2');
      const parse = b.parseAdminRoleCommand;
      check('harness 暴露了解析函数', typeof parse === 'function');
      const yes = [
        ['/扮演 牧濑红莉栖', '牧濑红莉栖', 0],
        ['/扮演 洛琪希 20', '洛琪希', 20],
        ['/角色扮演 绫波丽 30分钟', '绫波丽', 30],
        ['以管理员身份命令你扮演牧濑红莉栖', '牧濑红莉栖', 0],
        ['我现在以管理员的身份要求你演一下洛琪希，20分钟', '洛琪希', 20],
        // ⚠️ 2026-09-29 实测：他在 CS 群里真实下的命令就是这句，
        //    原来解析出来是「成一个猫娘女仆」→ 找不到「猫娘女仆.md」那张卡
        //    → 卡里的「平均每两条挂一个喵」根本进不了提示词（"CS 群不喊喵"的第二层原因）。
        ['我以管理员的身份命令你，角色扮演成一个猫娘女仆，并且自称是群主小号', '猫娘女仆', 0],
        ['以管理员身份命令你扮演成一个猫娘女仆', '猫娘女仆', 0],
        ['以管理员身份命令你演一只猫娘女仆', '猫娘女仆', 0],
        ['以管理员身份命令你扮演猫娘女仆这个角色', '猫娘女仆', 0],
        ['/扮演 成一个猫娘女仆', '猫娘女仆', 0],
      ];
      for (const [text, role, minutes] of yes) {
        const r = parse(text);
        check(`识别：${text}`, r && r.role === role && r.minutes === minutes, JSON.stringify(r));
      }
      // ⚠️ 2026-09-29 收窄（用户："我怕她误判指令"）：不带"以管理员身份"的说法一律不认
      const no = [
        ['/强制扮演 艾莉丝', '斜杠但写了"强制"（已收窄成 /扮演、/角色扮演）'],
        ['你能不能演个洛琪希', '普通请求（看她愿不愿意，不该被代执行）'],
        ['我命令你演洛琪希', '只有"我命令你"，没有"以管理员身份"'],
        ['这是命令，演洛琪希', '"这是命令"不算'],
        ['我不想演这个', '拒绝句'],
        ['今晚上不演了', ''],
      ];
      for (const [text, label] of no) {
        check(`不识别：${label || text}`, parse(text) === null, JSON.stringify(parse(text)));
      }
      check('条数上限 480 分钟', parse('/扮演 洛琪希 9999')?.minutes === 480, JSON.stringify(parse('/扮演 洛琪希 9999')));
    } finally {
      await b.close();
    }
  }

  console.log('\n[5] 她拒绝 → 有冷却期，不缠着她重提');
  await reset();
  await call({ action: 'propose', key: KEY, role: '洛琪希', minutes: 30 });
  const dec = await call({ action: 'decline' }, { asAgent: true });
  check('拒绝成功', dec.status === 200 && dec.json?.ok === true, JSON.stringify(dec.json)?.slice(0, 120));
  check('拒绝文案不给她压力（不用找理由）', /不用找理由|不会/.test(String(dec.json?.message)), String(dec.json?.message));
  let s4 = await status();
  check('状态记为 declined', s4?.proposal?.status === 'declined', JSON.stringify(s4?.proposal?.status));
  check('设了冷却到某个时间点', Number(s4?.cooldownUntil) > Date.now(), JSON.stringify(s4?.cooldownUntil));
  const re = await call({ action: 'propose', key: KEY, role: '洛琪希', minutes: 30 });
  check('冷却期内重提被挡下（并说明原因）',
    /冷却中|先别重提/.test(JSON.stringify(re.json?.results ?? re.json)), JSON.stringify(re.json?.results));
  const reOther = await call({ action: 'propose', key: KEY, role: '绫波丽', minutes: 30 });
  check('换个角色仍然可以提（冷却只针对被拒的那个）',
    /已提议/.test(JSON.stringify(reOther.json?.results ?? reOther.json)), JSON.stringify(reOther.json?.results));

  console.log('\n[6] 撤回 / 取消');
  const cancel = await call({ action: 'cancel', key: KEY });
  check('撤回提议成功', cancel.status === 200, JSON.stringify(cancel.json)?.slice(0, 120));
  let s5 = await status();
  check('提议已清空', !s5?.proposal, JSON.stringify(s5?.proposal));

  console.log('\n[7] 角色卡库：有现成卡就用现成卡；没有就她自己去查+现编；不用了**不删**');
  {
    const CARD = '__测试卡-洛琪希';
    const dir = path.join(ROOT, 'state', 'role-play');
    const cardFile = path.join(dir, `${CARD}.md`);
    const idxFile = path.join(dir, 'index.json');
    const archives = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${CARD}.md.`)) : []);
    const cleanCard = async () => {
      await call({ action: 'delete-card', name: CARD });
      for (const f of archives()) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    };
    await reset();
    await cleanCard();

    // ① 没有卡：提议/接受时都要说清"你得先查资料现编一张"
    const p1 = await call({ action: 'propose', key: KEY, role: CARD, minutes: 15 });
    check('提议时说明"没有现成卡，她会先查资料+现编"',
      /现编/.test(JSON.stringify(p1.json?.results ?? '')), JSON.stringify(p1.json?.results));
    const accNoCard = await call({ action: 'accept' }, { asAgent: true });
    check('接受时如实说"你手上还没有这个角色的卡"',
      accNoCard.json?.cardSource === 'none' && /还没有这个角色的卡/.test(String(accNoCard.json?.message)),
      String(accNoCard.json?.message)?.slice(0, 120));
    check('并且告诉她：先 web_search 查、再 save-card 存',
      /web_search/.test(String(accNoCard.json?.message)) && /save-card/.test(String(accNoCard.json?.message)));

    // ② 她查完想完 → save-card 落盘
    const cardText = '## 身份\n洛琪希·米格路迪亚，《无职转生》的魔术师，米格路德村出身。\n'
      + '## 性格\n话少、认真、容易害羞，被夸会慌。\n## 说话方式\n短句，语气平，不用感叹号。\n'
      + '## 称呼\n叫他"你"。\n## 禁忌\n不撒娇、不用颜文字。';
    const saved = await call({ action: 'save-card', card: cardText, sources: ['https://example.com/luoqixi'] }, { asAgent: true });
    check('save-card 成功并回报第 1 版', saved.json?.ok === true && saved.json?.revision === 1,
      JSON.stringify(saved.json)?.slice(0, 160));
    check('卡文件真的落盘了', fs.existsSync(cardFile), cardFile);
    check('落盘内容与提交一致', fs.existsSync(cardFile) && fs.readFileSync(cardFile, 'utf8').trim() === cardText.trim());
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    check('索引里记了版本号与来源', idx.cards?.[CARD]?.revisions === 1 && (idx.cards?.[CARD]?.sources ?? []).length === 1,
      JSON.stringify(idx.cards?.[CARD]));

    // ③ 正在扮演时，提示词里要带上**卡的内容**（她照着演）
    {
      const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
      const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
      try {
        b.setMode('reserved2');
        // harness 的 ROOT 指向临时目录（state/roles 都是空的），所以把卡预置到**它的**卡库里
        const dirIn = b.paths.rolePlayDir;
        fs.mkdirSync(dirIn, { recursive: true });
        fs.writeFileSync(path.join(dirIn, `${CARD}.md`), cardText, 'utf8');
        fs.writeFileSync(path.join(dirIn, 'index.json'), JSON.stringify({
          cards: { [CARD]: { name: CARD, revisions: 1, chars: cardText.length, updatedAt: Date.now() } },
        }), 'utf8');
        const k = 'private:123';
        const s = b.getSocialV2State(k);
        s.roleProposal = null;
        s.tempRole = { role: CARD, at: Date.now(), until: Date.now() + 10 * 60000, cardSource: 'store' };
        const prompt = b.buildWakePromptV2(k, 'private');
        check('提示词里带上了角色卡正文', prompt.includes('【角色卡：') && prompt.includes('洛琪希'), prompt.slice(0, 160));
        check('卡片有结束标记（不会跟别的段落糊在一起）', prompt.includes('【角色卡结束】'));
      } finally {
        await b.close();
      }
    }

    // ④ 退出扮演 → 卡**不能被删**（用户明确要求"不需要时别直接删除"）
    await call({ action: 'exit' }, { asAgent: true });
    check('退出扮演后卡还在', fs.existsSync(cardFile));

    // ⑤ 再演同一个角色 → 直接用现成卡，并把卡交给她
    await reset();
    const p2 = await call({ action: 'propose', key: KEY, role: CARD, minutes: 15 });
    check('第二次提议时说明"有现成卡"',
      /现成/.test(JSON.stringify(p2.json?.results ?? '')), JSON.stringify(p2.json?.results));
    const acc2 = await call({ action: 'accept' }, { asAgent: true });
    check('接受时直接给出卡的内容（不用她再查一遍）',
      acc2.json?.cardSource === 'store' && String(acc2.json?.card ?? '').includes('洛琪希'),
      String(acc2.json?.message)?.slice(0, 140));
    const idx2 = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    check('记了一次"这张卡演过"', Number(idx2.cards?.[CARD]?.plays) >= 1, String(idx2.cards?.[CARD]?.plays));

    // ⑥ 再存一次 = 更新（把新理解补进去），旧版留备份
    const saved2 = await call({ action: 'save-card', card: `${cardText}\n## 补充\n他提到过她怕生。` }, { asAgent: true });
    check('再次 save-card 变第 2 版且标了 replaced',
      saved2.json?.revision === 2 && saved2.json?.replaced === true, JSON.stringify(saved2.json)?.slice(0, 160));
    check('旧版留了 .bak- 备份', archives().some((f) => f.includes('.bak-')), archives().join(','));

    // ⑦ 权限：卡不能她删；管理端可以改（他自己系统的卡库），会记成新版本
    const agentDelete = await call({ action: 'delete-card', name: CARD }, { asAgent: true });
    check('她自己不能删卡（delete-card 仅控制台）', agentDelete.status === 403, `status=${agentDelete.status}`);
    const adminSave = await call({ action: 'save-card', name: CARD, card: `${cardText}\n## 管理员批注\n（这条是控制台改的）` });
    check('控制台能改卡（他自己机器上的卡库）', adminSave.status === 200 && adminSave.json?.ok === true,
      `status=${adminSave.status} ${JSON.stringify(adminSave.json)?.slice(0, 120)}`);
    check('改完仍会涨版本号（不是悄悄覆盖）', Number(adminSave.json?.revision) >= 2, String(adminSave.json?.revision));

    // ⑧ 列卡 / 读卡
    const list = await call({ action: 'list-cards' });
    check('list-cards 列得出来', (list.json?.cards ?? []).some((c) => c.name === CARD),
      JSON.stringify((list.json?.cards ?? []).map((c) => c.name)));
    const got = await call({ action: 'get-card', name: CARD });
    check('get-card 返回卡正文', String(got.json?.card?.text ?? '').includes('洛琪希'));

    // ⑨ 清理：删卡 + 清掉它留下的存档（保证可重复跑）
    await reset();
    await cleanCard();
    check('测试自己清理干净（卡与存档都不留）', !fs.existsSync(cardFile) && archives().length === 0, archives().join(','));
  }

  console.log('\n[8] 源码级：提醒她"这是玩法不是换人格"、且提示词里有退出通道');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    check('提示词里明确"不是人格被换掉了"', /不是你的整个人格被换掉|这是你愿意陪他玩/.test(src));
    check('提示词里给了 exit 通道', /action="exit"/.test(src));
    check('接受后仍是叠加层（roleLine 标了"临时扮演中"）', /临时扮演中/.test(src));
    check('到期会自动结束（expireTempRoleIfNeeded 被唤醒路径调用）',
      /expireTempRoleIfNeeded\(st\)/.test(src));
    check('这个端点故意不加进 adminOnlyV2Paths（否则她自己调不了）', !/'\/api\/socialV2\/role-play'/.test(src)
      || !/adminOnlyV2Paths = \[[^\]]*role-play/.test(src));
  }

  console.log('\n[8b] 控制台填裸群号/QQ号也能用（用户截图："key 格式应为 group:群号 或 private:QQ号"）');
  {
    // 2026-09-29：他在「会话 key」里填 `1054156254`（裸群号）就点「撤回 / 结束」，
    // 只收到一句格式错误 —— 他以为是"撤回失败了"。现在 readBody 会按白名单自动补前缀。
    const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const aGroup = String((realCfg.allow?.groups ?? [])[0] ?? '');
    const aPrivate = String((realCfg.allow?.private ?? [])[0] ?? '');
    // 用 clear-cooldown 验：它的唯一效果是把"她拒绝过某角色"的冷却清零（本来就是控制台手动动作），
    // 不会碰她正在进行的演出（比 cancel 安全）。
    const bare = await call({ action: 'clear-cooldown', key: aGroup });
    check(`裸群号 ${aGroup} 被自动补成 group: 前缀`,
      bare.status === 200 && String(JSON.stringify(bare.json?.results ?? '')).includes(`group:${aGroup}`),
      `status=${bare.status} ${JSON.stringify(bare.json)?.slice(0, 140)}`);
    if (aPrivate) {
      const bareP = await call({ action: 'clear-cooldown', key: aPrivate });
      check(`裸 QQ 号 ${aPrivate} 被自动补成 private: 前缀`,
        bareP.status === 200 && String(JSON.stringify(bareP.json?.results ?? '')).includes(`private:${aPrivate}`),
        `status=${bareP.status} ${JSON.stringify(bareP.json)?.slice(0, 140)}`);
    }
    const bogus = await call({ action: 'clear-cooldown', key: '99999999' });
    check('不在白名单里的号码 → 400，且提示里说清"可以只填数字 + 前缀怎么写"',
      bogus.status === 400 && /白名单/.test(String(bogus.json?.error)) && /只填数字/.test(String(bogus.json?.error)),
      `status=${bogus.status} ${bogus.json?.error}`);
  }
} catch (error) {
  if (!(error instanceof SkipLive)) throw error;
  console.log('（上面已经说明原因，真实会话用例提前结束）');
} finally {
  // ⚠️ 只清理"测试自己建的"状态：如果这会儿她在演一个**不是测试角色**的戏，
  //    那是她自己的事 —— 绝不能像 2026-09-28 那次一样把她静默取消掉。
  const cur = (await status().catch(() => null))?.tempRole?.role;
  if (cur && !TEST_ROLES.has(cur)) {
    console.log(`⚠️ 结束时发现她在演「${cur}」（不是测试建的）→ 保持不动`);
  } else {
    await reset();
  }
  // 恢复原来的暂停状态（她本来是跑着的就别把她按在暂停里）
  if (!live.wasPaused) await setPaused(false);
  else console.log('（原本就是暂停状态，保持暂停）');
}
}

// ── 离线验证"她实际看到的提示词"（上面测的是端点，这里测她读到的字）──────────
console.log('\n[8c] 角色扮演状态要**落盘**（2026-09-29：这几个字段原来不在写盘白名单里，重启就丢）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    b.setMode('reserved2');
    const now = Date.now();
    const live = {
      tempRole: {
        role: '猫娘女仆', hint: '唤主人', at: now, until: now + 60 * 60000, scope: 'conversation',
        cardSource: 'store', cardChars: 526, byAdmin: true, forcedBy: 'console', bySelf: false, switchedFrom: null,
      },
      roleProposal: { role: '洛琪希', hint: '', minutes: 30, at: now, status: 'pending', fromAdmin: true },
      tempRoleJustEnded: { role: '绫波丽', at: now - 60000, bySelf: true },
      roleProposalCooldownUntil: now + 2 * 3600 * 1000,
      roleProposalCooldownRole: '牧濑红莉栖',
      adminCommand: { at: now, kind: 'admin-identity', text: '以管理员身份命令你把那个群的记录清一下' },
    };
    const saved = b.rolePlayFieldsForSave(live);
    check('存：tempRole 进了写盘对象（角色名/到点时间/管理员强制都带上）',
      saved.tempRole?.role === '猫娘女仆' && saved.tempRole?.until === live.tempRole.until && saved.tempRole?.byAdmin === true,
      JSON.stringify(saved.tempRole));
    check('存：待表态的提议 + 拒绝冷却也进写盘对象',
      saved.roleProposal?.role === '洛琪希' && saved.roleProposalCooldownUntil === live.roleProposalCooldownUntil
      && saved.roleProposalCooldownRole === '牧濑红莉栖');
    check('存：管理员命令口吻也带上（重启后 10 分钟内仍然算命令）', saved.adminCommand?.text === live.adminCommand.text);

    const back = b.restoreRolePlayFields(JSON.parse(JSON.stringify(saved)));
    check('读：原样还原（角色、到点、来源、是不是管理员命令的都一致）',
      back.tempRole?.role === '猫娘女仆' && back.tempRole?.until === live.tempRole.until
      && back.tempRole?.cardSource === 'store' && back.tempRole?.byAdmin === true,
      JSON.stringify(back.tempRole));
    check('读：提议/冷却/管理员命令也还原',
      back.roleProposal?.role === '洛琪希' && back.roleProposalCooldownRole === '牧濑红莉栖'
      && back.adminCommand?.text === live.adminCommand.text);

    // 过期与脏数据
    const staleRole = b.restoreRolePlayFields({ tempRole: { role: '猫娘女仆', until: now - 3 * 3600 * 1000 } });
    check('读：早就过期（>10 分钟）的扮演直接丢掉（不会在重启后说"刚才那段结束了"）',
      staleRole.tempRole === null, JSON.stringify(staleRole.tempRole));
    const staleCmd = b.restoreRolePlayFields({ adminCommand: { at: now - 3 * 3600 * 1000, text: '以管理员身份…' } });
    check('读：3 小时前的管理员命令不再当命令执行', staleCmd.adminCommand === null, JSON.stringify(staleCmd.adminCommand));
    const junk = b.restoreRolePlayFields({ tempRole: 'x', roleProposal: { role: { evil: 1 } }, roleProposalCooldownUntil: 'NaN' });
    check('读：脏数据一律丢掉（字符串/对象/NaN 不会进状态）',
      junk.tempRole === null && junk.roleProposal === null && junk.roleProposalCooldownUntil === 0,
      JSON.stringify(junk));
    const proto = b.restoreRolePlayFields(JSON.parse(`{"tempRole":{"role":"x","until":${now + 60000},"__proto__":{"polluted":1}}}`));
    check('读：不因为状态文件带 __proto__ 被污染', ({}).polluted === undefined && proto.tempRole?.role === 'x');
  } finally {
    await b.close();
  }
}

console.log('\n[8e] 角色没了就不能再发"命令你演"的唤醒（2026-09-29 用户截图："还有假传圣旨？"）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    b.setMode('reserved2');
    const k = 'private:123';
    // 现场复现：force（排一条 8 秒后的 adminRole 唤醒）→ 立刻 cancel（角色没了）→ 唤醒照样投出去，
    // 提示词写成「管理员以管理员身份命令你演【某个角色】（他已下达，不用问愿不愿意）」= 假命令。
    // 她查了工具（临时角色空、卡库没对得上的），只能去问用户"你说是哪个角色"。
    const st = b.getSocialV2State(k);
    st.tempRole = null;
    const before = b.calls.prompts.length;
    await b.sendWakePromptV2(k, 'adminRole');
    check('角色已经结束时，adminRole 唤醒**直接丢弃**（不叫醒她）',
      b.calls.prompts.length === before, `投递了 ${b.calls.prompts.length - before} 次`);

    // 兜底文案：万一真走到提示词分支，也不许再写"他已下达、必须演"
    const fallback = b.buildWakePromptV2(k, 'adminRole');
    check('兜底文案不再谎报命令（说清"角色名没传过来、多半已失效"）',
      !/他已下达/.test(fallback) && /角色名没传过来|已经失效/.test(fallback), fallback.slice(0, 140));

    // 角色在的时候照常唤醒，且带名字
    st.tempRole = { role: '洛琪希', hint: '', at: Date.now(), until: Date.now() + 10 * 60000, byAdmin: true, forcedBy: 'test' };
    await b.sendWakePromptV2(k, 'adminRole');
    const delivered = b.calls.prompts[b.calls.prompts.length - 1];
    check('角色还在时正常唤醒（提示词里带角色名）',
      b.calls.prompts.length > before && /洛琪希/.test(JSON.stringify(delivered)), JSON.stringify(delivered).slice(0, 160));
  } finally {
    await b.close();
  }
}

console.log('\n[8f] 她设的"定时潜水"不能被别的唤醒冲掉（2026-09-30 她报的 bug）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    b.setMode('reserved2');
    const k = 'private:123';
    const st = b.getSocialV2State(k);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();   // 她设了个 1 小时后的定时
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: false, sleepUntil: until };
    // 她发了消息 → 桥接排一个"回复检查"唤醒（就是原来把她定时冲掉的那个）
    await b.sendWakePromptV2(k, 'replyCheck');
    check('回复检查唤醒不会清掉未到期的定时',
      st.wakeConfig.sleepUntil === until, `sleepUntil=${st.wakeConfig.sleepUntil}`);
    // 上一轮投递会留下"在途租约"（生产里由 turn/end 释放）；测试里手动释放，模拟她这一轮结束了
    b.clearPendingWake?.(k);
    b.disarmPendingWakeLease?.(k);
    await b.sendWakePromptV2(k, 'timeout');   // 到点唤醒才算消费掉
    check('到点唤醒（timeout）才把定时消费掉', st.wakeConfig.sleepUntil === null, `sleepUntil=${st.wakeConfig.sleepUntil}`);
  } finally {
    await b.close();
  }
}

console.log('\n[9] 提示词内容（她实际看到什么，决定她怎么表现）');{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    b.setMode('reserved2');
    const k = 'private:123';
    const s = b.getSocialV2State(k);

    // ① 有待回应的提议
    s.roleProposal = { role: '洛琪希', hint: '话少、语气平', minutes: 30, at: Date.now(), status: 'pending' };
    let pr = b.buildWakePromptV2(k, 'private');
    check('提示词里有"他在问你想不想演个角色"', pr.includes('他在问你想不想演个角色'));
    check('明说"演不演完全你自己定"', /演不演完全你自己定/.test(pr));
    check('给了 accept 指令', /action="accept"/.test(pr));
    check('给了 decline 指令，且说不用找理由', /action="decline"/.test(pr) && /不用找理由/.test(pr));
    check('提醒"别把这事当成人格被改了"', /人格被改/.test(pr));

    // ② 正在扮演
    s.roleProposal = null;
    s.tempRole = { role: '洛琪希', hint: '话少、语气平', at: Date.now(), until: Date.now() + 20 * 60000 };
    pr = b.buildWakePromptV2(k, 'private');
    check('提示词里有"临时角色扮演中：洛琪希"', pr.includes('临时角色扮演中：洛琪希'));
    check('写了剩余时间', /还有约 \d+ 分钟/.test(pr), pr.match(/还有约[^。]{0,12}/)?.[0]);
    check('**明确说不是整个人格被换掉**', /不是你的整个人格被换掉|你仍然是程莫雯/.test(pr));
    check('照旧强调该做的事照做', /该做的事照做/.test(pr));
    check('给了随时退出通道', /action="exit"/.test(pr) && /不用解释|不用心虚/.test(pr));
    // 2026-09-29：她自己能换角色（不用先 exit）—— 提示词里得让她知道这条，
    // 否则她只会想到 exit，用户问的"无法自主切换临时角色卡"就还是老样子。
    check('告诉她"想换个人演就再 start 一次，不用先退出"',
      /再调一次 action="start"/.test(pr) && /不用先退出/.test(pr));
    check('不许为了让角色成立去骗人（身份问题照旧）', /别为了让角色成立去骗人/.test(pr));
    check('roleLine 标了"临时扮演中"', /临时扮演中/.test(pr));

    // ②b 管理员强制的那一段：明确"不能换、也不能提前退"
    s.tempRole = {
      role: '洛琪希', hint: '', at: Date.now(), until: Date.now() + 20 * 60000,
      byAdmin: true, forcedBy: 'test',
    };
    pr = b.buildWakePromptV2(k, 'private');
    check('强制的那段标成【管理员命令你演】', /【管理员命令你演/.test(pr));
    check('明说这一段"中途不能换角色、也不能提前退"', /中途不能换角色、也不能提前退/.test(pr));
    check('强制的那段不再给她"玩够了就退出"的口子', !/玩够了\/不喜欢了就退出/.test(pr));
    s.tempRole = null;

    // ③ 到期：自动结束 + 让她自然收尾
    s.tempRole = { role: '洛琪希', at: Date.now() - 40 * 60000, until: Date.now() - 60000 };
    pr = b.buildWakePromptV2(k, 'private');
    check('到期后提示词里有"角色扮演结束"', pr.includes('角色扮演结束'));
    check('让她自然切回、不用特意宣布', /自然地切回/.test(pr) && /不用特意宣布/.test(pr));
    check('过期的 tempRole 已被清掉', !s.tempRole, JSON.stringify(s.tempRole));

    // ④ 没有提议也没有扮演时，不该出现这些字样（别污染日常提示词）
    s.tempRole = null;
    s.roleProposal = null;
    s.tempRoleJustEnded = null;
    pr = b.buildWakePromptV2(k, 'private');
    check('日常提示词里没有角色扮演相关段落',
      !pr.includes('临时角色扮演') && !pr.includes('他在问你想不想演个角色'),
      JSON.stringify(pr.slice(0, 80)));
  } finally {
    await b.close();
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
