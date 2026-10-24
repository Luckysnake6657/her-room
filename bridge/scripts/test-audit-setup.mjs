// Offline integration tests. Every setup invocation receives its own repository and DSH_HOME.
// QQ_BRIDGE_TEST_YAML_ROOT is only useful when auditing with an intentionally read-only
// node_modules tree; normal installs resolve the declared js-yaml dependency directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserRoot = process.env.QQ_BRIDGE_TEST_YAML_ROOT || path.dirname(require.resolve('js-yaml/package.json'));
const yaml = (await import(pathToFileURL(path.join(parserRoot, 'dist/js-yaml.mjs')).href)).default;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-audit-setup-'));
let failures = 0;

function fixture(name, patch = '') {
  const base = path.join(sandbox, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-dsh.mjs'), path.join(repo, 'scripts/setup-dsh.mjs'));
  // fixture 里也要有一份 package.json：0.2.0 起 buildPresetBundle() 从它读版本号写进 bundle
  // （版本身份一致性的单一来源）。这份 fixture 早于 bundle 出现，漏了它 setup 会 ENOENT 退出。
  fs.copyFileSync(path.join(root, 'package.json'), path.join(repo, 'package.json'));
  fs.cpSync(path.join(root, 'dsh'), path.join(repo, 'dsh'), { recursive: true });
  fs.cpSync(path.join(root, 'plugins'), path.join(repo, 'plugins'), { recursive: true });
  fs.cpSync(parserRoot, path.join(repo, 'node_modules/js-yaml'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const patchFile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(patchFile, patch);
  fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  // APPDATA 指向 fixture 内的空目录：setup-dsh.mjs 现在优先直接跑 DSH 的
  // `<APPDATA>/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`，而这个文件在装了 DSH 的机器上
  // 真实存在 —— 不挡住它，fixture 就会去调用**真实的 dsh CLI**（测试变成有副作用、且与
  // "调用 npm 的 .cmd shim"这条被测行为无关）。指到空目录后只会走 cmd/dsh.cmd 回退路径。
  const appData = path.join(base, 'appdata-empty');
  fs.mkdirSync(appData, { recursive: true });
  Object.assign(env, { PATH: path.dirname(process.execPath), DSH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: appData, QQ_BRIDGE_SKIP_DSH_INSTALL: '1' });
  const run = (profile = 'web', extraEnv = {}) => spawnSync(process.execPath, [path.join(repo, 'scripts/setup-dsh.mjs'), profile], {
    env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8', timeout: 15000,
  });
  return { repo, home, patchFile, run };
}

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  test('shared inserts, quoted IDs, flow YAML and unrelated nested arrays survive repeat setup', () => {
    const source = `# user patch\n- insert:\n    - id: mcp-snowluma\n      name: old\n    - id: custom\n      name: custom-plugin\n      config:\n        empty:\n          []\n        nested:\n          - id: mcp-snowluma-host\n            value: keep\n- insert:\n    - id: 'mcp-snowluma-host' # previous setup\n      name: old\n- {insert: [{id: mcp-web-search-safe, name: old}]}\n`;
    const f = fixture('structured', source);
    const originalCustom = yaml.load(source)[0].insert[1];
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const doc = yaml.load(fs.readFileSync(f.patchFile, 'utf8'));
      const entries = doc.flatMap((op) => op.insert || []);
      assert.deepEqual(entries.find((entry) => entry.id === 'custom'), originalCustom);
      for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
        assert.equal(entries.filter((entry) => entry.id === id).length, 1, `${id} duplicate`);
      }
      assert.equal(entries.find((entry) => entry.id === 'mcp-snowluma').config.toolCallTimeoutMs, 725000);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json')));
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing', 'qq-mode-console', 'qq-agent-presets']);
    // DSH 0.2.0 起 preset 只有 bundle 一种安装形式（$HOME/.agent-presets/<id>/ 已无人读取）。
    // 所以"装上了"的可观测证据是这三样：仓库里的生成物、~/.dsh/plugins 的链接、profile 的注册。
    const bundleDir = path.join(f.repo, 'dsh/presets/qq-agent-presets');
    assert.equal(pkg.dependencies['qq-agent-presets'], `link:${path.join(f.home, 'plugins/qq-agent-presets').replace(/\\/g, '/')}`);
    assert.equal(fs.realpathSync(path.join(f.home, 'plugins/qq-agent-presets')), fs.realpathSync(bundleDir));
    for (const name of ['cordis.patch.yml', 'package.json']) {
      assert.ok(fs.existsSync(path.join(bundleDir, name)), `bundle 生成物缺失: ${name}`);
    }
    // 反面：setup 不允许再往旧目录里写东西（旧目录只会在安装成功后删除，从不重建）
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false, '不应重建 $HOME/.agent-presets');
  });

  test('legacy root [] is repaired without altering literal strings', () => {
    const f = fixture('legacy', `[]\n- insert:\n    - id: custom\n      name: custom\n      config:\n        text: |\n          []\n          keep me\n`);
    // 预置一份 0.1.5 时代的 preset 目录。这个 fixture 用 QQ_BRIDGE_SKIP_DSH_INSTALL=1 跳过 bundle
    // 安装，而删除旧目录**只在安装成功后**发生（失败时留退路），所以它必须原样留着 ——
    // 这是"装好才删"这条设计的另一半保证（另一半见 test-setup-dsh-idempotent.mjs）。
    const legacyDir = path.join(f.home, '.agent-presets/qq-chat');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'agent.cordis.yml'), '# legacy\n');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(yaml.load(fs.readFileSync(f.patchFile, 'utf8'))[0].insert[0].config.text, '[]\nkeep me\n');
    assert.equal(fs.existsSync(path.join(legacyDir, 'agent.cordis.yml')), true, '安装被跳过时不该删旧目录');
  });

  test('malformed patch fails before replacing user configuration or presets', () => {
    const source = '- insert: [broken\n';
    const f = fixture('malformed', source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), source);
    // 失败必须"什么都没动"。0.2.0 的超集证据链：旧目录不会被（重）建，新 bundle 不会被链接，
    // profile 不会被注册 —— 只断言旧目录的话，"失败但已经注册了半个 bundle"会漏过去。
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
    assert.equal(fs.existsSync(path.join(f.home, 'plugins/qq-agent-presets')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json'))).dsh.profile.bundles, ['existing']);
  });

  test('profile traversal is rejected before filesystem changes', () => {
    const f = fixture('traversal');
    const result = f.run('../../escape');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'escape')), false);
    assert.equal(fs.existsSync(path.join(f.home, '.agent-presets')), false);
    assert.equal(fs.existsSync(path.join(f.home, 'plugins/qq-agent-presets')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json'))).dsh.profile.bundles, ['existing']);
  });

  test('existing mode, DSH settings and non-link plugin directory remain untouched', () => {
    const f = fixture('preserve', '[]\n');
    fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
    const mode = '{"mode":"closed-agent","closedAgentPreset":"custom"}\n';
    fs.writeFileSync(path.join(f.repo, 'state/mode.json'), mode);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/mode.json'), 'utf8'), mode);
    const blocker = fixture('plugin-conflict', '[]\n');
    fs.mkdirSync(path.join(blocker.home, 'plugins/qq-mode-console'), { recursive: true });
    fs.writeFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'keep');
    assert.notEqual(blocker.run().status, 0);
    assert.equal(fs.readFileSync(path.join(blocker.home, 'plugins/qq-mode-console/keep.txt'), 'utf8'), 'keep');
    // 撞上非链接目录就 fatal：此时 preset bundle 的链接与注册都还没发生（顺序上它在插件链接之后），
    // 不许"装了一半"——否则 DSH 会报 half-registered 的 bundle 解析错误，比直接失败更难查。
    assert.equal(fs.existsSync(path.join(blocker.home, 'plugins/qq-agent-presets')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(blocker.home, 'profiles/web/package.json'))).dsh.profile.bundles, ['existing']);
  });

  if (process.platform === 'win32') test('Windows runs the npm .cmd shim with literal profile arguments', () => {
    const f = fixture('windows-cli');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const capture = path.join(bin, 'called.json');
    const cli = path.join(bin, 'fake-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), home: process.env.DSH_HOME}));\n`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const profile = 'test&name%CD%!';
    const result = f.run(profile, {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0', QQ_TEST_CAPTURE: capture,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(capture), `CLI was not invoked: ${result.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), { args: ['plugin', '--profile', profile, 'install'], home: f.home });
  });
} finally {
  // Resolve the exact fixture root before removing this test's temporary files.
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
