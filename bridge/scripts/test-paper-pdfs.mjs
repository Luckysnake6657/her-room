// 用两份真实论文测试提取（用户提供的实际文件）。
import fs from 'node:fs';
import { extractPdfTextSafe } from '../src/pdf-extract-safe.mjs';

const files = [
  ['学风问题(新)', 'C:/Users/zjin6/.dsh/attachments/v1/files/38/382f67abbbb4cd2898a144c2aa37531de1f96e65ecb607999d046ac75632da83/大学生学风问题的现象学透视_闫建璋.pdf'],
  ['解决问题的策略', 'C:/Users/zjin6/.dsh/attachments/v1/files/7c/7ca415dd91660be47eb5f191bc55048667aec7f5c1ad118a1b2a712faf0fbc86/“解决问题的策略”的意义探寻与教学设计_张艳超 (1).pdf'],
];

for (const [label, f] of files) {
  if (!fs.existsSync(f)) { console.log(`\n[${label}] 文件不存在`); continue; }
  const buf = fs.readFileSync(f);
  const t0 = Date.now();
  const r = await extractPdfTextSafe(buf, { timeoutMs: 15000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(50)}\n${label}  (${Math.round(buf.length / 1024)}KB, ${dt}s)\n${'='.repeat(50)}`);
  if (r.ok && r.text) {
    console.log(`✅ 提取 ${r.text.length} 字符 | 流 ${r.stats.streamCount} / 字体 ${r.stats.fontCount} / CMap ${r.stats.cmapCount}`);
    const cjk = (r.text.match(/[\u4e00-\u9fff]/g) || []).length;
    console.log(`   其中中文 ${cjk} 个`);
    console.log('   前 400 字：');
    console.log('   ' + r.text.slice(0, 400).replace(/\n/g, '\n   '));
  } else {
    console.log(`❌ ${r.ok ? '无文字' : (r.error || '失败')}`);
  }
}
