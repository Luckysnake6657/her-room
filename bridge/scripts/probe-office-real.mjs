// 用**真实文件**试 Office 取字，人工看提取质量（合成样例证明不了排版/中文/备注这些细节）。
//
// 用法：node scripts/probe-office-real.mjs <文件路径> [更多路径...]
import fs from 'node:fs';
import path from 'node:path';
import { extractOfficeTextSafe } from '../src/office-extract-safe.mjs';

const files = process.argv.slice(2);
if (!files.length) { console.error('用法：node scripts/probe-office-real.mjs <文件...>'); process.exit(2); }

for (const f of files) {
  console.log('='.repeat(78));
  if (!fs.existsSync(f)) { console.log(`❌ 文件不存在：${f}`); continue; }
  const buf = fs.readFileSync(f);
  console.log(`文件：${path.basename(f)}  ${(buf.length / 1024).toFixed(0)} KB`);
  const t0 = Date.now();
  const r = await extractOfficeTextSafe(buf, { name: path.basename(f), timeoutMs: 15000 });
  const ms = Date.now() - t0;
  if (!r.ok) {
    console.log(`❌ 取字失败（${ms}ms）：${r.error}`);
    continue;
  }
  console.log(`✅ 类型=${r.kind} 页/表=${r.stats?.pages ?? 0}（读了 ${r.stats?.pagesRead ?? 0}）`
    + ` 字符=${r.stats?.chars ?? r.text.length} 粗提取=${r.crude ? '是' : '否'} 耗时=${ms}ms`);
  console.log('─'.repeat(78));
  console.log(r.text.slice(0, 700));
  if (r.text.length > 700) console.log(`\n…（后面还有 ${r.text.length - 700} 字符）`);
  console.log('');
}
