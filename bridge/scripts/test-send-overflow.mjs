/**
 * 回归测试：**一次发太多条 → 自动截断到上限 + 明确告知**（不再整条拒绝）。
 *
 * 为什么改（2026-10-12 的实测数据）：末 1000 次工具调用里，`qq_send_message` 有 **11 次**栽在
 * "一次最多发 3 条"这条上。原来的路径是「被拒 → 她重新组织 → 再发一次」= 白跑一整轮模型推理
 * （几十秒 + token），忙中出错时还可能顺手把第 4、5 条的内容丢了（"其余的下次再说"很容易变成永远不说）。
 *
 * 改成截断之后：
 *   • 防刷屏的语义**一点没变**：她一次最多还是 maxMsgs 条（不可能靠一次调用刷 10 条）；
 *   • 但不用再挨一次错误往返：返回值里带 `dropped` / `dropNote`，她在同一回合补一次就完事。
 *
 * 这个用例用 harness 的**假网关**数实际发出几条（`calls.sent` ∪ `calls.http` 里的 send_*）
 * —— 不碰真 QQ、不改生产配置。每个用例用**独立会话**，避开连发/热度判定带来的干扰。
 */
import http from 'node:http';
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const MAX = 3;
const KEYS = ['private:901', 'private:902', 'group:903', 'private:904'];
const h = await bridgeHarness({
  config: {
    socialV2: {
      enabled: true,
      send: {
        burstMaxMessages: MAX,
        burstIntervalMinMs: 1,
        burstIntervalMaxMs: 2,
        longGapProbability: 0,
        maxSendPerMinute: 99,
        maxSendPerHour: 999,
        maxConsecutivePrivate: 99,
      },
      heat: { maxConsecutive: 99 },
    },
    ownerQQ: 123,
    allow: { private: ['901', '902', '904'], groups: ['903'] },
  },
});
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;
h.setMode('reserved2');

const req = (p, body, agentToken = '') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
    headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': agentToken, 'content-type': 'application/json' } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
  r.on('error', reject); r.end(JSON.stringify(body ?? {}));
});
// 发送可能走 bot 方法（calls.sent）也可能走 HTTP action（calls.http 里的 send_*）—— 两个都数
const sentCount = () => (h.calls.sent ?? []).length
  + (h.calls.http ?? []).filter((c) => /^send_/.test(String(c.action))).length;

try {
  console.log(`\n[1] 传 ${MAX + 2} 条 → 截断到 ${MAX} 条并告知（不再整条 400）`);
  {
    const key = KEYS[0];
    const agent = h.getSocialV2State(key).agentToken;
    const before = sentCount();
    const r = await req('/api/socialV2/send-message', { key, token: agent, messages: ['一', '二', '三', '四', '五'] }, agent);
    check('HTTP 200 + ok', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 200));
    check(`实际只发了 ${MAX} 条`, sentCount() - before === MAX, `实际 ${sentCount() - before} 条`);
    check('返回值带 dropped=2', r.json?.dropped === 2, JSON.stringify({ dropped: r.json?.dropped }));
    check('dropNote 说清"还有 2 条没发"', /还有 2 条没发/.test(String(r.json?.dropNote ?? '')), String(r.json?.dropNote ?? ''));
    check('sent 字段与上限一致（不是 5）', r.json?.sent === MAX, JSON.stringify({ sent: r.json?.sent }));
  }

  console.log('\n[2] 不超过上限时行为完全不变（不该冒出 dropped）');
  {
    const key = KEYS[1];
    const agent = h.getSocialV2State(key).agentToken;
    const before = sentCount();
    const r = await req('/api/socialV2/send-message', { key, token: agent, messages: ['甲', '乙', '丙'] }, agent);
    check('HTTP 200 + ok', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 160));
    check(`发了 ${MAX} 条`, sentCount() - before === MAX, `实际 ${sentCount() - before} 条`);
    check('没有 dropped / dropNote', r.json?.dropped === undefined && r.json?.dropNote === undefined, JSON.stringify(r.json).slice(0, 160));
  }

  console.log('\n[3] 分条接口（send-burst）同样截断 —— 两个入口不能一个改一个漏');
  {
    const key = KEYS[2];
    const agent = h.getSocialV2State(key).agentToken;
    const before = sentCount();
    const r = await req('/api/socialV2/send-burst', { key, token: agent, messages: ['a', 'b', 'c', 'd', 'e', 'f'] }, agent);
    check('HTTP 200 + ok（不是 400）', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 200));
    check(`只发了 ${MAX} 条`, sentCount() - before === MAX, `实际 ${sentCount() - before} 条`);
    check('带回 dropped=3', r.json?.dropped === 3, JSON.stringify({ dropped: r.json?.dropped }));
  }

  console.log('\n[4] 极端情况：一次塞 20 条也只能发上限那么多（防刷屏语义没被截断破坏）');
  {
    const key = KEYS[3];
    const agent = h.getSocialV2State(key).agentToken;
    const before = sentCount();
    const r = await req('/api/socialV2/send-message', {
      key, token: agent, messages: Array.from({ length: 20 }, (_, i) => `第${i + 1}条`),
    }, agent);
    check('HTTP 200', r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    check(`最多只发 ${MAX} 条`, sentCount() - before <= MAX, `实际 ${sentCount() - before} 条`);
    check('dropped 记录剩余 17 条', r.json?.dropped === 17, JSON.stringify({ dropped: r.json?.dropped }));
  }

  console.log('\n[5] 源码级：两个入口都必须"截断"而不是"拒绝"（改回旧写法立刻红）');
  {
    const src = fs.readFileSync('src/bridge.js', 'utf8');
    const truncations = (src.match(/const droppedMsgs = Math\.max\(0, messages\.length - maxMsgs\);/g) ?? []).length;
    check('两处入口都做了截断', truncations === 2, `找到 ${truncations} 处`);
    check('旧的"整条拒绝"文案已不存在（否则就是回退了）', !/请挑最要紧的 \$\{maxMsgs\} 条重发/.test(src));
    check('两边都用了 let messages（截断要能重新赋值，const 会 500）',
      (src.match(/let messages = Array\.isArray\(rawMessages\)/g) ?? []).length === 2,
      `找到 ${(src.match(/let messages = Array\.isArray\(rawMessages\)/g) ?? []).length} 处 let`);
  }
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
