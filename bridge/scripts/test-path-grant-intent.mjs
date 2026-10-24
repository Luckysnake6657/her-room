/**
 * 回归：「开全路径许可」的意图识别不能误报（2026-10-14，申请 #30 第 3 条）。
 *
 * 现场（管理员原话）：「我现在真的为什么会有这个了」「我不不敢打汉字了」。
 *   18:09 他发「**你权限没那么大吧**」→ 命中"授权名词"规则（就因为句子里有"权限"两个字），
 *     系统弹了「🔓 全路径许可已开（按意图认出来的：授权名词）」。
 *     他那句是**在否认**（"你没那么大权限"），却被当成"给你权限"。
 *   18:21 他只回「**哦牛批**」→ 又开了一次。走的是另一条路：
 *     `canGrantByShortYes`（她刚说过"我发不出去" + 他回个短 yes）——
 *     那条路当时**不要求他那句话本身有授权语义**，语气词也算同意。
 *
 * ⚠️ 为什么这两条必须严：误判的代价是**白开一次"能发任意文件"的口子**
 *   （`.env`/凭据/令牌照样拒，但任意路径的文档能发出去）。
 *
 * 本用例锁两头：
 *   [1] 真实误报样本**必须不触发**（改回去就红）
 *   [2] 真的授权**必须仍然触发**（别为了堵误报把功能杀光）
 *
 * 用法: node scripts/test-path-grant-intent.mjs
 */
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

  console.log('\n[1] 真实误报样本：必须不触发');
  {
    for (const s of [
      '你权限没那么大吧',            // 18:09 的真实原话 —— 在否认，不是在授权
      '你没那么大权限',
      '你权限不大吧',
      '你那点权限有限的',
      '哦牛批',                      // 18:21 的真实原话 —— 语气词
      '我真的为什么会有这个了',
      '我不不敢打汉字了',
      // ↓ 2026-10-14 18:38 **二次误报**的真实原话：只发一个裸授权名词就开许可（申请 #31）。
      //   #30 那次漏掉了这条最宽的路径 —— permNoun 一命中就设 why，**不要求任何动作词**。
      '权限',
      '授权',
      '特批',
      '许可',
      '破例',
      '放行',
      '权限。',
      '权限 ',
      '什么叫权限',
    ]) {
      const r = parse(s);
      check(`「${s}」不触发`, r === null || r.action !== 'grant', JSON.stringify(r));
    }
  }

  console.log('\n[2] 真的授权：必须仍然触发（别把功能杀光）');
  {
    for (const [s, why] of [
      ['行，给你权限', '授权名词'],
      ['这次特批', '授权名词'],
      ['破例一次', '授权名词'],
      ['给你开个权限', '授权名词'],
      ['那给你权限', '授权名词'],
      ['允许她发桌面上的文件', '允许+文件类目标'],
      ['让她把桌面那个报告发我', '指使她去发文件'],
    ]) {
      const r = parse(s);
      check(`「${s}」触发 grant`, r && r.action === 'grant', JSON.stringify(r));
    }
  }

  console.log('\n[3] 短确认那条路：语气词不能拍板开权限');
  {
    // 这条路的语义现在是两层：looksLikeGrantYes（短 yes）+ 新增的"必须自带授权语义"。
    // 语气词连第一层都过不了，所以直接断言 false 即可（真正的两层判据在 [1][2] 覆盖）。
    for (const t of ['哦牛批', '牛批', '哦', '好的呢', '啊这', '笑死']) {
      check(`「${t}」不触发短确认`, h.canGrantByShortYes(t) === false, String(h.canGrantByShortYes(t)));
    }
    check('canGrantByShortYes 对空串返回 false', h.canGrantByShortYes('') === false);
    // 「行/可以/开」这类**真授权词**在缺前提时也不该开（没有 pathGrantAsked）
    check('没前提时「行」也不开', h.canGrantByShortYes('行') === false);
  }

  console.log('\n[4] 撤销类不受影响');
  {
    check('「撤销全路径」仍然是 revoke', parse('撤销全路径')?.action === 'revoke', JSON.stringify(parse('撤销全路径')));
    check('「别给权限」仍然是 revoke', parse('别给权限')?.action === 'revoke', JSON.stringify(parse('别给权限')));
  }
} finally {
  await h.close();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
