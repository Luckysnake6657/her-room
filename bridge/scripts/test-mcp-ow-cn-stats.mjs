// 测试守望先锋国服（CN）战绩 MCP server：
// - 工具清单
// - 缺 # 数字时的拒绝
// - Overstats 服务未运行 / 未配置大神经据时的错误提示
// - 服务可用时（已配好凭据）的真实查询
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-ow-cn-stats.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

const PLAYER = process.argv[2] || '随缘居士#5729';

function show(label, res) {
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n===== ${label} ===== (${Buffer.byteLength(text, 'utf8')} 字节, isError=${res.isError ? '是' : '否'})`);
  console.log(text.length > 900 ? `${text.slice(0, 900)}\n...(截断)` : text);
}

try {
  await client.connect(transport);
  console.log('✅ 国服战绩 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const noHash = await client.callTool({ name: 'query', arguments: { action: 'get_cn_player_stats', player: '随缘居士' } });
  show('缺 # 数字（应拒绝并说明）', noHash);

  const empty = await client.callTool({ name: 'query', arguments: { action: 'get_cn_player_stats', player: '' } });
  show('空 ID（应拒绝）', empty);

  const stats = await client.callTool({ name: 'query', arguments: { action: 'get_cn_player_stats', player: PLAYER } });
  show(`get_cn_player_stats(${PLAYER})`, stats);

  const matches = await client.callTool({ name: 'query', arguments: { action: 'get_cn_player_matches', player: PLAYER, limit: 3 } });
  show(`get_cn_player_matches(${PLAYER})`, matches);

  const recent = await client.callTool({ name: 'query', arguments: { action: 'get_cn_recent_matches', player: PLAYER } });
  const recentText = recent.content?.[0]?.text ?? '';
  console.log(`\n===== get_cn_recent_matches（按天汇总）===== (${Buffer.byteLength(recentText, 'utf8')} 字节)`);
  try {
    const j = JSON.parse(recentText);
    console.log('  基准日期:', j.基准日期, '| 覆盖范围:', j.覆盖范围, '| 原始可读对局:', j.原始可读对局数);
    for (const d of j.按天汇总 || []) {
      console.log(`  ${d.日期}: ${d.场次} 场（${d.胜}胜 ${d.负}负）| 英雄: ${(d.英雄场次 || []).join(', ')}`);
      (d.对局 || []).slice(0, 2).forEach((m) =>
        console.log(`      ${m.时间} ${m.英雄}/${m.地图} ${m.结果} ${m.比分} ${m.击杀}/${m.死亡}/${m.助攻}`)
      );
    }
  } catch {
    console.log(recentText.slice(0, 500));
  }

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
