/**
 * 回归测试：按需读文本文件的某一段（`qq_read_file_section`）。
 *
 * 用户实测：11MB 的台版小说 txt（无职转生1-26卷），她"只看得到开头和结尾"，
 * 用户问「前十卷能看吗」，她只能答「我这窗口最多就吃下开头几万字」
 *   「全26卷塞过来我也补不完；你要聊哪段就把那一章发我，别一直拿洛琪希刷我」
 * 所以给她一个自己翻页的工具：按行号取段 / 按关键词找（grep）。
 *
 * 走真实 HTTP 端点测（路由、鉴权、找文件、切段、关键词、翻页）。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 造一本"小说"：26 卷，每卷 40 行，行号可验证
const novelLines = [];
for (let vol = 1; vol <= 26; vol++) {
  novelLines.push(`=== 第${vol}卷 卷名${vol} ===`);
  for (let i = 1; i <= 39; i++) novelLines.push(`第${vol}卷第${i}行：主角继续赶路，洛琪希在旁看着。`);
}
const NOVEL = Buffer.from(novelLines.join('\n'), 'utf8');
// 第 1 卷开头那行、第 10 卷的那行，行号事先算好
const volLine = (v) => novelLines.findIndex((l) => l.startsWith(`=== 第${v}卷`)) + 1;

// GBK 样本（Node 没有 GBK 编码器，字节查表写死；先用 gb18030 反向自检）
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];
const gbkLine = Buffer.concat([
  Buffer.from('[INFO] ', 'latin1'), Buffer.from(GBK_ZHONGWEN), Buffer.from('\n', 'latin1'),
]);
check('GBK 字节自检（否则下面的 GBK 用例是假结论）',
  new TextDecoder('gb18030').decode(Buffer.from(GBK_ZHONGWEN)) === '中文');
const GBK_LOG = Buffer.concat(Array.from({ length: 300 }, () => gbkLine));

let nextBuffer = NOVEL;
let nextMeta = { fileId: 'novel-1', name: '无职转生1-26卷.txt' };
const bridge = await bridgeHarness({
  globals: { safeFetchAnyBuffer: async (url) => ({ statusCode: 200, url, buffer: nextBuffer }) },
});

try {
  const { fetchAndCacheQqFile } = bridge;
  const PORT = 3291;
  bridge.cfg.consolePort = PORT;
  bridge.cfg.consoleToken = 'fixture-console-token';
  bridge.setMode('reserved2');
  const key = 'private:123';
  const st = bridge.getSocialV2State(key);
  await fetchAndCacheQqFile({ ...nextMeta, url: 'https://x.invalid/n' }, undefined, { key });
  // 另一份 GBK 日志也收进来（同一会话两个文本文件）
  nextBuffer = GBK_LOG;
  await fetchAndCacheQqFile({ fileId: 'log-1', name: 'server.log', url: 'https://x.invalid/l' }, undefined, { key });
  nextBuffer = NOVEL;
  await bridge.startConsoleServer();
  await new Promise((r) => setTimeout(r, 400));
  const call = async (qs) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/socialV2/file-text?${qs}`, {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const K = `key=${encodeURIComponent(key)}`;

  console.log('\n[1] 按行号取段');
  const v10 = volLine(10);
  const r1 = await call(`${K}&file=${encodeURIComponent('无职转生')}&from=${v10}&to=${v10 + 2}`);
  check('端点可达', r1.status === 200 && r1.json?.ok === true, JSON.stringify(r1.json)?.slice(0, 150));
  check('行号对得上（第 10 卷那行）', String(r1.json?.section).startsWith(`=== 第10卷`),
    JSON.stringify(String(r1.json?.section).slice(0, 60)));
  check('返回的行号范围正确', r1.json?.from === v10 && r1.json?.to === v10 + 2,
    `${r1.json?.from}~${r1.json?.to}`);
  check('报出总行数', r1.json?.totalLines === novelLines.length, String(r1.json?.totalLines));
  check('报出编码', String(r1.json?.encoding).includes('utf-8'), String(r1.json?.encoding));

  console.log('\n[2] 只给 from：自动装到 maxChars，并给出 nextFrom（能一页页翻）');
  const r2 = await call(`${K}&file=无职转生&from=1&maxChars=800`);
  check('自动决定结束行', r2.json?.to > r2.json?.from, `${r2.json?.from}~${r2.json?.to}`);
  check('内容长度受 maxChars 约束', String(r2.json?.section).length <= 800 + 50,
    `len=${String(r2.json?.section).length}`);
  check('给了 nextFrom 供继续读', Number(r2.json?.nextFrom) === Number(r2.json?.to) + 1,
    `nextFrom=${r2.json?.nextFrom} to=${r2.json?.to}`);
  // 用 nextFrom 连续翻，确认能走到底且不卡住
  let cursor = 1;
  let pages = 0;
  let lastLine = 0;
  while (cursor && pages < 200) {
    const r = await call(`${K}&file=无职转生&from=${cursor}&maxChars=2000`);
    if (!r.json?.section) break;
    lastLine = r.json.to;
    cursor = r.json.nextFrom;
    pages++;
  }
  check(`翻页能走完整个文件（${pages} 页，到第 ${lastLine} 行）`,
    pages > 5 && lastLine >= novelLines.length - 1, `pages=${pages} lastLine=${lastLine}/${novelLines.length}`);

  console.log('\n[3] 关键词模式（grep）');
  const r3 = await call(`${K}&file=无职转生&keyword=${encodeURIComponent('第10卷')}`);
  check('找到命中', r3.json?.matchCount > 0, JSON.stringify(r3.json?.matchCount));
  check('命中带行号', r3.json?.matches?.[0]?.line > 0, JSON.stringify(r3.json?.matches?.[0]?.line));
  check('命中带上下文（前后几行）', r3.json?.matches?.[0]?.text?.includes('=== 第10卷'),
    JSON.stringify(r3.json?.matches?.[0]?.text)?.slice(0, 80));
  check('给的是可继续的 from/to', r3.json?.matches?.[0]?.from < r3.json?.matches?.[0]?.line);
  const r4 = await call(`${K}&file=无职转生&keyword=${encodeURIComponent('不存在的词xyz')}`);
  check('找不到时数量为 0 且给出说明', r4.json?.matchCount === 0 && /没有/.test(String(r4.json?.note)),
    String(r4.json?.note));

  console.log('\n[4] 边界');
  const r5 = await call(`${K}&file=无职转生&from=99999`);
  check('行号超出范围 → 如实说只有多少行', /只有 \d+ 行/.test(String(r5.json?.note)), String(r5.json?.note));
  check('越界时不硬编造内容', !r5.json?.section);
  const r6 = await call(`${K}&file=无职转生&from=1&maxChars=100`);
  check('maxChars 有小下限保护（不会返回 0 字符）', String(r6.json?.section ?? '').length >= 100,
    `len=${String(r6.json?.section).length}`);
  const r7 = await call(`${K}&file=${encodeURIComponent('不存在.txt')}`);
  check('文件不存在 → 给出候选列表', /没找到/.test(String(r7.json?.note)) && Array.isArray(r7.json?.files),
    JSON.stringify(r7.json?.note));

  console.log('\n[5] GBK 文件的分段也要解对（编码探测 + 分段是两回事）');
  const r8 = await call(`${K}&file=server.log&from=1&to=3`);
  check('识别出 GBK', /gb18030|gbk/i.test(String(r8.json?.encoding)), String(r8.json?.encoding));
  check('分段内容里中文正确、无乱码', String(r8.json?.section).includes('中文') && !String(r8.json?.section).includes('\uFFFD'),
    JSON.stringify(String(r8.json?.section).slice(0, 60)));

  console.log('\n[6] 不该把"文档"当文本文件、也不该把文本当文档');
  check('文本文件里列出的是两份文本（不含 office）',
    (r7.json?.files ?? []).length === 2 && (r7.json?.files ?? []).every((n) => /\.txt$|\.log$/.test(n)),
    JSON.stringify(r7.json?.files));
  // 用一个真 pptx 混进来，确认它不会被当文本文件
  {
    const zlibMod = await import('node:zlib');
    const mk = (name, content) => {
      const nb = Buffer.from(name, 'utf8');
      const raw = Buffer.from(content, 'utf8');
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0, 8);
      loc.writeUInt32LE(raw.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(nb.length, 26);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
      cen.writeUInt32LE(raw.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nb.length, 28);
      return { loc, nb, raw, cen };
    };
    const a = mk('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
    const parts = [a.loc, a.nb, a.raw, a.cen, a.nb];
    let off = a.loc.length + a.nb.length + a.raw.length;
    a.cen.writeUInt32LE(0, 42);
    const cd = Buffer.concat([a.cen, a.nb]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    const pptx = Buffer.concat([...parts, cd, eocd]);
    nextBuffer = pptx;
    await fetchAndCacheQqFile({ fileId: 'deck-x', name: '课件.pptx', url: 'https://x.invalid/p' }, undefined, { key });
    const r9 = await call(`${K}&file=${encodeURIComponent('不存在.txt')}`);
    check('pptx 不出现在"文本文件"候选里', !(r9.json?.files ?? []).some((n) => /pptx/.test(n)),
      JSON.stringify(r9.json?.files));
  }
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
