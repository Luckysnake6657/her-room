/**
 * 回归测试：**每轮注入的行为规则**（2026-10-02 抽成 src/prompt-rules.js 的那批）。
 *
 * 为什么要单独一个用例：规则文本以前是散在 `buildWakePromptV2()` 里的字面量，
 * "这条规矩还在不在提示词里"只能靠人肉翻代码。抽出来之后：
 *   • `RULE_INVENTORY` 是**唯一的清单**（每条规矩一个稳定 key + 一个特征句）；
 *   • 本用例把清单拿**真实渲染出来的提示词**逐条核对 —— 这才是真正的不变量：
 *     规矩在文件里、但没被拼进 base（或者被条件分支挡住）＝等于没写。
 *   • 顺带守住"文本只有一个家"：bridge.js 里不许再出现同一条规矩的原文，
 *     否则两边会各自演化（实测这类重复最后总会分叉）。
 *
 * 用法: node scripts/test-prompt-rules.mjs
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { RULE_INVENTORY, TONE_AND_LAYOUT } from '../src/prompt-rules.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const bridgeSrc = fs.readFileSync('src/bridge.js', 'utf8');
const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } } });
try {
  h.setMode('reserved2');
  const priv = h.buildWakePromptV2('private:123', 'someone');
  const grp = h.buildWakePromptV2('group:456', 'someone');

  console.log('\n[1] 清单里的每条规矩，真的进了她这一轮的提示词');
  for (const item of RULE_INVENTORY) {
    check(`${item.key}：${item.probe}`, priv.includes(item.probe) && grp.includes(item.probe),
      `私聊 ${priv.includes(item.probe) ? '有' : '无'} / 群聊 ${grp.includes(item.probe) ? '有' : '无'}`);
  }

  console.log('\n[2] 规则文本只有一个家：bridge.js 里不许再抄一份');
  // 只看**代码行**：搬迁时留下的注释（"── 别人不好受时怎么接（2026-10-01 …）──"）是**说明**，
  // 不是重复的规则文本 —— 把它当违规会让这条守卫变成"不许写注释"，那也是错的。
  const bridgeCode = bridgeSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const probe of ['先接住情绪，别急着解决问题', '拒绝别人不许用冷句', '要不要引用回复', '不是客服：不用有求必应', '别把关心说成一堂课']) {
    check(`bridge.js 代码里没有「${probe.slice(0, 12)}」的原文`, !bridgeCode.includes(probe));
  }
  check('bridge.js 仍然把 toneLine / comfortLine 拼进 base（结构没被改坏）',
    /honestyLine \+ (requestLine \+ )?toneLine/.test(bridgeSrc) && /toneLine \+ comfortLine/.test(bridgeSrc));
  check('别名指向模块（不是又粘回字面量）',
    /const toneLine = TONE_AND_LAYOUT;/.test(bridgeSrc) && /const comfortLine = COMFORT;/.test(bridgeSrc));

  console.log('\n[3] 体积账：规则文本多长（静默膨胀要看得见）');
  const total = RULE_INVENTORY.reduce((n, i) => n + i.text.length, 0);
  const uniq = new Set(RULE_INVENTORY.map((i) => i.text)).size;
  console.log(`  不重复规则块 ${uniq} 个；TONE_AND_LAYOUT 单块 ${TONE_AND_LAYOUT.length} 字符；清单合计 ${total} 字符`);
  check('TONE_AND_LAYOUT 没有空洞（>2000 字符说明确实是那一大块）', TONE_AND_LAYOUT.length > 2000);
  check('每个规则块都非空', RULE_INVENTORY.every((i) => i.text && i.text.trim().length > 10));
  check('规则块里没有孤立代理项（会让整个请求 400）',
    RULE_INVENTORY.every((i) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(i.text)));

  console.log('\n[4] 反面：清单不许把"别过度玩梗"写成"先接梗"（那次理解错方向被用户纠正过）');
  check('提示词里没有「先接梗」这种反方向要求', !/先接梗/.test(priv));
  check('提示词里明确写了"别过度玩梗"', /别过度玩梗/.test(priv));

  console.log('\n[5] 合并重复规则后不丢机制（2026-10-22）');
  // 组 2 引用：规则只在 baseStable 一处，唤醒后缀不再抄第二份（两份措辞不同会让她犹豫）。
  check('引用规则只出现一次（唤醒后缀没再抄一份）', priv.split('【要不要引用】').length - 1 === 1);
  // 组 3 答应：pendingQuestion（要办的事）和 pendingThought（自己回来的）是两个机制，
  // 合并成一条必丢一个 —— 这里钉住两个词都还在提示词里。
  check('答应锚两个机制都还在（pendingQuestion + pendingThought）',
    priv.includes('pendingQuestion') && priv.includes('pendingThought'));
  check('"不记就等于没答应过"的硬话还在', /不记就等于没答应过/.test(priv));
  // 组 4 表情：策略行里不再重复"不在清单里别用"（可用表情包开头已经说过）。
  check('表情策略没重复"不在清单里别用"', !/不在清单里/.test(priv));
} finally {
  await h.close();
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
