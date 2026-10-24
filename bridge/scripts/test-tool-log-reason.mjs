/**
 * 回归测试：**工具日志必须记下失败原因**（2026-10-01 事故）。
 *
 * 现场：她 20:05:28 想补一句「连人机验证都不让我过，挂着转圈」，被"连发"闸门拒了
 * （她已经连发 2 条、中间没人说话，再传 2 条 = 4 > 上限 3）。这条**永远没到你手上**，
 * 于是对话看起来像"你发表情包、她突然说'行，那我就蹲着'"。
 * 去查 why 的时候发现：`state/tool-calls.jsonl` 里 45 条失败的 `error` **全是 null** —— 等于黑盒。
 *
 * 根因：DSH 的 `tool/result` 事件结构是**嵌套两层**的
 *   message.content[0] = { type:'tool-result', isError, content:[{type:'text', text:'…'}] }
 * 而记录器读的是 `content[0].text`（那一层没有 text 字段）→ 永远拿到空串。
 *
 * 这个用例锁死：各种真实形状都能抠出原因，且**正常超时不算失败**。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  const f = h.describeToolResult;

  console.log('\n[1] 真实结构：失败时的原因在 content[0].content[0].text');
  const mcpError = {
    role: 'user',
    content: [{
      type: 'tool-result', toolCallId: 'c1', isError: true,
      content: [{ type: 'text', text: '发送失败：你已经连发 2 条、中间**没有人说话**（上限 3 条）。…先等约 45 秒' }],
    }],
  };
  const r1 = f(mcpError);
  check('失败被识别出来', r1.ok === false);
  check('**原因抠出来了**（不再 error: null）', /连发 2 条/.test(String(r1.error)), JSON.stringify(r1));

  console.log('\n[1b] MCP 工具的**平铺**形状：原因在 content[0].text（2026-10-10 她发文件被拒只留下 "[]"）');
  const flatMcpError = {
    content: [{ type: 'text', text: '发送文件失败：只允许发 state/outbox 里的文件（出站目录）。' }],
    isError: true,
  };
  const r1b = f(flatMcpError);
  check('失败被识别出来', r1b.ok === false);
  check('原因抠出来了（不是 "[]"）',
    /只允许发 state\/outbox/.test(String(r1b.error)) && r1b.error !== '[]', JSON.stringify(r1b));

  console.log('\n[2] 成功的结果不能被误判成失败');
  const okMsg = {
    content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '{"ok":true}' }] }],
  };
  const r2 = f(okMsg);
  check('ok=true', r2.ok === true);
  check('成功时不记 error', r2.error === null, JSON.stringify(r2));

  console.log('\n[3] 其它真实形状（别只认一种）');
  check('isError 挂在 message 上也能认',
    f({ isError: true, content: [{ type: 'tool-result', content: [{ type: 'text', text: '炸了' }] }] }).ok === false);
  check('原因在 block.error 上也能认',
    /超时/.test(String(f({ content: [{ type: 'tool-result', isError: true, error: '超时' }] }).error)));
  check('整块没有文本时，兜底留一段 JSON（宁可长也别留白）',
    (() => { const r = f({ content: [{ type: 'tool-result', isError: true, content: [{ type: 'image', data: 'x' }] }] }); return r.ok === false && r.error === null ? false : true; })());
  check('**真的什么都没有**时记 null，而不是误导性的 "[]"',
    (() => { const r = f({ content: [{ type: 'text', text: '' }], isError: true }); return r.ok === false && r.error === null; })());
  check('空消息不炸（事件缺字段时不能把主流程带崩）',
    f(undefined).ok === true && f(null).ok === true && f({}).ok === true);

  console.log('\n[4] 记录器真的用上了它（源码级，防止又被改回读 content[0].text）');
  const src = await import('node:fs').then((fs) => fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8'));
  check('tool/result 分支调用 describeToolResult', /const verdict = describeToolResult\(frame\.event\.data\?\.message\)/.test(src));
  check('不再有旧的 resultBlock?.text 直读写法', !/String\(resultBlock\?\.text/.test(src));
  check('发送成功的判定也走 verdict（否则引用/代发会跟着错）', /if \(verdict\.ok\) \{/.test(src));
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
