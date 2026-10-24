/**
 * 回归：`qq_read_file` 要能读到**旧版 .doc 的正文**（2026-10-13，申请 #27）。
 *
 * 现场：他发《实用数值方法实验指导书-2025.doc》（296KB）让她看「实验四」，
 *   她调了 4 次 `qq_read_file`（pages=1-4 / 5-12 / 1、keyword=实验一）**全都只收到**
 *   「第 1、2、3、4 页里没有可取的图（可能是纯文字页、或图是 wmf/emf 矢量格式）」，
 *   正文一个字都拿不到，最后只能让他把指导书**拍成照片**。
 *
 * 真相（本用例锁住的那条链）：这种 `.doc` 是 OLE 二进制，走 `extractLegacyPpt` 粗提取 ——
 *   **文字扫得出来**（存 `out.text`），但 `pages: 0` / `pageTexts: []`。
 *   而取文档那个端点只从 `pageTexts[n-1]` 取文字：
 *     · 旧：正文落在 `r.text` 里**没人用** → 她只看到"没有可取的图"
 *     · 新：没有页结构时把正文另附 `fullText`，工具层渲染出来（带 keyword 就给命中处附近）
 *
 * 所以本用例分两层：
 *   [1] 提取器层：造一个像 .doc 的 OLE 壳，断言**能扫出中文正文**（能力没被弄丢）
 *   [2]"有人用"层：源码级断言 端点/工具 真的把 `text` 用起来了
 *       —— 只测 [1] 会漏掉这次的真 bug：**能力在、但没人用**
 *
 * 用法: node scripts/test-doc-legacy-text.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLegacyPpt, detectOfficeKind, extractOfficeText } from '../src/office-extract-worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 造一个最小 OLE 复合文档壳（D0 CF 11 E0 A1 B1 1A E1）+ 一段 UTF-16LE 中文
const makeDoc = (body) => Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(200, 0),
  Buffer.from(body, 'utf16le'),
  Buffer.alloc(64, 0),
]);

console.log('\n[1] 提取器层：旧版 .doc 的中文正文扫得出来');
{
  const body = '实验四 线性方程组的数值解法 一、实验目的 掌握高斯消元法与列主元消去法';
  const buf = makeDoc(body);
  check('识别成 OLE 旧格式（ppt-legacy 这条腿负责 .doc/.ppt）',
    detectOfficeKind(buf, '实用数值方法实验指导书-2025.doc') === 'ppt-legacy');
  const r = extractLegacyPpt(buf);
  check('扫出了正文', String(r.text).includes('实验四'), JSON.stringify(String(r.text).slice(0, 120)));
  check('扫出了「线性方程组的数值解法」', String(r.text).includes('线性方程组的数值解法'));
  check('如实例：旧格式**没有页结构**', r.pages === 0 && r.pagesRead === 0, `pages=${r.pages}`);
  check('标了 crude（上层要如实告诉她是粗提取）', r.crude === true);

  const off = extractOfficeText(buf, '实用数值方法实验指导书-2025.doc', { includePageText: true });
  check('统一入口也能拿到文字', String(off.text).includes('实验四'));
  check('统一入口的 pageTexts 是空的（= 按页给不了，这才是病根）',
    Array.isArray(off.pageTexts) && off.pageTexts.length === 0, JSON.stringify(off.pageTexts));
}

console.log('\n[2] "有人用"层：正文必须真的被端点/工具用起来（这次的真 bug 就在这）');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  check('端点：没有页结构时把正文另附（fullText）',
    /const legacyFullText = !Object\.keys\(pageTexts\)\.length \? String\(r\.text/.test(bridge));
  check('端点：fullText 真的放进了响应', /\.\.\.\(legacyFullText \? \{ fullText: legacyFullText \} : \{\}\)/.test(bridge));
  check('端点：note 说清"旧版没有页结构、按页读不了正文"',
    /没有页结构\*\*，按页读不了正文/.test(bridge));
  // 2026-10-19：真凶是字段名 —— document-images 返回的粗提取正文叫 **fullText**（不是 text），
  //   所以原来那段兜底"一次都没执行过"。断言改成认两者，并且要求用到 crudeText。
  check('工具：渲染正文（pageTexts 为空时兜底 data.text / data.fullText）',
    /data\?\.text \?\? data\?\.fullText/.test(mcp) && /crudeText\.trim\(\)/.test(mcp));
  check('工具：带 keyword 时给命中处附近（否则几十页文档没法定位一节）',
    /正文里「\$\{kw\}」附近/.test(mcp));
  // ⚠️ 这条是本次最容易再犯的：isDocResult 只看 images 的话，纯文字 .doc 会被当成
  //    "文本文件结果"渲染 → 正文照样看不见
  check('工具：isDocResult 不能只看 images（纯文字 .doc 一张图都没有）',
    /String\(data\?\.text \?\? ''\)\.trim\(\)\.length > 0\)/.test(mcp));
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
