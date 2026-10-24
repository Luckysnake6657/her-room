/**
 * 回归：唱歌是异步的，工具不许"谎报唱完"（2026-10-16，申请 #40）。
 *
 * 事故（真实）：
 *   15:27:48 他发来一条 mp3 问「这个能唱吗」→ 15:28:23 桥接开始跑 `sing.py`。
 *   15:28:27/15:28:30 她回他：
 *     「能唱，这首就在我歌单里」
 *     「**刚又给你唱了一遍**，副歌那句我还是没底」   ← 过去式，说已经唱完了
 *   15:32:45 他：「还没收到歌啊」——他去看了，**什么都没有**。
 *   真相：那次的成品 15:39:55 才出来、15:40:02 才发出去（整条流水线 11.6 分钟）。
 *   她引用的工具原文是「唱完《反方向的钟》了，已经发给他」——**她没编，是工具撒了谎**：
 *   `mcp-snowluma-safe.js` 的 sing 分支**无条件**返回"唱完了"，**完全不看桥接返回的 `queued`**。
 *
 * 为什么这个 bug 比"发送失败"更该修：**假成功让她替一个没发生的事实作证**。
 *   她后来说「我这边只显示唱完了、发出去了，别的看不见」—— 她只能这么答，
 *   因为工具给她的就是一句断言，没有任何"还没好"的信息可转达。
 *
 * 本用例锁：①queued=true 时必须转达"还在唱"（用桥接给的 note）②只有真跑完才说唱完
 *   ③**禁止无条件"唱完"这句话再次出现**（这条是防回归的关键）。
 *
 * 用法: node scripts/test-sing-async-honesty.mjs
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const SRC = fs.readFileSync('D:/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');

// 把 sing 分支的文案选择逻辑照搬出来（与源码同构，用来验行为）
// ⚠️ queued 有两种"没跑完"的情形，都必须走 note：
//    queued===true  = 刚排上队（"开始唱了"）
//    queued===false = 这首已经在唱了（"我正在唱，已经 N 分钟"）
//    只有 **queued 字段整个不存在**（= 同步路径真的跑完了）才允许说"唱完了"。
const pickText = (data) => {
  if (data?.ok !== true) return `唱歌没成：${data?.error ?? '未知'}`;
  if (data.queued !== undefined) {
    return data.note || `开始唱《${data.name}》了，大概几分钟，唱完自动发给他。`;
  }
  return `唱完《${data.name}》了，已经发给他。`;
};

// ⚠️ 判据要精确：note 里出现「**唱完**我直接发给他」是**诚实**的（条件式：唱完之后会发）。
//    要禁的是**断言已经唱完**——`唱完《X》了` / `唱完了`。
const assertsDone = (t) => /唱完《[^》]*》了|唱完了/.test(t);

console.log('\n[1] 异步（queued=true）：必须说"还在唱"，不能说"唱完了"');
{
  const queued = { ok: true, queued: true, name: '反方向的钟', ahead: 0,
    note: '开始唱《反方向的钟》了，大概几分钟，唱完我直接发给他' };
  const t = pickText(queued);
  console.log('    渲染:', t);
  check('不断言"已经唱完"', !assertsDone(t), t);
  check('不含"已经发给他"（还没发！）', !/已经发给他/.test(t), t);
  check('转达了"开始唱"', /开始唱/.test(t), t);
  check('用了桥接给的 note（信息量最大）', t.includes('大概几分钟'), t);
  const fb = pickText({ ok: true, queued: true, name: 'X' });
  check('note 缺失时有兜底，且兜底也不谎报', !assertsDone(fb) && !/已经发给他/.test(fb), fb);
}

console.log('\n[2] 真跑完（queued 字段不存在 = 同步路径）才允许说"唱完了"');
{
  const done = { ok: true, name: '反方向的钟' };
  const t = pickText(done);
  check('说"唱完…已经发给他"', /唱完《反方向的钟》了，已经发给他/.test(t), t);
}

console.log('\n[2b] queued=false（=「我正在唱，已经 N 分钟」）同样不能说唱完');
{
  const running = { ok: true, queued: false, name: '反方向的钟', note: '这首我正在唱（已经 3.5 分钟了），唱完直接发给他' };
  const t = pickText(running);
  console.log('    渲染:', t);
  check('不断言"已经唱完"', !assertsDone(t), t);
  check('不含"已经发给他"', !/已经发给他/.test(t), t);
  check('转达了"我正在唱"', /我正在唱/.test(t), t);
}

console.log('\n[3] 失败要如实说失败');
{
  check('ok=false → 报错原文', /唱歌没成/.test(pickText({ ok: false, error: '歌单里没有《X》' })));
}

console.log('\n[4] 源码守卫：不许再出现"无条件唱完"');
{
  // ⚠️ 必须先剔掉注释行（这个仓库踩过：我的修复注释里就引用了那句"已经发给他"，
  //    不剔注释会把它当成"又出现一次无条件谎报"，假红）
  const code = SRC.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const iQueued = code.indexOf('if (data.queued !== undefined) {');
  const iDone = code.indexOf('唱完《${data.name}》了，已经发给他。');
  check('有 queued 分支', iQueued > 0, `@${iQueued}`);
  check('"唱完"那句在 queued 分支之后（受保护）', iQueued > 0 && iDone > iQueued, `queued@${iQueued} done@${iDone}`);
  // 确保**代码里**没有别的地方又冒出一句无条件"已经发给他"
  const all = [...code.matchAll(/已经发给他/g)].map((m) => m.index);
  check('代码里"已经发给他"只有受保护的那一处', all.length === 1, `出现 ${all.length} 次 @${all.join(',')}`);
  check('sing 提示里明确写了"异步/别反复点"（她才知道要等）', /sing 异步/.test(SRC) && /别反复点/.test(SRC));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
