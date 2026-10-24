// 测试 CS（5E）战绩 MCP server。
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-cs-5e-stats.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

const PLAYER = process.argv[2] || 'ropz';

const show = (label, res, max = 1200) => {
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n===== ${label} ===== (${Buffer.byteLength(text, 'utf8')} 字节, isError=${res.isError ? '是' : '否'})`);
  console.log(text.length > max ? text.slice(0, max) + '\n...(截断)' : text);
};

try {
  await client.connect(transport);
  console.log('✅ CS 5E MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  show('空昵称（应拒绝）', await client.callTool({ name: 'query', arguments: { action: 'search_5e_player', keyword: '' } }), 200);
  show('搜不存在的玩家', await client.callTool({ name: 'query', arguments: { action: 'search_5e_player', keyword: 'zzzz___notexist___9999' } }), 400);

  show(`search_5e_player(${PLAYER})`, await client.callTool({ name: 'query', arguments: { action: 'search_5e_player', keyword: PLAYER } }), 700);

  show(`get_5e_player_stats(${PLAYER})`, await client.callTool({
    name: 'query',
    arguments: { action: 'get_5e_player_stats', player: PLAYER, days: 60, limit: 5 }
  }), 2200);

  show(`get_5e_player_matches(${PLAYER})`, await client.callTool({
    name: 'query',
    arguments: { action: 'get_5e_player_matches', player: PLAYER, days: 60, limit: 3 }
  }), 1600);

  // 用 domain 直接查
  show('用 domain 查（0817kggjivhk）', await client.callTool({
    name: 'query',
    arguments: { action: 'get_5e_player_matches', player: '0817kggjivhk', days: 60, limit: 2 }
  }), 900);

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
