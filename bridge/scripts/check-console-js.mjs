// 把 console.html 里的内联 <script> 抽出来做语法检查（页面坏了很难发现，因为只在浏览器里报错）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const html = fs.readFileSync('public/console.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log(`内联脚本块: ${blocks.length} 个，合计 ${blocks.reduce((n, b) => n + b.length, 0)} 字符`);
let bad = 0;
blocks.forEach((code, i) => {
  const tmp = path.join(os.tmpdir(), `console-inline-${i}.js`);
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log(`  ✅ 第 ${i + 1} 块语法通过（${code.length} 字符）`);
  } catch (error) {
    bad++;
    console.log(`  ❌ 第 ${i + 1} 块语法错误：`);
    console.log(String(error.stderr ?? error).split('\n').slice(0, 6).join('\n'));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});
process.exit(bad ? 1 : 0);
