// 把这四个战绩 MCP 服务器的工具各合并成**一个入口**（action 分发），省每轮的工具描述 token。
//
// 为什么：工具定义每回合都要进上下文 —— 实测这 15 个战绩工具 ≈ 2000 token/回合
// （在线量法：node scripts/test-dsh-v2-wait.mjs 读 DSH 真实 request/header）。
// 合并后每个服务器只剩 1 个工具，且**保留全部 handler / schema / 参数说明**：
//   - 各 server.tool(...) 的注册被收集进 registeredTools（不改 handler）；
//   - 文件末尾注册一个 <服务器>__query，用 action 选具体查询；
//   - 参数用各自的 zod schema 二次校验（缺必填会点名说缺哪个）；
//   - 旧的全名（get_wmpvp_player_stats 等）作为**别名**继续可用 —— 人格卡/记忆里
//     写过的老名字不会突然失效。
//
// 幂等：已经合并过（含 registeredTools 标记）就跳过。用法：
//   node scripts/merge-stats-tools.mjs
//
// ⚠️ 实测后还跟了三个小补丁（都已应用，留在仓库里当记录；新装机器按顺序跑一遍即可）：
//   scripts/tune-stats-dispatch.mjs        摘要瘦身：按服务器剥掉重复的"只读查询 XX 平台…"套话，上限 64→46 字符
//   scripts/fix-stats-boiler.mjs           补全套话正则（漏了"只读扫描"、"玩家的"里那个"的"）
//   scripts/patch-dispatch-action-string.mjs  action 由 z.enum(短名) 改成 z.string() —— 见下面注释
// 另外 scripts/patch-stats-tests.mjs 把老的战绩测试脚本改成走 query 入口（用旧全名当 action）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const SERVERS = {
  'mcp-ow-stats.js': {
    intro: '守望先锋2（国际服，OverFast）只读查询。',
    strip: '/^(get_|search_)/',
  },
  'mcp-ow-cn-stats.js': {
    intro: '守望先锋【国服】（网易大神，经本地 Overstats）只读查询。',
    strip: '/^get_cn_/',
  },
  'mcp-cs-5e-stats.js': {
    intro: 'CS（5E 对战平台）只读查询。',
    strip: '/^(get_5e_|search_5e_)/',
  },
  'mcp-cs-wmpvp-stats.js': {
    intro: 'CS（完美世界竞技平台）只读查询。',
    strip: '/^(get_wmpvp_|search_wmpvp_)/',
  },
};

const MARK = 'const registeredTools = new Map();';
const COLLECT_ANCHOR = 'const server = new McpServer(';
const GUARD_ANCHOR = '// DSH 换代时关掉 stdin';

const collectBlock = (serverName) => `
// ── 工具合并（2026-09-28）─────────────────────────────────────────────
// 下面每个 server.tool(...) 都先被**收集**起来，文件末尾统一暴露成一个入口
// （见最后的 __origTool 注册）。handler / 描述 / schema 一个都没改。
// 目的：工具定义每回合都进上下文，${serverName} 原来那几个工具加起来 ≈ 每回合几百 token。
const registeredTools = new Map();
const __origTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => {
  registeredTools.set(name, { description, schema, handler });
};
`;

const dispatchBlock = (id, intro, strip) => `
// ── 单一入口：action 分发 ──────────────────────────────────────────────
// 对外只暴露一个工具：用 action 选具体查询、参数照旧。
// 对外短名由原名去掉冗余前缀得到（get_wmpvp_player_stats → player_stats），
// 旧全名同时作为**别名**保留，人格卡/记忆里写过的老名字不会失效。
const ACTION_STRIP = ${strip};
const exposedActions = new Map();   // 对外短名 → 原工具
const actionAliases = new Map();    // 旧全名 / 短名 → 对外短名
for (const [orig, t] of registeredTools) {
  const short = orig.replace(ACTION_STRIP, '');
  const use = exposedActions.has(short) ? orig : short;   // 撞名就退回原名，绝不互相覆盖
  if (!exposedActions.has(use)) exposedActions.set(use, t);
  actionAliases.set(orig, use);
}
const actionNames = [...exposedActions.keys()];
const actionBrief = (t) => {
  const s = String(t?.description ?? '').replace(/\\s+/g, ' ').trim();
  const first = s.split(/[。；;]/)[0] ?? '';
  return first.length > 46 ? first.slice(0, 46) + '…' : first;
};
// 参数表：按名字取**第一个**声明它的 schema（描述/枚举都更有用），一律 optional ——
// 真正的必填校验在下面按 action 取各自 schema 再做，报错也更准。
const dispatchShape = { action: z.enum(actionNames).describe('要执行哪个查询（见上方描述里的清单）') };
for (const t of exposedActions.values()) {
  for (const [k, v] of Object.entries(t.schema ?? {})) {
    if (k === 'action' || k in dispatchShape) continue;
    dispatchShape[k] = (typeof v?.optional === 'function' ? v.optional() : z.any().optional());
  }
}
__origTool(
  '${id}',
  '${intro}一个入口，用 action 选具体查询：\\n'
  + actionNames.map((n) => \`- action="\${n}"：\${actionBrief(exposedActions.get(n))}\`).join('\\n')
  + '\\n一次只查一件事；参数按各 action 的说明给，缺必填会明确告诉你缺哪个。'
    + '（旧的全名也认：action 写 get_wmpvp_player_stats 这种名字照样能用）',
  dispatchShape,
  async (args) => {
    const asked = args?.action;
    const key = exposedActions.has(asked) ? asked : actionAliases.get(asked);
    const t = key ? exposedActions.get(key) : null;
    if (!t) {
      return { content: [{ type: 'text', text: \`未知 action「\${asked}」。可用：\${actionNames.join('、')}\` }], isError: true };
    }
    const rest = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === 'action' || v === undefined || v === null) continue;
      rest[k] = v;
    }
    const parsed = z.object(t.schema ?? {}).safeParse(rest);
    if (!parsed.success) {
      const why = (parsed.error?.issues ?? [])
        .map((i) => \`\${(i.path ?? []).join('.') || '参数'}：\${i.message}\`).join('；');
      return { content: [{ type: 'text', text: \`action=\${key} 的参数不对：\${why}\` }], isError: true };
    }
    try {
      return await t.handler(parsed.data);
    } catch (error) {
      return { content: [{ type: 'text', text: \`\${key} 执行失败：\${error?.message ?? error}\` }], isError: true };
    }
  }
);

`;

let changed = 0;
for (const [file, spec] of Object.entries(SERVERS)) {
  const p = path.join(ROOT, 'src', file);
  let s = fs.readFileSync(p, 'utf8');
  const serverName = s.match(/new McpServer\(\{\s*name:\s*'([^']+)'/)?.[1] ?? file;
  if (s.includes(MARK)) {
    // 已经合并过：只把入口名统一成 'query'（早期版本误用了服务器名当工具名，
    // 会变成 mcp__ow-cn-stats__ow-cn-stats 这种又长又重复的名字）。
    const fixed = s.replace(`__origTool(\n  '${serverName}',`, "__origTool(\n  'query',");
    if (fixed !== s) { fs.writeFileSync(p, fixed, 'utf8'); console.log(`🔧 入口名改为 query：${file}`); changed++; }
    else console.log(`= 已经合并过，跳过：${file}`);
    continue;
  }
  const lines = s.split('\n');
  const ci = lines.findIndex((l) => l.startsWith(COLLECT_ANCHOR));
  if (ci < 0) { console.error(`❌ 找不到 McpServer 创建行：${file}`); process.exitCode = 1; continue; }
  lines.splice(ci + 1, 0, collectBlock(serverName).replace(/^\n/, ''));

  s = lines.join('\n');
  const gi = s.indexOf(GUARD_ANCHOR);
  const ai = s.lastIndexOf('await server.connect(');
  const at = gi >= 0 ? gi : ai;
  if (at < 0) { console.error(`❌ 找不到插入点：${file}`); process.exitCode = 1; continue; }
  s = s.slice(0, at) + dispatchBlock(serverName, spec.intro, spec.strip) + s.slice(at);

  fs.writeFileSync(p, s, 'utf8');
  console.log(`✅ 已合并：${serverName}（${file}）`);
  changed++;
}
console.log(`\n完成：改了 ${changed} 个文件`);

// 语法检查
for (const file of Object.keys(SERVERS)) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', file)], { stdio: 'pipe' });
    console.log(`  ✅ ${file} 语法通过`);
  } catch (error) {
    console.error(`  ❌ ${file} 语法失败：${String(error.stdout ?? error.message).slice(0, 400)}`);
    process.exitCode = 1;
  }
}
