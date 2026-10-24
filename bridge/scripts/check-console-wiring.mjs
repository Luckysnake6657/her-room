/**
 * 控制台前端接线审计（2026-09-29 用户问"web 前端的功能能用吗"）。
 *
 * 页面 JS 写错了只会在浏览器控制台报错，跑测试/自检都发现不了。这个脚本静态检查三件事：
 *   ① JS 里 getElementById('x') / querySelector('#x') 引用的元素，HTML 里必须真的有这个 id
 *      （反过来也报：HTML 里有 id 但没人用 —— 通常是我加完控件忘了接线）；
 *   ② JS 里 api('/api/xxx') / fetch('http://.../api/xxx') 调用的接口，bridge.js 里必须真的有这个路径；
 *   ③ 绑了 click 的按钮必须存在（①的推论，但单独报更好定位）。
 *
 * 只做静态对账，不启动浏览器：真·端到端得靠人工点，或者以后接 headless。
 *
 * 用法：node scripts/check-console-wiring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

// 页面上的内联 JS（去掉注释，免得注释里的例子被当引用）
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
const js = scripts.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
const jsQueryIds = new Set([...js.matchAll(/querySelector\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)].map((m) => m[1]));

const problems = [];
const warnings = [];
const ok = [];

// ① 元素引用
for (const id of jsIds) {
  if (htmlIds.has(id)) ok.push(`元素 #${id}`);
  else problems.push(`JS 引用了不存在的元素 #${id}（点了会 TypeError，功能静默失效）`);
}
for (const id of jsQueryIds) {
  if (!htmlIds.has(id)) problems.push(`JS querySelector('#${id}') 找不到元素`);
}

// ② 接口路径
const apiPaths = new Set([
  ...[...js.matchAll(/api\(\s*'(\/api\/[^']+)'/g)].map((m) => m[1]),
  ...[...js.matchAll(/fetch\(\s*(?:`|'|")([^'"`]*\/api\/[^'"`?]+)/g)].map((m) => m[1]),
]);
for (const raw of apiPaths) {
  const p = raw.replace(/^.*?(\/api\/)/, '/$1').replace(/\$\{[^}]*\}/g, '');
  if (!p.startsWith('/api/')) continue;
  // bridge.js 里用字符串或模板写路径；把 ${...} 当通配
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`['"\`]${esc}`);
  if (re.test(bridge)) ok.push(`接口 ${p}`);
  else problems.push(`前端调用的接口 ${p} 在 bridge.js 里找不到（会 404）`);
}

// ③ 无人使用的 id（很可能是"加完控件忘了接线"）
const IGNORE_UNUSED = /^(statusText|msg|rp[A-Z]|gs[A-Z]|recall|slang|feedback|cross|sticker|role|mode|closed|v2|session|prompt|busy|log|tool|memory|wake|send|wait|file|doc|onebot|security|preset)/;
for (const id of htmlIds) {
  if (jsIds.has(id) || jsQueryIds.has(id)) continue;
  // 有些 id 只被 CSS / 其它脚本用，或就是纯展示容器：只提示，不当问题
  if (!IGNORE_UNUSED.test(id)) warnings.push(`HTML 里的 #${id} 没有任何 JS 引用（可能忘了接线）`);
}

console.log(`元素引用 ${jsIds.size} 个 ｜ 接口调用 ${apiPaths.size} 个 ｜ HTML id ${htmlIds.size} 个\n`);
console.log(`✅ 对得上：${ok.length} 处`);
if (warnings.length) {
  console.log(`\n⚠️  可疑但不算错：${warnings.length} 处`);
  for (const w of warnings.slice(0, 20)) console.log(`   - ${w}`);
}
if (problems.length) {
  console.log(`\n❌ 真问题：${problems.length} 处`);
  for (const p of problems) console.log(`   - ${p}`);
}
console.log(`\n${problems.length ? '❌ 有接线问题' : '✅ 接线检查通过'}`);
process.exit(problems.length ? 1 : 0);
