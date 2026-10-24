/**
 * 无头浏览器渲染（2026-10-14）—— 用来抓**前端渲染页（SPA）**的正文。
 *
 * 为什么需要它：`safeFetch` 拿到的是服务端 HTML，而小黑盒/微博/小红书/B 站动态这类 App 分享页
 * 正文由 JS 异步加载，HTML 里只有空壳。实测小黑盒那个链接：HTTP 200、3369 字符、12 个 <script>，
 * 可见文本只有一句标题 —— 抓取"成功"但没内容。渲染一遍才能拿到正文。
 *
 * 安全边界（一条都不能少）：
 *   • 渲染前**先过 `validateFetchUrl`**（禁 localhost/私网/环回/链路本地/CGNAT/云元数据，DNS 全解析校验）
 *     —— 无头浏览器比普通抓取更危险，SSRF 必须拦在最前面；
 *   • 只用只读能力：不下载文件、不上传、不点按钮、不填表单；
 *   • 图片/字体/媒体一律中止（省时间也省流量）；
 *   • 超时 + 文本上限 + 浏览器空闲自动关闭（不留常驻大内存进程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { validateFetchUrl } from './safe-fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IDLE_CLOSE_MS = 5 * 60 * 1000;   // 5 分钟没人用就关掉浏览器
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_CHARS = 20000;

let browserPromise = null;
let idleTimer = null;

/**
 * 判断"静态 HTML 是不是壳、需要渲染一遍"（纯函数，能离线测）。
 * 判据都取实测过的特征，宁可能多渲染一次，也别把空壳当正文返回。
 */
export function needsRender(html, visibleText) {
  const src = String(html ?? '');
  const text = String(visibleText ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 200) return true;                                  // 可见文本太少 → 基本是壳
  const scripts = (src.match(/<script/gi) ?? []).length;
  if (scripts >= 8 && text.length < 1200) return true;                 // 一堆脚本 + 文本很少
  if (/(应用挂载后|请启用\s*JavaScript|enable javascript|__NEXT_DATA__|__NUXT__|window\.__INITIAL)/i.test(src)
    && text.length < 2000) return true;
  return false;
}

/**
 * 找一个可用的浏览器可执行文件：**优先用机器上已装的 Chrome/Edge**。
 * 为什么：`npm i puppeteer` 只装库、不下载它自带的 Chrome（实测报
 * "Could not find Chrome (ver. 155.0.8059.39)"）；而这台机器上已经有 Chrome 154，
 * 直接拿来用就省掉 150MB 下载，也不会去动人家日常浏览器（无头独立进程）。
 */
const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findBrowserExecutable() {
  for (const p of BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* 路径畸形就算了 */ }
  }
  return null;   // 返回 null → 让 puppeteer 用它自己下载的那个（若也没装就报错，错误里会说怎么办）
}
async function getBrowser() {
  if (!browserPromise) {
    const exe = findBrowserExecutable();
    browserPromise = puppeteer.launch({
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'],
    }).catch((error) => { browserPromise = null; throw error; });
  }
  return browserPromise;
}

/** 用完（或闲置）就关浏览器：不留一个常驻的 Chromium 吃内存。 */
export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try { const b = await p; await b.close(); } catch { /* 已经关了 */ }
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void closeBrowser(); }, IDLE_CLOSE_MS);
  try { idleTimer.unref?.(); } catch { /* 兼容 */ }
}

/**
 * 渲染一个页面，返回 `{ url, title, text, truncated, rendered }`。
 * @throws 校验不通过（内网等）或浏览器/导航失败时抛错，调用方决定怎么降级。
 */
export async function renderPage(urlString, { maxChars = DEFAULT_MAX_CHARS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { url } = await validateFetchUrl(urlString);   // ★ SSRF 前置：内网一律拒
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      // 只放行文档/脚本/xhr/fetch —— 图片、字体、媒体一律中止
      if (t === 'image' || t === 'font' || t === 'media') { req.abort().catch(() => {}); return; }
      req.continue().catch(() => {});
    });
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // ★ 2026-10-20 修：原来是**固定等 1.8 秒** —— 小黑盒这类 SPA 的数据请求要 3~5 秒，
    //   冷启动第一次只能抓到"小黑盒 - 玩家高能聚集地"这种空壳；有缓存时 1.8 秒又够用，
    //   所以症状是"第一次失败、第二次成功"（实测就是这么误判成"render 坏了"的）。
    //   改成**轮询正文长度**：连续两次不变就算稳定（快的时候 1 秒出结果，慢的时候等够 8 秒）。
    const READY_MAX_MS = Math.max(6000, Math.min(15000, timeoutMs));
    const textLen = () => page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    let last = -1;
    let stable = 0;
    const dead = Date.now() + READY_MAX_MS;
    while (Date.now() < dead) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await textLen();
      if (now > 200 && now === last) {
        stable += 1;
        if (stable >= 2) break;   // 连续两次没变 → 认为加载完
      } else {
        stable = 0;
      }
      last = now;
    }
    const data = await page.evaluate(() => ({
      title: document.title || '',
      text: document.body ? document.body.innerText : '',
    }));
    const text = String(data.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
      url: url.toString(),
      title: String(data.title ?? '').trim(),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      rendered: true,
    };
  } finally {
    try { await page.close(); } catch { /* 页面可能已崩 */ }
    touchIdle();
  }
}
