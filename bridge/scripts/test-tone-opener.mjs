/**
 * 回归：「行，……」当起句口头禅（2026-10-16，申请 #41）。
 *
 * 现场（他连指出四次，网关日志 23:30~23:33 原话，逐条可查）：
 *   23:30:18 她发「**行，记你账上了**」→ 23:30:29 他回「为啥记账」
 *   23:31:23 她发「**行，下次我直接说记住了**」→ 23:31:35 他回「**你看**」
 *   23:31:40 他「**还是行**」
 *   23:32:23 他「**这个我看已经成你口头禅了**」
 *   23:32:59 他「接话有没有更口语化的」
 *   23:33:38 他「**你说话得练练口语化了**」
 *
 * 他要的三样（本用例逐条锁）：
 *   ① 明确禁掉「行」「好的」「收到」这类公文式起句（尤其「行，……」句式）
 *   ② 口语化给**可操作判据**（具体替代词 + 允许语气词），不是只有"口语化"三个字
 *   ③ **反例存原话**（他早先交代过：别只写抽象规则）
 *
 * 为什么必须锁：这条规矩的价值**全在具体性**上。如果哪天有人把它改回
 * "要口语化一点"这种抽象话，规则还在、probe 还在，但**等于没写** ——
 * 所以这里断言的是"具体内容"，不是"有没有这一节"。
 *
 * 用法: node scripts/test-tone-opener.mjs
 */
import { TONE_AND_LAYOUT, RULE_INVENTORY } from '../src/prompt-rules.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const T = TONE_AND_LAYOUT;

console.log('\n[1] ① 公文式起句要明确禁掉（含「行，……」这个具体句式）');
{
  check('点名了「行」', /「行」/.test(T));
  check('点名了「好的」', /「好的」/.test(T));
  check('点名了「收到」', /「收到」/.test(T));
  check('点出了「行，……」这个句式', /「行，……」/.test(T));
  check('说清了为什么（同一个字反复用＝口癖）', /口癖/.test(T));
}

console.log('\n[2] ② 口语化要可操作：给具体替代词 + 允许语气词');
{
  // 至少给出 3 个可用的日常替代词
  const alts = ['成', '中', '懂了', '知道了', '好嘞', '嗯', '也是', '这么一说'];
  const hit = alts.filter((w) => T.includes(w));
  check(`给了具体替代词（命中 ${hit.length} 个：${hit.join('/')}）`, hit.length >= 3, hit.join('/'));
  check('明确允许语气词', /语气词/.test(T));
  for (const p of ['啊', '吧', '呢', '诶']) check(`允许语气词「${p}」`, T.includes(p));
  check('⚠️ 但没有推翻"别夹日文假名"那条（两者要能共存）',
    /别夹日文假名/.test(T) && /の、nya/.test(T));
}

console.log('\n[3] ③ 反例存原话（他交代过：别只写抽象规则）');
{
  check('存了「行，记你账上了」', T.includes('行，记你账上了'));
  check('存了「行，下次我直接说记住了」', T.includes('行，下次我直接说记住了'));
  check('也存了他的原话「还是行」', T.includes('还是行'));
  check('也存了他的原话「这个我看已经成你口头禅了」', T.includes('这个我看已经成你口头禅了'));
}

console.log('\n[4] 别把这一节的既有规矩弄丢（改一处不能砸别处）');
{
  check('仍要求"一条消息 = 一个短句"', /一条消息 = 一个短句/.test(T));
  check('仍要求"中文句子内部不留空格"', /中文句子内部不留空格/.test(T));
  check('仍有"别过度玩梗"', /别过度玩梗/.test(T));
  check('仍禁用 emoji 和括号动作', /不用 emoji 和颜文字/.test(T));
  check('新增内容没有孤立代理项（会让整个请求 400）',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(T));
}

console.log('\n[5] 真的进了她这一轮的提示词（私聊 + 群聊都要有）');
{
  const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
  try {
    h.setMode('reserved2');
    const priv = h.buildWakePromptV2('private:123', 'someone');
    const grp = h.buildWakePromptV2('group:456', 'someone');
    check('私聊提示词里有这条规矩', priv.includes('别拿「行」「好的」「收到」当起句口头禅'));
    check('群聊提示词里有这条规矩', grp.includes('别拿「行」「好的」「收到」当起句口头禅'));
    check('两个原话反例也真的进了提示词', priv.includes('行，记你账上了') && priv.includes('行，下次我直接说记住了'));
    // 清单里也要有它（否则"这条规矩还在不在"没人守）
    check('RULE_INVENTORY 里有登记', RULE_INVENTORY.some((i) => i.key === 'tone-no-formal-opener'));
  } finally {
    await h.close();
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
