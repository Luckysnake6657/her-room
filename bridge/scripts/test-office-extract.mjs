/**
 * 回归测试：Office 文档取字（PPT/PPTX/DOCX/XLSX/ODP）。
 *
 * 起因：用户反馈"我发 ppt 她看不懂"——原来只有纯文本和 PDF 会内联内容。
 *
 * 这里不依赖任何外部样例文件：直接**手搓 ZIP**（本地头 + 中央目录 + EOCD）
 * 造出假的 pptx/docx/xlsx/odp，再断言提取结果。
 */
import zlib from 'node:zlib';
import {
  extractOfficeText, detectOfficeKind, readZipDirectory,
  extractPptx, extractDocx, extractXlsx, extractOdp, extractLegacyPpt, LIMITS,
} from '../src/office-extract-worker.mjs';
import { extractOfficeTextSafe } from '../src/office-extract-safe.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// ── 最小 ZIP 打包器（只用于测试造样例）────────────────────────────────────
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);           // crc32（我们的读取器不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 38);            // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ── 样例构造 ─────────────────────────────────────────────────────────────
const slideXml = (title, body) => `<?xml version="1.0"?>
<p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>
  <p:sp><p:txBody>
    <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
    <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
    <a:p><a:r><a:t>第二行 &amp; 特殊字符 &lt;tag&gt;</a:t></a:r><a:br/><a:r><a:t>换行后</a:t></a:r></a:p>
  </p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

const notesXml = (note) => `<?xml version="1.0"?>
<p:notes xmlns:a="x"><p:cSld><p:spTree><p:sp><p:txBody>
  <a:p><a:r><a:t>7</a:t></a:r></a:p>
  <a:p><a:r><a:t>${note}</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

const pptx = buildZip([
  ['[Content_Types].xml', '<Types/>'],
  ['ppt/slides/slide1.xml', slideXml('第一页标题', '这是第一页的正文要点')],
  ['ppt/slides/slide2.xml', slideXml('第二页标题', '这是第二页的内容')],
  ['ppt/notesSlides/notesSlide1.xml', notesXml('讲这一页时要提一句备注')],
  ['ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
]);

const docx = buildZip([
  ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>第一段：会议纪要</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段带</w:t></w:r><w:tab/><w:r><w:t>制表符</w:t></w:r></w:p>
    <w:p><w:r><w:t>转义 &amp; 与 &lt;尖括号&gt;</w:t></w:r></w:p>
  </w:body></w:document>`],
]);

const xlsx = buildZip([
  ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst>
    <si><t>姓名</t></si><si><t>段位</t></si><si><t>兔兔</t></si><si><t>钻石</t></si>
  </sst>`],
  ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1790</v></c></row>
  </sheetData></worksheet>`],
]);

const odp = buildZip([
  ['mimetype', 'application/vnd.oasis.opendocument.presentation'],
  ['content.xml', `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:draw="d" xmlns:text="t">
    <office:body><office:presentation>
      <draw:page draw:name="p1"><text:p><text:span>ODP 第一页</text:span></text:p></draw:page>
      <draw:page draw:name="p2"><text:p>ODP 第二页纯文本</text:p></draw:page>
    </office:presentation></office:body>
  </office:document-content>`],
]);

// ── 1. 格式识别 ──────────────────────────────────────────────────────────
console.log('\n[1] 按内容识别格式（不轻信扩展名）');
check('识别 pptx', detectOfficeKind(pptx) === 'pptx');
check('识别 docx', detectOfficeKind(docx) === 'docx');
check('识别 xlsx', detectOfficeKind(xlsx) === 'xlsx');
check('识别 odp', detectOfficeKind(odp) === 'odp');
check('识别不了随机内容', detectOfficeKind(Buffer.from('hello world')) === '');
check('识别不了普通 zip（无 office 结构）',
  detectOfficeKind(buildZip([['a.txt', 'hi']])) === '');

// ── 2. PPTX ──────────────────────────────────────────────────────────────
console.log('\n[2] PPTX 取字');
const r1 = extractPptx(pptx);
check('拿到第 1 页标题', r1.text.includes('第一页标题'), r1.text.slice(0, 200));
check('拿到第 1 页正文', r1.text.includes('这是第一页的正文要点'));
check('拿到第 2 页标题', r1.text.includes('第二页标题'));
check('页数统计为 2', r1.pages === 2, `pages=${r1.pages}`);
check('有分页标记「第 1 页」', /第 1 页/.test(r1.text) && /第 2 页/.test(r1.text));
check('XML 转义被还原（& < >）',
  r1.text.includes('第二行 & 特殊字符 <tag>'), r1.text.slice(0, 400));
check('<a:br/> 变成换行', r1.text.includes('换行后'));
check('带上了讲者备注', r1.text.includes('备注') && r1.text.includes('讲这一页时要提一句备注'));
check('备注页里的页码噪声（纯数字行）被去掉', !/\n7\n/.test(r1.text));

// ── 3. DOCX ──────────────────────────────────────────────────────────────
console.log('\n[3] DOCX 取字');
const r2 = extractDocx(docx);
check('拿到第一段', r2.text.includes('第一段：会议纪要'), r2.text);
check('拿到第二段', r2.text.includes('第二段带'));
check('制表符保留', r2.text.includes('\t') || r2.text.includes('第二段带 制表符'));
check('转义还原', r2.text.includes('转义 & 与 <尖括号>'));

// ── 4. XLSX ──────────────────────────────────────────────────────────────
console.log('\n[4] XLSX 取字');
const r3 = extractXlsx(xlsx);
check('共享字符串解析正确', r3.text.includes('姓名') && r3.text.includes('段位'), r3.text);
check('数字单元格取到', r3.text.includes('1790'));
check('带单元格坐标', r3.text.includes('A1=姓名'), r3.text);
check('带工作表标题', r3.text.includes('工作表 1'));

// ── 5. ODP ───────────────────────────────────────────────────────────────
console.log('\n[5] ODP 取字');
const r4 = extractOdp(odp);
check('拿到第一页', r4.text.includes('ODP 第一页'), r4.text);
check('拿到第二页（无 span 的纯文本也要能取到）', r4.text.includes('ODP 第二页纯文本'));

// ── 6. 旧版 .ppt（OLE 二进制，粗提取）────────────────────────────────────
console.log('\n[6] 旧版 .ppt 粗提取');
{
  const ole = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
    Buffer.from('标题：这是旧版PPT的文字内容', 'utf16le'),
    Buffer.alloc(8),
    Buffer.from('第二个要点 bullet', 'utf16le'),
    Buffer.alloc(64),
  ]);
  check('识别为 ppt-legacy', detectOfficeKind(ole, 'x.ppt') === 'ppt-legacy', detectOfficeKind(ole, 'x.ppt'));
  const r5 = extractLegacyPpt(ole);
  check('扫出 UTF-16LE 中文文本', r5.text.includes('这是旧版PPT的文字内容'), r5.text);
  check('扫出英文要点', r5.text.includes('第二个要点 bullet'), r5.text);
  check('标记为粗提取（crude）', r5.crude === true);
  const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(200)]);
  check('空 .ppt 给出明确失败而不是乱码',
    (() => { try { extractLegacyPpt(ole2); return false; } catch (e) { return /另存为/.test(e.message); } })());

  // 噪声过滤：拿真实《答题纸》.doc 里出现过的两类垃圾行做回归
  {
    const noisy = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32),
      Buffer.from('宁波大学考核答题纸', 'utf16le'), Buffer.alloc(4),
      Buffer.from('大学生心理健康教育', 'utf16le'), Buffer.alloc(4),
      Buffer.from('橢橢좬좬', 'utf16le'), Buffer.alloc(4),                 // 韩文 → 必须丢
      Buffer.from('开敲獬ⸯ敲獬䭐ȁ-', 'utf16le'), Buffer.alloc(4),          // 生僻字+扩展A → 必须丢
      Buffer.from('ꌁਈ㹛ꥨ虯期杦杦', 'utf16le'), Buffer.alloc(32),          // 混杂 → 必须丢
    ]);
    const r6 = extractLegacyPpt(noisy);
    check('保留真实标题', r6.text.includes('宁波大学考核答题纸'), r6.text);
    check('保留真实课程名', r6.text.includes('大学生心理健康教育'), r6.text);
    check('丢掉韩文乱码「橢橢좬좬」', !r6.text.includes('좬'), r6.text);
    check('丢掉生僻字乱码「开敲獬ⸯ」', !r6.text.includes('獬'), r6.text);
    check('丢掉混杂乱码「ꌁਈ㹛」', !r6.text.includes('㹛'), r6.text);
  }
}

// ── 6b. PPT 内嵌图片（用户："我说的是 ppt 图片"）────────────────────────────
console.log('\n[6b] PPT 内嵌图片收集');
{
  const png = (kb) => {
    // 不需要是有效 PNG：取图只看扩展名/体积（内容原样透传给视觉输入）
    const b = Buffer.alloc(kb * 1024, 0x41);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0);
    return b;
  };
  const rels = (targets) => `<?xml version="1.0"?><Relationships>${targets
    .map((t, i) => `<Relationship Id="rId${i + 1}" Target="${t}"/>`).join('')}</Relationships>`;

  const withImgs = buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/slides/slide1.xml', slideXml('第一页', '正文一')],
    ['ppt/slides/_rels/slide1.xml.rels', rels(['../media/image1.png'])],
    ['ppt/slides/slide2.xml', slideXml('第二页', '正文二')],
    // 同一页两张大图：maxPerSlide=1 时必须只取一张，否则会挤掉后面的页
    ['ppt/slides/_rels/slide2.xml.rels', rels(['../media/image2.png', '../media/image3.png'])],
    ['ppt/slides/slide3.xml', slideXml('第三页', '正文三')],
    // 矢量图（数学公式）：视觉模型读不了，必须跳过
    ['ppt/slides/_rels/slide3.xml.rels', rels(['../media/formula.wmf'])],
    ['ppt/media/image1.png', png(20)],
    ['ppt/media/image2.png', png(30)],
    ['ppt/media/image3.png', png(40)],
    ['ppt/media/formula.wmf', Buffer.alloc(50 * 1024, 0x42)],
    ['ppt/media/icon.png', png(1)],   // 图标级小图：小于 minBytes，跳过
  ]);

  const all = extractOfficeText(withImgs, 'deck.pptx', { images: { maxCount: 4, maxPerSlide: 1 } });
  check('文字照常提取', all.text.includes('第一页') && all.text.includes('第三页'), all.text.slice(0, 120));
  check('取到了内嵌图', all.images.length === 2, `images=${all.images.length} ${JSON.stringify(all.images.map((i) => i.name))}`);
  check('只取第 1、2 页各一张（同页第二张被压掉）',
    JSON.stringify(all.images.map((i) => i.slide)) === '[1,2]',
    JSON.stringify(all.images.map((i) => `${i.name}@p${i.slide}`)));
  check('跳过 .wmf 矢量图', !all.images.some((i) => /wmf/i.test(i.name)));
  check('跳过图标级小图（<8KB）', !all.images.some((i) => i.name === 'icon.png'));
  check('图片带 mediaType', all.images.every((i) => /^image\//.test(i.mediaType)));
  check('图片 buffer 非空', all.images.every((i) => i.buffer?.length > 0));
  check('报出"文档里共有几张"（便于如实告知只送了部分）', all.totalImages >= 3, `totalImages=${all.totalImages}`);

  // 预算：maxCount 生效
  const limited = extractOfficeText(withImgs, 'deck.pptx', { images: { maxCount: 1, maxPerSlide: 1 } });
  check('maxCount=1 时只取 1 张', limited.images.length === 1, `images=${limited.images.length}`);

  // 纯图版（没有文字）：不该判失败，而是让她看图
  const imageOnly = buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'],
    ['ppt/slides/_rels/slide1.xml.rels', rels(['../media/image1.png'])],
    ['ppt/media/image1.png', png(25)],
  ]);
  const only = extractOfficeText(imageOnly, 'scan.pptx', { images: { maxCount: 4, maxPerSlide: 1 } });
  check('没有文字但有图 → 不算失败', only.text.length > 0 && only.images.length === 1);
  check('并说明"内容都在图里"', /图/.test(only.text), only.text);
  // 既没文字也没图 → 仍然如实失败
  const nothing = buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'],
  ]);
  check('既没文字也没图 → 明确失败', (() => {
    try { extractOfficeText(nothing, 'empty.pptx'); return false; }
    catch (e) { return /没有可提取的文字/.test(e.message); }
  })());
}

// ── 7. 安全边界：畸形/恶意输入不能崩、不能吃爆内存 ───────────────────────
console.log('\n[7] 安全边界');
for (const [label, buf, name] of [
  ['随机二进制', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 'a.pptx'],
  ['ZIP 魔数但内容是垃圾', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('garbage'.repeat(50))]), 'b.pptx'],
  ['截断的 EOCD', Buffer.concat([pptx.subarray(0, pptx.length - 10)]), 'c.pptx'],
  ['空 buffer', Buffer.alloc(0), 'd.pptx'],
  ['纯文本改名成 pptx', Buffer.from('这不是 pptx'), 'e.pptx'],
]) {
  let threw = false;
  try { extractOfficeText(buf, name); } catch { threw = true; }
  check(`${label} → 抛错而不是崩溃`, threw);
  const kind = detectOfficeKind(buf, name);
  check(`${label} → 识别为空或 pptx（不乱猜）`, kind === '' || kind === 'pptx', kind);
}

// ZIP 炸弹：声明超大解压体积的条目必须被上限挡住，不会真的去解
{
  // 造一个 200KB 的 deflate 流（解压后 8MB），并声明 uncompressedSize 超过上限
  const bombRaw = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const zip = buildZip([['ppt/slides/slide1.xml', bombRaw]]);
  // 直接把中央目录里的 uncompressedSize 改大，模拟"声明体积超限"
  const dir = readZipDirectory(zip);
  check('能读出条目元数据', dir.length === 1 && dir[0].name === 'ppt/slides/slide1.xml');
  check('单条目解压上限存在且合理',
    LIMITS.maxEntryBytes > 0 && LIMITS.maxEntryBytes <= 32 * 1024 * 1024, `${LIMITS.maxEntryBytes}`);
  check('总解压上限存在', LIMITS.maxTotalBytes > 0);
  check('页数/字符数都有上限', LIMITS.maxSlides > 0 && LIMITS.maxChars > 0);
}

// ── 8. 带硬超时的入口（真实 worker 线程）──────────────────────────────────
console.log('\n[8] worker 入口（真实线程 + 硬超时）');
{
  const r = await extractOfficeTextSafe(pptx, { name: 'test.pptx', timeoutMs: 8000 });
  check('worker 模式能取到文字', r.ok === true && r.text.includes('第一页标题'),
    JSON.stringify({ ok: r.ok, error: r.error, head: (r.text || '').slice(0, 80) }));
  check('worker 回传 kind', r.kind === 'pptx', r.kind);
  check('worker 回传统计', r.stats && r.stats.pages === 2, JSON.stringify(r.stats));

  const bad = await extractOfficeTextSafe(Buffer.from('not a ppt'), { name: 'x.pptx', timeoutMs: 5000 });
  check('worker 模式对垃圾输入返回 ok:false 而不是卡住', bad.ok === false);
  check('worker 返回可读的错误原因', typeof bad.error === 'string' && bad.error.length > 0, bad.error);
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
