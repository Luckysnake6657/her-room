// 按真实 token 用量，估算不同群规模/参数下的消耗与"烦人程度"。
// 用法: node scripts/estimate-group-load.mjs [群人数] [群每小时消息数]
//
// 真实基准（来自 session-84a3bb26 群会话实测）：
//   一次唤醒并回复 ≈ 17 个模型步，输入 12.5k + 输出 5.0k（其中推理 2.5k）
//   输入中约 47.8 万 token 走缓存读取（缓存单价远低于普通输入）
import fs from 'node:fs';

const members = Number(process.argv[2] ?? 100);
const msgsPerHour = Number(process.argv[3] ?? 200);

// 实测基准
const PER_WAKE = {
  steps: 17,
  inputTokens: 12471,
  cachedTokens: 478080 / 17,   // 摊到每次唤醒
  outputTokens: 4970,
  reasoningTokens: 2452,
};

const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
const v2 = cfg.socialV2;
const cur = {
  probability: v2.wake.recommendedProbability,
  maxWakePerMinute: v2.wake.maxWakePerMinute,
  maxWakePerHour: v2.wake.maxWakePerHour,
  contextWindow: v2.context.contextWindow,
  maxMessageChars: v2.send.maxMessageChars,
  maxSendPerHour: v2.send.maxSendPerHour,
};

// 候选方案
const plans = {
  '当前设置（按现状）': { ...cur },
  '100人群·保守': { probability: 0.01, maxWakePerMinute: 1, maxWakePerHour: 4, contextWindow: 10, maxMessageChars: 200 },
  '100人群·推荐': { probability: 0.02, maxWakePerMinute: 1, maxWakePerHour: 6, contextWindow: 12, maxMessageChars: 220 },
  '100人群·活跃': { probability: 0.04, maxWakePerMinute: 1, maxWakePerHour: 10, contextWindow: 15, maxMessageChars: 300 },
};

// 被 @ / 提问 / 叫名字 = 必醒，与概率无关。按群活跃度粗估每小时这类"硬触发"次数。
// 100 人活跃群：大约每 80~150 条消息出现一次点名。
const hardTriggersPerHour = Math.max(1, Math.round(msgsPerHour / 120));

const fmt = (n) => n.toLocaleString('zh-CN');
const estimate = (p) => {
  // 普通消息按概率触发
  const soft = msgsPerHour * p.probability;
  const raw = soft + hardTriggersPerHour;
  // 受每小时上限约束
  const wakes = Math.min(raw, p.maxWakePerHour);
  // 实测：约 60% 的唤醒她会发言，40% 看完就潜水（潜水那次步数更少，按 40% 成本算）
  const replyWakes = wakes * 0.6;
  const silentWakes = wakes * 0.4;
  const costPerWake = PER_WAKE.inputTokens + PER_WAKE.outputTokens;
  const tokensPerHour = replyWakes * costPerWake + silentWakes * costPerWake * 0.4;
  return { soft, hard: hardTriggersPerHour, raw, wakes, replyWakes, tokensPerHour };
};

console.log(`场景：${members} 人群，每小时约 ${fmt(msgsPerHour)} 条消息`);
console.log(`基准：一次唤醒 ≈ ${fmt(PER_WAKE.inputTokens)} 输入 + ${fmt(PER_WAKE.outputTokens)} 输出 tokens（${PER_WAKE.steps} 步）`);
console.log(`      其中约 ${fmt(PER_WAKE.cachedTokens)} 走缓存读取（缓存单价远低）`);
console.log(`      按群活跃度估：每小时"必醒"触发（@/提问/叫名字）约 ${hardTriggersPerHour} 次\n`);

for (const [name, p] of Object.entries(plans)) {
  const e = estimate(p);
  const perHour = e.tokensPerHour;
  const daily8h = perHour * 8;
  console.log(`── ${name} ──`);
  console.log(`   概率 ${p.probability} | 唤醒上限 ${p.maxWakePerHour}/时 | 上下文窗口 ${p.contextWindow} 条 | 单条上限 ${p.maxMessageChars} 字`);
  console.log(`   普通消息触发 ${e.soft.toFixed(1)}/时 + 必醒 ${e.hard}/时 = ${e.raw.toFixed(1)}/时 → 实际唤醒 ${e.wakes.toFixed(1)}/时`);
  console.log(`   其中发言约 ${e.replyWakes.toFixed(1)} 次/时（≈ 每 ${e.replyWakes > 0 ? Math.round(60 / e.replyWakes) : '∞'} 分钟说一次话）`);
  console.log(`   token 估算：${fmt(Math.round(perHour))}/时，活跃 8 小时约 ${fmt(Math.round(daily8h))}`);
  console.log('');
}

console.log('说明：');
console.log('  · "必醒"= 被@/被引用/直接提问/叫名字，不受概率与上限之外的限制；');
console.log('    人数越多、"必醒"越频繁，这才是大群里 token 的主要来源，而不是随机概率。');
console.log('  · 桥接还有两道额外保护：刚发过话会使概率×0.5；夜间(23-8点)×0.3。');
console.log('  · 输入大部分命中前缀缓存，实际计费显著低于上表的 token 总量。');
