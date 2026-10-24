// 测试守望先锋2 战绩查询 MCP server：
// - 工具清单
// - search_player：按名字搜索
// - get_player_stats：完整战报（检查体积，避免把 DSH 上下文撑爆）
// - get_hero_stats：单英雄详细数据
// - 错误路径：不存在的玩家要如实报"查不到"，不能编数据
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-ow-stats.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

const PLAYER = process.argv[2] || 'TeKrop-2217';
const HERO = process.argv[3] || '安娜';

function show(label, res) {
  const text = res.content?.[0]?.text ?? '';
  const bytes = Buffer.byteLength(text, 'utf8');
  console.log(`\n===== ${label} ===== (${bytes} 字节, isError=${res.isError ? '是' : '否'})`);
  console.log(bytes > 2400 ? `${text.slice(0, 2400)}\n...(已截断，共 ${bytes} 字节)` : text);
  return bytes;
}

try {
  await client.connect(transport);
  console.log('✅ OW 战绩 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const s = await client.callTool({ name: 'query', arguments: { action: 'search_player', name: PLAYER } });
  show(`search_player(${PLAYER})`, s);
  const sJson = JSON.parse(s.content?.[0]?.text ?? '{}');
  const pid = sJson.results?.[0]?.player_id;

  const all = await client.callTool({ name: 'query', arguments: { action: 'get_player_stats', player: PLAYER } });
  const allBytes = show(`get_player_stats(${PLAYER})`, all);

  const comp = await client.callTool({ name: 'query', arguments: { action: 'get_player_stats', player: PLAYER, mode: 'competitive' } });
  show(`get_player_stats(competitive)`, comp);

  const hero = await client.callTool({ name: 'query', arguments: { action: 'get_hero_stats', player: PLAYER, hero: HERO } });
  show(`get_hero_stats(${HERO})`, hero);

  if (pid) {
    const byId = await client.callTool({ name: 'query', arguments: { action: 'get_player_stats', player: pid, mode: 'quickplay' } });
    show('get_player_stats(by player_id)', byId);
  }

  const missing = await client.callTool({ name: 'query', arguments: { action: 'get_player_stats', player: 'zzz-nonexistent-99999' } });
  show('错误路径：不存在的玩家', missing);

  console.log('\n──────── 结果 ────────');
  console.log('完整战报体积:', allBytes, '字节', allBytes < 40000 ? '✓ 可接受' : '⚠️ 偏大');
  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
