// 修两条"让她语气硬"的跨会话记忆（只更新、不删除 —— 这是早就定下的规矩）。
//
// 背景（管理员 2026-09-29：「也别太嘴硬…她说话语气太硬了」）：
//   她的 coreMemory 里同时躺着两条互相矛盾的东西：
//     ① "正在扮演「艾莉丝·格雷拉特」…还让我用这套口吻在 OW 群和 CS 群说话：短句、直、不绕" ← **早就结束了**，但一直每轮注入
//     ② "…在那群说话短、损一点反而容易被接" ← 她自己总结的群风，直接把她往"短、损"推
//   角色已经到点结束（另一条记忆里写着），① 属于过期还会误导的旧账；
//   ② 不是错（群确实爱复读），但按新要求要补一句"语气别太硬"。
// 用法：node scripts/fix-hard-tone-memory.mjs [--apply]
import fs from 'node:fs';
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const APPLY = process.argv.includes('--apply');
const token = readConsoleToken();
const KEY = 'private:984776985';

const st = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const conv = st.conversations[KEY];
const core = st.coreMemory;

const find = (list, needle) => (list ?? []).find((t) => String(t?.text ?? '').includes(needle));

const plan = [];
const staleRole = find(conv.activeTopics, '正在扮演「艾莉丝·格雷拉特」') ?? find(core.activeTopics, '正在扮演「艾莉丝·格雷拉特」');
if (staleRole) {
  plan.push({
    why: '过期的"正在扮演艾莉丝"（那段早就结束了，却在每轮注入"用短句、直、不绕的口吻在群里说话"）',
    old: String(staleRole.text),
    new: '更新：演「艾莉丝·格雷拉特」那段**已经结束了**（桥接通知的到点结束），角色卡留着下次要演再调。'
      + '之后就用我自己的口吻说话——**别再端那套"短句、直、不绕"的腔**。'
      + '另外管理员 2026-09-29 提过：**语气别太硬**，说正事时放平。',
  });
}
const hurt = find(conv.activeTopics, '损一点反而容易被接') ?? find(core.activeTopics, '损一点反而容易被接');
if (hurt) {
  // ⚠️ 记忆正文上限 200 字，替换后不能变长（变长会被 slice 截掉尾巴）。
  //    所以这里把"损一点反而容易被接"整段换掉，长度基本持平。
  plan.push({
    why: '"说话短、损一点反而容易被接"（群风没错，但按新要求要补上"语气别太硬"）',
    old: String(hurt.text),
    new: String(hurt.text).replace(
      '——在那群说话短、损一点反而容易被接。',
      '——在那群说话可以短、可以接梗，但**管理员 2026-09-29 要求语气别太硬**：损要收着，说正事时放平。'),
  });
}

if (!plan.length) { console.log('没有需要修的条目'); process.exit(0); }
for (const p of plan) {
  console.log(`\n【要改】${p.why}\n  旧: ${p.old.slice(0, 120)}…\n  新: ${p.new.slice(0, 120)}…`);
}
if (!APPLY) { console.log('\n（这是预演；加 --apply 才真的写）'); process.exit(0); }

for (const p of plan) {
  const res = await fetch(`${BRIDGE_BASE}/api/socialV2/memory-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key: KEY, category: 'activeTopic', oldContent: p.old, newContent: p.new }),
  });
  const j = await res.json().catch(() => null);
  console.log(`  ${j?.ok ? '✅' : '❌'} HTTP ${res.status} ${j?.error ?? ''}`);
}

// 再补一条"这是他的要求"的记忆（high = 一年有效，会跨会话注入）
const rule = '管理员 2026-09-29 的规矩：**别太嘴硬**——互相贫可以嘴硬、可以损，但说正事、被认真问、'
  + '对方在求助或讲自己的事、涉及事实和原则时，语气放平、直接说；拒绝别人别用冷句'
  + '（"不能""换一个""这个免谈"），要说清原因再加一句人话。这条对所有会话都算数。';
const dup = find(core.activeTopics, '别太嘴硬') ?? find(conv.activeTopics, '别太嘴硬');
if (dup) {
  console.log('  = 已经有一条"别太嘴硬"的记忆，不重复加');
} else {
  const res = await fetch(`${BRIDGE_BASE}/api/socialV2/memory-append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ key: KEY, category: 'activeTopic', content: rule, importance: 'high' }),
  });
  const j = await res.json().catch(() => null);
  console.log(`  ${j?.ok ? '✅' : '❌'} 补记规矩 HTTP ${res.status} ${j?.error ?? ''}`);
}
console.log('\n完成。');
