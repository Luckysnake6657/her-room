/**
 * 回归测试：系统回执不许"假装是她说的"（2026-10-10 管理员反馈："感觉像是另一个人格了"）。
 *
 * 现场：桥接把「🔓 全路径许可已开…」「⏳ 系统服务重启中…」这类回执**用她的 QQ 号**发给管理员
 * （只有她一个号，没法换号）。于是：
 *   ① 管理员往上翻聊天记录，看到的是"她在说系统话"；
 *   ② 她自己的上下文里**没有**这些回执 —— 被问起时只能发懵或否认，像两个人。
 * 更糟的一例：排队提示原本发进"出事的会话"，实测 19:23~19:25 同一个群连发 6 条系统播报
 *（而且它绕过了全局静默"群里一个字都不发"）。
 *
 * 现在锁死三件事：
 *   [1] 发给管理员的系统消息**统一带【系统】前缀**，而且**只发给管理员**（绝不进群）；
 *   [2] 同一件事**同时**在她上下文里留一条 `系统代发` 便条（写明"不是你说的"）；
 *   [3] 已经写过更具体便条的场景（例如许可）不重复写（record:false）；
 *   [4] 便条不会撑爆上下文（按 recentLimit 裁剪）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const GKEY = 'group:456';
const PKEY = 'private:123';   // harness 的 ownerQQ = 123
const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
try {
  h.setMode('reserved2');
  const sentTo = (id) => h.calls.sent.filter((s) => String(s.id) === String(id)).map((s) => s.text);
  const notesOf = (key) => (h.getSocialV2State(key)?.recentMessages ?? []).filter((m) => m.system === true);

  console.log('\n[1] 回执带【系统】前缀，且只发给管理员（绝不进群）');
  const before456 = sentTo(456).length;
  const before123 = sentTo(123).length;
  await h.notifyOwnerSystem('🔇 测试回执', { key: GKEY });
  // 2026-10-19 起 notifyOwnerSystem 不再发 QQ（管理员：全关呗，真有问题了我会在客户端上面调）
  check('不再往 QQ 发系统消息（他在控制台看）',
    (h.calls.sent ?? []).filter((x) => String(x.id) === '123').length === 0,
    JSON.stringify((h.calls.sent ?? []).slice(-2)));
  // 2026-10-19：不再发 QQ，所以没有可查的前缀（门函数还在，只是不出门）
  check('不再有可发的系统消息', sentTo(123).length === 0, `123: ${sentTo(123).length}`);
  check('出事的群一条都没多发', sentTo(456).length === before456, `456: ${before456} → ${sentTo(456).length}`);

  console.log('\n[2] 同时在她上下文里留一条"系统代发"便条（写明不是她说的）');
  const notes = notesOf(GKEY);
  const last = notes[notes.length - 1];
  check('便条进了她的上下文', notes.length >= 1, `notes=${notes.length}`);
  check('便条标明"不是你说的"', /不是你说的/.test(String(last?.text ?? '')), String(last?.text ?? '').slice(0, 120));
  check('便条带上了回执正文', /测试回执/.test(String(last?.text ?? '')));
  check('便条是 system 类型（不会被她当成自己发过的话）', last?.system === true && last?.isSelf !== true);

  console.log('\n[3] 已经写过更具体便条的场景不重复写（record:false）');
  const n0 = notesOf(GKEY).length;
  await h.notifyOwnerSystem('🔓 许可回执（这件事已有专门便条）', { key: GKEY, record: false });
  check('没有新增便条', notesOf(GKEY).length === n0, `${n0} → ${notesOf(GKEY).length}`);
  check('record:false 也不发 QQ', sentTo(123).length === 0);

  console.log('\n[4] 不给 key 时便条落到管理员私聊（她跟他说话的那个会话）');
  const p0 = notesOf(PKEY).length;
  await h.notifyOwnerSystem('⏳ 排队提示', {});
  check('落到管理员私聊', notesOf(PKEY).length === p0 + 1 && /排队提示/.test(String(notesOf(PKEY).slice(-1)[0]?.text ?? '')));

  console.log('\n[5] 便条不会撑爆上下文（按 recentLimit 裁剪）');
  const st = h.getSocialV2State(GKEY);
  const limit = Number(h.cfg.socialV2?.context?.recentLimit) || 100;
  for (let i = 0; i < limit + 40; i++) {
    st.recentMessages.push({ sender: '对方', text: `填充 ${i}`, plain: `填充 ${i}`, media: [], time: Date.now() });
  }
  await h.notifyOwnerSystem('🔊 收尾回执', { key: GKEY });
  check(`上下文被裁到上限以内（${limit}）`, st.recentMessages.length <= limit, `长度=${st.recentMessages.length}`);

  console.log('\n[6] 源码级：固定系统文案不许再"发进会话"');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  // 2026-10-19：notifyOwnerSystem 不再发 QQ（管理员："全关呗，真有问题了我会在客户端上面调"），
  // 所以"带【系统】前缀"不再成立；只守"门函数还在 + 确实不再 sendToQQ"。
  check('统一出口还在，且不再发 QQ',
    /async function notifyOwnerSystem\(/.test(src)
    && !/return sendToQQ\(`private:\$\{cfg\.ownerQQ\}`/.test(src));
  // ⚠️ 2026-10-19 行为变了：管理员说"这个系统别出现在聊天界面"——
  //   排队提示连"管理员私聊"也不发了，**只记日志 + 控制台活动流**。
  //   判据：他做了动作需要回执 → 发；系统自己的状态变了 → 只记日志。
  check('排队提示只记日志（不发任何人）',
    !/sendToQQ\(key, '⏳/.test(src)
    && !/notifyOwnerSystem\(`⏳ DSH 还没就绪/.test(src)
    && /log\(`\[queue\] ⏳ DSH 还没就绪/.test(src));
  const groupNoise = (src.match(/sendToQQ\(key, '(⏳|🔇|🔊|🔓|🔒|✅|🚫)/g) ?? []).length;
  check('没有固定系统文案直接发进会话的写法', groupNoise === 0, `还有 ${groupNoise} 处`);
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
