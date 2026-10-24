// 真的调用一次「按需看文件」工具（stdio 拉起 MCP server → callTool），
// 验证工具自身的参数解析/请求/响应处理（不只是"注册上了"）。
//
// 2026-09-28 整合：原来的 qq_get_document_images + qq_read_file_section 合成
// 一个 qq_read_file（按参数自动选"文档页"或"文本段"模式），所以这里两种模式都打一遍。
//
// 用法：node scripts/test-mcp-doc-images-call.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 取一个真实会话的 key + agent token（工具要求带令牌）
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const key = Object.keys(st.conversations ?? {})[0];
const token = st.conversations?.[key]?.agentToken;
if (!key || !token) { console.error('拿不到会话/令牌'); process.exit(2); }
console.log(`用会话 ${key}（令牌 ${String(token).slice(0, 8)}…）\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')],
  cwd: ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' });
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'qq_read_file');
  check('工具已注册', !!tool);
  check('旧的两个工具名已下线（整合完成）',
    !tools.some((t) => t.name === 'qq_get_document_images' || t.name === 'qq_read_file_section'),
    tools.filter((t) => /read_file|document_images/.test(t.name)).map((t) => t.name).join(','));
  if (tool) {
    check('描述里写清了两种模式（文本段 / 文档页）',
      /pages/.test(tool.description) && (/from\/to|按行/.test(tool.description)) && /keyword/.test(tool.description),
      tool.description?.slice(0, 160));
    const props = tool.inputSchema?.properties ?? {};
    check('参数含 key/token/file/pages/from/to/keyword/maxChars',
      ['key', 'token'].every((k) => tool.inputSchema?.required?.includes(k))
      && ['file', 'pages', 'from', 'to', 'keyword', 'maxChars'].every((k) => k in props),
      Object.keys(props).join(','));
  }

  console.log('\n文档模式（pages=1；当前会话还没收到过文档 → 应给出可读提示，不是报错）');
  const r = await client.callTool({ name: 'qq_read_file', arguments: { key, token, pages: '1' } });
  const text = textOf(r);
  check('调用成功返回（不是 isError）', r.isError !== true, text.slice(0, 200));
  check('返回可读的文本内容', text.length > 0, JSON.stringify(r).slice(0, 200));
  check('没有文档时提示"没收到过/不在缓存"', /没收到过|不在缓存/.test(text), text.slice(0, 200));
  check('没有图片内容块（无图时不该塞图）', !(r.content ?? []).some((c) => c.type === 'image'));

  console.log('\n文本模式（from=1；没收到过文本文件时也要给可读提示）');
  const t = await client.callTool({ name: 'qq_read_file', arguments: { key, token, from: 1 } });
  const tText = textOf(t);
  check('文本模式不报错', t.isError !== true, tText.slice(0, 200));
  check('文本模式有可读说明', /文本|行|没收到过|没找到/.test(tText), tText.slice(0, 200));
  check('文本模式不塞图片', !(t.content ?? []).some((c) => c.type === 'image'));

  console.log('\n关键词模式（keyword）');
  const k = await client.callTool({ name: 'qq_read_file', arguments: { key, token, keyword: '动画' } });
  const kText = textOf(k);
  check('关键词模式不报错', k.isError !== true, kText.slice(0, 200));
  check('关键词模式有可读说明', /命中|没有|没收到过|没找到/.test(kText), kText.slice(0, 200));

  console.log('\n越权检查：伪造 token 应被拒（不能让别的会话读文件）');
  const bad = await client.callTool({ name: 'qq_read_file', arguments: { key, token: 'deadbeef'.repeat(6), pages: '1' } });
  const badText = textOf(bad);
  check('伪造令牌被拒绝（文档页）', bad.isError === true || /拒绝|无效|不允许|失败/.test(badText),
    `isError=${bad.isError} ${badText.slice(0, 160)}`);
  check('伪造令牌的报错里说明了原因', /无效|拒绝|不允许/.test(badText), badText.slice(0, 160));

  const badT = await client.callTool({ name: 'qq_read_file', arguments: { key, token: 'deadbeef'.repeat(6), from: 1 } });
  const badTText = textOf(badT);
  check('伪造令牌被拒绝（文本段）', badT.isError === true || /拒绝|无效|不允许|失败/.test(badTText),
    `isError=${badT.isError} ${badTText.slice(0, 160)}`);

  // 同类漏洞也存在于"看消息图片"那个老端点上，一起守住
  const badImg = await client.callTool({ name: 'qq_get_message_images', arguments: { key, messageId: '1', token: 'deadbeef'.repeat(6) } });
  const badImgText = textOf(badImg);
  check('伪造令牌被拒绝（消息图片）', badImg.isError === true || /拒绝|无效|不允许|失败/.test(badImgText),
    `isError=${badImg.isError} ${badImgText.slice(0, 160)}`);
} catch (error) {
  check('MCP 调用链路', false, String(error?.message ?? error));
} finally {
  try { await client.close(); } catch {}
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
