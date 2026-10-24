/**
 * 回归：许可不能"被闲聊命中"（2026-10-18，申请 #42 第三、四次误报）。
 *
 * 本次现场（网关日志 00:18:52，铁证）：
 *   他 00:18:52 说「**我现在给你的权限不低**」—— 就这一句，桥接开了 5 分钟全路径许可。
 *   他自己都没意识到说过（00:19:16 他问「**我又说啥了**」）。
 *
 * 机理：`permNoun` 命中"权限"→ 抠掉名词后剩「我现在**给**你的不低」→
 *       #31 加的 `grantAct` 里裸「**给**」命中 → why='授权名词+动作'。
 *       但这里「给…的」是**定语**（在描述"已经给你的那个权限"），**不是在下达授权**。
 *   同类形状实测 **6/6 全都误报**（见下）。
 *
 * 沿革（这条判据已经错了三次，每次都是"太宽"）：
 *   #30 「你权限没那么大吧」（否定）→ 补否定判据
 *   #31 「权限」（裸名词）          → 补"必须有动作"
 *   #42 「我现在给你的权限不低」（定语/评价）→ 本次补"动作词+的 = 定语"
 *   所以本用例的立场是：**宁可少开一次许可，也不许把闲聊当授权**。
 *
 * 另外本单排查时发现一个**更严重的洞**（顺手补了）：
 *   handleIncoming 里许可分支**没有 owner 守卫**（`ownerKey` 算了却没用），
 *   而注释明写"只认管理员：模型不能自己给自己开口子"——
 *   等于**群里任何群友说一句"给你权限"都能开全路径许可**。已补 `gc && !isOwner`。
 *
 * 用法: node scripts/test-path-grant-chat.mjs
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123 } });
try {
  h.setMode('reserved2');
  const parse = h.parsePathGrantCommand;
  const isGrant = (s) => { const r = parse(s); return !!(r && r.action === 'grant'); };

  console.log('\n[1] 本次真凶：陈述"已经给你的权限"不是授权');
  {
    // 00:18:52 的原话，必须不触发
    check('「我现在给你的权限不低」不触发（00:18:52 原话）', !isGrant('我现在给你的权限不低'),
      JSON.stringify(parse('我现在给你的权限不低')));
    for (const s of [
      '我给你的权限挺大的', '给你的权限不小', '开的那个权限够用了',
      '我批的权限你随便用', '我给你开的权限还行吧', '你现在权限不够',
      '我给你的权限够不够', '这个权限够大了吧',
    ]) {
      check(`「${s}」不触发`, !isGrant(s), JSON.stringify(parse(s)));
    }
  }

  console.log('\n[2] 纯闲聊整段不得开许可（照他给的 00:15~00:18 原话逐句跑）');
  {
    for (const s of [
      '口语化一点please🥺', '我是笨蛋不理解', '正常口语化交流不挺好的', '你也知道啊',
      '端啥', '修好了', '要是又犯，你直接拍我就成', '端着就是说话跟念稿一样，不自然',
      '估计是授权判断又误报了，我这儿没东西要发', '你那几句我都看了，没一句像授权',
    ]) {
      check(`「${s.slice(0, 18)}」不触发`, !isGrant(s), JSON.stringify(parse(s)));
    }
  }

  console.log('\n[3] 真授权必须仍然触发（别为了堵误报把功能杀光）');
  {
    for (const s of ['给你权限', '这次给你权限', '给你开个权限', '破例一次',
      '这次特批', '行，给你权限', '允许你发桌面上的文件', '让她把桌面那个报告发我']) {
      check(`「${s}」触发`, isGrant(s), JSON.stringify(parse(s)));
    }
  }

  console.log('\n[4] #31 的裸名词判据没有回退（前两次的成果还在）');
  {
    for (const s of ['权限', '授权', '特批', '许可', '破例', '放行', '权限。']) {
      check(`裸名词「${s}」仍不触发`, !isGrant(s), JSON.stringify(parse(s)));
    }
    // #30 的否定判据
    check('「你权限没那么大吧」仍不触发（#30）', !isGrant('你权限没那么大吧'));
    // 撤销类不受影响
    check('「撤销全路径」仍是 revoke', parse('撤销全路径')?.action === 'revoke');
  }

  console.log('\n[5] owner 守卫：只有管理员能开（源码 + 结构性）');
  {
    const src = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check('许可分支上有 !isOwner 守卫', /if \(gc && !isOwner\) \{/.test(code));
    check('非管理员试图授权会留日志（可审计）', /忽略非管理员的授权话/.test(code));
    // ⚠️ 关键：守卫必须在 grantPathAccess **之前**，否则等于没拦
    const iGuard = code.indexOf('if (gc && !isOwner) {');
    const iGrant = code.indexOf('grantPathAccess({ uses: gc.uses');
    check('守卫在 grantPathAccess 之前', iGuard > 0 && iGrant > iGuard, `guard@${iGuard} grant@${iGrant}`);
    check('isOwner 在本作用域内已定义', /const isOwner = String\(event\.user_id\) === String\(cfg\.ownerQQ/.test(code));
  }
} finally {
  await h.close();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
