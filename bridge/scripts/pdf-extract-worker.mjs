// PDF 提取 worker：主路径用 pdfjs-dist，失败再降级到自研提取器。
//
// 为什么主路径换成 pdfjs（实测对比两份真实论文 + 一份 CAD 图纸）：
//   论文1: pdfjs 5559 字符/4712 中文  vs  自研 5275/4699
//   论文2: pdfjs 3343 字符/2540 中文  vs  自研 740/0
//          ——该 PDF 字体子集缺 ToUnicode 映射，必须靠 useSystemFonts 才能取到中文
//   速度:  pdfjs 125ms  vs  自研 秒级
// 自研方案保留为降级路径：零依赖，对 pdfjs 异常的文件多一层保险。
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..'); // qq-bridge/
const fontsDir = path.join(pkgRoot, 'node_modules/pdfjs-dist/standard_fonts');
const cmapsDir = path.join(pkgRoot, 'node_modules/pdfjs-dist/cmaps');
const toUrl = (d) => d.replace(/\\/g, '/') + '/';

const MAX_PAGES = 30;
const MAX_TOTAL_CHARS = 200000;

async function viaPdfjs(buf, timeoutMs) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: fs.existsSync(fontsDir) ? toUrl(fontsDir) : undefined,
    cMapUrl: fs.existsSync(cmapsDir) ? toUrl(cmapsDir) : undefined,
    cMapPacked: true,
    useSystemFonts: true, // 关键：字体子集缺 ToUnicode 时靠系统字体补出中文
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const deadline = Date.now() + timeoutMs;
  const pages = Math.min(doc.numPages, MAX_PAGES);
  const parts = [];
  let total = 0;
  for (let p = 1; p <= pages; p++) {
    if (Date.now() > deadline) break;
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const str = content.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join('');
    parts.push(str);
    total += str.length;
    if (total > MAX_TOTAL_CHARS) break;
  }
  return { text: parts.join('\n').trim(), pages: doc.numPages, pagesRead: parts.length };
}

async function viaSelfMade(buf, timeoutMs) {
  const { extractPdfText } = await import('./extract-pdf-text.mjs');
  const r = extractPdfText(buf, { budgetMs: timeoutMs });
  return { text: r.text, pages: null, pagesRead: null, stats: r };
}

try {
  const raw = workerData?.buffer;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? []);
  const timeoutMs = Math.max(2000, Number(workerData?.timeoutMs) || 10000);

  let used = 'pdfjs';
  let out;
  try {
    out = await viaPdfjs(buf, Math.max(1500, timeoutMs - 1000));
  } catch (error) {
    try {
      out = await viaSelfMade(buf, Math.max(1500, timeoutMs - 1500));
      used = 'self-made';
    } catch (error2) {
      parentPort.postMessage({ ok: false, error: `pdfjs: ${error?.message ?? error} / 自研: ${error2?.message ?? error2}` });
      process.exit(0);
    }
  }

  const text = out.text ?? '';
  if (!text.trim()) {
    parentPort.postMessage({ ok: false, error: '未能提取到文字（可能是扫描件或加密 PDF）' });
    process.exit(0);
  }
  parentPort.postMessage({
    ok: true,
    text,
    engine: used,
    truncated: out.stats?.timedOut ?? false,
    stats: { pages: out.pages, pagesRead: out.pagesRead, ...(out.stats ?? {}) },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message ?? String(error) });
}
