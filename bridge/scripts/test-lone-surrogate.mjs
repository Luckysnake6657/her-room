/**
 * 回归测试：绝不让"半个 emoji"（孤立代理项）进入提示词。
 *
 * 背景（2026-09-28 真实故障）：私聊会话每一轮都报
 *   ⚠️ agent 处理出错：DeepSeek API error (HTTP 400)
 * 而群聊完全正常。原因是私聊自己那条记忆里有一句「你还有多少个号啊😨」，
 * 渲染记忆时 `String(t.text).slice(0, 60)` 正好切在 😨（\ud83d\ude28）中间，
 * 留下孤立高代理项 \ud83d。JSON 序列化后就是非法字符 → 请求被判 INVALID_REQUEST。
 * 因为那条记忆只属于私聊会话，所以只有私聊坏。
 *
 * 这里锁死三件事：
 *   1. clip() 按长度截断但绝不切碎代理对；stripLoneSurrogates() 能清掉脏字符。
 *   2. 记忆渲染器（真实函数）在 emoji 正好落在截断点上时不产生孤立代理项。
 *   3. 提示词出口 withSlangContext() 是最后一道网：不管上游塞什么进来都能兜住。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasLone = (s) => LONE.test(String(s));

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const bridge = await bridgeHarness({
  config: {
    socialV2: {
      memory: { maxInjectChars: 900 },
      session: { maxHistoryBytes: 2097152 },
    },
  },
});

try {
  const { clip, stripLoneSurrogates, formatMemoryV2, withSlangContext, appendMemoryV2, getSocialV2State } = bridge;

  console.log('\n[1] clip() 按长度截断但不切碎 emoji');
  // 😨 占 2 个码元（\ud83d \ude28）。切在 1 个码元处只能得到那半个字符。
  check('clip 边界正好落在 emoji 中间时不产生孤立代理项', !hasLone(clip('ab😨cd', 3)),
    JSON.stringify(clip('ab😨cd', 3)));
  check('clip 丢掉那半个字符（结果是 "ab"）', clip('ab😨cd', 3) === 'ab', JSON.stringify(clip('ab😨cd', 3)));
  check('边界落在 emoji 之后时保留完整 emoji', clip('ab😨cd', 4) === 'ab😨', JSON.stringify(clip('ab😨cd', 4)));
  check('未超长时原样返回', clip('ab😨cd', 99) === 'ab😨cd');
  check('超长但切点安全时正常截断', clip('hello world', 5) === 'hello');
  check('纯 emoji 串反复截断都不产生孤立代理项',
    Array.from({ length: 40 }, (_, i) => clip('😨😨😨😨😨😨😨😨', i + 1)).every((s) => !hasLone(s)));
  check('maxChars=0 返回空串', clip('abc', 0) === '');
  check('null/undefined 安全', clip(null, 10) === '' && clip(undefined, 10) === '');

  console.log('\n[2] stripLoneSurrogates() 清除脏字符');
  check('清掉孤立高代理项', stripLoneSurrogates('aa\ud83dbb') === 'aabb');
  check('清掉孤立低代理项', stripLoneSurrogates('aa\ude28bb') === 'aabb');
  check('保留成对代理项（合法 emoji）', stripLoneSurrogates('a😨b') === 'a😨b');
  check('混合时只清坏的', stripLoneSurrogates('😨\ud83d😨') === '😨😨');
  check('纯 ASCII 快速路径原样返回', stripLoneSurrogates('plain text') === 'plain text');

  console.log('\n[3] 记忆渲染器（真实函数）不再产出半个 emoji');
  // 造一条"emoji 正好坐在第 60 个码元上"的记忆 —— 就是线上出事的那条。
  const st = getSocialV2State('private:999');
  st.activeTopics = [];
  const prefix = '他让我在群里补两句关于甘志恒连甩ID的话：「已经三个号了大哥」「你还有多少个号啊';
  // 把 emoji 精确推到第 60/61 码元处，复现线上截断点
  const pad = 'x'.repeat(Math.max(0, 59 - prefix.length));
  const text = `${prefix}${pad}😨」，两条都用代发（自动确认）发出去了。`;
  st.activeTopics.push({ text, lastMentionAt: Date.now(), importance: 'normal' });
  const rendered = formatMemoryV2(st);
  check('渲染出的记忆不含孤立代理项', !hasLone(rendered), JSON.stringify(rendered.slice(0, 120)));
  check('渲染结果非空且确实是这条记忆', rendered.includes('你还有多少个号'), rendered.slice(0, 120));
  // 极端情况：整条记忆全是 emoji
  st.activeTopics = [{ text: '😨'.repeat(80), lastMentionAt: Date.now(), importance: 'high' }];
  check('整条记忆都是 emoji 时也不产生孤立代理项', !hasLone(formatMemoryV2(st)));
  // 印象（traits）路径同样要干净
  st.activeTopics = [];
  st.memberImpressions = { '测试的人': { traits: ['😨'.repeat(60)], interactionCount: 3, lastSeenAt: Date.now() } };
  check('印象（traits）渲染同样干净', !hasLone(formatMemoryV2(st)));

  console.log('\n[4] 提示词出口是最后一道网');
  check('withSlangContext 会清掉上游漏进来的孤立代理项',
    !hasLone(withSlangContext('记忆里混了坏字符：aa\ud83dbb')));
  check('withSlangContext 保留合法 emoji',
    withSlangContext('正常 emoji：😨').includes('😨'));
  check('withSlangContext 仍然带上时间行',
    withSlangContext('正文').includes('【当前时间】'));
  check('withSlangContext 仍然保留正文',
    withSlangContext('正文内容').includes('正文内容'));

  console.log('\n[5] 记忆入库时净化，脏字符不会写进存档');
  const st2 = getSocialV2State('private:998');
  st2.activeTopics = [];
  appendMemoryV2(st2, 'activeTopic', '他问「你还有多少个号啊\ud83d」，我回了', {}, 'private:998');
  const stored = st2.activeTopics.map((t) => t.text).join('\n');
  check('入库的话题文本不含孤立代理项', !hasLone(stored), JSON.stringify(stored));
  const st3 = getSocialV2State('private:997');
  appendMemoryV2(st3, 'activeTopic', '正常内容', { pendingQuestion: '他说\ud83d什么？' }, 'private:997');
  check('入库的 pendingQuestion 不含孤立代理项',
    !hasLone(st3.activeTopics.map((t) => t.pendingQuestion || '').join('')));
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
