/**
 * 记忆注入预览：用**真实**记忆（state/social-v2.json 的 coreMemory）离线渲染
 * "她这一轮到底会看到哪几条记忆"。
 *
 * 为什么需要它：记忆注入是**按分数抽奖**（850~900 字符预算 + 重要性/新鲜度排序），
 * 所以"她记没记住某件事"和"她这轮看没看到"是两回事 —— 排查行为问题时必须能离线复现后者。
 * 2026-10-01 就是靠它确认：「别动不动给人说教」那条**当时确实在提示词里**，
 * 所以她犯的不是"忘了"，而是那条规则**没有触发条件**（详见 QUICKSTART 的说话逻辑一节）。
 *
 * 用法：
 *   node scripts/render-memory-preview.mjs                    # 默认私聊 984776985
 *   node scripts/render-memory-preview.mjs group:795894138
 *   node scripts/render-memory-preview.mjs private:984776985 大道理 说教
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = process.argv[2] || 'private:984776985';
const probes = process.argv.slice(3);
const real = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  // 测试脚手架里 state 是空的，把真实 coreMemory 灌进它的 global
  h.socialV2.coreMemory = real.coreMemory;
  const topics = real.coreMemory.activeTopics ?? [];
  console.log(`会话: ${key}`);
  console.log(`coreMemory: activeTopics ${topics.length} 条 / high ${topics.filter((t) => t.importance === 'high').length} 条`);
  console.log(`注入预算: ${h.memoryInjectBudget()} 字符（非 high 保底另算）`);
  const rendered = h.formatMemoryV2ForChat(key, h.getSocialV2State(key));
  console.log('\n渲染出来的记忆块（就是她这轮看到的）:\n' + (rendered || '（空）'));
  for (const p of probes) {
    console.log(`\n命中检查「${p}」: ${rendered.includes(p) ? '✅ 在提示词里' : '❌ 没进这一轮'}`);
  }
} finally {
  await h.close();
}
