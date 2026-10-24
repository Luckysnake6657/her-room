// 校验 public/console.html 里内联 <script> 的语法。
// 提取脚本内容写成临时 .mjs 后交给 node --check。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = fs.readFileSync('D:/qq-bridge/public/console.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log(`找到 ${blocks.length} 个内联 script 块`);

let failed = 0;
blocks.forEach((code, i) => {
  const tmp = `D:/qq-bridge/public/_syntax-check-${i}.mjs`;
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log(`  ✅ 块 ${i}（${code.length} 字符）语法正确`);
  } catch (e) {
    failed += 1;
    console.log(`  ❌ 块 ${i} 语法错误：`);
    console.log(String(e.stderr || e.message).split('\n').slice(0, 12).join('\n'));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// 顺带检查我新加的关键函数是否都在
for (const name of ['refreshOnebot', 'saveOnebotAccount', 'obEsc']) {
  console.log(`  ${html.includes(name) ? '✅' : '❌'} 含 ${name}`);
}
for (const id of ['obAccounts', 'obMsg', 'obRefresh', 'obRestart']) {
  console.log(`  ${html.includes(`id="${id}"`) ? '✅' : '❌'} 含元素 #${id}`);
}

process.exit(failed ? 1 : 0);
