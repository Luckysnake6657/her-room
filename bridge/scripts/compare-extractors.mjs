// 两条提取路径在三份 PDF 上的效果对比，决定主/备方案。
//   A: 自研零依赖提取器
//   B: pdfjs-dist（legacy）提取文本，useSystemFonts + CMap
import fs from 'node:fs';
import path from 'node:path';
import { extractPdfTextSafe } from '../src/pdf-extract-safe.mjs';

const files = [
  ['论文1 学风问题', 'C:/Users/zjin6/.dsh/attachments/v1/files/38/382f67abbbb4cd2898a144c2aa37531de1f96e65ecb607999d046ac75632da83/大学生学风问题的现象学透视_闫建璋.pdf'],
  ['论文2 解决问题的策略', 'C:/Users/zjin6/.dsh/attachments/v1/files/7c/7ca415dd91660be47eb5f191bc55048667aec7f5c1ad118a1b2a712faf0fbc86/“解决问题的策略”的意义探寻与教学设计_张艳超 (1).pdf'],
  ['CAD 图纸', 'D:/桌面/詹文宇.pdf'],
];

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const std = path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/';
const cmaps = path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps').replace(/\\/g, '/') + '/';
const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

async function pdfjsExtract(buf, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf), standardFontDataUrl: std, cMapUrl: cmaps, cMapPacked: true,
      useSystemFonts: true, isEvalSupported: false, verbosity: 0,
    }).promise;
    let all = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      all += content.items.map((it) => it.str ?? '').join('') + '\n';
      if (Date.now() - t0 > timeoutMs) break;
    }
    return { ok: true, text: all.trim(), pages: doc.numPages, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

for (const [label, f] of files) {
  if (!fs.existsSync(f)) { console.log(`\n[${label}] 不存在`); continue; }
  const buf = fs.readFileSync(f);
  console.log(`\n${'='.repeat(56)}\n${label} (${Math.round(buf.length / 1024)}KB)\n${'='.repeat(56)}`);

  const a = await extractPdfTextSafe(buf, { timeoutMs: 15000 });
  console.log(`  A 自研提取器 : ${a.ok ? `${a.text.length} 字符 / 中文 ${cjkCount(a.text)}` : `失败(${a.error})`}`);
  if (a.ok && a.text) console.log(`     样本: ${JSON.stringify(a.text.slice(0, 90))}`);

  const b = await pdfjsExtract(buf);
  console.log(`  B pdfjs      : ${b.ok ? `${b.text.length} 字符 / 中文 ${cjkCount(b.text)} / ${b.pages}页 / ${b.ms}ms` : `失败(${b.error})`}`);
  if (b.ok && b.text) console.log(`     样本: ${JSON.stringify(b.text.slice(0, 90))}`);
}
