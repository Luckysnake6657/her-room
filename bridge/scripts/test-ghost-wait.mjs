/**
 * 回归：`qq_wait_for_messages` 的"幽灵等待"不能把会话冻住（2026-10-01 修）。
 *
 * 现场（她今天自己报了 3 次）：
 *   「12:01 有一次等待被连接掐断后，该会话一直报『已有一个等待中的 qq_wait_for_messages』，
 *     新的等待起不来；同时 qq_mark_read / qq_set_wake_config 因为没完成沉睡前观察也回不去潜水」——
 *   卡了十几分钟。wait 和收尾都靠它，等于会话冻住。
 *
 * 修法两条：
 *   ① 释放名额挂在 req close / req aborted / res close 三个事件上（少挂一个就可能漏）；
 *   ② 兜底：`st.waitingUntil`（这次等待自己声明的结束时间）超过 15 秒还没结束 → 当幽灵清掉并记日志。
 *   另外：被拒时告诉她"还剩几秒 + 别重试 + 可以先看未读"，而不是一句干巴巴的"请等待它结束"。
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

async function mkServer() {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, wake: { preSleepWaitMs: 300000 } } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  h.setMode('reserved2');
  const post = (p, body, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const token = h.getSocialV2State(String(body?.key ?? ''))?.agentToken ?? '';
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('接口没响应')));
    req.end(JSON.stringify(body));
  });
  return { h, post, port, close: async () => { await new Promise((r) => server.close(r)); await h.close(); } };
}

console.log('\n[1] 正常等待进行中：第二次 wait 被拒，但**要说清还剩几秒 + 别重试 + 可以先看未读**');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(GKEY);
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    // 造一个"正在等"的名额（还没到期，不是幽灵）
    h.activeWaits.add(GKEY);
    st.waitingUntil = Date.now() + 120 * 1000;
    const second = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: 30000 });
    check('第二次被拒（429）', second.status === 429, JSON.stringify(second));
    check('说清还剩多少秒', /还剩约 \d+ 秒/.test(second.json?.error ?? ''), second.json?.error);
    check('明确"别重试"', /别重试/.test(second.json?.error ?? ''), second.json?.error);
    check('给出替代动作（先看未读）', /qq_get_unread_messages/.test(second.json?.error ?? ''), second.json?.error);
  } finally { await close(); }
}

console.log('\n[2] 幽灵等待：名额还占着，但声明的结束时间早过了 → 自动清掉，新等待能起来');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(GKEY);
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    h.activeWaits.add(GKEY);                 // 幽灵：名额占着
    st.waitingUntil = Date.now() - 60 * 1000; // 而它声明的结束时间早就过了
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: 1000 });
    check('幽灵被清掉后不再 429（新等待能起来）', r.status === 200, JSON.stringify(r).slice(0, 200));
    check('waitingUntil 已被清空', !h.getSocialV2State(GKEY).waitingUntil, String(h.getSocialV2State(GKEY).waitingUntil));
  } finally { await close(); }
}

console.log('\n[2b] 反例：还没到期的等待不许被当成幽灵清掉（否则并发就绕过去了）');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(GKEY);
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    h.activeWaits.add(GKEY);
    st.waitingUntil = Date.now() + 5 * 60 * 1000;   // 声明还剩 5 分钟
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: 1000 });
    check('仍然被拒（没到期就不能清）', r.status === 429, JSON.stringify(r).slice(0, 200));
    check('名额还在', h.activeWaits.has(GKEY));
  } finally { await close(); }
}

console.log('\n[3] 源码级：释放名额挂在三个事件上（少一个就可能漏）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check("req.on('close', finishWait)", /req\.on\('close', finishWait\)/.test(src));
  check("req.on('aborted', finishWait)", /req\.on\('aborted', finishWait\)/.test(src));
  check("res.on('close', finishWait)", /res\.on\('close', finishWait\)/.test(src));
  check('有基于 waitingUntil 的幽灵兜底', /清掉幽灵等待/.test(src));
  check('finishWait 是幂等的（waitDone 守卫）', /let waitDone = false/.test(src));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
