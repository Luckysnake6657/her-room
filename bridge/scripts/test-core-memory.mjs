// 跨会话记忆的隐私边界测试。
//
// 直接 import bridge.js 里模块级的纯函数 filterMemoryForChat（与运行时同一份实现），
// 再用线上真实的 coreMemory 数据构造断言。跑法：
//   node scripts/test-core-memory.mjs
process.env.QQ_BRIDGE_PROBE = '1';

import fs from 'node:fs';
const { filterMemoryForChat } = await import('file:///D:/qq-bridge/src/bridge.js');

const state = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const realCore = state.coreMemory ?? { activeTopics: [], pendingThoughts: [], memberImpressions: {} };
console.log('读取线上 coreMemory，条目数:',
  `话题 ${realCore.activeTopics.length} / 想法 ${realCore.pendingThoughts.length} / 印象 ${Object.keys(realCore.memberImpressions).length}`);

// 合成一批覆盖各种来源的数据，确保各分支都被测到
const core = {
  activeTopics: [
    { text: '私聊话题：他发了《奥德赛》截图', source: 'owner', lastMentionAt: Date.now() },
    { text: 'A群话题：聊了CS2比赛', source: 'group:111', lastMentionAt: Date.now() },
    { text: 'B群话题：聊了无畏契约', source: 'group:222', lastMentionAt: Date.now() },
  ],
  pendingThoughts: [
    { text: '私聊想法：想问他要不要一起看', source: 'owner' },
    { text: 'A群想法：想吐槽那个操作', source: 'group:111' },
  ],
  memberImpressions: {
    '他（owner）': { traits: ['嘴硬'], interactionCount: 3, source: 'owner' },
    '小明': { traits: ['爱玩CS'], interactionCount: 2, source: 'group:111' },
    '阿强': { traits: ['话少'], interactionCount: 1, source: 'group:222' },
  },
};

const texts = (o) => [
  ...o.activeTopics.map((t) => t.text),
  ...o.pendingThoughts.map((t) => t.text),
  ...Object.keys(o.memberImpressions),
];

const cases = [
  {
    name: '私聊：可见私聊来源记忆',
    key: 'private:984776985',
    expect: ['私聊话题：他发了《奥德赛》截图', '私聊想法：想问他要不要一起看', '他（owner）'],
    forbid: [],
  },
  {
    name: '群 A：可见本群 + 其它群，不可见私聊',
    key: 'group:111',
    expect: ['A群话题：聊了CS2比赛', 'B群话题：聊了无畏契约', '小明', '阿强'],
    forbid: ['私聊话题：他发了《奥德赛》截图', '私聊想法：想问他要不要一起看', '他（owner）'],
  },
  {
    name: '群 B：同样不可见私聊',
    key: 'group:222',
    expect: ['B群话题：聊了无畏契约', 'A群话题：聊了CS2比赛'],
    forbid: ['私聊话题：他发了《奥德赛》截图', '他（owner）'],
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const out = filterMemoryForChat({ key: c.key, st: null, coreMemory: core });
  const got = texts(out);
  const missing = c.expect.filter((e) => !got.includes(e));
  const leaked = c.forbid.filter((f) => got.includes(f));
  const ok = missing.length === 0 && leaked.length === 0;
  if (ok) pass++; else fail++;
  console.log(`\n${ok ? '✅' : '❌'} ${c.name}  [${c.key}]`);
  console.log('   可见:', got.join(' | ') || '(空)');
  if (missing.length) console.log('   ❌ 缺少:', missing.join(' | '));
  if (leaked.length) console.log('   ❌ 泄露:', leaked.join(' | '));
}

// 用线上真实数据再做一次"私聊内容不得进群"的回归
const realOut = filterMemoryForChat({ key: 'group:1124778377', st: null, coreMemory: realCore });
const realLeak = [
  ...realOut.activeTopics.map((t) => t.text),
  ...Object.keys(realOut.memberImpressions),
].filter((t) => String(t).includes('奥德赛') || String(t).includes('owner'));
console.log(`\n${realLeak.length === 0 ? '✅' : '❌'} 线上真实数据：私聊记忆（《奥德赛》/owner 印象）未进入群会话`);
if (realLeak.length) console.log('   泄露内容:', realLeak.join(' | '));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 && realLeak.length === 0 ? 0 : 1);
