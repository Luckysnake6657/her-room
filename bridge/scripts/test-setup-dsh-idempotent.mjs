// setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次，断言
//   ① 不会产生重复的 MCP 条目 id（DSH 遇到重复 loader entry id 会启动崩溃）；
//   ② 0.2.0 的 preset **bundle** 生成物两次内容一致（生成器必须确定性）；
//   ③ profile 把 bundle 注册正确（link: 依赖 + bundles 清单 + node_modules 链接）；
//   ④ 0.1.5 时代留下的 $DSH_HOME/.agent-presets 在安装成功后已被删掉。
//
// 为什么断言 ②③④（2026-10-10 换口径）：0.2.0 起 preset 不再是
// `$DSH_HOME/.agent-presets/<id>/` 目录（已无人读取），而是 bundle 声明。只断言旧目录里
// 有文件的话，脚本"打印安装成功但 preset 根本没进 DSH 清单"这个真实故障不会被发现。
//
// 隔离方式：DSH_HOME 指向仓库内的一次性目录 state/setup-dsh-test-home；PATH 只留 node 与一个
// **假 dsh 启动器**；APPDATA 指向空目录，让 setup 找不到机器上真实安装的
// `@deepseek-ai/dsh/lib/bin.js`，从而只走假启动器那条路。这样测试永远不会真的去跑
// `dsh plugin install` / pnpm（旧版这里会落到真实 DSH 的 bin.js 上，几毫秒退出码 1，
// 看着"跑了"，其实什么都没装，还多了一次对真实安装目录的调用）。
// 假启动器只做一件事：在 profile 的 node_modules 里建出两个 bundle 链接 —— 因为
// setup-dsh.mjs 判定安装成功看的就是**这个结果**，不看退出码。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpHome = path.join(ROOT, 'state', 'setup-dsh-test-home');
const PRESET_IDS = ['qq-chat', 'qq-chat-v2'];
const BUNDLE_NAME = 'qq-agent-presets';
const BUNDLE_DIR = path.join(ROOT, 'dsh', 'presets', BUNDLE_NAME);
// 生成物清单（改了 buildPresetBundle 的输出，这里也要跟着改）
const BUNDLE_FILES = ['cordis.patch.yml', 'package.json', 'qq-tool-restrict.mjs'];
// 两个 bundle 都必须出现在 profile 的 node_modules 里：preset bundle + 控制台插件
const EXPECTED_LINKS = [BUNDLE_NAME, 'qq-mode-console'];

fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

// 预置一个「历史版本」patch：无 BEGIN/END 标记、含空的 [] 根节点、只挂了 2 个 MCP
const legacyPatch = `# legacy profile patch
[]
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-snowluma-safe.js'

- insert:
    - id: mcp-snowluma-host
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma-host
        transport: stdio
        command: node
        args:
          - 'old/path/mcp-host-server.js'
`;
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), legacyPatch, 'utf8');
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-approval-toast': 'file:C:/x/dsh-approval-toast' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-approval-toast'] } },
}, null, 2), 'utf8');

// 预置 0.1.5 时代留下的 preset 目录：bundle 装好之后它必须消失（0.2.0 已不读它，
// 留着只会制造"我改了这里怎么不生效"的坑）
for (const id of PRESET_IDS) {
  fs.mkdirSync(path.join(tmpHome, '.agent-presets', id), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.agent-presets', id, 'agent.cordis.yml'), '# legacy preset copy\n', 'utf8');
}

// 用指向本仓库插件的 junction 冒充上一轮已安装的插件链接（与真实安装形态一致），
// 这样脚本会走「已存在且指向本仓库 → 跳过」的正常分支。
fs.symlinkSync(path.join(ROOT, 'plugins', 'qq-mode-console'), path.join(tmpHome, 'plugins', 'qq-mode-console'), 'junction');

// ── 假 dsh 启动器（见文件头注释） ────────────────────────────────────────────
const binDir = path.join(tmpHome, 'fake-bin');
const emptyAppData = path.join(tmpHome, 'empty-appdata');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(emptyAppData, { recursive: true });
const fakeCli = path.join(binDir, 'fake-dsh.mjs');
const captureFile = path.join(tmpHome, 'fake-dsh-calls.jsonl');
fs.writeFileSync(fakeCli, [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "// 冒充 dsh plugin install：真实安装的**结果**就是 profile 的 node_modules 里出现两个 bundle 链接，",
  "// setup-dsh.mjs 正是按这个结果判定成功（它不信退出码 —— 历史上有过'退出码 0 却什么都没装'）。",
  "const home = process.env.DSH_HOME;",
  "const profile = process.env.QQ_BRIDGE_SETUP_PROFILE;",
  "const nm = path.join(home, 'profiles', profile, 'node_modules');",
  "fs.mkdirSync(nm, { recursive: true });",
  "for (const [name, target] of [['qq-mode-console', process.env.QQ_TEST_PLUGIN_SRC], ['qq-agent-presets', process.env.QQ_TEST_BUNDLE_SRC]]) {",
  "  const link = path.join(nm, name);",
  "  // 只在不存在时建：测试目录每次都是新的，不删。绝不 rmSync 一个 junction ——",
  "  // Windows 上递归删 junction 有跟穿到目标目录的风险，而目标就是本仓库的目录。",
  "  if (!fs.existsSync(link)) fs.symlinkSync(target, link, 'junction');",
  "}",
  "fs.appendFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), profile }) + '\\n');",
  '',
].join('\n'), 'utf8');
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${fakeCli}" %*\r\n`);
} else {
  const shim = path.join(binDir, 'dsh');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

function runSetup(label) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web'], {
    // PATH 只留假启动器与 node（真实 dsh 不可见）；APPDATA 指向空目录 → setup 找不到真实的
    // dsh lib/bin.js，只会调用我们的假启动器。DSH_HOME 指向一次性目录 → 不碰机器上的 ~/.dsh。
    env: {
      ...process.env,
      DSH_HOME: tmpHome,
      PATH: [binDir, path.dirname(process.execPath)].join(path.delimiter),
      APPDATA: emptyAppData,
      QQ_TEST_CAPTURE: captureFile,
      QQ_TEST_PLUGIN_SRC: path.join(ROOT, 'plugins', 'qq-mode-console'),
      QQ_TEST_BUNDLE_SRC: BUNDLE_DIR,
    },
    encoding: 'utf8',
    cwd: ROOT,
  });
  console.log(`\n--- ${label} (exit=${r.status}${r.error ? ' err=' + r.error.message : ''}) ---`);
  console.log((r.stdout || '').trim() || '(no stdout)');
  if (r.stderr?.trim()) console.log('STDERR:', r.stderr.trim());
  return r;
}

const norm = (s) => s.replace(/\r\n/g, '\n');
const snapshotBundle = () => Object.fromEntries(
  BUNDLE_FILES.map((f) => [f, norm(fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8'))]),
);

runSetup('第 1 次运行');
const afterFirst = snapshotBundle();
runSetup('第 2 次运行');
const afterSecond = snapshotBundle();

const finalPatch = fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
let failed = 0;
const assert = (ok, msg) => { if (!ok) failed += 1; console.log(`${ok ? '✅' : '❌'} ${msg}`); };

// 断言 1：每个托管 id 恰好出现一次
for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
  const n = finalPatch.split('\n').filter((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l)).length;
  assert(n === 1, `id ${id} 出现 ${n} 次（期望 1）`);
}

// 断言 2：旧路径已被替换为本仓库路径
const hasOldPath = finalPatch.includes('old/path/');
assert(!hasOldPath, `旧脚本路径已清除（old/path 出现=${hasOldPath}）`);

// 断言 3：独立成行的 [] 已被剥离
const hasBareArray = /^[ \t]*\[\][ \t]*$/m.test(finalPatch);
assert(!hasBareArray, '无独立成行的空数组 []');

// 断言 4：YAML 可解析且顶层是数组
const YAML = await import(pathToFileURL(path.join(dshModulesDir(), 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;
let doc;
try { doc = yaml.load(finalPatch); } catch (e) {
  console.log(`❌ YAML 解析失败: ${e.message}`); failed += 1;
}
if (doc) {
  assert(Array.isArray(doc), `YAML 顶层为数组（${Array.isArray(doc) ? doc.length + ' 项' : typeof doc}）`);
  const ids = doc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
  console.log(`   解析出的 MCP id: ${ids.join(', ')}`);
}

// 断言 5：profile package.json 注册正确 —— 两个 bundle 都在 bundles 清单里，且没破坏别人的
const pkg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;
assert(bundles.includes(BUNDLE_NAME) && bundles.includes('qq-mode-console') && bundles.includes('dsh-approval-toast'),
  `profile bundles 正确: ${bundles.join(', ')}`);
assert(`link:${path.join(tmpHome, 'plugins', BUNDLE_NAME).replace(/\\/g, '/')}` === pkg.dependencies[BUNDLE_NAME],
  `dependencies['${BUNDLE_NAME}'] 指向本临时 home 的链接（实际 ${pkg.dependencies[BUNDLE_NAME]}）`);
// 链接确实建出来了，并且指回仓库的生成物目录（realpath 会解析 junction）
const linkPath = path.join(tmpHome, 'plugins', BUNDLE_NAME);
assert(fs.existsSync(linkPath) && fs.realpathSync(linkPath) === fs.realpathSync(BUNDLE_DIR),
  `~/.dsh/plugins/${BUNDLE_NAME} 指向 ${BUNDLE_DIR}`);

// 断言 6：生成物两次运行内容一致（生成器确定性；手写源没变就不该有 diff）
const drift = BUNDLE_FILES.filter((f) => afterFirst[f] !== afterSecond[f]);
assert(drift.length === 0, `两次运行生成的 bundle 内容一致（不一致的文件: ${drift.join(', ') || '无'}）`);

// 断言 7：生成物内容自洽 —— 两条 preset 声明在；plugins 顶层 id 序列与手写源一致；
// bundle 版本跟着主包；qq-tool-restrict.mjs 是手写源那一份
const bundlePatch = yaml.load(afterSecond['cordis.patch.yml']);
const decls = new Map(bundlePatch.flatMap((op) => op?.insert ?? [])
  .filter((e) => String(e?.id ?? '').startsWith('preset-'))
  .map((e) => [e.config?.id, e]));
for (const p of PRESET_IDS) {
  const genIds = (decls.get(p)?.config?.plugins ?? []).map((e) => e?.id);
  const srcIds = (yaml.load(fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', p, 'agent.cordis.yml'), 'utf8')) ?? []).map((e) => e?.id);
  assert(genIds.length > 0 && genIds.length === srcIds.length && genIds.every((id, i) => id === srcIds[i]),
    `preset-${p} 的 plugins id 序列与手写源一致（生成物 ${genIds.length} 条 / 手写源 ${srcIds.length} 条）`);
  const restrict = (decls.get(p)?.config?.plugins ?? []).find((e) => e?.id === 'qq-tool-restrict');
  assert(restrict?.name === `${BUNDLE_NAME}/qq-tool-restrict.mjs`,
    `preset-${p} 的 qq-tool-restrict 按包名引用（实际 ${restrict?.name}）`);
}
const repoVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
assert(JSON.parse(afterSecond['package.json']).version === repoVersion,
  `bundle package.json 版本跟随主包（${JSON.parse(afterSecond['package.json']).version} vs ${repoVersion}）`);
assert(afterSecond['qq-tool-restrict.mjs'] === norm(fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', PRESET_IDS[0], 'qq-tool-restrict.mjs'), 'utf8')),
  'bundle 里的 qq-tool-restrict.mjs 与手写源一致');

// 断言 8：旧目录被删掉（bundle 安装成功后才删；失败时留着当退路）
assert(!fs.existsSync(path.join(tmpHome, '.agent-presets')),
  `0.1.5 时代的 $DSH_HOME/.agent-presets 已删除`);

// 断言 9：假启动器被调用过两次，参数正确 —— 证明"自动安装 profile bundle"这一步真的走了，
// 而且是走我们的假启动器（没有碰机器上真实的 dsh）
const calls = fs.existsSync(captureFile)
  ? fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
assert(calls.length === 2 && calls.every((c) => c.profile === 'web' && c.args.join(' ') === 'plugin --profile web install'),
  `假 dsh 启动器被调用 2 次且参数正确（实际 ${calls.length} 次: ${calls.map((c) => c.args.join(' ')).join(' | ') || '无'}）`);
assert(EXPECTED_LINKS.every((n) => fs.existsSync(path.join(tmpHome, 'profiles', 'web', 'node_modules', n))),
  `profile node_modules 里两个 bundle 链接都在（${EXPECTED_LINKS.join(' / ')}）`);

console.log(failed === 0 ? '\n✅ setup-dsh.mjs 幂等性测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
