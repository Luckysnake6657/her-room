// 把老的战绩测试/探针脚本改成走"单一入口"：工具名 → query，老工具名 → action。
// 用**老全名当 action**（别名）是最小改动，也顺带证明了别名没坏。
// 幂等。用法：node scripts/patch-stats-tests.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TOOLS = [
  'search_player', 'get_player_stats', 'get_hero_stats',
  'get_cn_player_stats', 'get_cn_player_matches', 'get_cn_recent_matches',
  'search_5e_player', 'get_5e_player_stats', 'get_5e_player_matches',
  'search_wmpvp_player', 'get_wmpvp_player_stats', 'get_wmpvp_player_season_history',
  'get_wmpvp_player_matches', 'get_wmpvp_last_match', 'get_wmpvp_daily_summary',
];
const FILES = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^(test|probe)-mcp-/.test(f) && f.endsWith('.mjs'))
  .concat(['test-ow-hero-aliases.mjs'])
  .filter((f, i, arr) => arr.indexOf(f) === i && fs.existsSync(path.join(ROOT, 'scripts', f)));

let changedFiles = 0;
let edits = 0;
for (const f of FILES) {
  const p = path.join(ROOT, 'scripts', f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  for (const tool of TOOLS) {
    // ① call('tool', {...})
    const reA = new RegExp(`call\\('${tool}',\\s*\\{`, 'g');
    s = s.replace(reA, () => { edits++; return `call('query', { action: '${tool}',`; });
    // ② name: 'tool', arguments: {  （可能跨行）
    const reB = new RegExp(`name:\\s*'${tool}',(\\s*)arguments:\\s*\\{`, 'g');
    s = s.replace(reB, (m, ws) => { edits++; return `name: 'query',${ws}arguments: { action: '${tool}',`; });
  }
  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    console.log(`✅ ${f}`);
    changedFiles++;
  }
}
console.log(`\n完成：改了 ${changedFiles} 个文件，共 ${edits} 处调用`);
