/**
 * 回归：**同一条消息不能递给她两遍**（2026-10-01 修）。
 *
 * 现场（私聊工具日志）：
 *   22:58:33 wait 真等 31 秒 → newMessages [1624,1625]
 *   22:58:39 wait（立即返回 unseen-unread）→ 又是 [1624,1625]
 *   23:04:36 wait 真等 238 秒 → [1629,1630]
 *   23:04:41 get_unread → 又是 [1629,1630]
 * 每条消息都被交了两遍、每次多烧一个完整模型请求；她自己的推理里困惑过"又是那条旧消息 1614…它又出现了"。
 *
 * 根因：两条返回路径不一致 —— "有未看过消息→立即返回"那条会推进 lastSeenUnreadSeq 并从未读里划掉，
 *   "真等到了消息"那条什么都不做，于是下一轮又把同一批交出去。
 * 修法：真等到消息时同样标记为已看过（推进 lastSeenUnreadSeq + 从未读列表划掉），并落盘。
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

const KEY = 'group:456';

async function mkServer() {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, wake: { preSleepWaitMs: 300000 } } } });
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
    req.setTimeout(25000, () => req.destroy(new Error('接口没响应')));
    req.end(JSON.stringify(body));
  });
  return { h, post, close: async () => { await new Promise((r) => server.close(r)); await h.close(); } };
}

function pushIncoming(h, key, seq, text, sender = '群友A') {
  const st = h.getSocialV2State(key);
  const m = { seq, messageId: `-${seq}`, sender, text, plain: text, tail: text, isSelf: false, time: Date.now(), userId: 1000 + seq };
  st.recentMessages.push(m);
  st.unread.push(m);
  st.lastUnreadSeq = seq;
  st.lastIncomingAt = Date.now();
  st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
  return st;
}

console.log('\n[1] 真等到消息 → 交给她之后必须标记"看过了"');
{
  const { h, post, close } = await mkServer();
  try {
    const st0 = h.getSocialV2State(KEY);
    st0.wakeConfig = { ...(st0.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    // 起一个 wait，然后在等待期间塞一条新消息（模拟对方说话）
    const waiting = post('/api/socialV2/wait', { key: KEY, timeoutMs: 6000, quietMs: 1000 });
    await new Promise((r) => setTimeout(r, 500));
    pushIncoming(h, KEY, 501, '在吗');
    const r = await waiting;
    check('这次是"真的等到了"（reason 空、waitedMs>0）',
      r.status === 200 && !r.json?.reason && Number(r.json?.waitedMs) > 0, JSON.stringify(r).slice(0, 220));
    check('消息交到了她手上', (r.json?.newMessages ?? []).some((m) => String(m.text).includes('在吗')));
    const st = h.getSocialV2State(KEY);
    check('**lastSeenUnreadSeq 推进了**（下轮不会再当"没看过"）', Number(st.lastSeenUnreadSeq) >= 501, `lastSeenUnreadSeq=${st.lastSeenUnreadSeq}`);
    check('**未读列表里划掉了**（不会被再交一遍）', !(st.unread ?? []).some((m) => Number(m.seq) === 501), JSON.stringify(st.unread?.map((m) => m.seq)));

    // 关键断言：紧接着再 wait 一次，不能再把同一条递过来
    const again = await post('/api/socialV2/wait', { key: KEY, timeoutMs: 800 });
    const dup = (again.json?.newMessages ?? []).some((m) => Number(m.seq) === 501);
    check('紧接着再 wait → **不会重复递同一批**', again.json?.reason !== 'unseen-unread' && !dup, JSON.stringify(again.json).slice(0, 220));
  } finally { await close(); }
}

console.log('\n[2] 反例：真的还没看过时，仍然要立即交给她（原有行为不能坏）');
{
  const { h, post, close } = await mkServer();
  try {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true, triggers: { atMention: true } };
    pushIncoming(h, KEY, 601, '还没看过的消息');
    const r = await post('/api/socialV2/wait', { key: KEY, timeoutMs: 3000 });
    check('立即返回 unseen-unread', r.json?.reason === 'unseen-unread', JSON.stringify(r.json).slice(0, 200));
    check('内容交到了她手上', (r.json?.newMessages ?? []).some((m) => String(m.text).includes('还没看过')));
  } finally { await close(); }
}

console.log('\n[3] 源码级：两条路都要标记"看过了"');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('真等到消息那条路也推进 lastSeenUnreadSeq',
    /if \(newMessages\.length\) \{\s*\n\s*const maxSeq = newMessages\.reduce/.test(src));
  check('并且真的从未读列表里划掉', /kept\.length !== \(st\.unread\?\.length \?\? 0\)/.test(src));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
