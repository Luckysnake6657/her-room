// 国服战绩功能的最终自检：凭据、上游、MCP 注册、白名单、服务状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仓库根：所有"查 preset 逻辑"的路径都相对它解析。
// 为什么不再写死 C:/Users/zjin6/...：那台机器的家目录一换（或换机器）整个检查就失效，
// 而且 DSH 0.2.0 起 preset 的权威位置已经从 ~/.dsh/.agent-presets/ 变成仓库里的手写源。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_BUNDLE = 'qq-agent-presets';

const ok = (b) => (b ? '✅' : '❌');
const line = (s) => console.log('   ' + s);

console.log('════ 国服战绩功能 · 最终检查 ════\n');

// 1) 凭据
console.log('【1】凭据（config.py）');
try {
  const c = fs.readFileSync('D:/Overstats/Overstats-main/config/config.py', 'utf8');
  const role = c.match(/"role_id":\s*(\d+)/);
  const tok = c.match(/"token":\s*"([^"]+)"/);
  line('role_id: ' + (role ? role[1] : '(未配置)'));
  line('token  : ' + (tok ? `${tok[1].slice(0, 6)}…(${tok[1].length}位)` : '(未配置)'));
  line('占位符残留: ' + (c.includes('replace-with-your-token') ? '⚠️ 有' : '✅ 无'));
} catch (e) {
  line('❌ 读不到 config.py: ' + e.message);
}
console.log('');

// 2) token 文件是否还存在（可以删了）
console.log('【2】临时 token 文件');
const tf = 'D:/Overstats/_token.txt';
if (fs.existsSync(tf)) {
  line('⚠️ 仍存在（值已写入 config.py，建议删掉）：' + tf);
} else {
  line('✅ 已删除');
}
console.log('');

// 3) 上游服务
console.log('【3】Overstats 服务（127.0.0.1:18080）');
try {
  const r = await fetch('http://127.0.0.1:18080/healthz', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  line('✅ ' + JSON.stringify(j));
} catch (e) {
  line('❌ ' + e.message);
}
console.log('');

// 4) DSH MCP 条目
console.log('【4】DSH 的 MCP 条目');
try {
  const y = fs.readFileSync('C:/Users/zjin6/.dsh/profiles/web/cordis.patch.yml', 'utf8');
  const names = [...y.matchAll(/serverName:\s*(\S+)/g)].map((m) => m[1]);
  names.forEach((n) => line('• ' + n));
  line('共 ' + names.length + ' 个，含 ow-cn-stats: ' + ok(names.includes('ow-cn-stats')));
} catch (e) {
  line('❌ ' + e.message);
}
console.log('');

// 5) guard 白名单
// 查 preset 逻辑读**手写源** dsh/agent-presets/<preset>/qq-tool-restrict.mjs（相对仓库根）。
// 旧写法读 ~/.dsh/.agent-presets/<preset>/…：DSH 0.2.0 起那个目录已经没有任何代码读取，
// 文件可能是 0.1.5 时代的化石 —— 拿它来判"白名单对不对"会给出与实际运行相反的结论。
console.log('【5】guard 白名单（两套 preset，读仓库手写源）');
for (const preset of ['qq-chat-v2', 'qq-chat']) {
  const p = path.join(REPO, 'dsh', 'agent-presets', preset, 'qq-tool-restrict.mjs');
  try {
    const { apply } = await import(pathToFileURL(p).href);
    const guards = [];
    apply({ tools: { restrict() {}, guard(f) { guards.push(f); } } });
    const g = guards[0];
    const allow = (n) => g({ name: n }) === undefined;
    line(
      `[${preset}] cn=${ok(allow('mcp__ow-cn-stats__query'))} ` +
        `intl=${ok(allow('mcp__ow-stats__query'))} ` +
        `cs5e=${ok(allow('mcp__cs-5e-stats__query'))} ` +
        `wmpvp=${ok(allow('mcp__cs-wmpvp-stats__query'))} ` +
        `pwsh=${ok(!allow('pwsh'))}拒绝 dev=${ok(!allow('dev_build_plugin'))}拒绝`
    );
  } catch (e) {
    line(`[${preset}] ❌ ${e.message}`);
  }
}
// 「装上去的那份」在 DSH 侧是 ~/.dsh/plugins/qq-agent-presets/qq-tool-restrict.mjs
// （profile 用 link: 依赖解析，Windows 上是 junction，所以走 realpath 穿透）。
// 手写源和装上去的副本漂移 = 群里实际跑的还是旧白名单：两边都报，别只看源。
try {
  const installed = fs.realpathSync(path.join(os.homedir(), '.dsh', 'plugins', PRESET_BUNDLE, 'qq-tool-restrict.mjs'));
  const handwritten = fs.readFileSync(path.join(REPO, 'dsh', 'agent-presets', 'qq-chat', 'qq-tool-restrict.mjs'));
  line(`装上去的那份 ${ok(fs.readFileSync(installed).equals(handwritten))}与手写源一致 → ${installed}`);
} catch (e) {
  line(`⚠️ 读不到装上去的 ${PRESET_BUNDLE} bundle（${e.message}）：跑 node scripts/setup-dsh.mjs 装一次`);
}
console.log('');

// 6) 人格卡
console.log('【6】人格卡');
const role = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
const limit = (() => {
  try {
    const v = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, '')).socialV2?.roleCard?.maxChars;
    if (v === 0) return Infinity;
    return Number.isFinite(Number(v)) && Number(v) >= 1000 ? Math.round(Number(v)) : 8000;
  } catch { return 8000; }
})();
line(`字符数 ${role.length}/${limit === Infinity ? '不截断' : limit} ${ok(role.length <= limit)}`);
line('含国服说明: ' + ok(role.includes('ow-cn-stats')));
console.log('');

// 7) 进程
console.log('【7】进程');
try {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | ForEach-Object { \'python PID \' + $_.ProcessId + \' 启动 \' + $_.CreationDate.ToString(\'HH:mm:ss\') }"',
    { encoding: 'utf8' }
  ).trim();
  line(out || '(没有 python 进程)');
} catch {
  line('(无法查询 python 进程)');
}
console.log('');

console.log('════ 检查结束 ════');
