/**
 * 守卫：**省 token 但不能把规则弄丢，也不能又涨回去**（2026-10-01）。
 *
 * 背景：管理员要"省点 token 但效果还得好"。工具面是最大头（46 个工具 ≈ 9.3k token/轮，其中约 1.6 万字符
 * 是每个工具都带的 schema 样板，动不了），所以这轮只做了两件**零能力损失**的事：
 *   ① 参数说明去冗余（`key`/`token` 那几句原来被抄了 25 遍，而读写差异在提示词【会话令牌】里已完整讲过）；
 *   ② 工具描述里**与提示词重复的成段规则**改为一句"见提示词【X】"（规则本体仍在提示词里，每轮都注入）。
 *
 * 这个用例守三件事：
 *   A. 被删的那几条规则，**必须还能在提示词里找到**（否则就是真的弄丢了）；
 *   B. 同一句长规则**不许同时出现在提示词和工具面**（那是我们刚清掉的重复，别又抄回来）；
 *   C. 工具面总字数有个上限（涨回去了就说明有人又在堆描述）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// ── 工具面（起一次 MCP 进程，拿真实 schema）────────────────────────────────
function toolSurface() {
  const src = `
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const ROOT = process.cwd();
const client = new Client({ name: 'budget', version: '1' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], cwd: ROOT, env: { ...process.env } }));
const { tools } = await client.listTools();
await client.close();
const out = tools.map((t) => ({ name: t.name, description: String(t.description ?? ''), params: Object.fromEntries(Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => [k, String(v?.description ?? '')])), chars: JSON.stringify(t).length }));
console.log(JSON.stringify(out));
`;
  const tmp = path.join(ROOT, 'scripts', `_tmp-toolsurface-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    const r = spawnSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) return { error: `${r.stderr || r.stdout}`.slice(0, 400) };
    return { tools: JSON.parse(r.stdout.trim().split('\n').pop()) };
  } finally { try { fs.unlinkSync(tmp); } catch { /* 没生成 */ } }
}

console.log('\n[A] 从工具描述里删掉的规则，必须还在提示词里');
const surface = toolSurface();
if (surface.error) {
  check('能取到工具面', false, surface.error);
} else {
  const tools = surface.tools;
  const allToolText = tools.map((t) => `${t.description} ${Object.values(t.params).join(' ')}`).join('\n');
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { socialV2: { enabled: true, slang: { enabled: true } } } });
  let prompt = '';
  try {
    h.setMode('reserved2');
    const key = 'private:984776985';
    h.getSocialV2State(key).agentToken = 'fixture';
    prompt = h.buildWakePromptV2(key, 'timeout');
  } finally { await h.close(); }

  // 这些规则"从工具描述移到了提示词"，逐条确认提示词里真的有
  const mustBeInPrompt = [
    ['一条消息 = 一个短句', /一条消息 = 一个短句/],
    ['逗号能不用就不用', /逗号能不用就不用/],
    ['信息类例外（合成一整段）', /信息类/],
    ['引用看距离：隔三条以上要引用', /隔了三条以上|隔三条以上/],
    ['引用看距离：紧挨着一两条不引用', /紧挨着你的一两条/],
    ['沉睡前观察流程', /沉睡前强制等待/],
    // 2026-10-19：改成"可以分段"（桥接判定的是时间，不是 wait 次数）
    ['沉睡前观察要说明可以分段', /可以分段/],
    ['沉睡前观察的返回字段', /preSleepWaitRemainingMs/],
    ['表情包策略（含频率）', /表情包策略/],
    ['表情频率有具体数字', /3~5 轮/],
  ];
  for (const [label, re] of mustBeInPrompt) {
    check(`提示词里有：${label}`, re.test(prompt), prompt.slice(0, 0) || '（提示词里找不到）');
  }

  console.log('\n[B] 同一句长规则不许两边都有（刚清掉的重复别又抄回来）');
  const mustNotBeInTools = [
    ['短句排版那整段', /一条消息 = 一个短句/],
    ['引用距离那整段', /隔了三条以上/],
    ['沉睡前观察那整段（长句解释）', /如果全程没人说话，返回/],
    ['表情频率那句', /3~5 轮/],
  ];
  for (const [label, re] of mustNotBeInTools) {
    check(`工具面里没有重复：${label}`, !re.test(allToolText), '工具描述里又抄了一份 → 每轮白花钱');
  }
  // 反过来：删掉长段之后，工具里必须留下"去哪看规则"的指针（否则她真的不知道规则在哪）
  check('工具里留了指向提示词的指针（沉睡前观察）', /见提示词【沉睡前强制等待】/.test(allToolText));
  check('工具里留了指向提示词的指针（表情策略）', /见提示词【表情包策略】/.test(allToolText));
  check('工具里留了指向提示词的指针（引用规则）', /见提示词【要不要引用回复】/.test(allToolText));

  console.log('\n[C] 工具面预算（涨回去说明又在堆描述）');
  const total = tools.reduce((s, t) => s + t.chars, 0);
  // 换算比例跟 measure-tool-cost.mjs 保持一致（工具面是"中文描述 + ASCII schema"混合，约 0.33 token/字符）
  console.log(`     当前 snowluma ${tools.length} 个工具 / JSON 合计 ${total} 字符 ≈ ${Math.round(total * 0.33)} token/轮`);
  // 2026-10-14：一口气加了四个功能工具（qq_send_voice 说话 / qq_diary 日记 / qq_gallery 相册 / qq_sing 歌单翻唱），
  // 各自带 schema 样板约 300~400 字符。
  // ⚠️ **下次再加工具之前，先压这几个**（现在排前面的长描述）：
  //   qq_role_play（~1600，逐 action 说明，可再合并）、qq_run_matlab（~1400）、qq_memory_append（~1200）
  // 已经压过一轮（qq_run_matlab / qq_role_play / qq_memory_append 各删了几段冗余），别再一路抬上去。
  // 这是**功能性新增**（不是往描述里灌水），所以闸门抬到 29800；规矩不变：以后再加工具，先把旧描述压下来，
  // 别一路往上抬 —— 抬之前先问自己"这 300 字符买到了一个真能力吗"。
  const BUDGET = Number(process.env.TOOL_BUDGET_CHARS) || 29800;
  check(`snowluma 工具面 ≤ ${BUDGET} 字符`, total <= BUDGET, `现在 ${total}（超了 ${total - BUDGET}）——想想是不是把提示词里的规则又抄进工具描述了`);
  const noDesc = tools.filter((t) => !t.description.trim()).map((t) => t.name);
  check('每个工具都还有描述', noDesc.length === 0, JSON.stringify(noDesc));
  const bareParams = [];
  for (const t of tools) {
    for (const [k, d] of Object.entries(t.params)) if (!d.trim()) bareParams.push(`${t.name}.${k}`);
  }
  check('每个参数都还有说明（没被削成空）', bareParams.length === 0, JSON.stringify(bareParams.slice(0, 8)));
  // 参数说明也不许再堆长句
  const longParams = [];
  for (const t of tools) for (const [k, d] of Object.entries(t.params)) if (d.length > 120) longParams.push(`${t.name}.${k}(${d.length})`);
  check('参数说明都不超过 120 字符（防止再写小作文）', longParams.length === 0, JSON.stringify(longParams));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
