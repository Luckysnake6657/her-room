// 二代工具面的「实时」端到端测试：真建一个 qq-chat-v2 会话、发一句极短的话，
// 然后**直接从 DSH 真正发出去的请求头**（request/header 事件）里读出这一轮的工具清单，
// 断言 qq_wait_for_messages / qq_read_file 等在不在里面。
//
// 为什么不再"让模型把工具名念一遍"（旧做法）：
//   那个提示词要模型在 reasoningEffort=max 下枚举 57 个工具名，
//   实测**单步要 4.5~5.5 分钟**（2026-09-28 连跑三次都在超时线上），
//   于是测试常年假失败 —— 而会话文件里 turn/start、turn/end 明明都齐全。
//   请求头里本来就带着完整工具定义，直接读它：几秒钟出结果，而且测的是**真正发出去的东西**。
// （纯逻辑单测见 scripts/test-v2-wait.mjs，两者不重复。）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
let warn = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
/**
 * 软失败：**只在"这一轮没跑完"这种环境性抖动上用**。
 *
 * 背景（2026-10-10）：这个用例在批测里偶发红（单独跑必过）—— 它要真发一次 DSH 请求，
 * 桥接刚重启/她那边正好在跑回合时，12 秒的实时回合可能等不到 turn/end。
 * 而**本用例真正要断言的是工具面**，而工具面来自 request/header（第一帧就到了，跟回合跑没跑完无关）。
 * 所以：只要拿到了请求头，"回合没在超时内结束"就降级成 warn —— 否则这个门会变成
 * "多跑几次总能绿"的假门，而假门比没有门更糟（会训练人重跑到绿为止）。
 */
const soft = (name, detail) => { warn++; console.log(`  ⚠️ ${name}${detail ? ` — ${detail}` : ''}`); };

async function main() {
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  const api = new NodeApiClient('http://127.0.0.1:3080', undefined, auth);
  const cwd = path.join(ROOT, 'state', 'self-test-v2-wait');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  console.log('SESSION_CREATED', sessionId);

  let header = null;
  let ended = null;
  const started = Date.now();
  const TIMEOUT_MS = 120_000;
  const stream = api.events.mux({});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待回复超时（${TIMEOUT_MS / 1000}s）`)), TIMEOUT_MS);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          if (frame.event?.type === 'request/header') header = frame.event.data?.header ?? null;
          if (frame.event?.type === 'turn/end') { clearTimeout(timer); resolve(frame.event); return; }
        }
        if (frame.type === 'stream/error') { clearTimeout(timer); reject(new Error('事件流错误: ' + JSON.stringify(frame.error))); return; }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });

  stream.follow(sessionId);
  // 极短提示词：这一轮的目的只是"让 DSH 发出一次真实请求"，不要花 5 分钟生成工具名。
  const accepted = unwrap(await api.sessions.prompt({
    sessionId, mode: 'queue',
    content: [{ type: 'text', text: '只回复两个字：收到' }],
  }), 'session.prompt');
  console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));
  try {
    ended = await done;
  } catch (error) {
    // 拿不到请求头 = 什么都没测到 → 硬失败；拿到了头 → 只是回合没跑完（环境抖动）→ 软失败
    if (header) soft('实时回合能跑完（这次没在超时内结束，但请求头已拿到，工具面断言仍然有效）', `${error?.message ?? error}；会话文件：${sessionId}`);
    else check('实时回合能跑完', false, `${error?.message ?? error}；会话文件：${sessionId}`);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`耗时 ${elapsed}s`);

  if (ended) check('实时回合能跑完', true, `turn/end reason=${ended.data?.reason ?? '?'}，${elapsed}s`);

  const tools = Array.isArray(header?.tools) ? header.tools : [];
  check('拿到真实的请求头（工具定义在里面）', tools.length > 0,
    header ? `provider=${header?.config?.provider}/${header?.config?.model}` : '没收到 request/header 事件');

  // DSH 给 MCP 工具加命名空间前缀（mcp__snowluma__qq_xxx），断言用裸名比较。
  const bare = (n) => String(n).replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
  const names = tools.map((t) => bare(t.name));
  const chars = tools.reduce((n, t) => n + t.name.length + String(t.description ?? '').length + JSON.stringify(t.parameters ?? {}).length, 0);
  console.log(`  本轮实际工具数 ${names.length} / ${chars} 字符 ≈ ${Math.round(chars / 3)} token（每轮都要带）`);
  const qqTools = tools.filter((t) => /snowluma/.test(t.name));
  const qqChars = qqTools.reduce((n, t) => n + t.name.length + String(t.description ?? '').length + JSON.stringify(t.parameters ?? {}).length, 0);
  console.log(`  其中 QQ（snowluma）工具 ${qqTools.length} 个 / ${qqChars} 字符 ≈ ${Math.round(qqChars / 3)} token`);
  // 按 MCP 服务器分组，看合并前后每个来源各占多少（工具名形如 mcp__<server>__<tool>）
  const byServer = new Map();
  for (const t of tools) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t.name);
    const srv = m ? m[1] : '(DSH 内置)';
    const c = t.name.length + String(t.description ?? '').length + JSON.stringify(t.parameters ?? {}).length;
    const cur = byServer.get(srv) ?? { n: 0, c: 0 };
    byServer.set(srv, { n: cur.n + 1, c: cur.c + c });
  }
  const rows = [...byServer.entries()].sort((a, b) => b[1].c - a[1].c);
  for (const [srv, v] of rows) console.log(`    ${String(v.n).padStart(2)} 个 / ${String(v.c).padStart(5)} 字符  ${srv}`);
  const statsChars = rows.filter(([s]) => /stats/.test(s)).reduce((n, [, v]) => n + v.c, 0);
  console.log(`  战绩类工具合计 ${statsChars} 字符 ≈ ${Math.round(statsChars / 3)} token`);
  check('qq_wait_for_messages 在工具面里', names.includes('qq_wait_for_messages'));
  check('qq_read_file 在工具面里（合并后的按需读文件）', names.includes('qq_read_file'),
    '缺它说明 DSH 的 MCP 进程还是旧代码 —— MCP 服务是 DSH 启动时拉起的，要重启 DSH 才生效');
  check('被合并掉的旧工具名不在工具面里',
    !names.includes('qq_get_document_images') && !names.includes('qq_read_file_section'),
    names.filter((n) => /read_file|document_images/.test(n)).join(',') || '只剩 qq_read_file');
  check('qq_recall_message 在工具面里（她能自己收拾刷屏）', names.includes('qq_recall_message'),
    '缺它同样要重启 DSH');
  check('qq_role_play 在工具面里（临时角色扮演由她表态）', names.includes('qq_role_play'),
    '缺它同样要重启 DSH');
  check('qq_request_action 在工具面里（她只能申请、不能执行——这是她唯一的"动手"路径）', names.includes('qq_request_action'),
    '缺它说明 MCP 还是旧代码：node scripts/reload-mcp.mjs 热重载即可');
  // ★ 光看"工具名在不在"会漏掉**改了参数但没重载**这种情况（2026-10-10 真踩了）：
  //   我给 web_fetch 加了 offset 分页，只重载了 snowluma 那套（reload-mcp 的默认目标），
  //   web-search-safe 还跑着旧代码 —— 她传 offset 被忽略、结果里也没有 nextOffset，
  //   而"工具名在不在"这条检查完全看不出来。所以这里**直接查参数 schema**。
  {
    const wf = tools.find((t) => /web_fetch$/.test(String(t.name)));
    const props = wf?.parameters?.properties ?? {};
    check('web_fetch 的 schema 里有 offset（长文续读）', Object.prototype.hasOwnProperty.call(props, 'offset'),
      `实际参数：${Object.keys(props).join(',') || '(取不到)'} —— 缺它说明 **web-search-safe 那个 MCP 进程还是旧代码**：`
      + '跑 `node scripts/reload-mcp.mjs web-search-safe`（注意：不带参数时只重载 snowluma！）');
  }
  check('qq_send_file 在工具面里（发文件，出站目录锁）', names.includes('qq_send_file'),
    '缺它说明 MCP 还是旧代码：node scripts/reload-mcp.mjs');
  check('没有凭据类工具混进工具面', !names.some((n) => /token|secret|console/i.test(n)), names.filter((n) => /token|secret|console/i.test(n)).join(','));

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败${warn ? ` / ${warn} 软失败` : ''}`);
  try { await stream.close?.(); } catch {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
