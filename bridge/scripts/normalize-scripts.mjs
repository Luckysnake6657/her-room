// 统一脚本文件编码。两条规则**方向相反**，但都是这台机器上的硬约束：
//
//   .bat / .cmd → 纯 ASCII + CRLF，**不能有 BOM**
//     cmd.exe 按 OEM 代码页（本机 GBK）读批处理。UTF-8 BOM 会让首行变成
//     `ï»¿@echo off`，于是 `@echo off` 失效、首行被当命令执行；中文注释会变乱码命令；
//     只有 LF 换行时，cmd 会在带标签/`goto`/多行 `for` 的行上从中间截断
//     （`start.bat` 里就有 `:loop` + `goto loop`，最容易出事）。
//
//   .ps1 → 非 ASCII 内容**必须带 UTF-8 BOM**，换行 CRLF
//     `powershell.exe` 是 Windows PowerShell 5.1，默认按 ANSI/GBK 解码无 BOM 的 .ps1。
//     于是 `'启动AI机器人.lnk'` 变成 `'QQ妗ユ帴...'`，而且尾字节还能把收尾引号吃掉，
//     直接变成 ParserError。实测踩过：make-shortcuts.ps1 就因此整个跑不起来。
//     （纯 ASCII 的 .ps1 加不加 BOM 都行，这里统一不加，减少噪音。）
//
// 用法：
//   node scripts/normalize-scripts.mjs           # 修正
//   node scripts/normalize-scripts.mjs --check   # 只检查（自检/CI 用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
const nonAsciiCount = (buf) => [...buf].filter((b) => b > 0x7f).length;

/** 换行统一成 CRLF，去掉孤立 CR，补末尾换行。返回 { text, notes }。 */
function normalizeNewlines(text) {
  const notes = [];
  if (text.includes('\r')) notes.push('统一换行');
  let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!t.endsWith('\n')) { t += '\n'; notes.push('补末尾换行'); }
  return { text: t.replace(/\n/g, '\r\n'), notes };
}

let changed = 0;
let problems = 0;

function handleBat(name) {
  const file = path.join(ROOT, name);
  const buf = fs.readFileSync(file);
  const notes = [];
  let body = buf;
  if (hasBom(body)) { body = body.subarray(3); notes.push('去掉 UTF-8 BOM（cmd 会把它当命令）'); }
  const { text, notes: n2 } = normalizeNewlines(body.toString('utf8'));
  notes.push(...n2);
  const out = Buffer.from(text, 'utf8');
  const bad = nonAsciiCount(out);
  if (bad) {
    problems++;
    console.log(`❌ ${name}：仍有 ${bad} 个非 ASCII 字节，必须改写成英文（cmd 按 GBK 读）`);
  }
  if (!out.equals(buf)) {
    if (CHECK_ONLY) { problems++; console.log(`❌ ${name}：${notes.join('、')}`); return; }
    fs.writeFileSync(file, out); changed++;
    console.log(`✅ ${name}：${notes.join('、')}`);
  }
}

function handlePs1(name) {
  const file = path.join(ROOT, name);
  const buf = fs.readFileSync(file);
  const notes = [];
  const body = hasBom(buf) ? buf.subarray(3) : buf;
  const { text, notes: n2 } = normalizeNewlines(body.toString('utf8'));
  notes.push(...n2);
  const needsBom = nonAsciiCount(Buffer.from(text, 'utf8')) > 0;
  if (needsBom && !hasBom(buf)) notes.push('加 UTF-8 BOM（PS 5.1 否则按 GBK 解码，中文会烂）');
  if (!needsBom && hasBom(buf)) notes.push('去掉多余 BOM（纯 ASCII 不需要）');
  const out = Buffer.concat([needsBom ? BOM : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  if (!out.equals(buf)) {
    if (CHECK_ONLY) { problems++; console.log(`❌ ${name}：${notes.join('、')}`); return; }
    fs.writeFileSync(file, out); changed++;
    console.log(`✅ ${name}：${notes.join('、')}`);
  }
}

/**
 * 递归收集脚本文件，跳过 node_modules / state / 生成物 / third_party。
 * third_party 是下载来的第三方源码（RVC、GPT-SoVITS 那些），里面的 .bat/.ps1 是人家项目的，
 * 不该按我们的编码规范去改写（2026-10-14）。
 */
function collect(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'state' || entry.name === 'third_party' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(abs, ext, acc);
    else if (entry.name.toLowerCase().endsWith(ext)) acc.push(abs);
  }
  return acc;
}

for (const abs of collect(ROOT, '.bat').concat(collect(ROOT, '.cmd'))) handleBat(path.relative(ROOT, abs));
for (const abs of collect(ROOT, '.ps1')) handlePs1(path.relative(ROOT, abs));

if (CHECK_ONLY) {
  if (!problems) console.log('✅ 所有 .bat/.cmd（ASCII+CRLF+无BOM）与 .ps1（中文带BOM）都合规');
  process.exit(problems ? 1 : 0);
}
console.log(changed ? `\n规范化了 ${changed} 个文件` : '\n没有需要修改的文件');
process.exit(problems ? 1 : 0);
