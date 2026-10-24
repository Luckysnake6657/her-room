/**
 * 回归：「沉睡前观察」不能因为"群里一直有人说话"而永远满足不了（2026-10-01 修）。
 *
 * 现场：OW 群一个 turn 里她调了 **20 次 qq_wait_for_messages**，自己的推理写着
 *   "keep cycling: consume unread, wait 300s"；今天 mark_read 被拒 7 次。
 * 根因：只有"真等了一会儿才收到消息"那条路会置 preSleepWaitObservedAt（而且要 timeoutMs ≥ 观察窗口），
 *   而**有人说话时 wait 走的是 `unseen-unread` 立即返回**那条路 —— 那条路不计入观察，
 *   于是观察永远不成立 → mark_read / set_wake_config 一直被拒 → wait→读未读→wait 无限空转。
 *   （每次空转 = 一个完整模型请求；私聊会话上下文已经 14 万 token。）
 *
 * 修法：`unseen-unread` 立即返回时，只要她请求的就是观察窗口（timeoutMs ≥ preSleepWaitMs），
 *   也算"已完成观察"——消息已经被交到她手上，看过就能决定要不要参与。
 *   但**不许用短等待绕过**（timeoutMs 不够就仍然算没观察）。
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

/** 观察窗口设成 7 秒（默认 300000），测试不用真等 5 分钟。
 *  ⚠️ 必须大于 wait 端点的 timeoutMs 下限（`socialV2.wait.minMs`，默认 5000），
 *  否则"短等待"会被端点夹到 5000，就测不出"短等待不算观察"这件事（第一版就踩了）。 */
const PRE_MS = 7000;
const GKEY = 'group:456';

async function mkServer() {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, wake: { preSleepWaitMs: PRE_MS } } } });
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
    req.setTimeout(20000, () => req.destroy(new Error('接口没响应')));
    req.end(JSON.stringify(body));
  });
  return { h, post, close: async () => { await new Promise((r) => server.close(r)); await h.close(); } };
}

/** 塞一条"别人发的、她还没看过"的消息（unread 非空 + lastUnreadSeq 前进） */
function pushUnseen(h, key, seq, text, sender = '群友A') {
  const st = h.getSocialV2State(key);
  const m = { seq, messageId: `-${seq}`, sender, text, plain: text, tail: text, isSelf: false, time: Date.now(), userId: 1000 + seq };
  st.unread.push(m);
  st.recentMessages.push(m);
  st.lastUnreadSeq = seq;
  st.lastIncomingAt = Date.now();
  st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
  return st;
}

console.log('\n[1] 有未看过消息 + 她请求的是观察窗口 → 这次立即返回**要算完成观察**');
{
  const { h, post, close } = await mkServer();
  try {
    const st = pushUnseen(h, GKEY, 101, '要不要买服务器');
    check('前置：现在确实是被拦状态（观察没做）', h.preSleepWaitBlockedV2(st) === true);
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: PRE_MS * 2 });
    check('立即返回（reason=unseen-unread）', r.json?.reason === 'unseen-unread' && r.json?.arrived === true, JSON.stringify(r).slice(0, 200));
    check('消息交到了她手上（newMessages 里有）', (r.json?.newMessages ?? []).some((m) => String(m.text).includes('买服务器')));
    check('**这次算完成观察**（preSleepWaitObserved=true）', r.json?.preSleepWaitObserved === true, JSON.stringify(r.json));
    check('修好之后不再是"被拦"状态', h.preSleepWaitBlockedV2(h.getSocialV2State(GKEY)) === false);
    const mr = await post('/api/socialV2/mark-read', { key: GKEY });
    check('于是 qq_mark_read 能收尾（原来一直被 400 拒）', mr.status === 200 && mr.json?.ok === true, JSON.stringify(mr).slice(0, 200));
  } finally { await close(); }
}

console.log('\n[2] 但**不许用短等待绕过**：timeoutMs 不到观察窗口 → 不算观察');
{
  const { h, post, close } = await mkServer();
  try {
    pushUnseen(h, GKEY, 201, '随便一句');
    // 5000 = wait 端点的 timeoutMs 下限（minMs），远小于观察窗口 7000
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: 5000 });
    check('仍然是立即返回', r.json?.reason === 'unseen-unread');
    check('这次**不算**完成观察（preSleepWaitObserved 为假）', !r.json?.preSleepWaitObserved, JSON.stringify(r.json));
    check('还是被拦（防"1 秒 wait 绕过观察"）', h.preSleepWaitBlockedV2(h.getSocialV2State(GKEY)) === true);
  } finally { await close(); }
}

console.log('\n[3] 注里说清"不用再调 get_unread"（她每次都会多烧一个请求）');
{
  const { h, post, close } = await mkServer();
  try {
    pushUnseen(h, GKEY, 301, '又来一条');
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: PRE_MS * 2 });
    check('明确告诉她消息已经给了、不用再查未读',
      /不用再调 qq_get_unread_messages/.test(r.json?.note ?? ''), r.json?.note);
    check('并告诉她这次可以收尾沉睡', /算你已经完成沉睡前观察/.test(r.json?.note ?? ''), r.json?.note);
  } finally { await close(); }
}

console.log('\n[4] 安静到底仍然算"等满观察"（原有行为不能被改坏）');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(GKEY);
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    const r = await post('/api/socialV2/wait', { key: GKEY, timeoutMs: PRE_MS });
    check('没人说话 → 等满后 preSleepWaitSatisfied=true', r.json?.preSleepWaitSatisfied === true, JSON.stringify(r.json).slice(0, 200));
    check('之后不被拦', h.preSleepWaitBlockedV2(h.getSocialV2State(GKEY)) === false);
  } finally { await close(); }
}

console.log('\n[5] 源码级：立即返回那条路必须真的置了观察标记（防回退）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('unseen-unread 分支里有 preSleepAttemptNow', /const preSleepAttemptNow = timeoutMs >=/.test(src));
  check('它真的置了 preSleepWaitObservedAt', /if \(preSleepAttemptNow\) st\.preSleepWaitObservedAt = Date\.now\(\)/.test(src));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
