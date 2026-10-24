// Office / OOXML 文档取字 worker：PPT / PPTX / DOCX / XLSX / ODP。
//
// 为什么需要它：用户反馈"我发 ppt 她看不懂"——原来只有纯文本和 PDF 会内联内容，
// 其它文件在她眼里只有"文件名 + 大小"。
//
// 这些都是 ZIP + XML（OOXML/ODF），所以自己写了个最小 ZIP 读取器，
// **不引入新依赖**（只用 node:zlib）。旧版 .ppt 是 OLE 二进制，没有 XML 可取，
// 走"扫描 UTF-16LE/GBK 文本段"的粗略提取，并明确标注是粗提取。
//
// 安全边界（防 zip 炸弹 / 畸形文件）：所有体积与条数都有硬上限，
// 并且由 office-extract-safe.mjs 放进 worker 线程跑，超时可强制终止。
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

// ── 上限（防止畸形/恶意文件把内存吃爆）────────────────────────────────────
export const LIMITS = {
  maxEntries: 4000,            // 压缩包里的条目数
  maxEntryBytes: 12 * 1024 * 1024,   // 单个条目解压后上限
  maxTotalBytes: 64 * 1024 * 1024,   // 所有条目解压后总量
  maxSlides: 200,              // 最多读多少页幻灯片
  maxChars: 60000,             // 提取文本总字符上限
};

// ── 最小 ZIP 读取器 ───────────────────────────────────────────────────────
// 只支持 stored(0) 与 deflate(8)，这正是 OOXML/ODF 用的两种。
// 不处理 ZIP64（QQ 下载上限本来就远小于 4GB）。
function findEocd(buf) {
  // EOCD 签名 0x06054b50，注释最长 65535 字节，从尾部往前找
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 读取 ZIP 的中央目录，返回 [{ name, method, compressedSize, uncompressedSize, localOffset }]。
 * 只解析目录，不解压——按需再 readEntry。
 */
export function readZipDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > LIMITS.maxEntries) throw new Error(`ZIP 条目过多（${count}）`);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) break;
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // 中央目录条目签名
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 解压一个条目，返回 Buffer 或 null（超限/损坏/加密时）。 */
export function readZipEntry(buf, entry) {
  if (!entry || entry.uncompressedSize > LIMITS.maxEntryBytes) return null;
  if (entry.method !== 0 && entry.method !== 8) return null; // 不支持 bzip2/lzma 等
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) return null;
  const raw = buf.subarray(start, end);
  try {
    if (entry.method === 0) return Buffer.from(raw);
    const out = zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes });
    return out;
  } catch {
    return null;
  }
}

/** 把整个 zip 读成 Map<name, Buffer>，但只读我们关心的那些（省内存/时间）。 */
export function readZipSelected(buf, wanted) {
  const dir = readZipDirectory(buf);
  const files = new Map();
  let total = 0;
  for (const e of dir) {
    if (!wanted(e.name)) continue;
    const data = readZipEntry(buf, e);
    if (!data) continue;
    total += data.length;
    if (total > LIMITS.maxTotalBytes) break;
    files.set(e.name, data);
  }
  return files;
}

// ── XML 文本工具 ──────────────────────────────────────────────────────────
export function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&amp;/g, '&');
}

/**
 * 取某个 XML 里成对标签的块，**连开始标签的属性一起返回**。
 * 属性必须留着：XLSX 判断一个单元格是不是共享字符串靠的是 `<c t="s">` 上的 `t`，
 * 只拿 inner body 就把这个信息丢了（第一版就是这么错的，测试当场抓到）。
 */
function tagBlocks(xml, tag) {
  const re = new RegExp(`<${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] ?? '', body: m[2] });
  return out;
}

/** 同上，但只要 body（大多数场景够用）。 */
function blocksOf(xml, tag) {
  return tagBlocks(xml, tag).map((b) => b.body);
}

/**
 * 从一个块里按出现顺序抓文本：既抓 `<tag>` 的文本，也把自闭合标记换成指定字符。
 * 第一版只抓 `<a:t>`/`<w:t>`，于是 `<w:tab/>` 换出来的制表符在标签**外面**、
 * 直接被丢掉（测试抓到）；所以必须让"标记"和"文本"在同一个交替正则里按序匹配。
 */
function runsOf(block, textTag, tokens = {}) {
  const tokenTags = Object.keys(tokens);
  const alt = tokenTags.length ? `|<(${tokenTags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*/>` : '';
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>${alt}`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(block))) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[2] !== undefined) out += tokens[m[2]] ?? '';
  }
  return out;
}

// 常用汉字（前若干高频字）。用来判断一段 UTF-16 扫描结果"像不像人话"：
// 二进制噪声经常扫出**技术上合法**但现实中不会成串出现的生僻字/韩文。
const COMMON_CJK = new Set('的一是不了在人有我他这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感班课姓名考核成绩学号班级');

function looksLikeBinaryNoise(run) {
  const chars = [...run];
  let suspicious = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if ((c >= 0xac00 && c <= 0xd7af)      // 韩文音节：中文文档里出现就是误读
      || (c >= 0x2e80 && c <= 0x2fff)     // CJK 部首补充
      || (c >= 0x3400 && c <= 0x4dbf)     // CJK 扩展 A（生僻）
      || (c >= 0xf900 && c <= 0xfaff)     // CJK 兼容表意
      || (c >= 0xe000 && c <= 0xf8ff)     // 私用区
      || (c >= 0x00c0 && c <= 0x00ff)) {  // 拉丁补充字母（Ĩ 这类，UTF-16 误读的常客）
      suspicious++;
    }
  }
  // 阈值 0.1 是拿真实文件试出来的：旧版《答题纸》.doc 里的
  // 「开敲獬ⸯ敲獬䭐ȁ-」(1/9) 和「ꌁਈ㹛ꥨ虯期杦杦」(2/9) 都该丢，
  // 而「宁波大学考核答题纸」「标题：这是旧版PPT的文字内容」一个可疑字符都没有、必须留。
  if (suspicious / Math.max(1, chars.length) > 0.1) return true;
  const hasCommonCjk = chars.some((ch) => COMMON_CJK.has(ch));
  const asciiWord = (run.match(/[A-Za-z]{3,}|\d{3,}/g) ?? []).length > 0;
  // 既没有常用汉字、也没有像样的 ASCII 词 → 当成噪声
  return !hasCommonCjk && !asciiWord;
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
    .trim();
}

// ── PPTX ─────────────────────────────────────────────────────────────────
/**
 * 去掉 OOXML 的"域"（`<a:fld>`）：幻灯片编号、日期这类占位符的文字也放在 `<a:t>` 里，
 * 不去掉的话每一页都会混进一个孤零零的页码/日期。
 * 实测真实课件（宁波大学线性代数 .ppt、班会 .pptx）的备注页里就混着 `1.7.2013` 和 `‹#›`。
 */
function stripFields(xml) {
  return String(xml)
    .replace(/<a:fld[\s\S]*?<\/a:fld>/g, '')
    .replace(/<w:fldSimple[\s\S]*?<\/w:fldSimple>/g, '');
}

function slideNumber(name) {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

export function extractPptx(buf) {
  const files = readZipSelected(buf, (n) => /^ppt\/(slides|notesSlides)\/.*\.xml$/i.test(n));
  const slideNames = [...files.keys()].filter((n) => /^ppt\/slides\/[^/]+\.xml$/i.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slideNames.length) throw new Error('PPTX 里找不到幻灯片（ppt/slides/*.xml）');
  const noteNames = [...files.keys()].filter((n) => /^ppt\/notesSlides\/[^/]+\.xml$/i.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const notesByNum = new Map(noteNames.map((n) => [slideNumber(n), files.get(n)]));

  const parts = [];
  const pageTexts = [];   // 每页正文（不含"这一页没有文字"占位），供按需工具单页取用
  let chars = 0;
  let realChars = 0;   // 真正的正文（不含"这一页没有文字"这种占位），用来判断整份是不是纯图
  const max = Math.min(slideNames.length, LIMITS.maxSlides);
  let read = 0;
  for (let i = 0; i < max; i++) {
    const xml = stripFields(files.get(slideNames[i]).toString('utf8'));
    // 一个 <a:p> 就是一段（标题/正文/项目符号各是一段），段内抓 <a:t> 文本运行。
    const paras = blocksOf(xml, 'a:p').map((p) => runsOf(p, 'a:t', { 'a:br': '\n' })).map((t) => t.trim()).filter(Boolean);
    let body = tidy(paras.join('\n'));
    const note = notesByNum.get(slideNumber(slideNames[i]));
    if (note) {
      const n = tidy(blocksOf(stripFields(note.toString('utf8')), 'a:p').map((p) => runsOf(p, 'a:t', { 'a:br': '\n' })).map((t) => t.trim()).filter(Boolean).join('\n'));
      // 备注页会把页码/日期等噪声也带上，去掉纯数字行、日期行和残留的占位符
      const useful = n.split('\n')
        .filter((l) => l && !/^\d+$/.test(l))
        .filter((l) => !/^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/.test(l))
        .filter((l) => !/‹#›|‹›/.test(l))
        .join('\n');
      if (useful) body += `\n（备注：${useful}）`;
    }
    realChars += body.length;
    pageTexts.push(body);   // 按需工具要能单独取"第 N 页讲的是什么"
    if (!body) body = '（这一页没有文字，可能是图片）';
    const piece = `── 第 ${i + 1} 页 ──\n${body}`;
    chars += piece.length;
    parts.push(piece);
    read++;
    if (chars > LIMITS.maxChars) break;
  }
  // 整份都没文字（截图/扫描版课件）：不能让上层以为"取到内容了"，
  // 否则她只会看到一串页码、却没有内容可谈（端到端测试抓到的坑）。
  if (realChars === 0) {
    throw new Error(`这份 PPT 共 ${slideNames.length} 页，但里面没有可提取的文字（整份都是图片/截图），看不到内容`);
  }
  const more = slideNames.length - read;
  let text = parts.join('\n\n');
  if (more > 0) text += `\n\n…（还有 ${more} 页未展开）`;
  return { text, pages: slideNames.length, pagesRead: read, kind: 'pptx', pageTexts };
}

// ── DOCX ─────────────────────────────────────────────────────────────────
export function extractDocx(buf) {
  const files = readZipSelected(buf, (n) => n === 'word/document.xml');
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('DOCX 里找不到 word/document.xml');
  const xmlText = xml.toString('utf8');
  const paras = blocksOf(xmlText, 'w:p').map((p) =>
    runsOf(p, 'w:t', { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n' }).trim()).filter(Boolean);
  const text = tidy(paras.join('\n'));
  if (!text) throw new Error('DOCX 里没有可提取的文字');
  return { text, pages: 0, pagesRead: 0, kind: 'docx' };
}

// ── XLSX ─────────────────────────────────────────────────────────────────
export function extractXlsx(buf) {
  const files = readZipSelected(buf, (n) =>
    n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/i.test(n));
  const shared = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    for (const si of blocksOf(ss.toString('utf8'), 'si')) {
      shared.push(blocksOf(si, 't').map((t) => decodeXmlEntities(t)).join(''));
    }
  }
  const sheetNames = [...files.keys()].filter((n) => /^xl\/worksheets\//i.test(n))
    .sort((a, b) => (Number(/(\d+)/.exec(a)?.[1]) || 0) - (Number(/(\d+)/.exec(b)?.[1]) || 0));
  if (!sheetNames.length) throw new Error('XLSX 里找不到工作表');
  const parts = [];
  let chars = 0;
  let sheetsRead = 0;
  for (const name of sheetNames.slice(0, 10)) {
    const xml = files.get(name).toString('utf8');
    const rows = [];
    for (const row of blocksOf(xml, 'row')) {
      const cells = [];
      // 用 tagBlocks 拿属性：`t="s"` / `r="A1"` 都在 <c> 的开始标签上
      for (const cell of tagBlocks(row, 'c')) {
        const attrs = cell.attrs;
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
        const isShared = /t="s"/.test(attrs);
        const isInline = /t="(inlineStr|str)"/.test(attrs);
        let val = '';
        if (isInline) val = blocksOf(cell.body, 't').map((t) => decodeXmlEntities(t)).join('');
        else {
          const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
          if (v !== undefined) val = isShared ? (shared[Number(v)] ?? '') : decodeXmlEntities(v);
        }
        if (val !== '' && val != null) cells.push(ref ? `${ref}=${val}` : String(val));
      }
      if (cells.length) rows.push(cells.join('  '));
      if (rows.length > 500) { rows.push('…（行数过多，已截断）'); break; }
    }
    if (!rows.length) continue;
    const piece = `── 工作表 ${sheetsRead + 1}（${name.replace(/^xl\/worksheets\//, '')}）──\n${rows.join('\n')}`;
    chars += piece.length;
    parts.push(piece);
    sheetsRead++;
    if (chars > LIMITS.maxChars) break;
  }
  if (!parts.length) throw new Error('XLSX 里没有可提取的内容');
  return { text: tidy(parts.join('\n\n')), pages: 0, pagesRead: sheetsRead, kind: 'xlsx' };
}

// ── ODP（OpenDocument Presentation）──────────────────────────────────────
export function extractOdp(buf) {
  const files = readZipSelected(buf, (n) => n === 'content.xml');
  const xml = files.get('content.xml')?.toString('utf8');
  if (!xml) throw new Error('ODP 里找不到 content.xml');
  const pages = xml.split(/<draw:page[\s>]/).slice(1);
  if (!pages.length) throw new Error('ODP 里没有幻灯片');
  const parts = [];
  let read = 0;
  for (let i = 0; i < Math.min(pages.length, LIMITS.maxSlides); i++) {
    const paras = blocksOf(pages[i].split('</draw:page>')[0], 'text:p')
      .map((p) => {
        const withRuns = runsOf(p, 'text:span', { 'text:line-break': '\n' });
        // 有些段落没有 span，直接剥标签兜底
        return withRuns || decodeXmlEntities(p.replace(/<[^>]+>/g, ''));
      })
      .map((t) => t.trim()).filter(Boolean);
    // 有些段落没有 span，直接剥标签兜底
    const fallback = paras.length ? paras : [decodeXmlEntities(pages[i].replace(/<[^>]+>/g, ' '))];
    parts.push(`── 第 ${i + 1} 页 ──\n${tidy(fallback.join('\n'))}`);
    read++;
  }
  return { text: parts.join('\n\n'), pages: pages.length, pagesRead: read, kind: 'odp' };
}

// ── 旧版 .ppt（OLE 二进制，无 XML）────────────────────────────────────────
// PowerPoint 97-2003 把文本按 UTF-16LE 存在 "PowerPoint Document" 流里；
// 也有部分按本地代码页(GBK)存。这里直接扫文本段，属于**粗提取**：
// 拿得到标题和要点，但可能有噪声，所以调用方必须如实告诉她这是粗提取。
export function extractLegacyPpt(buf) {
  const found = [];
  const seen = new Set();
  const pushRun = (s) => {
    const t = s.replace(/\s+/g, ' ').trim();
    // 过短的段没意义；纯符号/乱码的丢掉
    if (t.length < 2) return;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const letters = (t.match(/[A-Za-z0-9]/g) ?? []).length;
    if (cjk + letters < 2) return;
    if (!(cjk || letters) && !/[，。、；：？！]/.test(t)) return;
    // 关键质量闸：把二进制误读产生的"合法但不成话"的串挡掉。
    // 实测旧版《答题纸》.doc 能扫出「宁波大学考核答题纸」（有用），
    // 同时也会扫出「橢橢좬좬」「탔퓇퓚퓇쏚립뷃겹骡」（纯噪声）。
    if (looksLikeBinaryNoise(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    found.push(t);
  };

  // UTF-16LE 文本段
  let i = 0;
  while (i + 4 <= buf.length && found.length < 400) {
    let run = '';
    let j = i;
    while (j + 2 <= buf.length) {
      const code = buf.readUInt16LE(j);
      const ch = String.fromCharCode(code);
      const ok = (code >= 0x20 && code < 0xd800) || (code >= 0x4e00 && code <= 0x9fff) || code === 0x0a || code === 0x0d;
      if (!ok) break;
      run += ch;
      j += 2;
    }
    if (run.length >= 2) { pushRun(run); i = j + 2; } else i += 2;
  }
  // GBK 文本段（旧文件里也常见）
  try {
    const gbk = new TextDecoder('gbk', { fatal: false });
    let k = 0;
    while (k < buf.length && found.length < 500) {
      let end = k;
      while (end < buf.length && buf[end] >= 0x20 && buf[end] !== 0x7f && buf[end] !== 0x0b) end++;
      if (end - k >= 6) {
        const seg = buf.subarray(k, end);
        const dec = gbk.decode(seg);
        if (/[\u4e00-\u9fff]/.test(dec)) pushRun(dec);
      }
      k = end + 1;
    }
  } catch { /* 没有 gbk 解码器就算了 */ }

  if (!found.length) throw new Error('旧版 .ppt 是二进制格式，没能扫出文字（建议让用户另存为 .pptx）');
  const text = found.slice(0, 300).join('\n');
  return { text, pages: 0, pagesRead: 0, kind: 'ppt-legacy', crude: true };
}

// ── 内嵌图片收集（截图版 PPT 的全部内容就是这些图）────────────────────────
// 用户的原话是"我说的是 ppt 图片"——光取文字不够：很多课件就是一张张截图。
// 所以这里把文档里的图也捞出来，交给上层当**视觉输入**（image part）送给她看。
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;   // wmf/emf/tiff 视觉模型读不了，直接跳过
const MEDIA_TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

function mediaTypeOf(name) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] ?? '';
  return MEDIA_TYPE_BY_EXT[ext] ?? '';
}

/**
 * 收集文档内嵌的图片，按**幻灯片顺序**（靠 `_rels/slideN.xml.rels` 的引用关系映射），
 * 并记录每张图属于第几页 —— 这样提示词里能写"第 3 页的图"，
 * 她就能对着图说"第 3 页那个流程图"，而不是"有一张图"。
 *
 * 用户的原话是"我说的是 ppt 图片""不是截图，ppt里面的图片"：
 * 正常课件里图是**正文之外的补充信息**（流程图、示意图、数据图表、照片），
 * 光取文字会漏掉一大半意思，所以图也要作为视觉输入送过去。
 *
 * 预算控制（视觉输入很贵，必须卡死）：
 *   • maxCount      最多几张（默认 6）
 *   • maxTotalBytes 合计字节上限（默认 3MB）
 *   • minBytes      小于这个的当图标/项目符号/logo，丢掉（默认 8KB）
 *   • perImageMax   单张过大（默认 2MB）也跳过，否则一张就吃满预算
 */
export function collectDocumentImages(buf, kind, opts = {}) {
  const maxCount = Math.max(0, Number(opts.maxCount ?? 6));
  const maxTotalBytes = Math.max(0, Number(opts.maxTotalBytes ?? 3 * 1024 * 1024));
  const minBytes = Math.max(0, Number(opts.minBytes ?? 8 * 1024));
  const perImageMax = Math.max(0, Number(opts.perImageMaxBytes ?? 2 * 1024 * 1024));
  // 每页最多送几张：同一页拿 3 张会挤掉后面好几页，而"看到更多不同页"更有用。
  // （实测《第六次班会》第 4 页有 3 张大图，不限制的话 6 张预算全花在前两页上。）
  const maxPerSlide = Math.max(1, Number(opts.maxPerSlide ?? 1));
  // 按需取图：只要指定页的（她问"第 3 页那张图"时就靠这个）
  const pageFilter = Array.isArray(opts.pages) && opts.pages.length
    ? new Set(opts.pages.map(Number).filter((n) => Number.isFinite(n) && n > 0))
    : null;
  if (!maxCount || !maxTotalBytes) return [];

  let dir;
  try { dir = readZipDirectory(buf); } catch { return []; }
  const byName = new Map(dir.map((e) => [e.name, e]));
  const findFull = (tail) => [...byName.keys()].find((k) => k.endsWith('/' + tail)) ?? '';

  // 首选顺序：第 1 页引用的图 → 第 2 页的 → …（记下页码）
  const preferred = [];   // { name, slide }
  const seen = new Set();
  const relNames = dir
    .filter((e) => /_rels\/(slide|document|sheet)\d*\.xml\.rels$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (Number(/(\d+)/.exec(a)?.[1]) || 0) - (Number(/(\d+)/.exec(b)?.[1]) || 0));
  // rels 文件名里的**真实页号**必须从文件名解析，不能用遍历序号 ——
  // 没有图的页可能压根没有 rels 文件（或 word/document.xml.rels 没有编号），
  // 用序号会让页码整体错位，于是"看第 3 页"取到的是别的页（测试抓到过）。
  let seq = 0;
  for (const relName of relNames.slice(0, 400)) {
    seq++;
    const base = relName.split('/').pop();
    const pageNo = Number(/(\d+)/.exec(base)?.[1]) || seq;
    const data = readZipEntry(buf, byName.get(relName));
    if (!data) continue;
    for (const m of data.toString('utf8').matchAll(/Target="([^"]+)"/g)) {
      const t = m[1];
      if (!IMAGE_EXT_RE.test(t)) continue;   // wmf/emf 等直接跳过
      const tail = t.split('/').filter(Boolean).pop();
      const full = findFull(tail);
      if (full && !seen.has(full)) { seen.add(full); preferred.push({ name: full, slide: pageNo }); }
    }
  }
  // 兜底：rels 没引用到的图（母版/背景/未使用），按 zip 顺序补在后面
  for (const e of dir) {
    if (!/(^|\/)(ppt|word|xl)\/media\/|(^|\/)Pictures\//i.test(e.name)) continue;
    if (!IMAGE_EXT_RE.test(e.name)) continue;
    if (!seen.has(e.name)) { seen.add(e.name); preferred.push({ name: e.name, slide: 0 }); }
  }

  const images = [];
  let total = 0;
  const perSlideCount = new Map();
  for (const { name, slide } of preferred) {
    if (images.length >= maxCount) break;
    if (pageFilter && slide > 0 && !pageFilter.has(slide)) continue;   // 只要指定页
    const entry = byName.get(name);
    if (!entry) continue;
    if (entry.uncompressedSize < minBytes || entry.uncompressedSize > perImageMax) continue;
    if (entry.uncompressedSize > maxTotalBytes - total) continue;
    if (slide > 0) {
      const used = perSlideCount.get(slide) ?? 0;
      if (used >= maxPerSlide) continue;
    }
    const mediaType = mediaTypeOf(name);
    if (!mediaType) continue;
    const data = readZipEntry(buf, entry);
    if (!data?.length) continue;
    total += data.length;
    if (slide > 0) perSlideCount.set(slide, (perSlideCount.get(slide) ?? 0) + 1);
    images.push({ name: name.split('/').pop(), mediaType, buffer: data, slide, bytes: data.length });
  }
  return images;
}

/** 文档里**总共有多少张**可用的内嵌图（用来如实告诉她"只送来了其中几张"）。 */
export function countDocumentImages(buf) {
  try {
    const dir = readZipDirectory(buf);
    return dir.filter((e) => /(^|\/)(ppt|word|xl)\/media\/|(^|\/)Pictures\//i.test(e.name)
      && IMAGE_EXT_RE.test(e.name) && e.uncompressedSize >= 8 * 1024).length;
  } catch { return 0; }
}

// ── 统一入口 ─────────────────────────────────────────────────────────────
/** 取图用的格式判定（沿用 detectOfficeKind）。 */
export function detectOfficeKind(buf, name = '') {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) ?? [])[1] ?? '';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    // ZIP：靠内容判断，别信扩展名
    try {
      const dir = readZipDirectory(buf);
      const names = dir.map((e) => e.name);
      if (names.some((n) => /^ppt\/slides\//.test(n))) return 'pptx';
      if (names.some((n) => n === 'word/document.xml')) return 'docx';
      if (names.some((n) => /^xl\/worksheets\//.test(n))) return 'xlsx';
      if (names.includes('content.xml') && names.includes('mimetype')) return 'odp';
    } catch { /* 目录坏了，按扩展名兜底 */ }
    if (ext === 'pptx' || ext === 'pptm' || ext === 'ppsx' || ext === 'potx') return 'pptx';
    if (ext === 'docx' || ext === 'docm') return 'docx';
    if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
    if (ext === 'odp') return 'odp';
    return '';
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) {
    // OLE 复合文档魔数（D0 CF 11 E0 A1 B1 1A E1）：ppt/doc/xls 都是这个壳。
    // ppt / doc 走粗提取（正文多为 UTF-16LE/本地代码页，扫得出来）；
    // xls 是 BIFF 二进制记录，扫出来基本是数字垃圾，所以**不做**。
    if (ext === 'ppt' || ext === 'pps' || ext === 'doc') return 'ppt-legacy';
    return '';
  }
  return '';
}

export function extractOfficeText(buf, name = '', opts = {}) {
  const kind = detectOfficeKind(buf, name);
  if (!kind) throw new Error('不是可识别的 Office 文档');
  // 内嵌的图先捞出来（正常课件里图是正文之外的重要信息：流程图/示意图/图表/照片）
  const images = collectDocumentImages(buf, kind, opts.images ?? {});
  const totalImages = countDocumentImages(buf);
  let out;
  try {
    switch (kind) {
      case 'pptx': out = extractPptx(buf); break;
      case 'docx': out = extractDocx(buf); break;
      case 'xlsx': out = extractXlsx(buf); break;
      case 'odp': out = extractOdp(buf); break;
      case 'ppt-legacy': out = extractLegacyPpt(buf); break;
      default: throw new Error(`不支持的文档类型：${kind}`);
    }
  } catch (error) {
    // 没有文字但**有图**：不算失败 —— 图本身就是内容，让她直接看图。
    // 只有既没文字也没图才算真的看不到。
    if (!images.length) throw error;
    out = { text: '', pages: 0, pagesRead: 0, kind };
  }
  out.images = images;
  out.totalImages = totalImages;
  if (opts.includePageText) out.pageTexts = out.pageTexts ?? [];
  if (!String(out.text ?? '').trim() && images.length) {
    out.text = '（这份文档里没有可提取的文字，内容都在图里；已附上图片，直接看图）';
  }
  return out;
}

// ── worker 入口 ──────────────────────────────────────────────────────────
if (parentPort && workerData) {
  try {
    // ⚠️ workerData 里传过来的 Buffer 经结构化克隆会变成 **Uint8Array**，
    //    没有 readUInt32LE/subarray().toString() 这些方法（第一版直接报
    //    "buf.readUInt32LE is not a function"，被测试抓到）。必须转回 Buffer。
    const raw = workerData.buffer;
    const buffer = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw?.buffer ?? raw, raw?.byteOffset ?? 0, raw?.byteLength ?? undefined);
    const r = extractOfficeText(buffer, workerData.name ?? '', workerData.opts ?? {});
    const text = r.text ?? '';
    const images = Array.isArray(r.images) ? r.images : [];
    if (!text.trim() && !images.length) {
      parentPort.postMessage({ ok: false, error: '没有提取到文字，也没有可用的图片（可能是纯矢量图/加密文档）' });
    } else {
      parentPort.postMessage({
        ok: true, text, kind: r.kind, crude: !!r.crude,
        stats: {
          pages: r.pages, pagesRead: r.pagesRead, chars: text.length,
          images: images.length, totalImages: r.totalImages ?? images.length,
          imageSlides: images.map((i) => i.slide).filter(Boolean),
        },
        // 按需工具要单页正文；不带这个开关时不回传，省得白搬几万字符
        pageTexts: workerData.opts?.includePageText ? (r.pageTexts ?? []) : undefined,
        // Buffer 经结构化克隆会变成 Uint8Array，主线程侧再转回来（Buffer.from 能直接吃）
        images: images.map((i) => ({ name: i.name, mediaType: i.mediaType, slide: i.slide, bytes: i.bytes, buffer: i.buffer })),
      });
    }
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message ?? String(error) });
  }
}
