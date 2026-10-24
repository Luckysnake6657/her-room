// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { needsRender, renderPage, closeBrowser } from './safe-render.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 HTML 粗剥成"可见文本"（只为判断要不要渲染，不求精确）。 */
function visibleTextOf(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // ⚠️ 2026-10-14 修：这里原来走 safeFetch（手写 socket 那条受限链路），实测 Bing 对它的请求
  //    返回的是**不含结果的骨架页**（`<title>xxx - 搜索</title>`、`<h2>` 数 0、正文全是 JS 引导代码），
  //    于是 web_search 一直返回空结果。改用 node 内置 fetch 就有服务端渲染的结果了。
  //    安全性不受影响：域名是**写死的** cn.bing.com，query 只进 searchParams，
  //    没有用户可控的 URL（SSRF 防护真正要守的是 web_fetch 那条路径，那里仍然走 safeFetch）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let html = '';
  try {
    const res = await fetch(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // 浏览器 UA：Bing 对"像机器人"的 UA 更容易给骨架页
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`搜索服务 HTTP ${res.status}`);
    html = (await res.text()).slice(0, 512000);
  } finally {
    clearTimeout(timer);
  }
  const results = [];
  // ① 首选 Bing 的结果块（`b_algo`）；② 若改版了没有这个类名，退化成"标题链接"结构
  //    （Bing 的结果标题一直是 `<h2><a href="http…">`，比类名稳）—— 这条兜底就是这次踩坑加的。
  const blocks = html.includes('b_algo')
    ? html.split('<li class="b_algo"').slice(1)
    : [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[0] + (html.slice(m.index, m.index + 1200)));
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    // 跳过 Bing 自家的链接（设置/帮助/图片搜索之类不是结果）
    if (/^https?:\/\/(www\.|cn\.)?bing\.com\//i.test(urlStr)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.5' });

server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本。默认从开头给 50000 字符；**长文用 offset 接着读**'
  + '（把上一次结果里的 nextOffset 填进 offset 就能读到后半段，不用重找页面）。'
  + '**前端渲染页（小黑盒/微博/小红书/B站动态这类 App 分享页）也能抓**：先取 HTML，发现只有空壳'
  + '（正文由 JS 加载）会自动用无头浏览器渲染一遍再取正文（多花几秒，结果里 rendered=true）。'
  + '禁止访问内网/本机地址，不执行任何本地操作。',
  {
    url: z.string().describe('要抓取的 http(s) URL'),
    offset: z.number().optional().describe('从第 N 个字符开始读（默认 0）。长文续读时传上次返回的 nextOffset'),
    render: z.enum(['auto', 'always', 'never']).optional()
      .describe('要不要用无头浏览器渲染：auto=发现是空壳才渲染（默认）；always=直接渲染；never=只取 HTML'),
  },
  async ({ url, offset, render }) => {
    const mode = render === 'always' || render === 'never' ? render : 'auto';
    try {
      const off = Math.max(0, Math.floor(Number(offset) || 0));
      const result = await safeFetch(url, 50000, off);
      let rendered = null;
      if (mode !== 'never') {
        const looksShell = needsRender(result.body, visibleTextOf(result.body));
        if (mode === 'always' || looksShell) {
          try {
            rendered = await renderPage(url, { maxChars: 50000, timeoutMs: 30000 });
          } catch (error) {
            // 渲染失败不要吞掉原来的结果：静态正文（可能是壳，也可能够用）照常返回，并说明为什么没渲染
            rendered = { error: `渲染失败：${error?.message ?? error}` };
          }
        }
      }
      const payload = rendered && !rendered.error
        ? {
          ...result,
          body: rendered.text,
          title: rendered.title || undefined,
          rendered: true,
          chars: rendered.text.length,
          ...(rendered.truncated ? { truncatedByRender: true } : {}),
        }
        : { ...result, ...(rendered?.error ? { renderNote: rendered.error } : {}), rendered: false };
      const hint = payload.nextOffset && !payload.rendered
        ? `\n\n（这页读完了，后面还有：把 offset=${payload.nextOffset} 再抓一次同一个 URL 就能接着读）`
        : '';
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + hint }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

// DSH 换代时关掉 stdin（热重载/重启）时，MCP SDK 不保证本进程会退出，
// 会留下空闲僵尸进程（实测热重载一次就有两个）。stdin 一断就干净退出。
// 用 globalThis 取 process：审计测试会在没有 process 的 vm 沙箱里加载本文件。
const exitOnStdinClose = () => { try { globalThis.process?.exit(0); } catch {} };
globalThis.process?.stdin?.on?.('end', exitOnStdinClose);
globalThis.process?.stdin?.on?.('close', exitOnStdinClose);
// 注意：**不要**在这里 process.stdin.resume() —— 那会提前进入 flowing 模式，
// 把客户端刚发出的 initialize 请求吞掉（StdioServerTransport 自己去读 stdin）。

await server.connect(new StdioServerTransport());
// 退出时把无头浏览器关掉（别留常驻 Chromium）
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) process.on(sig, () => { void closeBrowser(); });
}
