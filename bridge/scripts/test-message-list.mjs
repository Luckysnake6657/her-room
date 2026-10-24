/**
 * 回归：消息列表解析（2026-10-01 真实事故）。
 *
 * 她在 QQ 上发出来的是**一个气泡里的原始 JSON**：
 * ```
 * ["你都坐这儿跟我贫了，肯定是赶上了", "几点的车"，"不对，问错了", "睡了没"]
 * ```
 * 根因：她把 `messages` 传成了字符串，第 3 项前面是**全角逗号**（，），于是
 * `JSON.parse` 抛错、`catch {}` 什么都不做 → 整串（带方括号和引号）当一条消息发了出去。
 * 最糟的是它**不报错、不重试、用户直接看到原始 JSON**。
 *
 * 所以这里锁三件事：
 *   ① `parseMessageList` 能把各种"模型手滑形状"都切开，且**不改消息内容**；
 *   ② 「[图片]」「[链接] 看这个」这类正常消息**不许被误拆**；
 *   ③ 桥接端到端：拿那串真·事故字符串打发送接口 → 必须发成 4 个气泡，而不是 1 条。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseMessageList } from '../src/message-list.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 事故原文（一字不改，含那个全角逗号）
const INCIDENT = '["你都坐这儿跟我贫了，肯定是赶上了", "几点的车"，"不对，问错了", "睡了没"]';

console.log('\n[1] 各种"手滑形状"都能切开，且内容不变');
{
  const cases = [
    ['事故原文（全角逗号）', INCIDENT, 4],
    ['干净 JSON 数组字符串', '["那就行", "今天你那边还有事吗"]', 2],
    ['每个元素后面都是全角逗号', '["甲"，"乙"，"丙"]', 3],
    ['全角引号 + 全角逗号', '［“你好”，“在吗”］', 2],
    ['单引号数组', "['a', 'b', 'c']", 3],
    ['包在 markdown 围栏里', '```json\n["a", "b"]\n```', 2],
    ['真的是数组', ['a', 'b'], 2],
    ['嵌套数组也拍平', [['a'], ['b', 'c']], 3],
    ['JSON 字符串单条', '"你好"', 1],
  ];
  for (const [label, input, want] of cases) {
    const r = parseMessageList(input);
    check(`${label} → ${want} 条`, r.messages.length === want, `${r.messages.length} 条：${JSON.stringify(r.messages)}`);
  }
  const r = parseMessageList(INCIDENT);
  check('★ 事故原文切开后**内容逐字不变**（全角逗号还在）',
    r.messages[0] === '你都坐这儿跟我贫了，肯定是赶上了' && r.messages[2] === '不对，问错了',
    JSON.stringify(r.messages));
  check('修复时明确告诉调用方"我改过参数了"（便于提醒模型下次传数组）', r.repaired === true && !!r.note, JSON.stringify({ repaired: r.repaired, note: r.note }));
}

console.log('\n[2] 正常消息不许被误拆');
{
  const cases = [
    ['[图片]', 1, '[图片]'],
    ['[表情包:盯]', 1, '[表情包:盯]'],
    ['[链接] 你看这个', 1, '[链接] 你看这个'],
    ['在吗', 1, '在吗'],
    ['“你好”', 1, '你好'],          // 整句只有一段引号 → 剥掉引号（跟 "\"你好\"" 一致）
    ['["单条"]', 1, '单条'],
  ];
  for (const [input, want, wantText] of cases) {
    const r = parseMessageList(input);
    check(`「${input}」→ ${want} 条${wantText !== input ? `（内容「${wantText}」）` : ''}`,
      r.messages.length === want && r.messages[0] === wantText, JSON.stringify(r.messages));
  }
  check('空串 → 0 条（不会发空消息）', parseMessageList('').messages.length === 0);
  check('null/undefined → 0 条', parseMessageList(null).messages.length === 0 && parseMessageList(undefined).messages.length === 0);
}

console.log('\n[3] 端到端：手滑字符串打真接口，必须切开而不是原样发出');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.send ?? {};
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, send: CFG } } });
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
    req.setTimeout(15000, () => req.destroy(new Error('接口没响应')));
    req.end(JSON.stringify(body));
  });
  try {
    // ① 三条 + 全角逗号（同一类手滑）→ 必须发成 3 个气泡
    const THREE = '["你都坐这儿跟我贫了，肯定是赶上了"，"几点的车"，"睡了没"]';
    const r = await post('/api/socialV2/send-message', { key: 'private:123', messages: THREE, gapMode: 'fixed', gapMs: 1500 });
    check('三条的手滑串 → 发成 3 条', r.status === 200 && r.json?.sent === 3, JSON.stringify(r));
    const calls = (h.calls?.http ?? []).filter((c) => c.action === 'send_private_msg');
    check('OneBot 那边确实收到 3 次发送', calls.length === 3, JSON.stringify(calls.length));
    const texts = calls.map((c) => (c.body?.message ?? []).find((x) => x?.type === 'text')?.data?.text ?? '');
    check('3 条正文逐字对得上（没有方括号/引号残留）',
      JSON.stringify(texts) === JSON.stringify(['你都坐这儿跟我贫了，肯定是赶上了', '几点的车', '睡了没']),
      JSON.stringify(texts));
    check('没有任何一条是"整串 JSON"', !texts.some((t) => t.startsWith('[') && t.includes('","')), JSON.stringify(texts));
    check('返回里带"参数已自动修复"的提示（她下次就知道要传数组）', /自动修复/.test(String(r.json?.note ?? '')), JSON.stringify(r.json?.note));
    // ② 事故原文（4 条）→ 超过"一次最多 3 条"。
    //    ⚠️ 2026-10-12 晚改过语义：原来是**整条拒绝 400**，现在改成**截断到 3 条 + 告知剩余**
    //    （理由：末 1000 次工具调用里 11 次栽在超限拒绝上，每次都要"被拒 → 重新组织 → 再发"，
    //     白跑一整轮模型推理）。但这条事故的**核心安全断言一条都不能少**：
    //     发出去的必须是**解析后的正文**，绝不能把原始 JSON 串发到 QQ。
    const before = calls.length;
    const r4 = await post('/api/socialV2/send-message', { key: 'private:123', messages: INCIDENT });
    check('4 条 → 截断成 3 条（200，不再整条拒绝）', r4.status === 200 && r4.json?.ok === true && r4.json?.sent === 3,
      JSON.stringify(r4).slice(0, 200));
    check('返回值说清还剩几条（dropped + dropNote）',
      r4.json?.dropped === 1 && /还有 1 条没发/.test(String(r4.json?.dropNote ?? '')),
      JSON.stringify({ dropped: r4.json?.dropped, dropNote: r4.json?.dropNote }));
    const after = (h.calls?.http ?? []).filter((c) => c.action === 'send_private_msg');
    const sent4 = after.slice(before).map((c) => (c.body?.message ?? []).find((x) => x?.type === 'text')?.data?.text ?? '');
    check('只多发 3 条（不是 4 条、也不是 0 条）', after.length - before === 3, `发送次数 ${after.length}（之前 ${before}）`);
    check('发出的**全是解析后的正文**，没有原始 JSON 混进去',
      sent4.length === 3 && !sent4.some((t) => t.startsWith('[') || t.includes('"type"') || t.includes('\\"')),
      JSON.stringify(sent4));
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
