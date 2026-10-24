// 用最小 DOM 桩验证「模块刷新按钮」注入逻辑（不依赖浏览器）
import fs from 'node:fs';

const html = fs.readFileSync('D:/qq-bridge/public/console.html', 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ── 最小 DOM 桩 ─────────────────────────────────────────────
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this._text = '';
    this.dataset = {};
    this.listeners = {};
    this.classes = new Set();
    this.attrs = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html ?? ''; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest(sel) {
    // 只支持 tag 选择器
    const want = sel.toUpperCase();
    let n = this;
    while (n) { if (n.tagName === want) return n; n = n.parent; }
    return null;
  }
}

// 从 HTML 里抽出所有 sec-no 的 h2，构造最小树
const secNos = [...html.matchAll(/<h2[^>]*><span class="sec-no">([^<]+)<\/span>/g)].map((m) => m[1]);
const spans = [];
const h2s = [];
for (const sec of secNos) {
  const h2 = new El('h2');
  const sp = new El('span');
  sp._text = sec;
  h2.appendChild(sp);
  spans.push(sp);
  h2s.push(h2);
}
console.log(`构造了 ${h2s.length} 个分区标题`);

const document = {
  querySelectorAll: (sel) => (sel === '.sec-no' ? spans : []),
  getElementById: () => null,
  createElement: (t) => new El(t),
  addEventListener: () => {},
};
const window = {};

// ── 只抽出注入那一段逻辑单独跑（避免执行整个页面脚本）──
const start = code.indexOf('const SECTION_REFRESH');
const end = code.indexOf('setInterval(', start);
const injectCode = code.slice(start, end);
console.log(`注入逻辑 ${injectCode.length} 字符\n`);

const fn = new Function('document', 'window', 'console', injectCode + '\nreturn { SECTION_REFRESH };');
const { SECTION_REFRESH } = fn(document, window, console);

console.log('=== 桩自检 ===');
console.log('  spans 数量:', spans.length);
console.log('  document.querySelectorAll(".sec-no") 返回:', document.querySelectorAll('.sec-no').length);
console.log('  第一个 span 的 textContent:', JSON.stringify(spans[0]?.textContent));
console.log('  第一个 h2 的 children:', h2s[0]?.children.map((c) => c.tagName).join(','));
{
  const b = h2s[0]?.children.find((c) => c.tagName === 'BUTTON');
  console.log('  按钮 className:', JSON.stringify(b?.className));
  console.log('  按钮 classes:', JSON.stringify([...(b?.classes ?? [])]));
  console.log('  按钮 dataset:', JSON.stringify(b?.dataset));
  console.log('  按钮 textContent:', JSON.stringify(b?.textContent));
  console.log('  按钮 title:', JSON.stringify(b?.title));
  console.log('  addEventListener 注册的事件:', Object.keys(b?.listeners ?? {}).join(','));
}
console.log('  closest("h2") 能上去吗:', spans[0]?.closest('h2') === h2s[0]);
console.log('');

console.log('=== 注入结果 ===');
let ok = 0, miss = 0;
for (const [sec, fns] of Object.entries(SECTION_REFRESH)) {
  const idx = secNos.indexOf(sec);
  const h2 = idx >= 0 ? h2s[idx] : null;
  // 注意：桩里 className 赋值不会同步进 classes 集合（真实浏览器会），所以查 className
  const btn = h2?.children.find((c) => c.tagName === 'BUTTON');
  if (btn && String(btn.className || '').includes('sec-refresh')) {
    ok++;
    console.log(`  ✅ 分区 ${sec.padEnd(3)} 按钮="${btn.textContent}" 点击会调 ${fns.join(' / ')}`);
  } else {
    miss++;
    console.log(`  ❌ 分区 ${sec} 没挂上按钮（secNos 里有吗: ${idx >= 0}）`);
  }
}
console.log(`\n成功 ${ok} / 失败 ${miss}`);

// 确认这些函数在页面里真的有定义（否则点击会 console.warn）
console.log('\n=== 目标函数是否都在页面里有定义 ===');
const allFns = [...new Set(Object.values(SECTION_REFRESH).flat())];
for (const name of allFns) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  console.log(`  ${re.test(code) ? '✅' : '❌'} ${name}`);
}

// 确认没有把已有专属刷新按钮的模块重复加
console.log('\n=== 已自带按钮的模块应被跳过 ===');
for (const sec of ['05b', '08', '16']) {
  console.log(`  ${SECTION_REFRESH[sec] ? '⚠️ 被注入了（会重复）' : '✅ 已跳过'} 分区 ${sec}`);
}
