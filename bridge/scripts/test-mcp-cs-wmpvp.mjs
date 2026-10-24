// 测试完美平台（wmpvp）MCP server。
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-cs-wmpvp-stats.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

const PLAYER = process.argv[2] || 'ropz';

const show = (label, res, max = 1000) => {
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n===== ${label} ===== (${Buffer.byteLength(text, 'utf8')} 字节, isError=${res.isError ? '是' : '否'})`);
  console.log(text.length > max ? text.slice(0, max) + '\n...(截断)' : text);
};

try {
  await client.connect(transport);
  console.log('✅ 完美平台 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  show('空 keyword（应拒绝）', await client.callTool({ name: 'query', arguments: { action: 'search_wmpvp_player', keyword: '' } }), 200);
  show('搜不存在的名字', await client.callTool({ name: 'query', arguments: { action: 'search_wmpvp_player', keyword: 'zzz_不存在_9999' } }), 400);

  show(`search_wmpvp_player(${PLAYER})`, await client.callTool({ name: 'query', arguments: { action: 'search_wmpvp_player', keyword: PLAYER } }), 900);

  // 用搜到的 steamId 试查战绩（当前无 token，应给出明确的配置提示）
  const s = await client.callTool({ name: 'query', arguments: { action: 'search_wmpvp_player', keyword: PLAYER } });
  let steamId = null;
  try {
    const j = JSON.parse(s.content[0].text);
    steamId = j.results?.[0]?.steamId ?? null;
  } catch {}
  console.log(`\n  → 取到 steamId: ${steamId || '(无)'}`);

  if (steamId) {
    show(`get_wmpvp_player_stats(${steamId})`, await client.callTool({
      name: 'query',
      arguments: { action: 'get_wmpvp_player_stats', player: steamId }
    }), 1200);
    show(`get_wmpvp_player_matches(${steamId})`, await client.callTool({
      name: 'query',
      arguments: { action: 'get_wmpvp_player_matches', player: steamId, limit: 3 }
    }), 900);
  }

  // 非法 steamId / 昵称
  show('乱填的名字', await client.callTool({ name: 'query', arguments: { action: 'get_wmpvp_player_stats', player: 'zzz_不存在_9999' } }), 400);

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
