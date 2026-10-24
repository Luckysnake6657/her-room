/**
 * 回归测试：按需看图工具（`qq_get_document_images`）。
 *
 * 用户的需求："他让你记住一份 PPT 随时答问" —— 但 19 页的图不可能一次全塞进去
 * （视觉输入按图算钱，默认只附 4 张）。所以做一个工具：想不起来哪一页，她自己翻那一页看。
 * 用户原话："工具吧，到时候再整合一下就行"。
 *
 * 这里锁死三件事：
 *   1. 文档按**会话**索引（不然她不知道"这个群最近收到过哪份文档"）；
 *   2. 页号解析支持 "3" / "3,5,7" / "3-8"（还有中文"到"）；
 *   3. 按页取图真的只取那几页，并且同一页的多张图都给她。
 */
import zlib from 'node:zlib';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { extractOfficeTextSafe } from '../src/office-extract-safe.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

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
const slide = (t, body) => `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree><p:sp><p:txBody>
  <a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>${body}</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const rels = (targets) => `<?xml version="1.0"?><Relationships>${targets
  .map((t, i) => `<Relationship Id="rId${i + 1}" Target="${t}"/>`).join('')}</Relationships>`;
const png = (kb) => {
  const b = Buffer.alloc(kb * 1024, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0);
  return b;
};

// 4 页的 PPT：第 1 页文字、第 2 页两张图、第 3 页一张图、第 4 页纯文字
const DECK = buildZip([
  ['[Content_Types].xml', '<Types/>'],
  ['ppt/slides/slide1.xml', slide('封面：步进电机汇报', '汇报人：我')],
  ['ppt/slides/slide2.xml', slide('第2页 驱动芯片', 'A4988 与 DRV8825 对比')],
  ['ppt/slides/_rels/slide2.xml.rels', rels(['../media/chip-a.png', '../media/chip-b.png'])],
  ['ppt/slides/slide3.xml', slide('第3页 NEMA 尺寸表', 'NEMA17 / NEMA23')],
  ['ppt/slides/_rels/slide3.xml.rels', rels(['../media/nema.png'])],
  ['ppt/slides/slide4.xml', slide('第4页 结论', '谢谢')],
  ['ppt/media/chip-a.png', png(20)],
  ['ppt/media/chip-b.png', png(25)],
  ['ppt/media/nema.png', png(30)],
]);

let nextBuffer = DECK;
const bridge = await bridgeHarness({
  globals: {
    safeFetchAnyBuffer: async () => ({ statusCode: 200, url: 'https://cdn.example.invalid/f', buffer: nextBuffer }),
  },
});

try {
  const { fetchAndCacheQqFile, parsePageSpec, findConversationDocuments, messageFileCache } = bridge;

  console.log('\n[1] 页号解析（她说"第3页"/"3-8"/"3,5,7" 都要能懂）');
  check('单个页码', JSON.stringify(parsePageSpec('3')) === '[3]', JSON.stringify(parsePageSpec('3')));
  check('逗号列表', JSON.stringify(parsePageSpec('3,5,7')) === '[3,5,7]', JSON.stringify(parsePageSpec('3,5,7')));
  check('区间 3-8', JSON.stringify(parsePageSpec('3-8')) === '[3,4,5,6,7,8]', JSON.stringify(parsePageSpec('3-8')));
  check('中文"到"', JSON.stringify(parsePageSpec('2到4')) === '[2,3,4]', JSON.stringify(parsePageSpec('2到4')));
  check('波浪号', JSON.stringify(parsePageSpec('5~6')) === '[5,6]', JSON.stringify(parsePageSpec('5~6')));
  check('反向区间自动纠正', JSON.stringify(parsePageSpec('5-3')) === '[3,4,5]', JSON.stringify(parsePageSpec('5-3')));
  check('混用 + 全角逗号', JSON.stringify(parsePageSpec('1，3，6-7')) === '[1,3,6,7]', JSON.stringify(parsePageSpec('1，3，6-7')));
  check('垃圾输入不炸（返回空）', JSON.stringify(parsePageSpec('abc')) === '[]');
  check('上限 20 页（防她一次要一百页）', parsePageSpec('1-100').length === 20, String(parsePageSpec('1-100').length));

  console.log('\n[2] 文档按会话索引（她得知道"这个会话收到过哪份文档"）');
  const e1 = await fetchAndCacheQqFile({ fileId: 'deck-1', name: '步进电机汇报.pptx', url: 'https://x.invalid/1' }, undefined, { key: 'private:984776985' });
  check('取到文字', e1.text?.includes('步进电机汇报'), e1.text?.slice(0, 60));
  // 默认 maxCount=4 / maxPerSlide=1：第 2 页两张只取一张 + 第 3 页一张 = 2 张
  check('取到图（默认每页最多一张 → 2 张）', e1.images?.length === 2, `images=${e1.images?.length}`);
  check('默认取图每页不重复', new Set((e1.images ?? []).map((i) => i.slide)).size === (e1.images ?? []).length);
  check('记下了收到的会话', Array.isArray(e1.keys) && e1.keys.includes('private:984776985'), JSON.stringify(e1.keys));
  const found = findConversationDocuments(messageFileCache, 'private:984776985', '步进电机');
  check('按会话能找回这份文档', found.target?.entry?.name === '步进电机汇报.pptx', JSON.stringify(found.names));
  check('别的会话找不到它（不会串会话）',
    findConversationDocuments(messageFileCache, 'group:999', '').docs.length === 0);
  check('按部分文件名能命中', findConversationDocuments(messageFileCache, 'private:984776985', '步进').target != null);
  check('按 fileId 能精确命中', findConversationDocuments(messageFileCache, 'private:984776985', 'deck-1').target != null);
  check('找不到时返回候选列表（好告诉她有哪些）',
    findConversationDocuments(messageFileCache, 'private:984776985', '不存在的名字').target === null
    && findConversationDocuments(messageFileCache, 'private:984776985', '不存在的名字').names.length === 1);

  console.log('\n[3] 按需取某几页的图（工具的核心）');
  const only3 = await extractOfficeTextSafe(DECK, {
    name: '步进电机汇报.pptx', timeoutMs: 15000, includePageText: true,
    images: { pages: [3], maxCount: 8, maxPerSlide: 4, maxTotalBytes: 6 * 1024 * 1024 },
  });
  check('只要第 3 页 → 只回来第 3 页的图',
    only3.images.length === 1 && only3.images.every((i) => i.slide === 3),
    JSON.stringify(only3.images.map((i) => `${i.name}@p${i.slide}`)));
  check('带回第 3 页的文字（她答问要有内容）',
    (only3.pageTexts?.[2] ?? '').includes('NEMA 尺寸表'), JSON.stringify(only3.pageTexts?.[2]));

  const page2 = await extractOfficeTextSafe(DECK, {
    name: 'x.pptx', timeoutMs: 15000, includePageText: true,
    images: { pages: [2], maxCount: 8, maxPerSlide: 4, maxTotalBytes: 6 * 1024 * 1024 },
  });
  check('问第 2 页 → 同一页的两张图都给（不是只给一张）',
    page2.images.length === 2 && page2.images.every((i) => i.slide === 2),
    JSON.stringify(page2.images.map((i) => i.name)));

  const range = await extractOfficeTextSafe(DECK, {
    name: 'x.pptx', timeoutMs: 15000,
    images: { pages: parsePageSpec('2-3'), maxCount: 8, maxPerSlide: 4, maxTotalBytes: 6 * 1024 * 1024 },
  });
  check('区间 2-3 → 覆盖两页的图', range.images.length === 3, `images=${range.images.length}`);

  const none = await extractOfficeTextSafe(DECK, {
    name: 'x.pptx', timeoutMs: 15000, includePageText: true,
    images: { pages: [4], maxCount: 8, maxPerSlide: 4, maxTotalBytes: 6 * 1024 * 1024 },
  });
  check('问纯文字页 → 图 0 张但文字还在（不能报错）',
    none.ok === true && none.images.length === 0 && (none.pageTexts?.[3] ?? '').includes('结论'),
    JSON.stringify({ ok: none.ok, n: none.images.length }));

  console.log('\n[4] 不带 pages 时仍取"最值得看的几张"（原有行为不变）');
  const auto = await extractOfficeTextSafe(DECK, {
    name: 'x.pptx', timeoutMs: 15000,
    images: { maxCount: 4, maxPerSlide: 1, maxTotalBytes: 3 * 1024 * 1024 },
  });
  check('自动选图仍然工作（第 2、3 页各一张）', auto.images.length === 2, `images=${auto.images.length}`);
  check('每页最多一张（第 2 页只取一张）',
    new Set(auto.images.map((i) => i.slide)).size === auto.images.length,
    JSON.stringify(auto.images.map((i) => i.slide)));
  console.log('\n[5] 真实 HTTP 端点走一遍（路由/鉴权/找文档/按页取图）');
  {
    const PORT = 3287;
    bridge.cfg.consolePort = PORT;
    bridge.cfg.consoleToken = 'fixture-console-token';
    bridge.setMode('reserved2');
    // 用 harness 白名单内的会话（private:123），否则会被 modeAllowed 拦掉
    const key = 'private:123';
    const st = bridge.getSocialV2State(key);
    // 同一份 PPT 在这个会话里也收一次（端点只认"这个会话收到过的文档"）
    await fetchAndCacheQqFile({ fileId: 'deck-1', name: '步进电机汇报.pptx', url: 'https://x.invalid/1' }, undefined, { key });
    await bridge.startConsoleServer();
    await new Promise((r) => setTimeout(r, 400));
    const call = async (qs) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/socialV2/document-images?${qs}`, {
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const r1 = await call(`key=${encodeURIComponent(key)}&pages=3`);
    check('端点可达且 200', r1.status === 200, `status=${r1.status} ${JSON.stringify(r1.json)?.slice(0, 150)}`);
    check('按页返回第 3 页的图', r1.json?.images?.length === 1 && r1.json.images[0].slide === 3,
      JSON.stringify(r1.json?.images?.map((i) => i.slide)));
    check('返回 base64 图像数据（模型能吃）', typeof r1.json?.images?.[0]?.data === 'string' && r1.json.images[0].data.length > 100);
    check('带该页文字', String(r1.json?.pageTexts?.[3] ?? '').includes('NEMA'), JSON.stringify(r1.json?.pageTexts));
    check('报出文件名与总页数', r1.json?.file === '步进电机汇报.pptx' && r1.json?.totalPages === 4,
      JSON.stringify({ f: r1.json?.file, p: r1.json?.totalPages }));

    const r2 = await call(`key=${encodeURIComponent(key)}&pages=2`);
    check('按页要第 2 页 → 同一页两张图都给', r2.json?.images?.length === 2, JSON.stringify(r2.json?.images?.map((i) => i.slide)));
    const r3 = await call(`key=${encodeURIComponent(key)}&pages=${encodeURIComponent('2-3')}`);
    check('区间写法也认', r3.json?.images?.length === 3, `n=${r3.json?.images?.length}`);
    const r4 = await call(`key=${encodeURIComponent(key)}&file=${encodeURIComponent('步进')}`);
    check('按部分文件名找得到', r4.json?.file === '步进电机汇报.pptx', JSON.stringify(r4.json?.file));
    const r5 = await call(`key=${encodeURIComponent(key)}&file=${encodeURIComponent('不存在的.pptx')}`);
    check('找不到时给出候选列表而不是报错', r5.status === 200 && Array.isArray(r5.json?.files) && r5.json.files.length === 1,
      JSON.stringify(r5.json));
    const r6 = await call(`key=${encodeURIComponent('group:456')}&pages=1`);
    check('别的会话里找不到（不会串）', r6.json?.images?.length === 0 && /没收到过|不在缓存/.test(r6.json?.note ?? ''),
      JSON.stringify(r6.json?.note));
    const r7 = await call(`key=${encodeURIComponent(key)}&pages=3`).catch(() => null);
    const noToken = await fetch(`http://127.0.0.1:${PORT}/api/socialV2/document-images?key=${encodeURIComponent(key)}&pages=3`)
      .then((res) => res.json()).catch(() => null);
    check('reserved2 下缺 agent token 会被拒', noToken?.ok !== true, JSON.stringify(noToken)?.slice(0, 120));
    check('带 token 的请求仍然正常（前后一致）', r7?.json?.images?.length === 1);

    console.log('\n[6] 边界与易错点（"没取到图"不能被当成"这页没有图"）');
    const r8 = await call(`key=${encodeURIComponent(key)}&pages=99`);
    check('要了不存在的页 → 如实说"只有 N 页"',
      /只有 4 页/.test(r8.json?.note ?? ''), JSON.stringify(r8.json?.note));
    check('并给出越界页列表（供她修正）',
      JSON.stringify(r8.json?.outOfRangePages) === '[99]', JSON.stringify(r8.json?.outOfRangePages));

    const r9 = await call(`key=${encodeURIComponent(key)}&pages=${encodeURIComponent('2,4')}`);
    check('有的是图、有的是纯文字页 → 明确告知哪页没图',
      /第 4 页没取到图/.test(r9.json?.note ?? ''), JSON.stringify(r9.json?.note));
    check('但该页的文字仍然给她（她能答"第4页讲什么"）',
      String(r9.json?.pageTexts?.[4] ?? '').includes('结论'), JSON.stringify(r9.json?.pageTexts));

    const r10 = await call(`key=${encodeURIComponent(key)}&pages=${encodeURIComponent('abc, ,3')}`);
    check('页号里有垃圾字符也不炸（能挑出 3）',
      r10.status === 200 && r10.json?.images?.length === 1, `status=${r10.status} n=${r10.json?.images?.length}`);

    const r11 = await call(`key=${encodeURIComponent(key)}&pages=3&file=deck-1`);
    check('用 fileId 也能定位', r11.json?.file === '步进电机汇报.pptx', JSON.stringify(r11.json?.file));

    // 旧版 OLE 二进制（不是 ZIP）：不能崩，应给出"没有可取的图"
    nextBuffer = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64),
      Buffer.from('旧版PPT文字内容', 'utf16le'), Buffer.alloc(64),
    ]);
    await fetchAndCacheQqFile({ fileId: 'ole-1', name: '老课件.ppt', url: 'https://x.invalid/2' }, undefined, { key });
    const r12 = await call(`key=${encodeURIComponent(key)}&pages=1&file=${encodeURIComponent('老课件')}`);
    check('旧版 .ppt 取图不崩（老实说没有图）',
      r12.status === 200 && r12.json?.images?.length === 0, `status=${r12.status} ${JSON.stringify(r12.json?.note)}`);

    // 非文档文件（zip）不该被当成"可以看图的文档"
    nextBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    await fetchAndCacheQqFile({ fileId: 'plain-zip', name: '压缩包.zip', url: 'https://x.invalid/3' }, undefined, { key });
    const r13 = await call(`key=${encodeURIComponent(key)}&pages=1&file=${encodeURIComponent('压缩包')}`);
    check('普通 zip 不会被列成文档', /没找到/.test(r13.json?.note ?? ''), JSON.stringify(r13.json?.note));

    // 同一份文档在第二个会话也收到时，必须补进索引（缓存按 fileId 命中会早返回）
    check('同一文件在第二个会话也补进了索引',
      (messageFileCache.get('deck-1')?.keys ?? []).includes('private:123'),
      JSON.stringify(messageFileCache.get('deck-1')?.keys));

    console.log('\n[7] 文档图的额度必须独立（不能被同一消息里的 QQ 图片挤掉）');
    {
      const big = Buffer.alloc(20000, 0x41);
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(big, 0);
      const docImgs = Array.from({ length: 5 }, (_, i) => ({
        kind: 'docImage', slide: i + 1, mediaType: 'image/png', name: `p${i + 1}.png`, buffer: big,
      }));
      // 只有文档图
      const only = await bridge.resolveMediaList(docImgs.map((m) => ({ ...m })));
      check('5 张文档图全部转成视觉输入', only.filter((p) => p.type === 'image').length === 5,
        `n=${only.filter((p) => p.type === 'image').length}`);
      // 前面塞 5 个 QQ 图片段（会因下载失败被跳过）——文档图不该因此被"额度"挤掉
      const mixed = await bridge.resolveMediaList([
        ...Array.from({ length: 5 }, (_, i) => ({ kind: 'image', url: `https://x.invalid/${i}.jpg` })),
        ...docImgs.map((m) => ({ ...m })),
      ]);
      const docParts = mixed.filter((p) => p.type === 'image');
      check('QQ 图片占满额度时，文档图仍然照常送到（额度独立）', docParts.length === 5, `n=${docParts.length}`);
      check('文本标签按页标注（她能指代）',
        /文档第 1 页的图/.test(mixed.filter((p) => p.type === 'text').map((p) => p.text).join('|')));
    }
  }
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
