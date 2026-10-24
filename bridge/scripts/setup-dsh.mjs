#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//      （DSH 0.2.0 起 preset 必须是 bundle 声明，不再是 $DSH_HOME/.agent-presets 目录，
//        见 buildPresetBundle 的注释）
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 在 profile package.json 中注册 qq-mode-console 插件 与 qq-agent-presets bundle
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

const PRESET_IDS = ['qq-chat', 'qq-chat-v2'];
const PRESET_BUNDLE_NAME = 'qq-agent-presets';
const PRESET_BUNDLE_DIR = path.join(REPO_ROOT, 'dsh', 'presets', PRESET_BUNDLE_NAME);

/**
 * 把 `dsh/agent-presets/<id>/` 的两套 preset 生成 DSH 0.2.0 的 **bundle** 形式。
 *
 * 为什么必须换（2026-10-10，升到 0.2.0 后当场踩到）：0.1.5 时代用户 preset 是
 * `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`），而 **0.2.0 起没有任何代码
 * 再读这个目录**（DSH 自带技能 `editing-cordis-compositions` 的原话：Nothing reads that directory any more）。
 * 症状极具迷惑性：`node scripts/setup-dsh.mjs` 照旧打印 "preset installed"，DSH 也照常启动，
 * 但 `agentPresets/list` 里只有内置的 standard/ptc/minimal/cordis → 桥接 fail-closed 拒绝建会话
 * （`⛔ 群聊/仿真会话缺少 preset "qq-chat-v2"`）→ 她永远不被唤醒，而每个服务看着都"在跑"。
 *
 * 现在的形式：一个 bundle 包（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`），
 * patch 里 insert 一行 `@deepseek-ai/dsh-agent-preset` 声明（Loader 行 id 约定 `preset-<id>`），
 * 声明带 `id` / `name` / `description` / `order` / `plugins`。preset 要用自己的代码
 * （`qq-tool-restrict.mjs`）时按**包名**引用 —— 和 `qq-mode-console` 插件同一套机制。
 *
 * 为什么是"生成"而不是手写一份：插件清单有 200+ 行、还带着解释安全设计的注释，手抄一份必然漂移。
 * 所以 `dsh/agent-presets/<id>/` 仍然是**唯一手写源**，这里每次原样缩进搬过去。
 */
function buildPresetBundle() {
  for (const id of PRESET_IDS) {
    const dir = path.join(REPO_ROOT, 'dsh', 'agent-presets', id);
    for (const f of ['preset.yml', 'agent.cordis.yml', 'qq-tool-restrict.mjs']) {
      if (!fs.existsSync(path.join(dir, f))) fatal(`preset source not found: ${path.join(dir, f)}`);
    }
  }
  // 两份 qq-tool-restrict.mjs 历史上是复制品；不一致就报错，别把"错的那份"装进 bundle 还当成功
  const restrict = PRESET_IDS.map((id) => fs.readFileSync(path.join(REPO_ROOT, 'dsh', 'agent-presets', id, 'qq-tool-restrict.mjs')));
  if (!restrict.every((buf) => buf.equals(restrict[0]))) {
    fatal(`preset 里的 qq-tool-restrict.mjs 两份内容不一致：${PRESET_IDS.join(' / ')}；先让它们一致再重跑`);
  }

  const lines = [
    '# 这个文件由 scripts/setup-dsh.mjs 生成，请不要手改。',
    '# 手写源：dsh/agent-presets/<id>/{preset.yml,agent.cordis.yml}；改完重跑 node scripts/setup-dsh.mjs。',
    '# DSH 0.2.0 起 preset 只认这种 bundle 声明（旧的 $DSH_HOME/.agent-presets/<id>/ 已无人读取）。',
  ];
  for (const id of PRESET_IDS) {
    const dir = path.join(REPO_ROOT, 'dsh', 'agent-presets', id);
    const meta = yaml.load(fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8')) ?? {};
    const order = Number(meta.order);
    // 插件清单原样搬，只做两件事：整体缩进到 plugins: 之下；把 preset 内部模块改成按包名引用
    const plugins = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\s+$/, '')
      .split('\n')
      .map((l) => (l.trim() ? `          ${l}` : ''))
      .join('\n')
      .replace(/^(\s*)name: '?"?\.\/qq-tool-restrict\.mjs'?"?/gm, `$1name: ${PRESET_BUNDLE_NAME}/qq-tool-restrict.mjs`);
    if (!plugins.includes(`${PRESET_BUNDLE_NAME}/qq-tool-restrict.mjs`)) {
      fatal(`preset ${id} 里找不到 qq-tool-restrict 插件条目（security guard 会整体消失，不允许静默跳过）`);
    }
    lines.push(
      '- insert:',
      `    - id: preset-${id}`,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      `        id: ${id}`,
      `        name: ${yamlSingleQuote(meta.name ?? id)}`,
      `        description: ${yamlSingleQuote(meta.description ?? '')}`,
      `        order: ${Number.isFinite(order) ? order : 10}`,
      '        plugins:',
      plugins,
    );
  }

  ensureDir(PRESET_BUNDLE_DIR);
  fs.writeFileSync(path.join(PRESET_BUNDLE_DIR, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8');
  const mainPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(PRESET_BUNDLE_DIR, 'package.json'), `${JSON.stringify({
    name: PRESET_BUNDLE_NAME,
    // 版本与主包保持一致：仓库有"对外自称的版本号必须等于 package.json"的守卫（verify:adaptation）
    version: mainPkg.version,
    private: true,
    type: 'module',
    description: 'DSH agent presets for the QQ bridge (qq-chat / qq-chat-v2), generated by scripts/setup-dsh.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`, 'utf8');
  fs.copyFileSync(
    path.join(REPO_ROOT, 'dsh', 'agent-presets', PRESET_IDS[0], 'qq-tool-restrict.mjs'),
    path.join(PRESET_BUNDLE_DIR, 'qq-tool-restrict.mjs'),
  );
  log(`preset bundle generated: ${PRESET_BUNDLE_DIR}（声明 ${PRESET_IDS.map((id) => `preset-${id}`).join(' / ')}）`);
}

/**
 * 清掉 0.1.5 时代留下的 `$DSH_HOME/.agent-presets/`。
 *
 * 为什么删而不是留着：0.2.0 已经不读它，留着只会制造"我改了这里怎么不生效"的坑
 * （这份目录曾经是权威）。只在 bundle 安装成功后才删 —— 安装失败时旧的还在，至少留条退路。
 */
function removeLegacyPresetDirs() {
  const legacy = path.join(DSH_HOME, '.agent-presets');
  if (!fs.existsSync(legacy)) return;
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
    log(`legacy preset dir removed: ${legacy}（DSH 0.2.0 不再读它，权威在 ${PRESET_BUNDLE_DIR}）`);
  } catch (e) {
    log(`legacy preset dir 删除失败（不影响使用）：${e.message}`);
  }
}

/**
 * 岗位技能库（2026-10-10，"数字员工"落地）：
 * 仓库里的 `dsh/skills/<name>/SKILL.md` → `~/.dsh/skills/<name>/SKILL.md`。
 *
 * 为什么放仓库里再同步：技能是"这个岗位怎么干活"的知识（改桥接的流程、排查顺序、
 * DSH 插件准入三问、学习链刷新四步），必须跟代码一起版本化、一起 review；
 * 而 DSH 只扫 `~/.dsh/skills`（用户级）和 `<项目>/.dsh/skills`。
 * 放用户级而不是项目级，是为了**不给她加每轮成本**：她的 preset 没有 skill 工具
 * （`qq-tool-restrict` 白名单里没有），所以技能目录对她等于不存在。
 */
function installSkills() {
  const src = path.join(REPO_ROOT, 'dsh', 'skills');
  if (!fs.existsSync(src)) { log('skills source not found, skip'); return; }
  const dest = path.join(DSH_HOME, 'skills');
  ensureDir(dest);
  // 逐个技能目录同步（不用整体覆盖：万一 ~/.dsh/skills 里还有别的手工技能，别删人家的）
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(src, entry.name);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
    fs.cpSync(from, path.join(dest, entry.name), { recursive: true, force: true });
    n += 1;
  }
  log(`skills installed: ${n} 个 → ${dest}`);
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 由桥接托管的 MCP 条目 id：脚本对这几个 id 拥有所有权，可安全地按 id 增删。
const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'mcp-ow-stats', 'mcp-ow-cn-stats', 'mcp-cs-5e-stats', 'mcp-cs-wmpvp-stats'];

function mcpEntries() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
    'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
    'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
    // 守望先锋2 战绩查询（OverFast）；一次查询要打两次远端，给足超时。
    'mcp-ow-stats': { serverName: 'ow-stats', script: path.join(REPO_ROOT, 'src', 'mcp-ow-stats.js'), toolCallTimeoutMs: 120000 },
    // 守望先锋国服战绩（本地 Overstats -> 网易大神）；上游可能要排队，超时给足。
    'mcp-ow-cn-stats': { serverName: 'ow-cn-stats', script: path.join(REPO_ROOT, 'src', 'mcp-ow-cn-stats.js'), toolCallTimeoutMs: 150000 },
    // CS（5E 平台）战绩查询；也是多次串行请求。
    'mcp-cs-5e-stats': { serverName: 'cs-5e-stats', script: path.join(REPO_ROOT, 'src', 'mcp-cs-5e-stats.js'), toolCallTimeoutMs: 120000 },
    // CS（完美平台）战绩查询；搜索免认证，战绩需 token，超时同样给足。
    'mcp-cs-wmpvp-stats': { serverName: 'cs-wmpvp-stats', script: path.join(REPO_ROOT, 'src', 'mcp-cs-wmpvp-stats.js'), toolCallTimeoutMs: 120000 },
  };
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const [id, s] of Object.entries(servers)) {
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (!MANAGED_MCP_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries();
  return { patchFile, original, text, removed };
}

function patchCordis({ patchFile, original, text, removed }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    try { fs.writeFileSync(`${patchFile}.qq-bridge.bak`, original, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${MANAGED_MCP_IDS.length} 条）`);
}

/**
 * 把一个仓库目录以 symlink/junction 挂到 `$DSH_HOME/plugins/<name>`，供 profile 用 `link:` 依赖引用
 * （DSH 启动时才解析得到）。已存在且指向本仓库 → 保持不动；指向别处/失效 → 重建；
 * 存在但不是链接 → 直接报错让人处理（不擅自删别人的目录）。
 */
function ensureLink(repoDir, linkPath, label) {
  if (!fs.existsSync(repoDir)) fatal(`${label} not found: ${repoDir}`);
  ensureDir(path.dirname(linkPath));

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect ${label} link: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} path already exists and is not a symlink/junction: ${linkPath}. Please remove it manually or move it out of the way, then rerun.`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(repoDir);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`${label} link already exists and points to this repo: ${linkPath}`);
      return linkPath;
    }
    log(`${label} link exists but points elsewhere/broken, recreating: ${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(repoDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(repoDir, linkPath, 'dir');
    }
    log(`${label} link created: ${linkPath}`);
  } catch (e) {
    fatal(`failed to create ${label} link: ${e.message}`);
  }
  return linkPath;
}

function ensurePluginLink() {
  return ensureLink(
    path.join(REPO_ROOT, 'plugins', 'qq-mode-console'),
    path.join(DSH_HOME, 'plugins', 'qq-mode-console'),
    'plugin',
  );
}

function ensurePresetBundleLink() {
  return ensureLink(PRESET_BUNDLE_DIR, path.join(DSH_HOME, 'plugins', PRESET_BUNDLE_NAME), 'preset bundle');
}

function patchProfilePackage(pluginLink, presetBundleLink) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  // 两个 bundle 都用同一套机制注册：link: 依赖 + bundles 清单里的一条。
  // qq-agent-presets 是 preset 声明（DSH 0.2.0 起 preset 只能这样装），qq-mode-console 是控制台插件。
  const links = [
    { name: 'qq-mode-console', link: pluginLink },
    { name: PRESET_BUNDLE_NAME, link: presetBundleLink },
  ];
  for (const { name, link } of links) {
    const linkVal = `link:${link.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json dependency ${name} -> ${linkVal}`);
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle added: ${name}`);
    }
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console / qq-agent-presets 以 link: 依赖注册进 profile package.json 后，DSH 首次启动
// 需要先安装一次才能解析这些 bundle（否则 cold start 报 "cannot resolve profile bundle"）。
//
// 为什么优先直接跑 DSH 自己的 bin.js 而不是 `cmd /c dsh.cmd`（2026-10-10 踩到）：
// npm 全局目录对"交出去的 cmd.exe 子进程"不一定可见 —— 本仓库 dsh-guard.bat 的注释里就写着同一句话
// （"the npm global dir is not reliably visible to the cmd.exe child we hand off to"）。
// 实测：CMD 方式一直报 `'dsh.cmd' 不是内部或外部命令`、退出码 1，而这个失败只被记成一行日志，
// 于是"profile bundle 安装"这一步长期**静默失败**，直到升级后 preset 不生效才暴露。
// 直接 node <dsh>/lib/bin.js 不需要 PATH，也没有 cmd 的引号/变量展开坑。
//
// 判定成功也不看退出码，而是看**结果**：profile 的 node_modules 里那两个链接在不在。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return false;
  }
  const windows = process.platform === 'win32';
  const npmRoot = windows ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm') : '';
  const dshBin = windows ? path.join(npmRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '';
  let r;
  if (windows && fs.existsSync(dshBin)) {
    r = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', PROFILE, 'install'], {
      encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
  } else {
    // 回退路径（非 Windows、或找不到 bin.js）：沿用原来的 cmd + 环境变量展开写法
    const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
    const args = windows
      ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
      : ['plugin', '--profile', PROFILE, 'install'];
    r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
    });
  }
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
  } else if (r.status !== 0) {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
  // 退出码只当线索，真正判据是**结果**：profile 的 node_modules 里两个 bundle 链接在不在。
  // （cmd 回退路径的失败就表现为"退出码 0 但什么都没装"，只信退出码会继续静默失败。）
  const missing = ['qq-mode-console', PRESET_BUNDLE_NAME].filter((name) => (
    !fs.existsSync(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', name))
  ));
  if (!missing.length) {
    log(`dsh plugin --profile ${PROFILE} install: OK（links present: qq-mode-console / ${PRESET_BUNDLE_NAME}）`);
    return true;
  }
  log(`⚠️ profile bundle 没装好，缺链接：${missing.join(', ')}`);
  log(`   请手动执行：dsh plugin --profile ${PROFILE} install（否则 DSH 启动会报 cannot resolve profile bundle）`);
  return false;
}

// Validate the existing YAML before changing any presets or configuration.
const cordisPatch = prepareCordisPatch();
buildPresetBundle();
installSkills();
patchCordis(cordisPatch);
const pluginLink = ensurePluginLink();
const presetBundleLink = ensurePresetBundleLink();
patchProfilePackage(pluginLink, presetBundleLink);
ensureLocalModeFile();
// 旧目录只在 bundle 安装成功之后才删：安装失败时至少还留着 0.1.5 时代的退路
if (autoInstallProfileBundles()) {
  removeLegacyPresetDirs();
} else {
  // 明确说一句：旧目录这次**是故意留着的**。否则排查时会看到"文档说旧目录还在=没装成功"，
  // 但这次失败原因其实是"没跑安装"（例如离线准备时用了 QQ_BRIDGE_SKIP_DSH_INSTALL=1）。
  log('legacy preset dir（若存在）本次保留：bundle 未安装成功/被跳过时不删退路');
}
log('Done. Please restart DSH (or reload the profile) for the new presets/MCP to take effect.');
