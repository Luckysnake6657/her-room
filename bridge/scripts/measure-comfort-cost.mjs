/**
 * 量 2026-10-01 这一轮（安慰规则 + 别只说结论 + 【刚发生的几条】）的 token 代价。
 * 换算沿用项目口径：提示词基本是中文，×0.62 token/字符。
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const real = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const b = await bridgeHarness({ config: { socialV2: { enabled: true, memory: { maxInjectChars: 850 } } } });
const T = (n) => Math.round(n * 0.62);
try {
  b.setMode('reserved2');
  b.socialV2.coreMemory = real.coreMemory;
  const st = b.getSocialV2State('private:984776985');
  const now = Date.now();

  // 场景 A：安静（只有一条旧消息）—— 【刚发生的几条】不出现
  st.recentMessages = [{ sender: '他', text: '睡了没', time: now - 3 * 3600000, seq: 815 }];
  st.unread = [];
  const quiet = b.buildWakePromptV2('private:984776985', 'private');
  // 场景 B：刚聊起来（4 条）—— 出现
  st.recentMessages = [
    { sender: '他', text: '发烧不至于', time: now - 4 * 60000, seq: 811 },
    { sender: '他', text: '嗓子好难受…', time: now - 2 * 60000, seq: 812 },
    { sender: '', text: '没烧就好办', time: now - 60000, isSelf: true },
    { sender: '他', text: '阿莫西林能吃吗', time: now - 30000, seq: 813 },
  ];
  st.unread = st.recentMessages.filter((m) => !m.isSelf);
  const hot = b.buildWakePromptV2('private:984776985', 'private');

  const seg = (p, head, tail) => {
    const i = p.indexOf(head);
    if (i < 0) return 0;
    // 块自己以 \n\n 结尾；给 tail 时再用下一个块头兜底（tail 可能在 head 之前，别用 indexOf 裸比）
    const j = p.indexOf('\n\n', i);
    if (j > i && !tail) return j - i;
    const k = tail ? p.indexOf(tail, i) : -1;
    if (k > i) return k - i;
    return (j > i ? j : p.length) - i;
  };
  const comfort = seg(quiet, '【别人不好受时怎么接】', '【只报做过的】');
  const recentHot = seg(hot, '【刚发生的几条】', '【要不要引用回复】');
  const conclusion = seg(quiet, '- **别只说结论**', '【跨会话的规矩要记下来】');

  console.log(`安静时的整份提示词: ${quiet.length} 字符 ≈ ${T(quiet.length)} token`);
  console.log(`刚聊起来时:         ${hot.length} 字符 ≈ ${T(hot.length)} token`);
  console.log('\n本轮新增（一直都会注入的）:');
  console.log(`  【别人不好受时怎么接】 ${comfort} 字符 ≈ ${T(comfort)} token`);
  console.log(`  【搭得上话】新增三条   ${conclusion} 字符 ≈ ${T(conclusion)} token`);
  const promise = (() => {
    const i = quiet.indexOf('【答应了就要留个锚】');
    if (i < 0) return 0;
    const end = quiet.indexOf('对方一直等。', i);
    return end > i ? (end + '对方一直等。'.length - i) : 0;
  })();
  console.log(`  【答应了就要留个锚】   ${promise} 字符 ≈ ${T(promise)} token`);
  console.log(`  小计                  ${comfort + conclusion + promise} 字符 ≈ ${T(comfort + conclusion + promise)} token`);
  console.log('\n只在"刚聊起来"时出现（安静时是 0）:');
  console.log(`  【刚发生的几条】       ${recentHot} 字符 ≈ ${T(recentHot)} token`);
  console.log(`  （它顶掉的旧【这轮要回哪条，引用 id 直接给你】约 150 字符 ≈ ${T(150)} token）`);
} finally {
  await b.close();
}
