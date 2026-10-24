// 量 MCP 工具定义占多少字符（工具名+描述+schema 都会进每轮上下文，是实打实的 token 成本）。
// 用法：node scripts/measure-tool-cost.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVERS = [
  { name: 'snowluma', script: 'src/mcp-snowluma-safe.js' },
  { name: 'snowluma-host', script: 'src/mcp-host-server.js' },
  { name: 'web-search-safe', script: 'src/mcp-web-search-safe.js' },
  { name: 'ow-stats', script: 'src/mcp-ow-stats.js' },
  { name: 'ow-cn-stats', script: 'src/mcp-ow-cn-stats.js' },
  { name: 'cs-5e-stats', script: 'src/mcp-cs-5e-stats.js' },
  { name: 'cs-wmpvp-stats', script: 'src/mcp-cs-wmpvp-stats.js' },
];

let grand = 0;
const all = [];
for (const { name, script } of SERVERS) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, script)], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'cost-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const rows = tools.map((t) => ({
      name: t.name,
      chars: t.name.length + String(t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length,
    })).sort((a, b) => b.chars - a.chars);
    const total = rows.reduce((n, r) => n + r.chars, 0);
    grand += total;
    console.log(`\n=== ${name}（${rows.length} 个工具，共 ${total} 字符 ≈ ${Math.round(total / 3)} token 粗估）===`);
    for (const r of rows.slice(0, 12)) console.log(`  ${String(r.chars).padStart(5)}  ${r.name}`);
    if (rows.length > 12) console.log(`  …（其余 ${rows.length - 12} 个合计 ${rows.slice(12).reduce((n, r) => n + r.chars, 0)} 字符）`);
    all.push(...rows.map((r) => ({ ...r, server: name })));
  } catch (error) {
    console.log(`\n=== ${name}：启动失败 ${error?.message ?? error}`);
  } finally {
    try { await client.close(); } catch {}
  }
}
console.log(`\n总计 ${all.length} 个工具 / ${grand} 字符 ≈ ${Math.round(grand / 3)} token（每轮都要带）`);
console.log('\n最贵的 12 个：');
for (const r of all.sort((a, b) => b.chars - a.chars).slice(0, 12)) {
  console.log(`  ${String(r.chars).padStart(5)}  ${r.server}/${r.name}`);
}
