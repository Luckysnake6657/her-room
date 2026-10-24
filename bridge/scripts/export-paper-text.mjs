// 把两份论文的提取结果导出到工作区（供查看），并做质量自检。
import fs from 'node:fs';
import { extractPdfTextSafe } from '../src/pdf-extract-safe.mjs';

const jobs = [
  ['学风问题的现象学透视_闫建璋', 'C:/Users/zjin6/.dsh/attachments/v1/files/38/382f67abbbb4cd2898a144c2aa37531de1f96e65ecb607999d046ac75632da83/大学生学风问题的现象学透视_闫建璋.pdf'],
  ['解决问题的策略的意义探寻与教学设计_张艳超', 'C:/Users/zjin6/.dsh/attachments/v1/files/7c/7ca415dd91660be47eb5f191bc55048667aec7f5c1ad118a1b2a712faf0fbc86/“解决问题的策略”的意义探寻与教学设计_张艳超 (1).pdf'],
];

for (const [name, f] of jobs) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）: ${name}`); continue; }
  const buf = fs.readFileSync(f);
  const t0 = Date.now();
  const r = await extractPdfTextSafe(buf, { timeoutMs: 20000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `D:/deepseekharness/论文提取-${name}.md`;
  if (r.ok && r.text) {
    const cjk = (r.text.match(/[\u4e00-\u9fff]/g) || []).length;
    const head = [
      `# ${name}`,
      '',
      `- 来源：\`${f}\``,
      `- 引擎：**${r.engine}**（pdfjs 主路径 / 自研降级）`,
      `- 提取：${r.text.length} 字符，其中中文 ${cjk} 个`,
      `- 页数：${r.stats?.pages ?? '?'}（读取 ${r.stats?.pagesRead ?? '?'} 页）`,
      `- 耗时：${dt}s`,
      '',
      '---',
      '',
      r.text,
    ].join('\n');
    fs.writeFileSync(out, head, 'utf8');
    console.log(`✅ ${name}: ${r.text.length} 字符 / 中文 ${cjk} / 引擎 ${r.engine} / ${dt}s`);
    console.log(`   已写入 ${out.split('/').pop()}`);
  } else {
    console.log(`❌ ${name}: ${r.error}`);
  }
}
