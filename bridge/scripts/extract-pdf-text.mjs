// PDF 文字提取（零依赖，自研）。用于 QQ 文件消息里的 PDF。
//
// 已实测支持的场景：
//   - 中文 PDF（CID 字体 + ToUnicode CMap + hex 字符串）→ 中文正确还原
//   - 英文 PDF（简单字体 + 字面量字符串）
//
// 已知不支持（超时/失败时优雅降级，由调用方提示「看不到内容」）：
//   - PDF 1.5+ 对象流（/Type /ObjStm，对象与内容流被压缩进对象流）
//   - 加密 PDF、扫描件（图片无文字层）、LZW/DCT 等非 Flate 压缩
//
// 设计要点（都是踩过的坑）：
//   1. 内容流必须**线性扫描**，不能用正则：TJ 数组的正则在大流上灾难性回溯（曾卡死 120s+）
//   2. CMap/ToUnicode 流必须按对象号排除，否则其 <0000> <FFFF> 会污染正文
//   3. 字体字典要读完整：/Subtype /Type0、/Encoding /Identity-H 可能在字典靠后位置
//   4. 简单字体 1 字节码、Type0/Identity-H 是 2 字节 CID → 解码必须跟着字体走
//   5. zlib.inflateSync 是同步的，必须限制流大小，否则解压超大流会卡死进程
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { scanContentStream as scanStream, isContentStreamDict } from './pdf-content-scanner.mjs';

const MAX_STREAM_BYTES = 8 * 1024 * 1024;    // 单个流（压缩态）上限
const MAX_INFLATED_BYTES = 32 * 1024 * 1024; // 解压后上限

export function extractPdfText(buf, opts = {}) {
  const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 8000;
  const deadline = Date.now() + budgetMs;
  const outOfTime = () => Date.now() > deadline;

  const latin = buf.toString('latin1');
  if (!latin.startsWith('%PDF')) throw new Error('不是 PDF 文件');

  const warnings = [];
  let timedOut = false;

  // ── 0. 对象索引：一次线性扫描，同时记住每个对象的起止偏移 ──
  // 性能关键：不要在每个对象上重复 indexOf('endobj') / 大切片（曾因此超时）。
  const objIndex = new Map(); // objNum -> { start, end }
  {
    const re = /(?:^|[^0-9])(\d+)\s+0\s+obj\b/g;
    let m;
    let prev = null;
    while ((m = re.exec(latin)) !== null) {
      const num = Number(m[1]);
      const start = m.index + (m[0].length - m[0].trimStart().length);
      if (prev) prev.end = start; // 上一个对象的正文到这里结束
      if (!objIndex.has(num)) {
        const rec = { start, end: latin.length };
        objIndex.set(num, rec);
        prev = rec;
      }
    }
  }

  const objBody = (objNum, maxLen = 200000) => {
    const rec = objIndex.get(objNum);
    if (!rec) return null;
    const stop = Math.min(rec.end, rec.start + maxLen);
    const slice = latin.slice(rec.start, stop);
    // 对象正文以 endobj 收尾：按需裁剪，避免把下一个对象的头部带进来
    const e = slice.indexOf('endobj');
    return e >= 0 ? slice.slice(0, e) : slice;
  };

  const getStream = (objNum) => {
    const body = objBody(objNum, MAX_STREAM_BYTES + 4096);
    if (!body) return null;
    const sIdx = body.indexOf('stream');
    if (sIdx < 0) return null;
    const dict = body.slice(0, sIdx);
    const lenM = dict.match(/\/Length\s+(\d+)/);
    if (lenM && Number(lenM[1]) > MAX_STREAM_BYTES) return null;
    let data = body.slice(sIdx + 'stream'.length).replace(/^\r?\n/, '');
    const endIdx = data.lastIndexOf('endstream');
    if (endIdx >= 0) data = data.slice(0, endIdx);
    if (data.length > MAX_STREAM_BYTES) return null;
    const raw = Buffer.from(data, 'latin1');
    if (/\/FlateDecode/.test(dict)) {
      try {
        return zlib.inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES }).toString('latin1');
      } catch { return null; }
    }
    // 非 Flate（如 CCITTFaxDecode 扫描图）不在这里处理：解出来也不是文本
    return /\/Filter/.test(dict) ? null : raw.toString('latin1');
  };

  // ── 1. 字体：对象号、ToUnicode 引用、字节模式 ──
  const fontRefs = [];
  const fontByteMode = new Map();
  // 字体文件流的对象号（FontFile/FontFile2/FontFile3）——这些是嵌入字形数据，
  // 不是页面内容，必须排除，否则几百 KB 的字体二进制会被当内容流扫描（曾导致超时）。
  const fontFileObjNums = new Set();
  for (const objNum of objIndex.keys()) {
    if (outOfTime()) { timedOut = true; break; }
    const body = objBody(objNum, 200000);
    if (!body) continue;
    for (const m of body.matchAll(/\/FontFile[23]?\s+(\d+)\s+0\s+R/g)) {
      fontFileObjNums.add(Number(m[1]));
    }
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const tu = body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    const isCid = /\/Subtype\s*\/Type0/.test(body) || /\/Encoding\s*\/Identity-H/.test(body);
    fontByteMode.set(objNum, isCid ? 2 : 1);
    fontRefs.push({ objNum, toUnicodeObjNum: tu ? Number(tu[1]) : null });
  }

  const fontNameToObj = new Map();
  for (const m of latin.matchAll(/\/([A-Za-z][A-Za-z0-9]*)\s+(\d+)\s+0\s+R/g)) {
    const num = Number(m[2]);
    if (fontRefs.some((f) => f.objNum === num)) fontNameToObj.set(m[1], num);
  }

  // ── 2. ToUnicode CMap 解析 ──
  const toUnicodeMaps = new Map();
  for (const { objNum, toUnicodeObjNum } of fontRefs) {
    if (!toUnicodeObjNum) continue;
    if (outOfTime()) { timedOut = true; break; }
    const cmap = getStream(toUnicodeObjNum);
    if (!cmap) continue;
    const map = new Map();
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), hexToUtf16(pair[2]));
      }
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const text = block[1];
      for (const r of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        const dst = parseInt(r[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(c, String.fromCodePoint(dst + (c - lo)));
          if ((c - lo) % 4096 === 0 && outOfTime()) { timedOut = true; break; }
        }
        if (timedOut) break;
      }
      if (timedOut) break;
      for (const r of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
        const lo = parseInt(r[1], 16);
        const items = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToUtf16(x[1]));
        items.forEach((s, i) => map.set(lo + i, s));
      }
    }
    if (map.size) toUnicodeMaps.set(objNum, map);
  }

  // ── 3. 内容流：线性扫描取文本 ──
  const cmapObjNums = new Set();
  for (const { toUnicodeObjNum } of fontRefs) if (toUnicodeObjNum) cmapObjNums.add(toUnicodeObjNum);

  const chunks = [];
  let streamCount = 0;
  for (const objNum of objIndex.keys()) {
    if (outOfTime()) { timedOut = true; break; }
    const body = objBody(objNum, 4000);
    if (!body || !/stream/.test(body)) continue;
    const dict = body.slice(0, body.indexOf('stream'));
    if (!isContentStreamDict(dict)) continue;
    if (cmapObjNums.has(objNum)) continue;
    // 嵌入字体文件（TrueType/CFF）与 Type1 字体程序都不是页面内容
    if (fontFileObjNums.has(objNum)) continue;
    if (/\/Length1\b|\/Subtype\s*\/(TrueType|Type1|Type1C|CIDFontType0C|OpenType)/.test(dict)) continue;
    const s = getStream(objNum);
    if (!s) continue;
    streamCount++;
    try {
      const part = scanStream(s, (name) => fontNameToObj.get(name), toUnicodeMaps, fontByteMode, deadline);
      if (part) chunks.push(part);
    } catch (error) {
      warnings.push(`流 ${objNum} 解析失败：${error?.message ?? error}`);
    }
  }

  const text = chunks.join('')
    // CJK 文档里 Td/TD 换行常把一个词拆开：若换行两侧都是 CJK，则合并（不插空格）
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\n([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1$2')
    // 连续多行空行压缩
    .replace(/\n{3,}/g, '\n\n')
    // 行内多余空白压缩
    .replace(/[ \t]{2,}/g, ' ')
    // 丢掉无意义字符（私用区、控制符）
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ue000-\uf8ff]/g, '')
    .trim();

  return {
    text,
    streamCount,
    fontCount: fontRefs.length,
    cmapCount: toUnicodeMaps.size,
    hasToUnicode: toUnicodeMaps.size > 0,
    timedOut,
    warnings,
  };
}

function hexToUtf16(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

// CLI：node extract-pdf-text.mjs <pdf路径>
if (process.argv[1] && process.argv[1].endsWith('extract-pdf-text.mjs')) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node extract-pdf-text.mjs <pdf路径>');
    process.exit(1);
  }
  const r = extractPdfText(readFileSync(file), { budgetMs: 8000 });
  console.log(`内容流 ${r.streamCount} | 字体 ${r.fontCount} | CMap ${r.cmapCount} | 超时 ${r.timedOut}`);
  console.log(`提取 ${r.text.length} 字符：`);
  console.log(r.text.slice(0, 600));
}
