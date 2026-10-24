/**
 * 回归：「他（owner）」的印象变体要并回一条（2026-10-13，申请 #26 第 2 条）。
 *
 * 现场：她的 memberImpressions 有 47 条，其中 **12 条其实是同一个人（管理员）**
 *   ——「他（owner）」「熊猫人永不为奴」「Mad scientist（熊猫人，owner）」
 *   「他（984776985，私聊）」「管理员984776985」… 每条 interactionCount 只有 1~8。
 *   印象段排在话题/想法**之后**、按 interactionCount 降序 —— 12 个碎片没一个攒得够大，
 *   于是**一条都排不进注入位**：她每轮只看到 `【对群友的印象】` 空标题。
 *   她自己的话：「只剩几条标签，久了像换了个人接班，手里只有记录本」。
 *
 * 本用例锁三件事：
 *   [1] 该合的合：带 ownerQQ 的、以及 traits 里自证 ownerQQ 的，并成一条 `他（owner）`
 *   [2] 不该合的不合：显示名不带身份信息的人**绝不能**被卷进来（误合 = 把别人的印象
 *       贴到他名下，比不合并更糟）
 *   [3] 干净数据是 no-op（只有 0/1 条候选时原样返回，不动存档结构）
 *
 * 用法: node scripts/test-owner-impression-merge.mjs
 */
process.env.QQ_BRIDGE_PROBE = '1';

import fs from 'node:fs';
const { mergeOwnerImpressions } = await import('file:///D:/qq-bridge/src/bridge.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const OWNER = '984776985';

console.log('\n[1] 该合的合：他换过的各种名字并成一条');
{
  const imps = {
    '他（owner）': { traits: ['爱留证据'], interactionCount: 5, source: 'owner' },
    '984776985（管理员）': { traits: ['嫌我带问号'], interactionCount: 2, source: 'owner' },
    '他（984776985，私聊）': { traits: ['凌晨两点睡'], interactionCount: 4, source: 'owner' },
    '管理员984776985': { traits: ['爱赖床'], interactionCount: 2, source: 'owner' },
    '熊猫人永不为奴': { traits: ['群主（ownerQQ 984776985），爱发表情包'], interactionCount: 8, source: 'group:111' },
    '小明': { traits: ['爱玩CS'], interactionCount: 2, source: 'group:111' },
  };
  const out = mergeOwnerImpressions(imps, OWNER);
  const keys = Object.keys(out);
  check('并成了「他（owner）」一条', keys.includes('他（owner）'), keys.join(' | '));
  check('5 个变体不再各自成条', !keys.includes('984776985（管理员）') && !keys.includes('他（984776985，私聊）')
    && !keys.includes('管理员984776985') && !keys.includes('熊猫人永不为奴'), keys.join(' | '));
  check('traits 全部带过来了（去重）',
    ['爱留证据', '嫌我带问号', '凌晨两点睡', '爱赖床', '群主（ownerQQ 984776985），爱发表情包'].every((t) => out['他（owner）'].traits.includes(t)),
    JSON.stringify(out['他（owner）'].traits));
  check('interactionCount 累加（5+2+4+2+8=21）', out['他（owner）'].interactionCount === 21, String(out['他（owner）'].interactionCount));

  console.log('\n[2] 不该合的不合：显示名不带身份信息的人必须原样留着');
  check('「小明」仍是独立一条', keys.includes('小明'), keys.join(' | '));
  check('「小明」的 traits 没被卷进他名下', !out['他（owner）'].traits.includes('爱玩CS'), JSON.stringify(out['他（owner）'].traits));
  check('总条数 = 2（他 + 小明）', keys.length === 2, keys.join(' | '));
}

console.log('\n[3] 可伪造的称呼不单独采信（"群主/管理员"没带号码就不认）');
{
  const imps = {
    '某个群主': { traits: ['别的群的群主，跟管理员无关'], interactionCount: 9, source: 'group:222' },
    '管理员': { traits: ['其实是另一个群的管理员'], interactionCount: 3, source: 'group:333' },
  };
  const out = mergeOwnerImpressions(imps, OWNER);
  check('光叫"群主/管理员"不会被并进来', Object.keys(out).length === 2 && !Object.keys(out).includes('他（owner）'),
    Object.keys(out).join(' | '));
}

console.log('\n[4] 干净数据是 no-op');
{
  const one = { '小明': { traits: ['爱玩CS'], interactionCount: 2, source: 'group:111' } };
  check('只有 1 条无关印象 → 原样返回', mergeOwnerImpressions(one, OWNER) === one);
  const single = { '他（owner）': { traits: ['只有一条'], interactionCount: 1, source: 'owner' } };
  check('只有 1 条"他" → 原样返回（不改键名）', mergeOwnerImpressions(single, OWNER) === single);
  check('没配 ownerQQ → 原样返回', mergeOwnerImpressions(one, '') === one);
  check('空对象不炸', Object.keys(mergeOwnerImpressions({}, OWNER)).length === 0);
  check('null 不炸', Object.keys(mergeOwnerImpressions(null, OWNER)).length === 0);
}

console.log('\n[5] 线上真实数据：能认出他是哪些条，且不误伤别人');
{
  const real = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8').replace(/^\uFEFF/, ''));
  const realImps = real.coreMemory?.memberImpressions ?? {};
  const out = mergeOwnerImpressions(realImps, OWNER);
  const before = Object.keys(realImps).length;
  const after = Object.keys(out).length;
  console.log(`     线上印象 ${before} 条 → 合并后 ${after} 条（并为 ${before - after + 1} 条变体）`);
  check('线上数据确实发生了合并（说明真有变体）', after < before - 1, `${before} → ${after}`);
  check('合并后仍有「他（owner）」', !!out['他（owner）'], Object.keys(out).slice(0, 5).join(' | '));
  check('他的条数变多了（够排进注入位了）', (out['他（owner）']?.interactionCount ?? 0) > 20,
    String(out['他（owner）']?.interactionCount));
  // 误伤检查：没带号码、traits 也没自证的条目必须原样在
  const untouched = Object.keys(realImps).filter((n) => !String(n).includes(OWNER)
    && !(realImps[n].traits ?? []).some((t) => /ownerQQ\s*984776985/.test(String(t))));
  const missing = untouched.filter((n) => !(n in out));
  check(`不该动的 ${untouched.length} 条全都在`, missing.length === 0, missing.slice(0, 5).join(' | '));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
