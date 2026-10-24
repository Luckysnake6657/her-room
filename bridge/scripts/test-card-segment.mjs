/**
 * 回归：QQ 分享卡片要能读出标题/摘要/链接（2026-10-14，申请 #29）。
 *
 * 现场：他给了一个小黑盒帖子链接，想让她看正文跟他讨论。抓到的只是 **JS 空壳页**
 *   （正文由前端渲染，curl / web_fetch 都不执行 JS；服务端也不给 SEO 兜底 ——
 *   我用 Googlebot UA 试过，返回的是同一个 3369 字节空壳）。
 *   我还把它接口的签名算法逆出来了（HMAC-SHA256、key=`Z7mFG4tQp9Ws2LxB8H`、
 *   `_rnd="15:"+sig`），但**正确签名与故意写错的签名返回一模一样**（都是
 *   `{"msg":"请求失败了"}`，且这句不在任何前端 bundle 里 = 服务端给的），
 *   说明卡的是**登录票据**而不是签名 —— 这条路不通。
 *
 * 正文其实有另一条路：**他转发那条帖子时，QQ 会把标题/摘要/链接打包进卡片 JSON**。
 *   网关自己都解析出来了（日志里 `[卡片:哔哩哔哩]`），但桥接把整个 json 段压成
 *   `[卡片消息]`，内容全丢 —— 和小黑盒空壳页同一个病：**东西在，没人取**。
 *
 * 本用例锁：卡片里的 title/desc/url 要真的进到她看到的文本里；
 *   结构认不出来时老实退回 `[卡片消息]`（**不许编内容**）。
 *
 * 用法: node scripts/test-card-segment.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  const render = (data) => h.segmentsToText([{ type: 'json', data }]);

  console.log('\n[1] news 型分享卡片（QQ 转发链接最常见的形状）');
  {
    const raw = JSON.stringify({
      app: 'com.tencent.structmsg', view: 'news',
      meta: { news: { title: '这游戏真有说法吧', desc: '小黑盒玩家实测：那个算法其实是错的', jumpUrl: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=51c6729d32e0', tag: '小黑盒' } },
      prompt: '[QQ小程序]小黑盒',
    });
    const out = await render({ data: raw });
    console.log('    渲染:', out);
    check('不再是光秃秃的 [卡片消息]', out !== '[卡片消息]', out);
    check('带上了卡片标题', out.includes('这游戏真有说法吧'), out);
    check('带上了摘要', out.includes('小黑盒玩家实测'), out);
    check('带上了链接（她能顺着去看/引用）', out.includes('link_id=51c6729d32e0'), out);
  }

  console.log('\n[2] ark 型卡片（另一套键名：detail_1 / qqdocurl）');
  {
    const raw = JSON.stringify({ app: 'com.tencent.ark', view: 'ark', meta: { detail_1: { title: '帖子标题在这里', desc: '摘要也在这里', qqdocurl: 'https://xiaoheihe.cn/x' } }, prompt: '[QQ小程序]' });
    const out = await render({ data: raw });
    console.log('    渲染:', out);
    check('ark 型也能取到标题', out.includes('帖子标题在这里'), out);
    check('ark 型也能取到摘要', out.includes('摘要也在这里'), out);
    check('ark 型也能取到链接', out.includes('xiaoheihe.cn/x'), out);
  }

  console.log('\n[3] 脏输入不能崩、也不能编');
  {
    check('不是 JSON → 退回 [卡片消息]', (await render({ data: 'not json at all' })) === '[卡片消息]');
    check('空 data → 退回 [卡片消息]', (await render({ data: '' })) === '[卡片消息]');
    check('JSON 里没有可读字段 → 退回 [卡片消息]',
      (await render({ data: JSON.stringify({ app: 'x', view: 'y', meta: { z: { a: 1, b: true } } }) })) === '[卡片消息]');
    check('对象形态的 data 也认（有些网关直接给对象）',
      (await render({ data: { meta: { news: { title: '对象形态标题' } } } })).includes('对象形态标题'));
    check('不会因为超长字段炸掉', (await render({ data: JSON.stringify({ meta: { news: { title: 'x'.repeat(5000) } } }) })).length < 400);
  }

  console.log('\n[4] 源码守卫：别再退回"只给个占位符"');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
    check("json 段走的不是写死的 '[卡片消息]'", /case 'json': out\.push\(formatCardSegment\(d\)\); break;/.test(src));
    check('有 formatCardSegment 实现', /function formatCardSegment\(d\)/.test(src));
    check('取不到内容时**如实退回**占位符（不编）', /if \(!bits\.length\) return '\[卡片消息\]';/.test(src));
  }
} finally {
  await h.close();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
