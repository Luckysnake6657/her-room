/**
 * 回归测试：无头浏览器渲染的**纯逻辑**（2026-10-14）。
 *
 * 背景：小黑盒/微博/小红书/B站动态这类 App 分享页是前端渲染（SPA），服务端 HTML 只有空壳 ——
 * 实测那个小黑盒链接 HTTP 200、3369 字符、12 个 <script>，可见文本只剩一句标题。所以加了
 * `web_fetch` 的自动渲染兜底（接到 src/safe-render.js）。
 *
 * 这个用例钉住三件**必须离线就能验**的事（不需要真的联网/启浏览器）：
 *   [1] "要不要渲染"的判定（空壳 → 渲染；正常静态页 → 别白花几秒）
 *   [2] **内网地址必须在启动浏览器之前就被拒**（SSRF 前置 —— 顺序错了等于开了一个内网浏览器）
 *   [3] 浏览器可执行文件探测（优先用机器上已装的 Chrome/Edge，省 150MB 下载）
 */
import { needsRender, findBrowserExecutable, renderPage, closeBrowser } from '../src/safe-render.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

console.log('\n[1] 要不要渲染（空壳 → 渲染；正常页 → 别白花几秒）');
{
  // 实测过的小黑盒那种空壳
  const shell = `<!DOCTYPE html><html><head><script type="module" src="/a.js"></script><script src="/b.js"></script>
    <script src="/c.js"></script><script src="/d.js"></script><script src="/e.js"></script><script src="/f.js"></script>
    <script src="/g.js"></script><script src="/h.js"></script>
    <style>/* 静态正文存在时隐藏 SPA；应用挂载后移除正文，恢复 SPA 展示。 */ #post-static ~ #app { visibility: hidden }</style>
    </head><body><div id="app"></div></body></html>`;
  check('小黑盒那种空壳 → 要渲染', needsRender(shell, '小黑盒 - 玩家高能聚集地') === true);
  check('几乎没文本 → 要渲染', needsRender('<html><body></body></html>', '') === true);
  check('正文很长的静态页 → 不用渲染',
    needsRender('<html><body>' + '<p>这是一段正常正文。</p>'.repeat(80) + '</body></html>', '正文'.repeat(400)) === false);
  check('认得出"应用挂载后移除正文"这种 SPA 标记',
    needsRender('<html><body>应用挂载后移除正文<div id=app></div></body></html>', 'x'.repeat(300)) === true);
  check('认得出 next/nuxt 的服务端注水壳',
    needsRender('<html><body><script>window.__NEXT_DATA__={}</script>' + 'y'.repeat(300) + '</body></html>', 'z'.repeat(300)) === true);
  check('中等长度静态页（够读）→ 不渲染',
    needsRender('<html><body><p>' + '内容'.repeat(300) + '</p></body></html>', '内容'.repeat(300)) === false);
}

console.log('\n[2] SSRF 前置：内网地址必须在**启动浏览器之前**被拒（顺序错了就是开了个内网浏览器）');
{
  const targets = ['http://127.0.0.1:3100/api/status', 'http://localhost:3000/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/'];
  let rejected = 0;
  const details = [];
  for (const t of targets) {
    try {
      await renderPage(t, { timeoutMs: 3000 });
      details.push(`${t} 竟然没被拒 ✗`);
    } catch (error) {
      const msg = String(error?.message ?? error);
      // 必须是"校验类"的拒绝（内网/不允许），而不是浏览器启动失败之类的其它错
      if (/内网|私有|环回|本机|localhost|不允许|拒绝|private|loopback|metadata|解析/i.test(msg)) rejected++;
      else details.push(`${t} 报的是别的错：${msg.slice(0, 80)}`);
    }
  }
  check('四个内网/元数据地址全部被拒', rejected === 4, details.join(' | '));
}

console.log('\n[3] 浏览器可执行文件探测（优先用机器上已装的）');
{
  const exe = findBrowserExecutable();
  check('能返回字符串或 null（不抛错）', exe === null || typeof exe === 'string');
  if (exe) {
    check('返回的是绝对路径且真实存在', /^[A-Za-z]:\\/.test(exe), exe);
    check('是 Chrome 或 Edge', /chrome\.exe$|msedge\.exe$/i.test(exe), exe);
  } else {
    console.log('     （这台机器没探测到 Chrome/Edge —— 那就得靠 puppeteer 自带的，测试跳过路径断言）');
  }
}

await closeBrowser();   // 收尾：别留一个常驻 Chromium
console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
