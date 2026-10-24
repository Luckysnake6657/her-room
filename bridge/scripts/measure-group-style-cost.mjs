/**
 * 量一下"这轮改动到底多花多少 token"（用户 2026-09-29 问）。
 *
 * 三段分开量，不含糊：
 *   ① **每轮增量**：群风格卡 + 例句注入 —— 在 harness 里把 groupStyle 开/关各 build 一次唤醒提示词，直接做差；
 *   ② **一次性**：黑话补课的推理提示词（12 条候选）—— 用 src/slang-learner.js 的 buildResearchPrompt 原样算；
 *   ③ **基线对照**：工具定义（之前从 DSH 真实请求头量过：32853 字符 ≈ 10951 token）、唤醒提示词本体、人格卡。
 *
 * 字符→token 的换算按两类文本分开估（这也是之前实测得到的经验值）：
 *   - ASCII/JSON 为主（工具定义那种）：≈0.33 token/字符（实测 32853→10951）
 *   - 中文为主（提示词那种）：≈0.6 token/字符
 * 所以下面同时给"字符数"和"估算区间"，别把估算当精确值。
 *
 * 用法：node scripts/measure-group-style-cost.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { buildResearchPrompt } from '../src/slang-learner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const tok = (chars, kind = 'zh') => Math.round(chars * (kind === 'ascii' ? 0.33 : 0.6));

// ── 真实注入内容（直接从线上状态读）─────────────────────────────────────────
const styleFile = JSON.parse(fs.readFileSync(path.join(STATE, 'group-style.json'), 'utf8'));
const exFile = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'style-examples.json'), 'utf8')); } catch { return { examples: [] }; } })();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const exampleCount = Number(cfg.socialV2?.groupStyle?.exampleCount ?? 5);
const cards = Object.entries(styleFile.profiles ?? {});
const avgCardChars = cards.length ? Math.round(cards.reduce((n, [, p]) => n + String(p.text).length, 0) / cards.length) : 0;
const generalChars = styleFile.general ? String(styleFile.general.text).length : 0;
const exampleChars = (exFile.examples ?? []).slice(0, exampleCount).reduce((n, x) => n + String(x).length + 2, 0);

console.log('① 每轮增量（两层模版；2026-09-29 用户要求"通用模版在所有聊天作为底层逻辑"）');
console.log(`   通用底层（**所有会话**，含私聊）：${generalChars} 字符 ≈ ${tok(generalChars)} token`);
console.log(`   本群细节（只在群聊）：平均 ${avgCardChars} 字符 ≈ ${tok(avgCardChars)} token`);
console.log(`   例句：${Math.min(exampleCount, (exFile.examples ?? []).length)} 条 ≈ ${exampleChars} 字符 ≈ ${tok(exampleChars)} token（跟通用层走）`);
console.log(`   → **私聊每轮** ≈ ${generalChars + exampleChars + 50} 字符 ≈ ${tok(generalChars + exampleChars + 50)} token`);
console.log(`   → **群聊每轮** ≈ ${generalChars + exampleChars + avgCardChars + 90} 字符 ≈ ${tok(generalChars + exampleChars + avgCardChars + 90)} token`);
const perTurnPriv = generalChars + exampleChars + 50;
const perTurnGroup = generalChars + exampleChars + avgCardChars + 90;

// ── harness 实测差值（同一套代码路径 buildWakePromptV2）────────────────────
let measuredOn = 0;
let measuredOff = 0;
for (const on of [true, false]) {
  const b = await bridgeHarness({
    config: { socialV2: { enabled: true, groupStyle: { enabled: on, minSamples: 5, exampleCount } } },
  });
  try {
    b.setMode('reserved2');
    // 造语料：文本要**各不相同**（去重按 群|人|文本|分钟，重复文本会被并掉 —— 第一次测就栽在这）
    for (let i = 0; i < 40; i++) b.feedGroupCorpus('group:456', `群友${i % 3}`, `第${i}句话 你懂我意思吧`);
    for (let i = 0; i < 40; i++) b.feedGroupCorpus('private:123', '管理员', `私聊第${i}句`);
    fs.writeFileSync(path.join(b.paths.stateDir, 'style-examples.json'), JSON.stringify({ examples: exFile.examples ?? [] }));
    const gp = b.buildWakePromptV2('group:456', 'atMention');
    const pp = b.buildWakePromptV2('private:123', 'atMention');
    console.log(`   [实测] groupStyle=${on ? '开' : '关'} → 群聊提示词 ${gp.length} 字符（≈${tok(gp.length)} token）｜私聊 ${pp.length} 字符（≈${tok(pp.length)} token）`
      + `｜群聊含通用层 ${gp.includes('【打字习惯') ? '✓' : '✗'} 含本群层 ${gp.includes('【本群说话的样子') ? '✓' : '✗'}`);
    if (on) { measuredOn = gp.length; globalThis.__privOn = pp.length; } else { measuredOff = gp.length; globalThis.__privOff = pp.length; }
  } finally {
    await b.close();
  }
}
if (measuredOn && measuredOff) {
  console.log(`   实测差值：群聊 +${measuredOn - measuredOff} 字符 ≈ +${tok(measuredOn - measuredOff)} token/轮`
    + `｜私聊 +${globalThis.__privOn - globalThis.__privOff} 字符 ≈ +${tok(globalThis.__privOn - globalThis.__privOff)} token/轮`);
}

// ── 一次性：黑话补课推理 ────────────────────────────────────────────────────
console.log('\n② 一次性成本：黑话补课推理（只有我们主动跑才发生）');
const triage = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'slang-triage.json'), 'utf8')); } catch { return null; } })();
if (triage?.shortlist?.length) {
  const sample = triage.shortlist.slice(0, 12).map((k) => ({ content: k.content, evidence: [{ text: k.examples?.[0] ?? '' }] }));
  const prompt = buildResearchPrompt(sample);
  console.log(`   12 条候选的研究提示词：${prompt.length} 字符 ≈ ${tok(prompt.length)} token`);
  console.log('   加上每轮联网（web_search/web_fetch 结果）+ 输出的 JSON，实测 12 条跑了 2 轮：'
    + `约 ${tok(prompt.length) * 2 + 3000}~${tok(prompt.length) * 2 + 8000} token 量级（一次性，不是每轮）`);
  console.log(`   短名单还剩 ${triage.shortlist.length} 条没跑（跑完约 ×${(triage.shortlist.length / 12).toFixed(1)} 倍于上面这个数）`);
} else {
  console.log('   还没有 state/slang-triage.json（先跑 node scripts/triage-slang.mjs）');
}

// ── 基线对照 ────────────────────────────────────────────────────────────────
console.log('\n③ 基线对照（这些改动之外的大头）');
console.log('   工具定义：32853 字符 ≈ 10951 token（之前从 DSH 真实请求头实测）');
console.log('   人格卡：8150 字符 ≈ ' + tok(8150) + ' token（估算）');
console.log('   唤醒提示词本体：约 4000 字符 ≈ ' + tok(4000) + ' token（估算）');
const baseline = 10951 + tok(8150) + tok(4000);
console.log(`   一个回合的输入量级 ≈ ${baseline} token → 群聊增量约占 ${((tok(perTurnGroup) / baseline) * 100).toFixed(1)}%，私聊约占 ${((tok(perTurnPriv) / baseline) * 100).toFixed(1)}%`);
console.log('\n④ 不花 token 的部分：语料库是本地文件追加（0 token）；黑话提取频率没动（还是原来那套阈值/冷却）。');
