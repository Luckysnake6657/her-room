// 中文英雄别名验证：群友实际打的是"大锤""麦克雷""76""球""阿三"，不是官方译名。
// 逐个调用 get_hero_stats，检查是否命中正确的英雄 key。
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-ow-stats.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

const PLAYER = process.argv[2] || 'TeKrop-2217';
// [输入, 期望的 hero key, 期望模式]
const CASES = [
  ['大锤', 'reinhardt', 'quickplay'],
  ['麦克雷', 'cassidy', 'quickplay'],
  ['76', 'soldier-76', 'quickplay'],
  ['源氏', 'genji', 'quickplay'],
  ['天使', 'mercy', 'quickplay'],
  ['D.VA', 'dva', 'quickplay'],
  ['猪', 'roadhog', 'quickplay'],
  ['球', 'wrecking-ball', 'quickplay'],
  ['阿三', 'symmetra', 'quickplay'],
  ['安娜', 'ana', 'quickplay'],
  ['genji', 'genji', 'quickplay'],
  ['Mercy', 'mercy', 'quickplay'],
];

let pass = 0;
let fail = 0;
// 上游（overfast-api.tekrop.fr）超时/不可达时，判不出来的是**网络**不是别名逻辑。
// 2026-10-02 实测：上游挂的那次，批测里这个用例 214 秒后报红，看起来像回归、其实是外网。
// 这类条目单独记为"未验证"，并在结尾**大声**说明 —— 不能当成通过（会掩盖真回归），
// 也不该把整批测试染红（会让人误以为是本地代码坏了）。
let envSkip = 0;
const ENV_FAIL_RE = /请求超时|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|502|503|504/;

try {
  await client.connect(transport);

  for (const [input, expect, mode] of CASES) {
    const res = await client.callTool({
      name: 'query',
      arguments: { action: 'get_hero_stats', player: PLAYER, hero: input, mode },
    });
    const text = res.content?.[0]?.text ?? '';
    let got = null;
    try {
      got = JSON.parse(text).英雄 ?? null;
    } catch {
      got = null;
    }
    const okay = got === expect || (res.isError && text.includes(expect));
    if (okay) { pass++; console.log(`✅ ${input.padEnd(8)} -> ${got ?? '(无该英雄数据但已识别为 ' + expect + ')'}`); }
    else if (ENV_FAIL_RE.test(text)) { envSkip++; console.log(`⚠️ ${input.padEnd(8)} 上游超时/不可达，本项未验证（不是别名回归）：${text.slice(0, 90)}`); }
    else { fail++; console.log(`❌ ${input.padEnd(8)} 期望 ${expect}，实际 ${got ?? text.slice(0, 110)}`); }
  }

  // 完全乱填的英雄名，应该明确报错而不是瞎猜
  const junk = await client.callTool({
    name: 'query',
    arguments: { action: 'get_hero_stats', player: PLAYER, hero: '这不是英雄名xyz', mode: 'quickplay' },
  });
  const junkText = junk.content?.[0]?.text ?? '';
  // 上游挂了也是"没瞎猜"，同样算过（否则外网抖动会伪装成别名 bug）
  const junkOk = junk.isError || junkText.includes('没有') || ENV_FAIL_RE.test(junkText);
  console.log(`${junkOk ? '✅' : '❌'} 乱填英雄名 -> ${junkText.slice(0, 130)}`);
  if (!junkOk) fail++;
  else if (ENV_FAIL_RE.test(junkText)) envSkip++;

  console.log(`\n──────── 别名映射：${pass} 通过 / ${fail} 失败${envSkip ? ` / ${envSkip} 未验证（上游超时）` : ''} ────────`);
  if (envSkip) console.log('⚠️ 有项目因 overfast 上游超时未验证 —— 上游恢复后请重跑本用例，别把这次结果当成"别名没问题"。');
  process.exit(fail ? 1 : 0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
