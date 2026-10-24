/**
 * 回归：发送节奏与"刷屏"节流（2026-09-30 管理员提的三件事）。
 *
 * ① 大量消息同一时间发出 → 两条根因都锁住：
 *    a) 间隔下限（原来 1000ms 起步 → 现在 1500ms，按长度 1500+35×字数）；
 *    b) **她读到的"1 秒一条"是桥接自己编的时间戳**（老代码写 `time: now + i*1000`）→ 现在记真实发送时刻。
 * ② 上下文过长不引用消息 → 把"回哪条"的 seq 直接摆到她眼前（未读里有多个人时才给）。
 * ③ 群里热烈时她也刷屏 → 热度判定 + 提示词提醒 + 热的会话收紧每分钟额度 + 没人接话不许一直连发。
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
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.send ?? {};
/** 发消息的场景必须带上**真实 send 配置**：fixture 不带 socialV2.send 时桥接会退回内置兜底值，
 *  测出来就不是生产那一套了（调试时踩出来的：兜底值是 burstMaxMessages 8 / gapBaseMs 800）。 */
const withSend = (extra = {}) => ({ enabled: true, send: CFG, ...extra });
/** harness 默认白名单是 private:123 / group:456 —— 发消息只能用这两个 */
const PKEY = 'private:123';
const GKEY = 'group:456';

/** 起一个 harness + 控制台服务；post 会自动带上该会话的 agent token
 *  （reserved2 下发送必须带 agent token，不带直接 403 —— 写测试时踩过一次） */
async function mkServer(config) {
  const h = await bridgeHarness({ config });
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
/** 往会话里塞"别人说的"消息（直接写状态，比走 handleIncoming 精确可控） */
function pushIncoming(h, key, items) {
  const st = h.getSocialV2State(key);
  for (const it of items) {
    st.recentMessages.push({ sender: it.sender, text: it.text, plain: it.text, isSelf: false, time: it.time });
  }
  return st;
}
const fuelHot = (h, key, { n = 20, senders = 3, now = Date.now() } = {}) => pushIncoming(h, key,
  Array.from({ length: n }, (_, i) => ({ sender: `群友${i % senders}`, text: `消息${i}`, time: now - (i + 1) * 20000 })));

console.log('\n[1] 发送间隔（computeGapsV2）');
{
  const h = await bridgeHarness();
  try {
    const cfg = { ...CFG, gapBaseMs: 1500, gapPerCharMs: 35, burstIntervalMinMs: 1500, burstIntervalMaxMs: 3000, maxGapMs: 10000, longGapProbability: 0 };
    check('单条 → 不产生间隔', h.computeGapsV2(['只有一条'], 'byLength', 0, [], cfg).length === 0);
    const byLen = h.computeGapsV2(['这条一共十二个字', '第二条'], 'byLength', 0, [], cfg);
    check('按长度：12 字 → 1500+12×35 ≈ 1920ms', byLen[0] >= 1500 && byLen[0] <= 2000, JSON.stringify(byLen));
    const fixed = h.computeGapsV2(['a', 'b', 'c'], 'fixed', 2500, [], cfg);
    check('fixed 三条 → 两个 2500ms', fixed.length === 2 && fixed.every((x) => x === 2500), JSON.stringify(fixed));
    check('超过 maxGapMs 会被夹住（不会卡着不发）', h.computeGapsV2(['a', 'b'], 'fixed', 999999, [], cfg)[0] === 10000);
    check('下限被抬到 burstIntervalMinMs=1500 → 不再有"1 秒一条"',
      h.computeGapsV2(['a', 'b'], 'fixed', 50, [], cfg)[0] >= 1500, JSON.stringify(h.computeGapsV2(['a', 'b'], 'fixed', 50, [], cfg)));
    const auto = h.computeGapsV2(['a', 'b', 'c'], 'auto', 0, [], { ...cfg, longGapProbability: 0 });
    check('auto 模式也守下限', auto.every((x) => x >= 1500 && x <= 3000), JSON.stringify(auto));
  } finally { await h.close(); }
}

console.log('\n[2] 她读到的"1 秒一条"是编的 → 现在记真实发送时刻');
{
  const { h, post, close } = await mkServer({ socialV2: withSend() });
  try {
    const before = Date.now();
    const r = await post('/api/socialV2/send-message', { key: PKEY, messages: ['第一条', '第二条'], gapMode: 'fixed', gapMs: 1500 });
    check('两条都发出去了', r.status === 200 && r.json?.sent === 2, JSON.stringify(r));
    const sentCalls = (h.calls?.http ?? []).filter((c) => c.action === 'send_private_msg');
    check('OneBot 那边确实收到两条', sentCalls.length === 2, JSON.stringify((h.calls?.http ?? []).map((c) => c.action)));
    check('内容对得上（含"第一条"）', JSON.stringify(sentCalls.map((c) => c.body?.message ?? [])).includes('第一条'), JSON.stringify(sentCalls[0]?.body));
    const self = (h.getSocialV2State(PKEY).recentMessages ?? []).filter((m) => m.isSelf);
    check('两条都记进了 recentMessages', self.length === 2, JSON.stringify(self.map((m) => m.text)));
    const d = self[1].time - self[0].time;
    check(`记录的时间差是真实间隔（${d}ms，不再是编的 1000ms）`, d >= 1300 && d <= 3500, `差 ${d}ms`);
    check('时间戳贴着真实的现在（不是编出来的未来时间）', self[0].time >= before && self[1].time <= Date.now() + 100,
      `${self[0].time} / ${self[1].time} vs ${before}`);
  } finally { await close(); }
}

console.log('\n[3] 没人接话时不许一直连发（群聊仍是 3；私聊 2026-10-01 放宽到 6）');
{
  const { h, post, close } = await mkServer({ socialV2: withSend({ heat: { maxConsecutive: 3 } }) });
  try {
    // ── 群聊：保持原来的严格档（群刷屏才是要防的那件事）──
    const burst = await post('/api/socialV2/send-message', { key: GKEY, messages: ['a', 'b', 'c'], gapMode: 'fixed', gapMs: 1500 });
    check('群里一次调用的三条爆发能发出去（连发预算下限 = burstMaxMessages）', burst.status === 200 && burst.json?.sent === 3, JSON.stringify(burst));
    check('发完后确实记了 3 条连发', h.consecutiveSelfSends(h.getSocialV2State(GKEY)) === 3);
    const again = await post('/api/socialV2/send-message', { key: GKEY, messages: ['还要说'] });
    check('群里第 4 条（中间没人说话）→ 429 拦下', again.status === 429, JSON.stringify(again));
    check('理由说得明白（提"连发"和"没有人说话"）', /连发/.test(again.json?.error ?? '') && /没有人说话/.test(again.json?.error ?? ''), again.json?.error);
    check('额度用尽时告诉她等对方接话、别重试', /等他接话/.test(again.json?.error ?? ''), again.json?.error);
    pushIncoming(h, GKEY, [{ sender: '熊猫人', text: '在的', time: Date.now() }]);
    const after = await post('/api/socialV2/send-message', { key: GKEY, messages: ['嗯'] });
    check('对方接话后又能发了', after.status === 200 && after.json?.ok === true, JSON.stringify(after));

    // ── 私聊：一对一的短句分条不是刷屏（实测按 3 卡会拒掉她第二条：当天 4 次被拒、8 条内容丢失）──
    const p1 = await post('/api/socialV2/send-message', { key: PKEY, messages: ['a', 'b', 'c'], gapMode: 'fixed', gapMs: 1500 });
    check('私聊三条爆发能发出去', p1.status === 200 && p1.json?.sent === 3, JSON.stringify(p1));
    const p2 = await post('/api/socialV2/send-message', { key: PKEY, messages: ['d', 'e'], gapMode: 'fixed', gapMs: 1500 });
    check('私聊接着再发两条（合计 5 条、中间没人说话）→ 放行（这是修掉"内容静默丢失"的关键）',
      p2.status === 200 && p2.json?.sent === 2, JSON.stringify(p2));
    check('私聊确实记了 5 条连发', h.consecutiveSelfSends(h.getSocialV2State(PKEY)) === 5);
    const p3 = await post('/api/socialV2/send-message', { key: PKEY, messages: ['f', 'g'] });
    check('私聊超过 6 条 → 429 拦下（还是有人管的）', p3.status === 429, JSON.stringify(p3));
    check('**先告诉她还剩几条额度，并要求"并成一条发、别把内容删掉"**',
      /还能再发 \d+ 条/.test(p3.json?.error ?? '') && /别把内容删掉/.test(p3.json?.error ?? ''), p3.json?.error);
    check('私聊上限可配（maxConsecutivePrivate）', Number(CFG.maxConsecutivePrivate) >= 4, JSON.stringify(CFG.maxConsecutivePrivate));
  } finally { await close(); }
}

console.log('\n[4] 群里正热闹 → 提示词提醒');
{
  const h = await bridgeHarness({
    config: { socialV2: withSend({ heat: { windowMs: 600000, hotIncoming: 20, hotSenders: 3, hotMaxSendPerMinute: 3, maxConsecutive: 3 } }) },
  });
  try {
    h.setMode('reserved2');
    check('空会话不热', h.conversationHeat(GKEY).hot === false, JSON.stringify(h.conversationHeat(GKEY)));
    fuelHot(h, GKEY, { n: 20, senders: 3 });
    const hot = h.conversationHeat(GKEY);
    check('20 条 / 3 人 → 判定为热', hot.hot === true && hot.senders === 3 && hot.incoming === 20, JSON.stringify(hot));
    check('窗口外的老消息不算（3 小时后就不热了）', h.conversationHeat(GKEY, Date.now() + 3 * 3600000).hot === false);
    const prompt = h.buildWakePromptV2(GKEY, 'timeout');
    check('提示词里出现【群里正热闹】并带具体条数', /【群里正热闹】/.test(prompt) && /20 条/.test(prompt), (prompt.match(/【群里正热闹】[^\n]*/) ?? [''])[0]);
    check('提醒她"插一句就够"、别连发', /插一句就够/.test(prompt) && /别连发第二条/.test(prompt));
    check('不热的会话没有这一行（不白烧 token）', !/【群里正热闹】/.test(h.buildWakePromptV2(PKEY, 'timeout')));
  } finally { await h.close(); }
}

console.log('\n[5] 热的会话：每分钟额度收到 hotMaxSendPerMinute');
{
  const { h, post, close } = await mkServer({
    socialV2: withSend({ heat: { hotIncoming: 20, hotSenders: 3, hotMaxSendPerMinute: 3, maxConsecutive: 3 } }),
  });
  try {
    fuelHot(h, GKEY, { n: 20, senders: 3 });
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await post('/api/socialV2/send-message', { key: GKEY, messages: [`第${i + 1}条`] }));
      // 每发一条补一条"别人说话"，避免撞上连发规则（这一节只测每分钟额度）
      pushIncoming(h, GKEY, [{ sender: '群友0', text: `接话${i}`, time: Date.now() }]);
    }
    check('前 3 条能发（热时上限 3 条/分钟，配置里是 8）', results.slice(0, 3).every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    check('第 4 条被拦（429）', results[3].status === 429, JSON.stringify(results[3]));
    check('理由是"热闹/别刷屏"，不是干巴巴的限流', /热闹/.test(results[3].json?.error ?? '') && /刷屏/.test(results[3].json?.error ?? ''), results[3].json?.error);
  } finally { await close(); }
}

console.log('\n[6] 引用：把"回哪条"的 seq 摆到她眼前');
{
  const { h, post, close } = await mkServer({ socialV2: withSend() });
  try {
    const st = h.getSocialV2State(GKEY);
    const now = Date.now();
    // ⚠️ 引用解析（resolveReplyTargetV2）是在 **recentMessages** 里按 seq 找的，不是 unread ——
    //    生产里两个列表都有这条消息（appendSocialV2Message 同时写），所以只塞 unread 会解析失败。
    //    （messageId 用数字：真正的 QQ id 是数字，onebotSend 会校验"非零整数"，用 fake-xx 会被它拦下）
    const m1 = { seq: 11, messageId: '-10011', sender: '熊猫人', text: '要不要买服务器', plain: '要不要买服务器', isSelf: false, time: now - 12 * 60000 };
    const m2 = { seq: 12, messageId: '-10012', sender: '猫猫', text: '我这边 60 就能拿下', plain: '我这边 60 就能拿下', isSelf: false, time: now - 60000 };
    st.recentMessages.push(m1, m2);
    st.unread = [m1, m2];
    const prompt = h.buildWakePromptV2(GKEY, 'timeout');
    // 2026-10-01：旧块只给"谁/第几条/多久前"（为了引用），现在连**内容**一起摆出来 ——
    // 一次解决两件事：她看得懂别人在说什么，引用也不用再去翻消息。
    check('出现【刚发生的几条】（最近几条直接摆在眼前）', /【刚发生的几条】/.test(prompt));
    check('带上两个人的第几条（seq）+ 说了什么',
      /熊猫人（第 11 条）：要不要买服务器/.test(prompt) && /猫猫（第 12 条）：我这边 60 就能拿下/.test(prompt),
      (prompt.match(/【刚发生的几条】[\s\S]{0,220}/) ?? [''])[0]);
    check('说清"回的不是最下面那条就要带 replyToMessageId"',
      /replyToMessageId=<那个第几条>/.test(prompt) && /要回的不是最下面那条/.test(prompt));
    // 2026-10-01 20:45 实测：她回了前面第 3 条（「0个人在意你拼了什么哈」）却没带引用，
    // 中间夹着表情包和拍一拍 → 管理员看截图以为是"她怎么突然发这句"。
    // 所以这条从"建议"改成硬要求，并要求她发送前自问一句。
    check('引用被写成硬要求（不是建议），并要求发前自检',
      /这不是建议/.test(prompt) && /发之前先看一眼/.test(prompt) && /不是就带 id/.test(prompt));
    // 只有一个人在说 → 内容照样摆出来（不然她看不懂在聊什么），但不啰嗦引用
    const s1 = { seq: 21, messageId: '-10021', sender: '熊猫人', text: '一', plain: '一', isSelf: false, time: now - 60000 };
    const s2 = { seq: 22, messageId: '-10022', sender: '熊猫人', text: '二', plain: '二', isSelf: false, time: now - 30000 };
    st.recentMessages.length = 0;
    st.recentMessages.push(s1, s2);
    st.unread = [s1, s2];
    const p1 = h.buildWakePromptV2(GKEY, 'timeout');
    check('只有一个人在说 → 仍然摆出内容（看得懂在聊什么）', /熊猫人（第 22 条）：二/.test(p1));
    check('只有一个人在说 → 不啰嗦引用指引（省 token）', !/replyToMessageId=<那个第几条>/.test(p1));
    // 引用端到端：拿 seq 当 replyToMessageId 真发一条（解析是在 recentMessages 里按 seq 找）
    const r = await post('/api/socialV2/send-message', { key: GKEY, messages: ['回你上面那条'], replyToMessageId: 21 });
    check('用 seq 引用能发出去', r.status === 200 && r.json?.ok === true, JSON.stringify(r));
    check('返回里带被引用的信息（她能确认引对了没）', !!r.json?.quoted, JSON.stringify(r.json?.quoted));
    const groupCalls = (h.calls?.http ?? []).filter((c) => c.action === 'send_group_msg');
    check('OneBot 收到的是"引用段 + 文本"', JSON.stringify(groupCalls[0]?.body ?? {}).includes('"type":"reply"'),
      JSON.stringify(groupCalls[0]?.body ?? null).slice(0, 240));
  } finally { await close(); }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
