// 把 PDF 文字提取接进桥接：
//   - 下载后若是 PDF（魔数 %PDF 或 .pdf 扩展名），用带硬超时的提取器取文字
//   - 提取成功 → 内容内联进消息（模型真正读到）
//   - 提取超时/失败 → 明确告知模型「这是 PDF，但解析失败/超时」，不让它瞎猜
import fs from 'node:fs';

const p = 'D:/qq-bridge/src/bridge.js';
let s = fs.readFileSync(p, 'utf8');
const before = s;
const steps = [];

// 1) import 提取器
s = s.replace(
  "import { safeFetchBuffer, safeFetchAnyBuffer, looksLikeImageBuffer } from './safe-fetch.js';",
  "import { safeFetchBuffer, safeFetchAnyBuffer, looksLikeImageBuffer } from './safe-fetch.js';\nimport { extractPdfTextSafe } from './pdf-extract-safe.mjs';",
);
steps.push(['import 提取器', s.includes('extractPdfTextSafe')]);

// 2) 增加 PDF 判定与上限常量
s = s.replace(
  "const MAX_FILE_BYTES = 4 * 1024 * 1024;        // 单文件下载上限",
  `const MAX_FILE_BYTES = 4 * 1024 * 1024;        // 单文件下载上限
const PDF_EXTRACT_TIMEOUT_MS = 12000;          // PDF 文字提取硬超时（worker 线程兜底）
const PDF_MAX_BYTES = 15 * 1024 * 1024;        // 超过这个体积不做 PDF 提取`,
);
steps.push(['新增常量', s.includes('PDF_EXTRACT_TIMEOUT_MS')]);

// 3) 在 fetchAndCacheQqFile 里加 PDF 分支
s = s.replace(
  `    const entry = { name, size: buffer.length, mime: '', buffer, text: null, truncated: false };
    if (isProbablyTextFile(name) || looksLikeTextBuffer(buffer)) {`,
  `    const entry = { name, size: buffer.length, mime: '', buffer, text: null, truncated: false };
    // PDF：先按魔数识别（扩展名不可靠），用带硬超时的提取器取文字。
    // 提取器跑在 worker 线程里：即使内部同步解压卡住，也不会阻塞消息处理。
    const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-' || /\.pdf$/i.test(name);
    if (isPdf) {
      if (buffer.length > PDF_MAX_BYTES) {
        entry.text = null;
        entry.pdfError = \`PDF 过大（\${Math.round(buffer.length / 1024 / 1024)}MB），未做文字提取\`;
      } else {
        const r = await extractPdfTextSafe(buffer, { timeoutMs: PDF_EXTRACT_TIMEOUT_MS });
        if (r.ok && r.text && r.text.trim()) {
          let text = r.text;
          if (text.length > MAX_FILE_INLINE_CHARS) {
            text = \`\${text.slice(0, MAX_FILE_INLINE_CHARS)}\\n…（PDF 内容过长，已截断）\`;
            entry.truncated = true;
          }
          entry.text = text;
          entry.pdfPages = r.stats?.fontCount ?? 0;
          log(\`[file] PDF 文字提取成功 \${name}：\${r.text.length} 字符\${r.timedOut ? '（超时截断）' : ''}\`);
        } else {
          entry.pdfError = r.timedOut ? 'PDF 解析超时（文档过于复杂）' : (r.error ?? 'PDF 未提取到文字');
          log(\`[file] PDF 提取失败 \${name}：\${entry.pdfError}\`);
        }
      }
      rememberFileInCache(fileId, entry);
      appendActivity(\`[file] PDF \${name}（\${buffer.length} 字节）\${entry.text ? '已提取文字' : '未提取到文字'}\`);
      return entry;
    }
    if (isProbablyTextFile(name) || looksLikeTextBuffer(buffer)) {`,
);
steps.push(['PDF 分支', s.includes('PDF 文字提取成功')]);

// 4) 消息文本里区分 PDF 失败
s = s.replace(
  `        if (cached?.error) {
          out.push(\`[文件 \${fileName}（\${sizeLabel} 字节，读取失败：\${cached.error}）]\`);
        } else if (cached?.text) {`,
  `        if (cached?.error) {
          out.push(\`[文件 \${fileName}（\${sizeLabel} 字节，读取失败：\${cached.error}）]\`);
        } else if (cached?.pdfError) {
          out.push(\`[文件 \${fileName}（\${sizeLabel} 字节，PDF；\${cached.pdfError}）——看不到内容，需要就直说看不到]\`);
        } else if (cached?.text) {`,
);
steps.push(['PDF 失败提示', s.includes('cached?.pdfError')]);

fs.writeFileSync(p, s, 'utf8');
console.log('字节:', before.length, '->', s.length);
for (const [n, ok] of steps) console.log(`  ${ok ? '✅' : '❌'} ${n}`);
