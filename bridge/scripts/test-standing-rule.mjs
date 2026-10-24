/**
 * 回归测试：**他交代过的长期禁令不能进不了提示词**。
 *
 * 现场（2026-10-02）：他反复说过「宁大 CS2 交流群里别说话，只有点名叫我才回」，
 * 她照旧在 CS2 群接话、科普、反驳别人。查下来不是"没记住"——
 * 那条存进了 `memberImpressions['管理员 984776985']`，而记忆渲染里：
 *   ① 印象段排在【你还记得的事】/【你想说但还没说的】**之后**；
 *   ② 印象段自己按 interactionCount 排序，那条只有 2 分（44 条里垫底）；
 *   ③ 900 字预算被前面吃光，push 一直返回 false → **这条从来没进过任何一轮提示词**。
 * 结果就是"她明明记着，但每轮都看不见"。
 *
 * 这条锁死：禁令类印象必须**置顶**、且**限死 2 行**（不能长成"规矩大全"，
 * 那是之前被否掉的写法）。
 *
 * 用法: node scripts/test-standing-rule.mjs
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { memory: { maxInjectChars: 900 } } } });
const { formatMemoryV2, looksLikeStandingRule } = h;

try {
  console.log('\n[1] 判据：只认"对我下命令"的禁令，不认"描述别人"');
  const yes = [
    '他反复交代：宁大 CS2 交流群（795894138）里别说话，只有点名叫我才能回；群里技术问题、闲',
    '他说那个群里别冒泡，只有@我才能接话',
    '让我少在群里说话',
    '交代我：不要回应那群人的技术问题，别接话',
    '严禁在这个群里发言',
  ];
  const no = [
    '熊猫人永不为奴（群主/管理员）：爱@我发蓝发鲸鱼小人表情包逗我，还会P图（给小人头上扣锅）然后截图发',
    '李武7：凌晨还在打OW，阴阳怪气型：「ow好舒服啊」「队友全是屎」；和骨血8一起吐槽队友',
    '他：让我别对表情包做评价，喜欢直接发表情',
    '隨緣貓貓：会接梗，拿我名字开玩笑："烤兔肉，一块钱一串"；平时在群里跟人开麦打快速',
    '田雨阳：今天连着找我查战绩',
    '这人平时在群里不怎么说话',
    '好女孩viola：管理员账号，爱连着甩表情包逗我',
  ];
  for (const t of yes) check(`认：${t.slice(0, 22)}…`, looksLikeStandingRule(t) === true);
  for (const t of no) check(`不认：${t.slice(0, 22)}…`, looksLikeStandingRule(t) === false);

  console.log('\n[2] 渲染：垫底的禁令印象必须出现在记忆块里、且排在"对群友的印象"前面');
  const NOW = Date.now();
  const manyImps = {};
  // 44 条印象，interactionCount 都比禁令高 —— 复现"按分数排序时禁令垫底"
  for (let i = 0; i < 43; i++) {
    manyImps[`群友${i}`] = { traits: [`随便记的一条印象内容第${i}条，够长够占位置`], interactionCount: 20 - (i % 5) };
  }
  manyImps['管理员 984776985'] = {
    traits: ['他反复交代：宁大 CS2 交流群（795894138）里别说话，只有点名叫我才能回；群里技术问题别接'],
    interactionCount: 2,
    source: 'owner',
  };
  const st = {
    activeTopics: [
      { text: '中午看一集《无职转生》，看完跟他说感想', importance: 'normal', at: NOW - 3600_000, lastMentionAt: NOW - 3600_000 },
      { text: '★答应他：有结果叫他', importance: 'high', at: NOW - 7200_000, lastMentionAt: NOW - 7200_000 },
    ],
    memberImpressions: manyImps,
  };
  const text = formatMemoryV2(st);
  console.log('  —— 渲染结果（前 8 行）——');
  for (const line of text.split('\n').slice(0, 8)) console.log(`  ${line}`);
  check('禁令进了提示词（这就是之前漏掉的那条）', /CS2 交流群|别说话/.test(text), text.slice(0, 200));
  check('专门有一段【他交代过的规矩】', text.includes('【他交代过的规矩】'), text.slice(0, 200));
  check('排在【对群友的印象】之前（印象可以丢，规矩不能丢）',
    text.indexOf('【他交代过的规矩】') < text.indexOf('【对群友的印象】'));
  check('规矩段在整块的最上面', text.indexOf('【他交代过的规矩】') < text.indexOf('【你还记得的事】'));
  check('规矩段最多 2 行（不许长成"规矩大全"）',
    text.split('\n').filter((l) => /^【他交代过的规矩】/.test(l) || (text.indexOf('【他交代过的规矩】') < text.indexOf(l) && l.startsWith('- ') && text.indexOf(l) < (text.indexOf('【你还记得的事】') > -1 ? text.indexOf('【你还记得的事】') : text.length))).length <= 3,
    text.split('\n').slice(0, 6).join(' | '));
  check('规矩段没把整块记忆挤爆（话题还在）', text.includes('无职转生') || text.includes('有结果叫他'), text);

  console.log('\n[3] 负面：没有禁令印象时，不许凭空长出【他交代过的规矩】段');
  const plain = formatMemoryV2({
    activeTopics: [{ text: '他在打OW', importance: 'normal', at: NOW - 60000, lastMentionAt: NOW - 60000 }],
    memberImpressions: { 李武7: { traits: ['凌晨还在打OW，阴阳怪气型'], interactionCount: 3 } },
  });
  check('没有禁令 → 没有规矩段', !plain.includes('【他交代过的规矩】'), plain);
  check('普通印象照常渲染', plain.includes('【对群友的印象】') && plain.includes('李武7'), plain);

  console.log('\n[5] 禁令要能**穿过隐私过滤**进群；普通私聊记忆照旧不许进群');
  // 那道过滤本来是对的（他私聊说的私事不该在群里被引用），但它把"他下的命令"也一起挡了 ——
  // 禁令存在 coreMemory（source=owner），在群聊上下文里被 allow() 判为不可见 →
  // 她在出事那个群里每轮都看不到它。这是本条 bug 的第二层。
  h.socialV2.coreMemory = {
    activeTopics: [],
    pendingThoughts: [],
    memberImpressions: {
      '管理员 984776985': {
        traits: [
          '他反复交代：宁大 CS2 交流群（795894138）里别说话，只有点名叫我才能回',
          '他昨晚说自己在住院，让我别跟群里提', // ← 私事：不许进群
        ],
        source: 'owner',
      },
    },
  };
  const groupMem = h.formatMemoryV2ForChat('group:795894138', {});
  console.log('  —— 群聊（CS2 群）注入的记忆 ——');
  for (const line of groupMem.split('\n')) console.log(`  ${line}`);
  check('群聊里能看到"CS2 群别说话"这条禁令', /别说话|CS2 交流群/.test(groupMem), groupMem);
  check('禁令单独成段', groupMem.includes('【他交代过的规矩】'), groupMem);
  check('同一印象里的**私事**没有跟着漏进群', !/住院/.test(groupMem), groupMem);
  const privMem = h.formatMemoryV2ForChat('private:984776985', {});
  check('私聊里那条私事照旧可见（过滤只挡群，不挡私聊）', /住院/.test(privMem), privMem);

  console.log('\n[6] 真实记忆复现：库里那条禁令现在进得了提示词吗');
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../state/social-v2.json', import.meta.url), 'utf8'));
    const cm = raw.coreMemory ?? {};
    const real = formatMemoryV2({
      activeTopics: cm.activeTopics ?? [],
      pendingThoughts: cm.pendingThoughts ?? [],
      memberImpressions: cm.memberImpressions ?? {},
    });
    const has = /别说话|CS2 交流群|只有点名/.test(real);
    check('真实 coreMemory 里的"CS2 群里别说话"渲染出来了', has,
      has ? '' : '渲染结果里没有：说明判据没覆盖真实那条的写法');
    if (has) console.log('  —— 真实渲染命中行 ——\n' + real.split('\n').filter((l) => /别说话|CS2 交流群|只有点名/.test(l)).map((l) => `  ${l}`).join('\n'));
  } catch (e) {
    check('读真实记忆', false, String(e?.message ?? e));
  }
} finally {
  await h.close();
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
