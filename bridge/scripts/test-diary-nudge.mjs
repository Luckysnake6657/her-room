/**
 * 回归：「今天还没写日记」的轻提醒（2026-10-18，申请 #45）。
 *
 * 起因：管理员问「日记你最近在写吗」，发现 **10/17 一整天没写**（最近一条 10/16 23:43）。
 *   他要她自己"自觉"写，但光靠记性会断，所以报给我做机制。
 *
 * 三条硬约束（他明确说的，本用例逐条锁）：
 *   ① **不许每条消息都提醒**（会烦）→ 每天最多一次；
 *   ② 不新造通道、不扩能力面 → 只往已有的日记规则前面带一句话；
 *   ③ 每天第一次唤醒就够。
 *
 * ⚠️ 两个容易踩的坑，这里都钉住了：
 *   · **"提醒过"必须用内存标记，不能落盘**。落盘的话，离线测试只要渲染一次提示词，
 *     就会把当天的提醒用掉 —— 真实唤醒当天再也不提醒，**功能被测试吃没**。
 *   · harness 把 ROOT 指到临时目录，所以它渲染时"今天没写日记"恒成立（临时目录里没有日记文件）。
 *     "今天已经写过 → 不提醒"那条用 shouldNudgeDiary 纯函数覆盖，别靠渲染断言。
 *
 * 用法: node scripts/test-diary-nudge.mjs
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const KEY = '【今天还没写日记】';

console.log('\n[1] 判据矩阵：什么时候才该提醒');
{
  const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  try {
    const sn = h.shouldNudgeDiary;
    check('今天一条没写 + 今天没提醒过 → 提醒', sn({ todayCount: 0, today: '2026-10-18', lastNudgeDate: '' }) === true);
    check('今天已经写过 → 不提醒（10/17 那种"断了"才是要提醒的场景）',
      sn({ todayCount: 1, today: '2026-10-18', lastNudgeDate: '' }) === false);
    check('今天写过好几条 → 不提醒',
      sn({ todayCount: 5, today: '2026-10-18', lastNudgeDate: '' }) === false);
    check('今天已经提醒过（同一日期）→ 不提醒（这条保证"不会每条都念"）',
      sn({ todayCount: 0, today: '2026-10-18', lastNudgeDate: '2026-10-18' }) === false);
    check('昨天提醒过、今天还没写 → 仍要提醒（跨天要重新提醒）',
      sn({ todayCount: 0, today: '2026-10-18', lastNudgeDate: '2026-10-17' }) === true);
    check('没有 today 时不提醒（防脏输入乱报）', sn({ todayCount: 0, today: '', lastNudgeDate: '' }) === false);
    check('空参数不抛', (() => { try { sn(); return true; } catch { return false; } })());
  } finally { await h.close(); }
}

console.log('\n[2] 真的进得了提示词，而且一天只出现一次');
{
  // harness 的 ROOT 是临时目录 → 里面没有日记文件 → 走"该提醒"的分支
  const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  try {
    h.setMode('reserved2');
    const p1 = h.buildWakePromptV2('private:123', 'someone');
    const p2 = h.buildWakePromptV2('private:123', 'someone');
    const p3 = h.buildWakePromptV2('group:456', 'someone');
    console.log('    第1次私聊含提醒:', p1.includes(KEY), '｜第2次:', p2.includes(KEY), '｜群聊:', p3.includes(KEY));
    check('第一次唤醒能看到提醒', p1.includes(KEY));
    check('提醒里说清了"今天只出现这一次"（她不会以为被反复催）',
      p1.includes('今天只出现这一次') || p1.includes('只出现这一次'));
    check('提醒里给了怎么写（qq_write_diary）', p1.includes('qq_write_diary'));
    check('同一进程里第二次构建**不再出现**（这就是"不每条都念"）', !p2.includes(KEY));
    check('跨会话也不重复出现（标记是全局的，不是每会话一个）', !p3.includes(KEY));
    check('日记规则本身没被顶掉', p1.includes('【日记】') && p1.includes('想写就写'));
  } finally { await h.close(); }
}

console.log('\n[3] 日记功能关掉时不提醒（她连日记本都不该有）');
{
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, diary: { enabled: false } }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  try {
    h.setMode('reserved2');
    const p = h.buildWakePromptV2('private:123', 'someone');
    check('关掉后既没有提醒、也没有日记规则', !p.includes(KEY) && !p.includes('【日记】'));
  } finally { await h.close(); }
}

console.log('\n[4] 源码守卫（防以后改坏）');
{
  const src = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('提醒拼在 diaryLine 上（走已有的日记段，没新造通道）', /diaryNudgeLine\(\) \+ DIARY_RULE/.test(code));
  check('有内存标记 diaryNudgeShownOn', /let diaryNudgeShownOn = '';/.test(code));
  // ★ 最关键的一条：标记**不许落盘**。落盘 = 离线测试渲染一次就把当天提醒用掉。
  check('标记不写进 socialV2（否则测试会把当天提醒吃掉）',
    !/socialV2\.diaryNudge/.test(code) && !/diaryNudgeShownOn[\s\S]{0,40}saveSocialV2State/.test(code));
  check('提醒文案是独立常量（测试能直接断言）', /export const DIARY_NUDGE_TEXT/.test(code));
  check('判据是纯函数（可离线测）', /export function shouldNudgeDiary/.test(code));
  check('日记关掉时直接返回空（早退在判据之前）',
    /cfg\.socialV2\.diary\.enabled === false\) return '';/.test(code));
  // 别把提醒做成"每条消息都发"：它只在提示词里出现，不该有任何 QQ 发送调用
  const nudgeBlock = code.slice(code.indexOf('function diaryNudgeLine'), code.indexOf('function diaryNudgeLine') + 500);
  check('提醒段里没有任何发送/QQ 调用（纯提示词）', !/sendToQQ|onebotSend|send_private|send_group/.test(nudgeBlock));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
