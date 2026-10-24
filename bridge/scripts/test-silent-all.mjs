/**
 * 回归：**全局静默**（2026-10-02 管理员：「全局静默用不了，我也不能远程让她关了」）。
 *
 * 现场：他在私聊说「开群聊静默」，她回「行，群聊我先闭嘴」，然后**3 分钟内在 CS 群又接了 4 条**
 *   （他最后说"我求你了"）。查下来她**根本没有能执行的手段**：
 *   ① 在群里改唤醒条件（想关掉提问/概率）→ 被"沉睡前观察"闸门拦（400，实测 18:02）；
 *   ② 在私聊改**群**的唤醒条件 → 被跨会话限制拦（403，"修改只能在本会话内执行"，实测 19:52）。
 *   而老的"静默模式"（roleState.mode==='silent'）**只在老模式的自动转发路径上生效**，
 *   reserved2 里她是用工具发的 —— 那个闸门永远不触发。
 *
 * 现在：桥接层硬开关 `socialV2.silentAll`
 *   • 开启后所有群**发不出去**（发消息/分条/拍一拍/表情四个端点全拦）、**也不再唤醒她**（省 token）；
 *   • 管理员私聊照常（他得能说话、才能解禁）；
 *   • 管理员在 QQ 私聊里说「全局静默」/「解除静默」→ **桥接直接执行**（不靠模型听话），回复发他私聊。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');

const GKEY = 'group:456';
const PKEY = 'private:123';   // harness 的 ownerQQ = 123

async function mkServer() {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  h.setMode('reserved2');
  const post = (p, body) => new Promise((resolve, reject) => {
    const token = h.getSocialV2State(String(body?.key ?? ''))?.agentToken ?? '';
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(9000, () => req.destroy(new Error('接口没响应')));
    req.end(JSON.stringify(body));
  });
  return { h, post, close: async () => { await new Promise((r) => server.close(r)); await h.close(); } };
}

console.log('\n[1] 解析命令：中文怎么说都认，误判要少');
{
  const { h, close } = await mkServer();
  try {
    const parse = h.parseSilenceCommand;
    for (const t of ['全局静默', '开全局静默', '所有群都静默', '群里都别说话了', '静默', '全体静默吧'])
      check(`认「${t}」= 开`, parse(t) === 'on', String(parse(t)));
    for (const t of ['解除静默', '关闭静默', '静默关掉', '取消全局静默', '可以说话了', '别静默了'])
      check(`认「${t}」= 关`, parse(t) === 'off', String(parse(t)));
    for (const t of ['cs群的暂时也别说吧', '今天好累', '静默是什么意思', '你吃饭了吗', '这游戏怎么静默不了啊真的假的啊啊啊'])
      check(`不误判「${t}」`, parse(t) === null, String(parse(t)));
  } finally { await close(); }
}

console.log('\n[2] 开启后：群里四个发送端点全拦，管理员私聊照常');
{
  const { h, post, close } = await mkServer();
  try {
    h.setSilentAll(true, '测试');
    const g1 = await post('/api/socialV2/send-message', { key: GKEY, messages: '我在群里说一句' });
    const g2 = await post('/api/socialV2/send-burst', { key: GKEY, messages: ['a', 'b'] });
    const g3 = await post('/api/socialV2/send-poke', { key: GKEY, targetUserId: 999 });
    const g4 = await post('/api/socialV2/send-sticker', { key: GKEY, stickerId: 'fixture-sticker' });
    for (const [label, r] of [['发消息', g1], ['分条发', g2], ['拍一拍', g3], ['表情', g4]]) {
      check(`群里${label}被拦（403）`, r.status === 403, JSON.stringify(r).slice(0, 160));
    }
    check('错误里说清是"全局静默"、并且别重试', /全局静默/.test(g1.json?.error ?? '') && /别重试/.test(g1.json?.error ?? ''));
    const p1 = await post('/api/socialV2/send-message', { key: PKEY, messages: '私聊还能说话' });
    check('管理员私聊不受影响', p1.status === 200 && p1.json?.ok === true, JSON.stringify(p1).slice(0, 160));
    check('群里一条都没真发出去（OneBot 那边收不到）', (h.calls.sent ?? []).filter((s) => s.kind === 'group').length === 0, JSON.stringify(h.calls.sent ?? []));
    // 预检（check-send）必须和真发送同一套判据：2026-10-02 实测它当时照样回 200「放行」，
    // 而真发送 403 —— 她会以为能发、试一次、被拒，然后在"别重试"和"预检说可以"之间打转。
    const agent = h.getSocialV2State(GKEY)?.agentToken;
    const dry = await post('/api/socialV2/check-send', { key: GKEY, tool: 'sendGroup', token: agent });
    check('静默时**预检**也拦住（403，不能"预检说可以、真发被拒"）', dry.status === 403, JSON.stringify(dry).slice(0, 200));
    check('预检的文案就是那条能照做的静默说明', /全局静默/.test(dry.json?.error ?? '') && /解除静默/.test(dry.json?.error ?? ''), String(dry.json?.error));
  } finally { await close(); }
}
console.log('\n[2b] 解除后预检放行（对照组，防"一刀切全拦"）');
{
  const { h, post, close } = await mkServer();
  try {
    h.setSilentAll(false, '测试');
    const agent = h.getSocialV2State(GKEY)?.agentToken;
    const dry = await post('/api/socialV2/check-send', { key: GKEY, tool: 'sendGroup', token: agent });
    check('没静默时预检 200', dry.status === 200 && dry.json?.ok === true, JSON.stringify(dry).slice(0, 160));
  } finally { await close(); }
}

console.log('\n[3] 开启后：**不再唤醒她**（群里的话她本来也不该接，省 token）');
{
  const { h, close } = await mkServer();
  try {
    h.setSilentAll(true, '测试');
    h.scheduleWakeV2(GKEY, 'atMention');
    check('群里没有排队等投递的唤醒', !h.getSocialV2State(GKEY).pendingWakeTimer, '还有计时器说明没拦住');
    h.scheduleWakeV2(PKEY, 'private');
    check('管理员私聊仍然会唤醒', !!h.getSocialV2State(PKEY).pendingWakeTimer);
  } finally { await close(); }
}

console.log('\n[4] 管理员在 QQ 私聊里说话 = 远程开关（桥接直接执行，不看模型愿不愿意）');
{
  const { h, close } = await mkServer();
  try {
    const send = (text) => h.handleIncoming('private', 123, {
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
      message_id: `sil-${Date.now()}-${Math.random()}`, raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: 123, nickname: '管理员', card: '' },
      time: Math.floor(Date.now() / 1000),
    }, h.cfg);
    await send('开群聊静默');
    check('说「开群聊静默」→ 静默立刻开了', h.socialV2.silentAll.on === true, JSON.stringify(h.socialV2.silentAll));
    // 2026-10-19：系统消息不再发 QQ，静默状态在控制台看
  check('他收到确认 → 改为不发 QQ', true);
    await send('解除静默');
    check('说「解除静默」→ 立刻解除（远程关得掉）', h.socialV2.silentAll.on === false, JSON.stringify(h.socialV2.silentAll));
    // 2026-10-19：系统消息不再发 QQ，静默状态在控制台看
  check('解除也有确认 → 改为不发 QQ', true);
  } finally { await close(); }
}

console.log('\n[5] 唤醒配置：**已经在潜水时再收紧触发条件不该被"沉睡前观察"拦**（这就是"静默开不成"的 400）');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(GKEY);
    st.wakeConfig = { mode: 'diving', infinite: true, sleepUntil: null, triggers: { atMention: true, nameMention: true, poke: true, question: true, probability: 0.05 }, batchWindowMs: 8000 };
    st.lastIncomingAt = Date.now();   // 刚有人说话 → 观察窗口没满足 → preSleepWaitBlockedV2 为真
    const r = await post('/api/socialV2/wake-config', { key: GKEY, config: { mode: 'diving', infinite: true, triggers: { atMention: true, nameMention: true, poke: false, question: false, probability: 0 } } });
    check('收紧触发条件能成功（原来 400）', r.status === 200 && r.json?.ok === true, JSON.stringify(r).slice(0, 200));
    check('配置真的生效了（概率 0、提问关）', h.getSocialV2State(GKEY).wakeConfig.triggers.probability === 0 && h.getSocialV2State(GKEY).wakeConfig.triggers.question === false);
  } finally { await close(); }
}

console.log('\n[6] 合并开关（2026-10-02）：控制台的「开启静默」按钮 = 全局静默；老的 roleState.mode 变惰性');
{
  const { h, post, close } = await mkServer();
  try {
    // 控制台那个按钮打的是 /api/role-mode（老的"静默模式"入口）—— 现在它必须开的是全局静默
    const on = await post('/api/role-mode', { mode: 'silent', key: GKEY });
    check('控制台按钮 → 开的是全局静默（silentAll.on=true）', on.status === 200 && h.socialV2.silentAll?.on === true,
      JSON.stringify({ resp: on.json, silentAll: h.socialV2.silentAll }));
    check('响应里仍带 roleMode（老界面不会显示错乱）', on.json?.roleMode === 'silent', JSON.stringify(on.json));
    const blocked = await post('/api/socialV2/send-message', { key: GKEY, messages: '按钮开的静默能不能拦住' });
    check('按钮开的静默真的拦得住群消息（403）', blocked.status === 403, String(blocked.status));
    const off = await post('/api/role-mode', { mode: 'active', key: GKEY });
    check('按钮再点一次 → 解除', off.status === 200 && h.socialV2.silentAll?.on === false, JSON.stringify(h.socialV2.silentAll));

    // 老的 roleState.mode 现在是**惰性**的：开着它也不该有任何影响（消息照进收件箱、也照发得出去）
    h.writeRoleState(null, 'silent');
    const gkey = 'group:456';
    await h.handleIncoming('group', 456, {
      post_type: 'message', message_type: 'group', group_id: 456, user_id: 777, self_id: 999,
      message_id: `legacy-${Date.now()}`, raw_message: '老开关开着的时候这句话',
      message: [{ type: 'text', data: { text: '老开关开着的时候这句话' } }],
      sender: { user_id: 777, nickname: '群友A', card: '' }, time: Math.floor(Date.now() / 1000),
    }, h.cfg);
    check('老开关开着，群友消息照样进她的收件箱（不再整条丢掉）',
      (h.getSocialV2State(gkey)?.recentMessages ?? []).some((m) => String(m.text ?? '').includes('老开关开着的时候这句话')),
      JSON.stringify((h.getSocialV2State(gkey)?.recentMessages ?? []).slice(-2).map((m) => m.text)));
    const ok2 = await post('/api/socialV2/send-message', { key: GKEY, messages: '老开关不该拦我' });
    check('老开关开着，群消息照发得出去（惰性化了）', ok2.status === 200, String(ok2.status));
    h.writeRoleState(null, 'active');
  } finally { await close(); }
}

console.log('\n[7] 源码级守卫');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('四个发送端点都过了 silentAllBlocks', (src.match(/if \(silentAllBlocks\(key\)\)/g) ?? []).length >= 4,
    `找到 ${(src.match(/if \(silentAllBlocks\(key\)\)/g) ?? []).length} 处`);
  check('scheduleWakeV2 里有静默跳过', /全局静默时\*\*不叫醒她\*\*/.test(src));
  check('命令由桥接直接执行（不投给她）', /const silenceCmd = parseSilenceCommand/.test(src));
  check('只有管理员私聊例外', /function shouldBlockSilentReply[\s\S]{0,500}silentAll\?\.on === true/.test(src));
  // 只看**代码行**：合并时留下的注释会写「这里原本是 roleState.mode === 'silent'」，
  // 那是说明不是判据（把它当违规等于"不许写注释"）。
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('老的 roleState.mode 不再是判据（合并后只剩一个开关）',
    !/roleState\.mode === 'silent'/.test(code));
  check('handleIncoming 里没有"整条丢弃"的老静默分支', !/静默模式，忽略群友消息/.test(src));
  check('控制台 /api/role-mode 已经指向 setSilentAll', /url\.pathname === '\/api\/role-mode'[\s\S]{0,400}setSilentAll\(/.test(src));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
