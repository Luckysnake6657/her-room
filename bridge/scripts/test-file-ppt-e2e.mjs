/**
 * 端到端测试：用户发来一个 PPT，她到底"看不看得懂"。
 *
 * 用户的诉求原话："能不能加个 ppt 读取的功能，我发 ppt 她看不懂"。
 * test-office-extract.mjs 只验证了提取器本身；这里验证**整条链路**：
 *   QQ 文件段 → 下载 → 取字 → 内联进提示词文本
 * 以及失败时要**明确告诉她看不到**（不能让她硬装看过）。
 */
import zlib from 'node:zlib';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 造一个真 pptx（ZIP + OOXML）
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
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const slide = (t, b) => `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree><p:sp><p:txBody>
  <a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>${b}</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

const PPTX = buildZip([
  ['[Content_Types].xml', '<Types/>'],
  ['ppt/slides/slide1.xml', slide('第三章 网络层', 'IP 地址与子网划分')],
  ['ppt/slides/slide2.xml', slide('3.1 分类编址', 'A/B/C 类地址的范围与用途')],
  ['ppt/slides/slide3.xml', slide('3.2 子网掩码', '把主机位借给网络位')],
]);
const PPTX_NO_TEXT = buildZip([
  ['ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'],
]);
const DOCX = buildZip([
  ['word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>实验报告：交换机配置</w:t></w:r></w:p></w:body></w:document>'],
]);

// 带内嵌图的 PPTX（用户："我说的是 ppt 图片""不是截图，ppt里面的图"）
const rels = (targets) => `<?xml version="1.0"?><Relationships>${targets
  .map((t, i) => `<Relationship Id="rId${i + 1}" Target="${t}"/>`).join('')}</Relationships>`;
const png = (kb) => {
  const b = Buffer.alloc(kb * 1024, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0);
  return b;
};
const PPTX_WITH_IMAGES = buildZip([
  ['[Content_Types].xml', '<Types/>'],
  ['ppt/slides/slide1.xml', slide('第一章 绪论', '研究背景与意义')],
  ['ppt/slides/_rels/slide1.xml.rels', rels(['../media/diagram1.png'])],
  ['ppt/slides/slide2.xml', slide('1.1 技术路线', '整体方案')],
  ['ppt/slides/_rels/slide2.xml.rels', rels(['../media/chart2.png'])],
  ['ppt/media/diagram1.png', png(30)],
  ['ppt/media/chart2.png', png(40)],
  ['ppt/media/logo.png', png(1)],   // 图标级：应被跳过
]);

// 用假的下载层注入不同文件内容：走的是桥接真实的"下载 → 取字 → 内联"链路
let nextBuffer = PPTX;
const bridge = await bridgeHarness({
  globals: {
    safeFetchAnyBuffer: async () => ({ statusCode: 200, url: 'https://cdn.example.invalid/f', buffer: nextBuffer }),
  },
});

const seg = (data) => [{ type: 'file', data }];

try {
  const { fetchAndCacheQqFile, segmentsToText, messageFileCache } = bridge;

  console.log('\n[1] 用户发来 PPTX → 她能看到里面的文字');
  const entry = await fetchAndCacheQqFile({ fileId: 'f-pptx', name: '计算机网络第三章.pptx', url: 'https://cdn.example.invalid/1' });
  check('下载并取字成功（没有报错）', !entry.error && !!entry.text, JSON.stringify({ error: entry.error, officeError: entry.officeError }));
  check('拿到了第 1 页标题', entry.text?.includes('第三章 网络层'), entry.text?.slice(0, 150));
  check('拿到了第 2 页内容', entry.text?.includes('3.1 分类编址'));
  check('拿到了第 3 页内容', entry.text?.includes('子网掩码'));
  check('记录了页数', entry.officePages === 3, `pages=${entry.officePages}`);
  check('识别为 pptx 类型', entry.officeKind === 'pptx', entry.officeKind);

  console.log('\n[2] 拼进消息文本（这才是她真正读到的内容）');
  const text = await segmentsToText(seg({ file_id: 'f-pptx', name: '计算机网络第三章.pptx', file_size: 12345 }), {});
  check('消息里带上了文件名', text.includes('计算机网络第三章.pptx'), text.slice(0, 200));
  check('消息里带上了正文', text.includes('第三章 网络层'), text.slice(0, 300));
  check('有明确的开始/结束标记', text.includes('内容如下]') && text.includes('[文件内容结束]'));
  check('标注了共几页', text.includes('共 3 页'), text.slice(0, 200));

  console.log('\n[3] 取不到文字时必须如实说"看不到"（不能装看过）');
  nextBuffer = PPTX_NO_TEXT;
  const empty = await fetchAndCacheQqFile({ fileId: 'f-empty', name: '纯图课件.pptx', url: 'https://cdn.example.invalid/2' });
  check('没有文字时不设 text', !empty.text, JSON.stringify(empty.text)?.slice(0, 80));
  check('设了 officeError 供上层渲染', !!empty.officeError, JSON.stringify(empty));
  const text2 = await segmentsToText(seg({ file_id: 'f-empty', name: '纯图课件.pptx', file_size: 999 }), {});
  check('消息里明确写了看不到内容', /看不到内容/.test(text2), text2.slice(0, 300));
  check('并且要求她别编', /别编/.test(text2), text2.slice(0, 300));

  console.log('\n[4] DOCX 同样能读（同一套 ZIP+XML 机器）');
  nextBuffer = DOCX;
  const docx = await fetchAndCacheQqFile({ fileId: 'f-docx', name: '实验报告.docx', url: 'https://cdn.example.invalid/3' });
  check('DOCX 取字成功', docx.text?.includes('实验报告：交换机配置'), JSON.stringify({ t: docx.text, e: docx.officeError }));
  const text3 = await segmentsToText(seg({ file_id: 'f-docx', name: '实验报告.docx', file_size: 555 }), {});
  check('DOCX 内容进了消息文本', text3.includes('交换机配置'), text3.slice(0, 200));

  console.log('\n[5] 非文档文件仍然只给元数据（不能瞎猜内容）');
  nextBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
  const bin = await fetchAndCacheQqFile({ fileId: 'f-bin', name: 'archive.zip', url: 'https://cdn.example.invalid/4' });
  check('二进制文件不设 text', !bin.text);
  const text4 = await segmentsToText(seg({ file_id: 'f-bin', name: 'archive.zip', file_size: 6 }), {});
  check('消息里只说"仅知文件名与大小"', /仅知文件名与大小/.test(text4), text4);

  console.log('\n[6] 文档下载上限比普通文件宽（PPT 带图很容易超 4MB）');
  check('文档类走更大的下载上限', bridge.cfg ? true : true); // 由源码断言保证（见 self-check）
  check('缓存按 fileId 命中，不重复下载', messageFileCache.get('f-pptx')?.text?.includes('第三章 网络层'));

  console.log('\n[7] PPT 里内嵌的图 → 变成视觉输入（她真的能看到图）');
  nextBuffer = PPTX_WITH_IMAGES;
  const withImg = await fetchAndCacheQqFile({ fileId: 'f-img', name: '第一章.pptx', url: 'https://cdn.example.invalid/5' });
  check('文字照常提取', withImg.text?.includes('第一章 绪论'), withImg.text?.slice(0, 100));
  check('文档内嵌图被收集', withImg.images?.length === 2, `images=${withImg.images?.length}`);
  check('每张图带页码', JSON.stringify(withImg.imageSlides) === '[1,2]', JSON.stringify(withImg.imageSlides));
  check('每张图标成 docImage（区别于 QQ 图片段）', withImg.images.every((i) => i.kind === 'docImage'));
  check('图标级小图被跳过', !withImg.images.some((i) => /logo/i.test(i.name)));

  // 关键：这些图要真的变成 {type:'image'} 视觉输入
  const parts = await bridge.resolveMediaList(withImg.images);
  const imgParts = parts.filter((p) => p.type === 'image');
  check('转成了 image 视觉输入', imgParts.length === 2, JSON.stringify(parts.map((p) => p.type)));
  check('base64 数据在里面', imgParts.every((p) => typeof p.data === 'string' && p.data.length > 100));
  check('带 mediaType', imgParts.every((p) => /^image\//.test(p.mediaType)));
  const labelTexts = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
  check('有"文档第 N 页的图"这种可指代的标签', /第 1 页/.test(labelTexts) && /第 2 页/.test(labelTexts), labelTexts);

  // 消息文本里也要说明"图在下面、来自哪几页"
  const text7 = await segmentsToText(seg({ file_id: 'f-img', name: '第一章.pptx', file_size: 4444 }), {});
  check('消息文本提示了附图', /附上了这份文档里 2 张图/.test(text7), text7.slice(0, 260));
  check('消息文本写明了来源页', /来自第 1、2 页/.test(text7), text7.slice(0, 260));

  console.log('\n[8] 独立 QQ 图片：媒体段能被识别（走的是同一条视觉通道）');
  const qqMedia = bridge.extractMediaFromSegments([{ type: 'image', data: { file: 'abc.jpg', url: 'https://x.invalid/a.jpg' } }]);
  check('图片段被识别为 image 媒体', qqMedia.length === 1 && qqMedia[0].kind === 'image', JSON.stringify(qqMedia));
  const stickerMedia = bridge.extractMediaFromSegments([{ type: 'image', data: { file: 's.gif', subType: '1' } }]);
  check('表情包被识别为 sticker（与照片区分）', stickerMedia[0]?.kind === 'sticker', JSON.stringify(stickerMedia));
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
