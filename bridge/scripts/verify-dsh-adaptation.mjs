// DSH 适配总验证：一次性跑完所有关键断言，输出 PASS/FAIL 清单。
// 不依赖 SnowLuma；不修改任何状态（探测会话会被 archive）。
//
// 文件名不再带版本号（原来是 verify-dsh-015-adaptation.mjs）：每升一次小版本都要改一遍
// 引用，而且名字会诱导后来者以为"只对 0.1.5 有效"。版本相关的事实记在这里：
//   - 0.1.5：persona schema 换字段、旧 preset 下线、API 改成斜杠式。
//   - 0.2.0（2026-10-10）：会话文件 session.v3 → session.v4（**旧 v3 文件留着不删**，
//     所以"写死 v3"的代码会去量一个已经冻结的文件 → 轮换永不触发 → 账单炸）；
//     MCP server 从 3 个涨到 7 个；帧粒度从"一行一帧"变成"一大块一帧"。
//     MCP 断言因此改成从 setup-dsh.mjs 派生，不再写死条数。
//     另外把「token 拿不到 / 401」从崩溃改成一条明确的 FAIL：手起的 DSH（npx 直接跑）
//     不会把 token 写进 guard 日志，旧脚本在这种情况下会甩一段 JSON.parse 栈，
//     看着像脚本坏了，其实是启动方式不对。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = process.cwd();
const DSH_MODULES = dshModulesDir();
const DSH_HOME = path.join(os.homedir(), '.dsh');
const BASE = 'http://127.0.0.1:3080';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 1. 仓库侧：preset persona schema ────────────────────────────────────────
const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

let oldRejected = false;
try { persona.Config({ text: 'x' }); } catch { oldRejected = true; }
check('dsh-persona 仍拒绝旧字段 text（故障前提成立）', oldRejected);

for (const p of ['qq-chat', 'qq-chat-v2']) {
  const f = path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml');
  const row = yaml.load(fs.readFileSync(f, 'utf8')).find((r) => r.id === 'persona');
  let schemaOk = false;
  try { persona.Config(row.config); schemaOk = true; } catch {}
  check(`preset ${p}: persona.config 通过 DSH schema`, schemaOk);
  check(`preset ${p}: 保留 {{model}} / {{cwd}} 变量`, /\{\{model\}\}/.test(row.config.prefix) && /\{\{cwd\}\}/.test(row.config.suffix ?? ''));
}

// ── 2. 部署侧：preset 按 0.2.0 的 bundle 形式装好了 ─────────────────────────
// 2026-10-10 换口径（升到 0.2.0 后当场踩到）：0.1.5 时代用户 preset 是目录
// `$DSH_HOME/.agent-presets/<id>/`，而 **0.2.0 起没有任何代码再读它**。这个变化极难发现：
// setup 照旧打印安装成功、DSH 照常启动，但 `agentPresets/list` 里只有内置的
// standard/ptc/minimal/cordis → 桥接 fail-closed 拒绝建会话 → 她永远不被唤醒，
// 而每个服务看着都"在跑"。所以这一节断言三件事：① 仓库里的**生成物**没有和手写源漂移；
// ② profile 把它注册成了 bundle 并 link 进了 node_modules；③ 旧目录已经不存在
// （留着只会制造"我改了这里怎么不生效"的坑）。
//
// 谁是谁：`dsh/agent-presets/<id>/` 是**唯一手写源**；`dsh/presets/qq-agent-presets/` 是
// setup-dsh.mjs 的**生成物**（生成器把整段 plugins 原样缩进 10 空格、并把 preset 内部模块
// 改成按包名引用）。这里的比较就是"生成器坏了 / 有人手改了生成物"的报警器。
//
// 旧写法是按字节比 `~/.dsh/.agent-presets/<p>/agent.cordis.yml`，还得用 norm() 抹平 CRLF；
// 现在改成"解析后比 id 序列"，缩进/换行/引号都不影响，也不会在同一内容的两种换行间误报。
const PRESET_IDS = ['qq-chat', 'qq-chat-v2'];
const PRESET_BUNDLE_NAME = 'qq-agent-presets';
const PRESET_BUNDLE_DIR = path.join(ROOT, 'dsh', 'presets', PRESET_BUNDLE_NAME);
const bundlePatchFile = path.join(PRESET_BUNDLE_DIR, 'cordis.patch.yml');
const bundlePkgFile = path.join(PRESET_BUNDLE_DIR, 'package.json');
// 缺文件时给 FAIL 而不是让 readFileSync 抛栈（缺生成物本身就是这条断言要报的事）
const readIfPresent = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

check(`生成物 dsh/presets/${PRESET_BUNDLE_NAME}/cordis.patch.yml 存在`, fs.existsSync(bundlePatchFile),
  `重跑 node scripts/setup-dsh.mjs 生成（别手改生成物）`);
check(`生成物 dsh/presets/${PRESET_BUNDLE_NAME}/package.json 存在`, fs.existsSync(bundlePkgFile));

const bundlePatchText = readIfPresent(bundlePatchFile);
let bundleDoc = null;
try { bundleDoc = yaml.load(bundlePatchText) ?? null; }
catch (error) { check('bundle cordis.patch.yml 能被 YAML 解析', false, `解析失败意味着 DSH 启动会直接报错：${error.message}`); }
if (bundleDoc !== null) {
  check('bundle cordis.patch.yml 能被 YAML 解析且顶层是数组', Array.isArray(bundleDoc), `类型 ${Array.isArray(bundleDoc) ? 'array' : typeof bundleDoc}`);
}
// Loader 行 id 约定 `preset-<id>`，声明里带 config.id。按 config.id 收成一张表，
// 顺手把"漏声明 / 多声明一个 preset"也抓出来。
const presetDecls = new Map();
for (const op of (Array.isArray(bundleDoc) ? bundleDoc : [])) {
  for (const entry of (Array.isArray(op?.insert) ? op.insert : [])) {
    if (String(entry?.id ?? '').startsWith('preset-')) presetDecls.set(String(entry?.config?.id ?? ''), entry);
  }
}
check(`bundle patch 文本含两条 Loader 行声明（${PRESET_IDS.map((p) => `preset-${p}`).join(' / ')}）`,
  PRESET_IDS.every((p) => new RegExp(`^\\s*- id: preset-${p}\\s*$`, 'm').test(bundlePatchText)));
check(`bundle 恰好声明 ${PRESET_IDS.length} 个 preset（config.id = ${PRESET_IDS.join(' / ')}）`,
  presetDecls.size === PRESET_IDS.length && PRESET_IDS.every((p) => presetDecls.has(p)),
  `实际声明: ${[...presetDecls.keys()].join(', ') || '(无)'}`);

for (const p of PRESET_IDS) {
  const decl = presetDecls.get(p);
  check(`bundle 声明 preset-${p}（用 dsh-agent-preset 加载器，config.id 正确）`,
    !!decl && decl.id === `preset-${p}` && decl.name === '@deepseek-ai/dsh-agent-preset' && decl.config?.id === p,
    decl ? `id=${decl.id} name=${decl.name}` : '缺这条声明');

  // 防漂移核心断言：生成物里的插件 id 序列必须和手写源**完全一致**。
  // 用 YAML 解析而不是数文本里的 "- id:" —— 生成器把整段缩进 10 空格，文本正则得跟着缩进写
  // （改一次缩进就误报）；解析后比 id 序列等价，还额外抓"有人手工注释掉/删掉一条"。
  const srcIds = (yaml.load(readIfPresent(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'))) ?? []).map((e) => e?.id);
  const genIds = (decl?.config?.plugins ?? []).map((e) => e?.id);
  const sameSeq = srcIds.length > 0 && srcIds.length === genIds.length && srcIds.every((id, i) => id === genIds[i]);
  check(`preset ${p}: bundle plugins 的顶层 id 序列与手写源完全一致`,
    sameSeq,
    sameSeq ? `${srcIds.length} 条：${srcIds.join(', ')}`
      : `生成物=[${genIds.join(', ')}] | 手写源=[${srcIds.join(', ')}] — 失败意味着生成器坏了或有人手改了生成物，重跑 node scripts/setup-dsh.mjs（别手改生成物）`);

  const restrict = (decl?.config?.plugins ?? []).find((e) => e?.id === 'qq-tool-restrict');
  check(`preset ${p}: qq-tool-restrict 按包名引用`,
    restrict?.name === `${PRESET_BUNDLE_NAME}/qq-tool-restrict.mjs`,
    `当前 name=${restrict?.name ?? '(缺这条)'}；写成相对路径会让安全白名单整体加载失败`);
}

// bundle 里的 qq-tool-restrict.mjs 是 setup-dsh.mjs 从手写源拷过来的那一份（安全白名单）。
// 逐字节比：它决定"群里的人能不能让她执行本机命令"，漂移了必须红。
const restrictSrcFile = path.join(ROOT, 'dsh', 'agent-presets', PRESET_IDS[0], 'qq-tool-restrict.mjs');
const restrictBundleFile = path.join(PRESET_BUNDLE_DIR, 'qq-tool-restrict.mjs');
check('bundle qq-tool-restrict.mjs 与手写源逐字节一致',
  fs.existsSync(restrictBundleFile) && fs.readFileSync(restrictSrcFile).equals(fs.readFileSync(restrictBundleFile)));

const patch = fs.readFileSync(path.join(DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8');
const patchDoc = yaml.load(patch);
const mcpIds = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
// 期望清单从 setup-dsh.mjs 派生，而不是写死条数和 id：写死的话每加一个 MCP server 都要改这里，
// 漏改的症状是"加好了却报失败"（或更糟：真少了也不报）。单一事实来源放在 setup-dsh.mjs。
const managedIds = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8');
  const m = /const MANAGED_MCP_IDS = \[([^\]]+)\]/.exec(src);
  return m ? m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
})();
check('能从 setup-dsh.mjs 派生出 MCP 期望清单', managedIds.length > 0, `派生到 ${managedIds.length} 个`);
check('profile patch 的 MCP 条目与 setup-dsh.mjs 完全一致且无重复',
  managedIds.length > 0 && mcpIds.length === managedIds.length
  && new Set(mcpIds).size === mcpIds.length
  && managedIds.every((id) => mcpIds.includes(id)),
  `patch=${mcpIds.join(', ')} | 期望=${managedIds.join(', ')}`);
const snowlumaEntry = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert).find((x) => x.id === 'mcp-snowluma');
check('mcp-snowluma 带 toolCallTimeoutMs=725000', snowlumaEntry?.config?.toolCallTimeoutMs === 725000);
check('mcp 路径指向本仓库', mcpIds.every((id) => {
  const e = patchDoc.filter((x) => x?.insert).flatMap((x) => x.insert).find((y) => y.id === id);
  return String(e.config.args[0]).includes('qq-bridge');
}));

const pkg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'profiles/web/package.json'), 'utf8'));
check('profile bundles 含 qq-mode-console', pkg.dsh.profile.bundles.includes('qq-mode-console'));
check('qq-mode-console link 依赖已注册', String(pkg.dependencies['qq-mode-console'] ?? '').startsWith('link:'));
check('qq-mode-console 已 link 进 node_modules', fs.existsSync(path.join(DSH_HOME, 'profiles/web/node_modules/qq-mode-console')));
// preset bundle 走的是和 qq-mode-console 完全相同的注册机制（link: 依赖 + bundles 清单）。
// 三条缺任何一条，DSH 要么启动报 "cannot resolve profile bundle"，要么 preset 不出现在
// agentPresets/list 里（后者正是 fail-closed 拒绝建会话的那个症状）。
check(`profile bundles 含 ${PRESET_BUNDLE_NAME}`, (pkg.dsh?.profile?.bundles ?? []).includes(PRESET_BUNDLE_NAME));
check(`${PRESET_BUNDLE_NAME} link 依赖已注册`, String(pkg.dependencies?.[PRESET_BUNDLE_NAME] ?? '').startsWith('link:'));
check(`${PRESET_BUNDLE_NAME} 已 link 进 node_modules`,
  fs.existsSync(path.join(DSH_HOME, 'profiles/web/node_modules', PRESET_BUNDLE_NAME)));
// 旧目录必须已经不在：0.2.0 不读它，留着会让人以为"改这里就生效"（setup 成功后才删）
check('$DSH_HOME/.agent-presets 已删除（0.2.0 不再读取，权威是 bundle）',
  !fs.existsSync(path.join(DSH_HOME, '.agent-presets')));

// ── 3. 仓库配置：模型 ───────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config.json dsh.model = deepseek-flash', cfg.dsh?.model === 'deepseek-flash', `当前 ${cfg.dsh?.model}`);
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
// 只看可执行代码，忽略注释（注释里会提到旧名做历史说明）。
// 必须**同时**剥掉行注释和块注释，而且必须整体扫描（不能逐行独立处理）：
//   - 只剥 `//` 时，`/** ... */` 里的旧名会被当成代码 —— 实测就误报过一条
//     （bridge.js 里解释"为什么不能写死 session.v3.jsonl.zstd"的 JSDoc，把"不许出现 v3"这条守卫打红）；
//   - 逐行处理块注释也不行：跨行注释的中间几行会被漏掉，而 `//` 出现在块注释内部（`/* a // b */`）
//     时先剥 `//` 会吃掉收尾的 `*/`，把后面一大段真代码一起误剥。
// 按 /\r?\n/ 切行的老写法还有个坑：JS 的 `.` 不匹配 \r，CRLF 文件直接 split('\n') 会让行尾留 \r，
// /\/\/.*$/ 的 `$` 够不到行尾、注释根本剥不掉（曾因此误报）。整体扫描天然没有这个问题。
const stripComments = (src) => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl; // 保留换行，行结构不变
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
};
const bridgeCode = stripComments(bridgeSrc);
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
// setup-dsh.mjs 曾被漏改：0.1.5 适配只清了 bridge.js，脚本里仍在写死已下线的 preset 名。
const setupCode = stripComments(fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8'));
check('setup-dsh.mjs 可执行代码无 router-standard 残留', !setupCode.includes('router-standard'));
check('setup-dsh.mjs 新装默认 closedAgentPreset 留空（交给 DSH 默认 preset）', /closedAgentPreset:\s*''/.test(setupCode));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 含 preset 清单/默认 preset 解析', bridgeSrc.includes('resolvePresetName') && bridgeSrc.includes('refreshPresetList'));

// 安全不变量回归防线：群聊/仿真会话在 preset 缺失时必须 fail-closed。
// 旧实现会在 preset 不在 DSH 清单里时静默回退到 DSH 默认 preset（standard，含 bash/
// 文件读写），把本地工具暴露给 QQ 群 —— 与 RULES.md「无本地工具」的承诺直接矛盾。
check('preset 解析带 strict 开关', /resolvePresetName\(name, \{ strict = false \} = \{\}\)/.test(bridgeCode));
check('非 closed-agent 模式以 strict 解析 preset', /resolvePresetName\(wanted, \{ strict: true \}\)/.test(bridgeCode));
check('群聊模式缺少 preset 时拒绝建会话（fail-closed）', /strictPreset && !preset/.test(bridgeCode));
check('群聊模式不再重试「无 preset」建会话', /strictPreset \? \[true\] : \[true, false\]/.test(bridgeCode));

// ── 3b. 版本身份一致性 ──────────────────────────────────────────────────────
// v0.1.5 曾带着自称 0.1.2-alpha.1 的 package-lock.json 发布出去（package.json 却是
// 0.1.5），三个 MCP server 的 serverInfo.version 也停在 0.1.0。版本漂移没有防线就会
// 复发，这里把「所有对外自称的版本号必须等于 package.json」固定下来。
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-mode-console/package.json'), 'utf8'));
check('package-lock.json 顶层 version 与 package.json 一致', lockJson.version === pkgJson.version, `lock=${lockJson.version} pkg=${pkgJson.version}`);
check('package-lock.json packages[""] version 与 package.json 一致', lockJson.packages?.['']?.version === pkgJson.version, `lock=${lockJson.packages?.['']?.version}`);
check('qq-mode-console 插件版本与主包一致', pluginPkg.version === pkgJson.version, `plugin=${pluginPkg.version}`);
// preset bundle 也是"对外自称版本号"的一份（生成物，版本从主包抄），一并纳入这条不变量
const presetBundlePkg = JSON.parse(readIfPresent(bundlePkgFile) || '{}');
check(`${PRESET_BUNDLE_NAME} bundle 版本与主包一致`, presetBundlePkg.version === pkgJson.version,
  `bundle=${presetBundlePkg.version ?? '(缺失)'} 主包=${pkgJson.version}；重跑 node scripts/setup-dsh.mjs`);
for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(`${f} 的 MCP serverInfo.version 与主包一致`, m?.[1] === pkgJson.version, `声明=${m?.[1]} 主包=${pkgJson.version}`);
}

// ── 4. 语法检查 ─────────────────────────────────────────────────────────────
for (const f of ['src/bridge.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/slang-learner.js', 'src/self-test.js', 'scripts/setup-dsh.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

// ── 4b. 会话文件格式（0.2.0：v3 → v4）──────────────────────────────────────
// 为什么单独立一节：0.2.0 把会话文件从 session.v3.jsonl.zstd 改成 session.v4.jsonl.zstd，
// 而且**升级后第一次写入时新写 v4、旧 v3 留在原地不删**。轮换判断（决定账单的那个）
// 一旦读错文件，就会去量一个已经冻结的 v3：字节数不再增长 → 阈值永不触发 →
// 会话无限膨胀。这条在真机上不值钱，但代价极大，所以既查"解析器存在"，也查"真机挑对了文件"。
const sessionHelperPath = path.join(ROOT, 'scripts/session-file.mjs');
check('存在会话文件解析器 scripts/session-file.mjs', fs.existsSync(sessionHelperPath));
const sessionHelper = fs.existsSync(sessionHelperPath)
  ? await import(pathToFileURL(sessionHelperPath).href)
  : null;
check('解析器导出 sessionFileIn / sessionFilePath',
  typeof sessionHelper?.sessionFileIn === 'function' && typeof sessionHelper?.sessionFilePath === 'function');
check('bridge.js 可执行代码不再写死 session.v3.jsonl.zstd', !bridgeCode.includes('session.v3.jsonl.zstd'));
check('bridge.js 通过 sessionFilePath 定位会话文件', bridgeCode.includes('function sessionFilePath('));

if (sessionHelper?.sessionFileIn) {
  const agentsSessions = path.join(DSH_HOME, 'sessions', '--D-qq-bridge-state-agents--');
  const cands = fs.existsSync(agentsSessions)
    ? fs.readdirSync(agentsSessions, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(agentsSessions, e.name))
      .map((d) => ({ d, names: (() => { try { return fs.readdirSync(d); } catch { return []; } })() }))
      .filter((x) => x.names.some((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n)))
      .map((x) => ({ d: x.d, m: fs.statSync(x.d).mtimeMs, names: x.names }))
      .sort((a, b) => b.m - a.m)
    : [];
  if (!cands.length) {
    results.push('⏭️ 她的会话目录里还没有 history 文件，跳过"真机挑文件"断言');
  } else {
    const top = cands[0];
    const versions = top.names.filter((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n));
    const maxV = Math.max(...versions.map((n) => Number(/^session\.v(\d+)/.exec(n)[1])));
    const picked = sessionHelper.sessionFileIn(top.d);
    check(`真机会话挑到最高版本（目录里有 ${versions.join(' / ')}）`,
      path.basename(picked) === `session.v${maxV}.jsonl.zstd`, `挑到 ${path.basename(picked)}`);
  }
}

// ── 5. 运行中的 DSH ─────────────────────────────────────────────────────────
// 本节的在线断言整体包在 try/catch 里：DSH 是手起的（npx 直接跑）时 token 不在 guard 日志里，
// 请求会拿到 401 的 "unauthorized" 文本；旧版在这里 JSON.parse 抛栈直接退出，
// 报错看着像脚本坏了，其实是启动方式不对。现在降级成一条带指引的 FAIL。
function tok() {
  const d = path.join(DSH_HOME, 'guard', 'logs');
  try {
    const f = fs.readdirSync(d).filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(d, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { n } of f) { try { const m = fs.readFileSync(path.join(d, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch {} }
  } catch {}
  return '';
}
// DSH 安装目录的形状在 0.2.0 变了：`dshModulesDir()` 用 @deepseek-ai/dsh-persona 反查，
// 0.2.0 起探针会落到 **DSH 自己那层** `.../@deepseek-ai/dsh/node_modules`，此时 `@deepseek-ai/dsh`
// 的 package.json 就在它的**上一级**（dsh 包根），而不是这一层里的 `@deepseek-ai/dsh/`。
// 两处都试，并且用 package.json 的 `name` 自校验（别把同名巧合当版本来源）。
// 只找第一处时会得到空版本号，报出来是"本机 DSH 版本未知" —— 看着像没装 0.2.0，其实只是路径形状变了。
const dshPkgPath = [
  path.join(DSH_MODULES, '@deepseek-ai', 'dsh', 'package.json'),
  path.join(DSH_MODULES, '..', 'package.json'),
].find((f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).name === '@deepseek-ai/dsh'; } catch { return false; }
}) ?? '';
const dshVersion = dshPkgPath ? JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')).version : '';
check('本机 DSH 已在 0.2 线（会话格式 v4 的分界）', /^0\.(2|[3-9]|\d{2,})\./.test(dshVersion), `当前 ${dshVersion || '未知'}`);

const t = tok();
check('能从 guard 日志里读到 DSH launch token', !!t,
  t ? '' : '没读到：DSH 必须用 dsh-guard.bat 启动（手起的 npx 实例不写日志，桥接会 401）');

let cookie = '';
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON（例如 401 的 "unauthorized"）：下面抛出可读错误 */ }
  if (!body) throw new Error(`HTTP ${r.status} ${text.trim().slice(0, 80)}`);
  return body.result;
}
try {
  const r0 = await fetch(`${BASE}/?token=${t}`, { redirect: 'manual' });
  cookie = r0.headers.get('set-cookie')?.split(';')[0] ?? '';
  check('DSH launch token → Cookie 换取成功', r0.status === 303 && !!cookie, `HTTP ${r0.status}`);

  const st = await rpc('settings/describe', {});
  check('settings/describe 可用', st.ok === true);
  const dm = st.value?.namespaces?.find((n) => n.ns === 'agent-default-model');
  check('DSH 全局默认模型 = deepseek-flash', dm?.value?.model === 'deepseek-flash', `当前 ${dm?.value?.model}`);
  const ap = await rpc('agentPresets/list', {});
  const presetIds = ap.value?.presets?.map((p) => p.id) ?? [];
  check('agentPresets/list 含 qq-chat 与 qq-chat-v2', presetIds.includes('qq-chat') && presetIds.includes('qq-chat-v2'),
    presetIds.join(', ') + (presetIds.includes('qq-chat') ? '' : ' — 只有内置 preset 就是 fail-closed 拒建会话的症状；装好 bundle 后必须重启 DSH 才会进这份清单'));
  // 0.2.0 同时改了设置命名空间：agent-presets → agent-preset-registry，字段 default → selectedDefault。
  // 旧写法读 `agent-presets.default`，在 0.2.0 上恒为空（实测命名空间已不存在）→ 这条断言会永远报红，
  // 而它想守的东西（closed-agent 留空时兜底到 DSH 的 standard）是好的。改成从 agentPresets/list 的
  // isDefault 标记读 —— 那才是 DSH 自己声明的默认 preset，也不再依赖命名空间/字段名。
  const defaultPreset = ap.value?.presets?.find((p) => p.isDefault)?.id;
  check('DSH 默认 preset 为 standard（closed-agent 留空时的兜底，取自 agentPresets/list 的 isDefault）',
    defaultPreset === 'standard', `isDefault=${defaultPreset ?? '(无)'}`);

  // 点号 endpoint（旧协议）应返回纯文本 404（不是 JSON 信封）——证明协议确为斜杠式
  const dotRes = await fetch(`${BASE}/api/session.list`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'v-dot', method: 'session.list', payload: { args: { _request: {} } } }),
  });
  const dotBody = await dotRes.text();
  check('点号 endpoint /api/session.list 不可用（旧协议已废弃）', dotRes.status === 404 && /not found/i.test(dotBody), `HTTP ${dotRes.status}`);
} catch (error) {
  // 一条 FAIL 说清"在线部分没跑成"，而不是让整个脚本带着栈崩掉
  check('DSH 在线 API 全部可用（token + 斜杠式协议）', false, String(error?.message ?? error));
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
