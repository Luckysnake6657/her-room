// 测试带硬超时的 PDF 提取（含已知会卡死的 CAD 图纸）。
import fs from 'node:fs';
import { extractPdfTextSafe } from './pdf-extract-safe.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node test-pdf-safe.mjs <pdf...>');
  process.exit(1);
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）: ${f}`); continue; }
  const buf = fs.readFileSync(f);
  const t0 = Date.now();
  const r = await extractPdfTextSafe(buf, { timeoutMs: 10000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== ${f.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)}KB, ${dt}s) ===`);
  if (r.ok) {
    console.log(`  ✅ 提取成功：${r.text.length} 字符${r.timedOut ? '（超时截断，仅部分）' : ''}`);
    console.log(`  统计：流 ${r.stats.streamCount} / 字体 ${r.stats.fontCount} / CMap ${r.stats.cmapCount}`);
    if (r.warnings?.length) console.log(`  警告 ${r.warnings.length} 条`);
    console.log('  前 200 字：');
    console.log('  ' + JSON.stringify(r.text.slice(0, 200)));
  } else {
    console.log(`  ❌ ${r.timedOut ? '超时' : '失败'}：${r.error}`);
  }
}
