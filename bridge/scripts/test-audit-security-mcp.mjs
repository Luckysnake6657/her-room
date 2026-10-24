// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';

/**
 * 在 vm 里加载 web-search-safe 那个 server（剥掉 import，靠这里的注入喂依赖）。
 *
 * 2026-10-14 的两处变化（都是**实测驱动的有意变更**，不是放宽）：
 *   ① 搜索改走 `fetch`：原来断言"搜索也走 safeFetch"，但实测 Bing 对 safeFetch 那条手写 socket
 *      链路返回的是**不含结果条目的骨架页**（<title>xxx - 搜索</title>、<h2> 数 0），导致 web_search
 *      一直空结果。安全性没降：域名写死 cn.bing.com、query 只进 searchParams，没有用户可控 URL。
 *   ② web_fetch 增加 SPA 渲染兜底：注入 needsRender/renderPage，并新增用例钉住"空壳 → 走渲染"。
 */
function loadWebTools(safeFetch, extra = {}) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    safeFetch, McpServer, StdioServerTransport: class {}, z, URL,
    // 搜索现在走 fetch（见上方说明）：测试注入假的 fetch，避免联网
    fetch: extra.fetch ?? (async () => { throw new Error('测试里没给 fetch'); }),
    // 渲染兜底：默认"判定为不需要渲染"，需要测渲染的用例自己传
    needsRender: extra.needsRender ?? (() => false),
    renderPage: extra.renderPage ?? (async () => { throw new Error('测试里没给 renderPage'); }),
    closeBrowser: extra.closeBrowser ?? (async () => {}),
    process: { on() {} },
    // vm 是全新 context：node 特有的定时器和 AbortController 也要喂进去
    setTimeout, clearTimeout, AbortController,
  });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search 净化查询词、走写死域名的 fetch，并解析出结果条目', async () => {
  const calls = [];
  const safeFetchCalls = [];
  const callTool = loadWebTools(
    async (url, maxChars) => { safeFetchCalls.push({ url, maxChars }); return { statusCode: 200, body: '' }; },
    {
      fetch: async (url) => {
        calls.push(url);
        return {
          status: 200,
          text: async () => '<li class="b_algo"><h2><a href="https://example.com/">Fixture title</a></h2><p>Fixture summary</p></li>',
        };
      },
    }
  );
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.query, 'fixture phrase');
  assert.equal(parsed.results[0].title, 'Fixture title');
  // 域名必须写死 cn.bing.com（不留用户可控 URL），查询词进 searchParams
  assert.equal(new URL(calls[0]).host, 'cn.bing.com');
  assert.equal(new URL(calls[0]).searchParams.get('q'), 'fixture phrase');
  // ★ 有意变更（2026-10-14）：搜索**不再**走 safeFetch —— 实测 Bing 对那条链路只返回不含结果的骨架页，
  //   于是 web_search 长期空结果。改走 fetch 后域名仍写死，安全性不变。
  assert.equal(safeFetchCalls.length, 0, '搜索不该再走 safeFetch（那样 Bing 只给骨架页）');
});

test('web_fetch 遇到 SPA 空壳会自动渲染，并返回渲染后的正文', async () => {
  const shell = '<!DOCTYPE html><html><head>' + '<script src="/a.js"></script>'.repeat(9) + '</head><body><div id="app"></div></body></html>';
  let rendered = 0;
  const callTool = loadWebTools(
    async () => ({ statusCode: 200, body: shell, offset: 0, nextOffset: null }),
    {
      // 真判定函数：空壳 → 需要渲染
      needsRender: (html, text) => String(text ?? '').trim().length < 200,
      renderPage: async () => { rendered++; return { url: 'http://example.com/', title: '渲染后的标题', text: '渲染出来的正文内容', truncated: false, rendered: true }; },
    }
  );
  const result = await callTool('web_fetch', { url: 'http://example.com/' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(rendered, 1, '空壳必须触发一次渲染');
  assert.equal(parsed.rendered, true);
  assert.equal(parsed.body, '渲染出来的正文内容');
  assert.equal(parsed.title, '渲染后的标题');
});

test('web_fetch 传 render:never 时不渲染（给她一个关掉的开关）', async () => {
  let rendered = 0;
  const callTool = loadWebTools(
    async () => ({ statusCode: 200, body: '<html><body>短短</body></html>', offset: 0, nextOffset: null }),
    { needsRender: () => true, renderPage: async () => { rendered++; return { text: 'x', rendered: true }; } }
  );
  const result = await callTool('web_fetch', { url: 'http://example.com/', render: 'never' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(rendered, 0);
  assert.equal(parsed.rendered, false);
});

test('抓取/搜索的拒绝都以工具错误形式暴露（不静默）', async () => {
  // 抓取走 safeFetch → 注入的 safeFetch 抛"内网重定向被拒"
  const callFetch = loadWebTools(async () => { throw new Error('fixture: internal redirect rejected'); });
  const r1 = await callFetch('web_fetch', { url: 'http://example.com' });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /internal redirect rejected/);

  // 搜索走 fetch（2026-10-14 起）→ 让注入的 fetch 抛错，同样要变成工具错误
  const callSearch = loadWebTools(async () => { throw new Error('不该走到 safeFetch'); }, {
    fetch: async () => { throw new Error('fixture: search transport rejected'); },
  });
  const r2 = await callSearch('web_search', { query: 'fixture' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /search transport rejected/);
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools(async () => { assert.fail('Unexpected transport call'); });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
});
