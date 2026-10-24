/**
 * 回归：消息的**可读时间**（2026-09-30）。
 *
 * 事故：她 16:23~16:32 刚聊完服务器（还报出过"一年七十五块"），12 分钟后却说"**上午**那台服务器你买了吗"。
 * 不是遗忘 —— 内容全在、价格也报对了；缺的是**时间锚点**：轮换 seed 只有"你：/对方："，消息工具返回的是
 * 毫秒 epoch，模型没法可靠换算成"16:23"，只能猜。
 *
 * 所以这里锁四件事：
 *   ① humanTime 的分档边界（刚刚 / N分钟前 / N小时前 / 昨天 / N天前，以及跨天的 atText）；
 *   ② 读消息的接口（unread / recent / message-detail / wait）都带上 atText + agoText；
 *   ③ 轮换后的【最近聊过什么】每行带"（距今多久）"；
 *   ④ 【此刻状态】的"最近一条"带年龄；
 *   ⑤ 时间戳缺失时不许崩、也不许编（返回 null）。
 */
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

// ── ① humanTime 分档（用 harness 里的真函数，不另抄一份） ──────────────────
console.log('\n[1] humanTime 分档');
{
  const h = await bridgeHarness();
  try {
    const now = new Date('2026-09-30T16:44:00+08:00').getTime();
    const at = (min, base = now) => h.humanTime(base - min * 60000, now);
    const cases = [
      [0, '刚刚'], [0.5, '刚刚'], [1, '1分钟前'], [12, '12分钟前'], [59, '59分钟前'],
      [60, '1小时前'], [180, '3小时前'],
    ];
    for (const [min, want] of cases) {
      const got = at(min).agoText;
      check(`${min} 分钟前 → ${want}`, got === want, `得到 ${got}`);
    }
    // 跨天：昨天 / 更早
    const yest = at(26 * 60).agoText;
    check('26 小时前 → 昨天', yest === '昨天', `得到 ${yest}`);
    const older = at(3 * 24 * 60).agoText;
    check('3 天前 → 3天前', older === '3天前', `得到 ${older}`);
    // atText 形态
    const todayAt = h.humanTime(new Date('2026-09-30T09:05:00+08:00').getTime(), now).atText;
    check('同一天 atText = 09:05', todayAt === '09:05', `得到 ${todayAt}`);
    const yd = h.humanTime(new Date('2026-09-29T21:07:00+08:00').getTime(), now).atText;
    check('昨天 atText = "昨天 21:07"', yd === '昨天 21:07', `得到 ${yd}`);
    const old = h.humanTime(new Date('2026-09-25T08:00:00+08:00').getTime(), now).atText;
    check('更早 atText = "9/25 08:00"', old === '9/25 08:00', `得到 ${old}`);
    // 脏输入不许崩、不许编
    for (const bad of [null, undefined, 0, -1, 'abc', NaN]) {
      const r = h.humanTime(bad, now);
      check(`脏时间戳 ${JSON.stringify(bad)} → 两个字段都是 null（不编造）`, r.atText === null && r.agoText === null, JSON.stringify(r));
    }
  } finally { await h.close(); }
}

// ── ②③④ 端到端：真跑 handleIncoming + 真打接口 + 真拼提示词 ────────────────
console.log('\n[2] 端到端（真接口 / 真提示词）');
{
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } }, consoleToken: 'fixture-console-token' });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('接口没响应')));
    req.end();
  });
  try {
    h.setMode('reserved2');
    const ev = (text, id, secAgo = 0) => ({
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
      message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }],
      sender: { user_id: 123, nickname: '管理员', card: '' },
      time: Math.floor((Date.now() - secAgo * 1000) / 1000),
    });
    await h.handleIncoming('private', 123, ev('要不要买个腾讯云服务器', 'mt-1'), h.cfg);
    await h.handleIncoming('private', 123, ev('一年七十五块', 'mt-2'), h.cfg);
    // ⚠️ 消息的 time 是**入库那一刻**盖的（不是 QQ 事件里的时间），所以回拨要直接改存下来的那条
    const stored = h.getSocialV2State('private:123').recentMessages;
    const now = Date.now();
    stored[stored.length - 2].time = now - 21 * 60 * 1000;
    stored[stored.length - 1].time = now - 12 * 60 * 1000;

    // ② recent / unread 都带可读时间
    const recent = await get('/api/socialV2/recent?key=private%3A123&limit=10');
    const msgs = recent.messages ?? [];
    check('recent 返回了消息', msgs.length >= 2, JSON.stringify(msgs.length));
    check('recent 每条都带 atText + agoText', msgs.every((m) => typeof m.atText === 'string' && typeof m.agoText === 'string'),
      JSON.stringify(msgs.map((m) => ({ at: m.atText, ago: m.agoText }))));
    // 毫秒 epoch 对模型没用（它换算不了），去掉省 token —— 留在 state 文件里给内部用
    check('读接口不再回毫秒 epoch（省 token）', msgs.every((m) => m.time === undefined),
      JSON.stringify(msgs.map((m) => m.time)));
    const agoList = msgs.map((m) => m.agoText);
    check('"12分钟前"这类相对时间真的算出来了', agoList.includes('12分钟前') && agoList.includes('21分钟前'), JSON.stringify(agoList));
    check('atText 是"时:分"而不是毫秒 epoch', msgs.every((m) => /^\d{2}:\d{2}$/.test(m.atText) || /^昨天 \d{2}:\d{2}$/.test(m.atText)),
      JSON.stringify(msgs.map((m) => m.atText)));
    const unread = await get('/api/socialV2/unread?key=private%3A123&limit=10');
    check('unread 也带 atText + agoText', (unread.messages ?? []).length >= 1 && unread.messages.every((m) => typeof m.atText === 'string'),
      JSON.stringify((unread.messages ?? []).map((m) => m.agoText)));

    // ③ 轮换 seed 每行带"距今多久"
    const st = h.getSocialV2State('private:123');
    st.needsContextSeed = true;
    const prompt = h.buildWakePromptV2('private:123', 'timeout');
    check('轮换后的【最近聊过什么】带括号年龄', /（\d+分钟前）|（刚刚）/.test(prompt), prompt.slice(0, 200));
    const seedLine = (prompt.match(/【最近聊过什么】[\s\S]*?\n\n/) ?? [''])[0];
    const seeded = seedLine.split('\n').filter((l) => l.startsWith('  '));
    check('seed 里**每一行**都有"（距今多久）"',
      seeded.length >= 1 && seeded.every((l) => /（(刚刚|\d+分钟前|\d+小时前|昨天|\d+天前)）/.test(l)),
      JSON.stringify(seeded));
    check('seed 里私聊不显示成"私聊："这种第三人称', !/^\s*私聊（/m.test(seedLine), seedLine);
    check('seed 明确告诉她括号是"距今多久"（别再当成很久以前）', /括号里是距今多久/.test(prompt));

    // ④ 【此刻状态】里最近一条带年龄（注意别匹配到别的段落里提到【此刻状态】的地方）
    const prompt2 = h.buildWakePromptV2('private:123', 'unmuted');
    const statusLine = (prompt2.match(/【此刻状态】未读 \d+ 条[^\n]*/) ?? [''])[0];
    check('【此刻状态】的"最近一条"带年龄', /最近一条来自[^；\n]*（(刚刚|\d+分钟前|\d+小时前)）/.test(statusLine), statusLine);

    // ⑤ message-detail 也带
    const detail = await get('/api/socialV2/message-detail?key=private%3A123&messageId=mt-2');
    check('message-detail 的 info 带 atText/agoText',
      detail?.info?.atText !== undefined && detail?.info?.agoText !== undefined, JSON.stringify(detail?.info));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
