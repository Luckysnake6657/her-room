// 四个战绩 MCP 服务器的"单一入口"回归测试（走真实 stdio，不发上游查询）：
//   ① 每个服务器只暴露 1 个工具；② action 清单/参数齐全；③ 未知 action 明确报可用值；
//   ④ 缺必填参数点名说缺哪个；⑤ 旧工具全名（别名）仍能解析到对应查询。
//
// 为什么需要它：这 15 个工具被合并成 4 个入口来省每轮的工具描述 token
// （合并前 ≈2076 token/回合，见 QUICKSTART「工具定义也有固定成本」）。合并/瘦身很容易
// 悄悄改坏：别名失效、必填校验丢失、参数名对不上 —— 这个测试就是守这些。
//
// 用法：node scripts/test-stats-dispatch.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); }
};

// 每个服务器：入口名 + 期望的 action 短名 + 每条的旧全名（别名）+ 一个必填参数
const SERVERS = [
  {
    file: 'mcp-ow-stats.js', actions: ['player', 'player_stats', 'hero_stats'],
    aliases: { search_player: 'player', get_player_stats: 'player_stats', get_hero_stats: 'hero_stats' },
    required: { player: 'name', player_stats: 'player', hero_stats: 'player' },
  },
  {
    file: 'mcp-ow-cn-stats.js', actions: ['player_stats', 'player_matches', 'recent_matches'],
    aliases: { get_cn_player_stats: 'player_stats', get_cn_player_matches: 'player_matches', get_cn_recent_matches: 'recent_matches' },
    required: { player_stats: 'player', player_matches: 'player', recent_matches: 'player' },
  },
  {
    file: 'mcp-cs-5e-stats.js', actions: ['player', 'player_stats', 'player_matches'],
    aliases: { search_5e_player: 'player', get_5e_player_stats: 'player_stats', get_5e_player_matches: 'player_matches' },
    required: { player: 'keyword', player_stats: 'player', player_matches: 'player' },
  },
  {
    file: 'mcp-cs-wmpvp-stats.js',
    actions: ['player', 'player_stats', 'player_season_history', 'player_matches', 'last_match', 'daily_summary'],
    aliases: {
      search_wmpvp_player: 'player', get_wmpvp_player_stats: 'player_stats',
      get_wmpvp_player_season_history: 'player_season_history', get_wmpvp_player_matches: 'player_matches',
      get_wmpvp_last_match: 'last_match', get_wmpvp_daily_summary: 'daily_summary',
    },
    required: {
      player: 'keyword', player_stats: 'player', player_season_history: 'player',
      player_matches: 'player', last_match: 'player', daily_summary: 'player',
    },
  },
];

let totalChars = 0;
for (const spec of SERVERS) {
  console.log(`\n═══ ${spec.file} ═══`);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src', spec.file)], cwd: ROOT, stderr: 'pipe',
  });
  const client = new Client({ name: 'stats-dispatch-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    check('只暴露 1 个工具', tools.length === 1, tools.map((t) => t.name).join(','));
    const t = tools[0];
    if (!t) continue;
    const chars = t.name.length + String(t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length;
    totalChars += chars;
    console.log(`  ${t.name} / ${chars} 字符 ≈ ${Math.round(chars / 3)} token`);
    check('action 必填', (t.inputSchema?.required ?? []).includes('action'));
    const desc = String(t.description ?? '');
    for (const a of spec.actions) {
      check(`描述里列了 action="${a}"`, desc.includes(`action="${a}"`));
    }
    // 参数名要在 schema 里（模型才知道怎么给）
    const props = Object.keys(t.inputSchema?.properties ?? {});
    for (const [action, param] of Object.entries(spec.required)) {
      check(`${action} 需要的参数 ${param} 在 schema 里`, props.includes(param), props.join(','));
    }

    const bad = await client.callTool({ name: t.name, arguments: { action: 'zzz_nope' } });
    const badText = textOf(bad);
    check('未知 action 被挡下并列出可用值',
      bad.isError === true && /未知 action/.test(badText) && spec.actions.every((a) => badText.includes(a)),
      badText.slice(0, 160));

    const first = spec.actions[0];
    const missing = await client.callTool({ name: t.name, arguments: { action: first } });
    const mText = textOf(missing);
    check(`缺必填参数时点名说缺哪个（${first}）`,
      missing.isError === true && mText.includes(`action=${first}`) && mText.includes(spec.required[first]),
      mText.slice(0, 160));

    // 别名：用旧全名 + 故意缺参数 —— 报错里应出现"解析后的短名"，说明别名被认了
    for (const [oldName, short] of Object.entries(spec.aliases)) {
      const r = await client.callTool({ name: t.name, arguments: { action: oldName } });
      const txt = textOf(r);
      check(`旧名 action="${oldName}" 能解析到 ${short}`,
        r.isError === true && txt.includes(`action=${short}`), txt.slice(0, 120));
    }
  } catch (error) {
    check('stdio 链路', false, String(error?.message ?? error));
  } finally {
    try { await client.close(); } catch {}
  }
}

console.log(`\n四个入口合计 ${totalChars} 字符 ≈ ${Math.round(totalChars / 3)} token（合并前 15 个工具 / 5949 字符 ≈ 1983）`);
const saved = 5949 - totalChars;
console.log(`省下 ${saved} 字符 ≈ ${Math.round(saved / 3)} token/回合`);
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
