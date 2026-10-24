// 一键自检：静态检查 + 启动链路检查 + 运行时健康 + 测试套件。
//
// 为什么要一个统一入口：这套系统是"桥接 + SnowLuma + DSH + Overstats + 控制台"
// 拼起来的，出问题时可能在任何一层。以前只能靠一条条命令手查，
// 而且我（AI）手查时容易犯两类错——用内联 `node -e` 被 shell 转义搞坏、
// 或者凭印象断言"应该没问题"。这个脚本把这些检查固定下来，可重复、可回归。
//
// 用法：
//   node scripts/self-check.mjs            # 全部检查
//   node scripts/self-check.mjs --fast     # 跳过测试套件（只做静态 + 运行时）
//   node scripts/self-check.mjs --json     # 输出 JSON（给别的程序用）
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConsoleToken, consoleTokenSource } from './lib/console-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const FAST = args.has('--fast');
const AS_JSON = args.has('--json');

/**
 * 「规则文本」的**并集**：结构在 `src/bridge.js`（谁被拼进 base、顺序如何），
 * 文案在 `src/prompt-rules.js`（2026-10-02 从 buildWakePromptV2 里抽出来的）。
 *
 * 判断"某条规矩还在不在"要用这个并集 —— 只看 bridge.js 会在重构后误报"规则被删了"
 * （实测：抽完当天 11 条假报警），只看 prompt-rules.js 又漏掉写在桥接里的小段规则。
 * 反过来，判断"有没有被拼进每轮提示词""顺序对不对"这类**结构**问题，仍然只查 bridge.js。
 */
const RULE_TEXT = (() => {
  const parts = [];
  for (const f of ['src/bridge.js', 'src/prompt-rules.js']) {
    try { parts.push(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { /* 缺文件就让相关检查自己报 */ }
  }
  return parts.join('\n');
})();

const results = [];
function ok(section, name, detail = '') { results.push({ section, name, level: 'ok', detail }); }
function warn(section, name, detail = '') { results.push({ section, name, level: 'warn', detail }); }
function bad(section, name, detail = '') { results.push({ section, name, level: 'bad', detail }); }
function info(section, name, detail = '') { results.push({ section, name, level: 'info', detail }); }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// ── 1. 语法 ────────────────────────────────────────────────────────────────
function checkSyntax() {
  const files = [];
  for (const dir of ['src', 'scripts']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(js|mjs)$/.test(f)) files.push(path.join(abs, f));
    }
  }
  let failed = 0;
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', timeout: 30000 });
    } catch (error) {
      failed++;
      bad('语法', path.relative(ROOT, f), String(error.stderr ?? error.message).split('\n')[0].slice(0, 160));
    }
  }
  if (!failed) ok('语法', `${files.length} 个源文件`, 'node --check 全部通过');
}

// ── 2. 死代码：定义了却从未被引用的函数 ───────────────────────────────────
// 只做"顶层/嵌套 function 声明 + 全文件引用计数"，故意保守：
// 计数时排除注释与字符串里的同名出现会更好，但那样容易漏报真死代码；
// 这里宁可少报也不误报——只在"整个文件里除了声明处没有第二次出现"时才报。
function checkDeadCode() {
  const targets = ['src/bridge.js', 'src/mcp-snowluma-safe.js', 'src/dsh-client.js'];
  for (const rel of targets) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    const dead = [];
    for (const name of names) {
      const escaped = name.replace(/[$]/g, '\\$');
      const count = (src.match(new RegExp(`\\b${escaped}\\b`, 'g')) ?? []).length;
      if (count <= 1) dead.push(name);
    }
    if (dead.length) warn('死代码', rel, `定义了但没被引用：${dead.join(', ')}`);
    else ok('死代码', rel, '没有发现未引用的函数声明');
  }
}

// ── 3. 启动链路：外部依赖路径是否真的存在 ─────────────────────────────────
function checkScriptEncoding() {
  // 编码规则（.bat 不能有 BOM+必须 ASCII+CRLF；.ps1 中文必须带 BOM）只写在
  // scripts/normalize-scripts.mjs 里一处，这里调用它的 --check 模式，
  // 免得两处规则各写一遍、改了一处忘了另一处。
  const script = path.join(ROOT, 'scripts', 'normalize-scripts.mjs');
  if (!fs.existsSync(script)) { warn('脚本编码', 'normalize-scripts.mjs 不存在', '无法校验 .bat/.ps1 编码'); return; }
  try {
    // third_party/ 是下载来的第三方源码（RVC/GPT-SoVITS 等），不适用我们的脚本编码规范
    const out = execFileSync(process.execPath, [script, '--check'], { cwd: ROOT, stdio: 'pipe', timeout: 60000, encoding: 'utf8' });
    ok('脚本编码', '.bat/.cmd 与 .ps1', String(out).trim().split('\n').slice(-1)[0].slice(0, 100));
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '');
    const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('❌'));
    bad('脚本编码', '有文件不符合约定', lines.slice(0, 4).join(' | ') || '详见 normalize-scripts.mjs --check');
  }
}

function checkLaunchChain() {
  const required = [
    ['D:\\qq-bridge\\launch-all.bat', '桌面快捷方式的目标'],
    ['D:\\qq-bridge\\scripts\\launch-all.mjs', '一键启动逻辑'],
    ['D:\\qq-bridge\\dsh-guard.bat', 'DSH 必须以它启动（否则读不到 launch token）'],
    ['D:\\qq-bridge\\start.bat', '桥接启动/守护'],
    ['D:\\qq-bridge\\config.json', '主配置'],
    ['D:\\SnowLuma\\launcher.bat', 'SnowLuma 启动器'],
    ['D:\\Overstats\\start-overstats.bat', 'Overstats 启动器']
  ];
  for (const [p, why] of required) {
    if (fs.existsSync(p)) ok('启动链路', p, why);
    else bad('启动链路', p, `缺失（${why}）`);
  }

  // 桌面快捷方式是否还指向一键启动（用户会从桌面点）
  try {
    const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop');
    const candidates = [];
    for (const d of ['D:\\桌面', desktop]) {
      if (d && fs.existsSync(d)) {
        for (const f of fs.readdirSync(d)) if (f.endsWith('.lnk')) candidates.push(f);
      }
    }
    if (!candidates.length) warn('启动链路', '桌面快捷方式', '没找到任何 .lnk（读不到桌面目录？）');
    else info('启动链路', '桌面 .lnk', candidates.join(', '));
  } catch {}

  // 曾经的重复入口 start-all.bat（不启 Overstats、盲等端口、不自动开控制台）已改写成
  // 转发到 launch-all.bat 的空壳——这里验证它确实只做转发，避免哪天又被改回"自己启一套"。
  const startAll = path.join(ROOT, 'start-all.bat');
  if (fs.existsSync(startAll)) {
    const src = fs.readFileSync(startAll, 'utf8');
    const forwards = /launch-all\.bat/.test(src);
    const launchesOwn = /\bstart\s+"|taskkill|dsh-guard/.test(src);
    if (forwards && !launchesOwn) ok('启动链路', 'start-all.bat', '已收敛为转发到 launch-all.bat');
    else bad('启动链路', 'start-all.bat', '又变成自己启一套了：会导致"从桌面启动"和"跑 launch-all"行为不一致');
  }

  // restart-stack.bat：把"手起的 DSH 换回 guard 模式"固定成一条命令（2026-10-10 那次现场）。
  // 少了 --restart-dsh 它就退化成普通重启（手起的 DSH 依旧不写 token、桥接依旧 401）；
  // 少了 post-restart-check 就没人确认"到底认证上没有"。这两个 flag 是它的全部价值，钉住。
  const restartStack = path.join(ROOT, 'restart-stack.bat');
  if (fs.existsSync(restartStack)) {
    const src = fs.readFileSync(restartStack, 'utf8');
    const killsDsh = /--restart-dsh/.test(src);
    const checks = /post-restart-check\.mjs/.test(src);
    if (killsDsh && checks) ok('启动链路', 'restart-stack.bat', '收 DSH 子树 → guard 重起 → 重启后体检');
    else bad('启动链路', 'restart-stack.bat', `缺少 ${killsDsh ? '' : '--restart-dsh（手起的 DSH 不会被换掉）'}${!killsDsh && !checks ? ' 和 ' : ''}${checks ? '' : 'post-restart-check（没人确认认证结果）'}`);
  }
}

/**
 * 启动冒烟：真的把桥接进程拉起来待几秒，看它会不会立刻崩。
 *
 * 为什么必须有这一项：`node --check` 只查语法，查不出"能过语法检查但一启动就崩"。
 * 实测踩过——`knownSecretTokens()` 引用了 main() 里的 `cfg`，模块作用域根本看不到，
 * 于是最早的几次 log() 就 ReferenceError，桥接启动即死；语法检查却全绿。
 *
 * 只在 3100 没有监听时才跑（否则单实例锁会挡住，而"已在运行"本身就证明它能加载）。
 * 为测试拉起的进程会被杀掉，不留副作用。
 */
async function checkStartupSmoke() {
  if (await portOpen(3100, 800)) { info('启动冒烟', '跳过', '桥接已在运行（能跑起来就说明加载没问题）'); return; }
  const entry = path.join(ROOT, 'src', 'bridge.js');
  if (!fs.existsSync(entry)) { warn('启动冒烟', '找不到 src/bridge.js', ''); return; }
  let child;
  try {
    child = spawn(process.execPath, [entry], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    bad('启动冒烟', '无法启动进程', String(error?.message ?? error));
    return;
  }
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 9000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) {
    try { child.kill('SIGKILL'); } catch {}
    ok('启动冒烟', '桥接能启动', '起了 9 秒没崩（测试进程已结束）');
    return;
  }
  const tail = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
  bad('启动冒烟', '桥接启动即退出', tail.slice(0, 220) || '（没有输出，可能被单实例锁挡住）');
}

// ── 4. 配置漂移：config.json 与 example 的键是否对得上 ─────────────────────
function checkConfigDrift() {
  const cur = readJsonSafe(path.join(ROOT, 'config.json'));
  const ex = readJsonSafe(path.join(ROOT, 'config.example.json'));
  if (!cur || !ex) { warn('配置', 'config.json / config.example.json', '有一个读不出来，跳过漂移检查'); return; }

  const flat = (o, prefix = '') => Object.entries(o ?? {}).flatMap(([k, v]) =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  const curKeys = new Set(flat(cur));
  const exKeys = new Set(flat(ex));

  const missing = [...exKeys].filter((k) => !curKeys.has(k));
  const extra = [...curKeys].filter((k) => !exKeys.has(k));
  if (missing.length) warn('配置', 'config.json 缺少 example 里的键', missing.slice(0, 12).join(', '));
  if (extra.length) info('配置', 'config.json 比 example 多出的键', extra.slice(0, 12).join(', '));
  if (!missing.length && !extra.length) ok('配置', 'config.json 与 example 键一致');

  // 关键值健康度
  const groups = cur?.allow?.groups ?? [];
  // ⚠️ 令牌有两个可能的位置：config.json 里的手动值，或"重新生成"后写进
  // state/console-token 的随机值（那时 config 里的会被清空）。
  // 只看 config.json 会在重新生成后误报"缺失"——实测踩过。
  const token = readConsoleToken();
  if (token) ok('配置', '控制台令牌已设置', `${token.slice(0, 8)}…（长度 ${token.length}，来自 ${consoleTokenSource()}）`);
  else bad('配置', '控制台令牌缺失', 'config.json 和 state/console-token 都没有有效值');
  if (cur?.ownerQQ) ok('配置', 'ownerQQ', String(cur.ownerQQ));
  else bad('配置', 'ownerQQ 缺失', '');
  info('配置', '白名单群', groups.join(', ') || '(空)');
  if (cur?.socialV2?.sticker?.enabled !== false) info('配置', '表情库', '已启用');
  return { groups };
}

// ── 5. 状态文件能否解析（损坏会导致桥接起不来）─────────────────────────────
function checkStateFiles() {
  const files = ['social-v2.json', 'stickers.json', 'slang.json', 'sessions.json', 'wmpvp-token.json',
    'current-role.json', 'mode.json', 'feedback.json'];
  for (const f of files) {
    const p = path.join(ROOT, 'state', f);
    if (!fs.existsSync(p)) { info('状态文件', f, '不存在（可能还没生成）'); continue; }
    const parsed = readJsonSafe(p);
    if (parsed === null) bad('状态文件', f, 'JSON 解析失败 —— 桥接读它时会抛错');
    else ok('状态文件', f, `${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
  }

  // 完美平台 token 是否还新鲜（CS 战绩要用）
  const tok = readJsonSafe(path.join(ROOT, 'state', 'wmpvp-token.json'));
  if (tok) {
    const exp = Number(tok.expiresAt ?? tok.exp ?? 0);
    const captured = Date.parse(String(tok.capturedAt ?? '')) || 0;
    if (exp) {
      if (Date.now() > exp) warn('CS 战绩', 'wmpvp-token 已过期', `过期于 ${new Date(exp).toLocaleString('zh-CN')}；重跑「抓取完美token.bat」`);
      else ok('CS 战绩', 'wmpvp-token 有效', `有效至 ${new Date(exp).toLocaleString('zh-CN')}`);
    } else if (captured) {
      // 抓包脚本只拿得到 access_token，拿不到 expires_in，所以没有准确过期时间。
      // 退而求其次按"抓取时间"给个新鲜度提示——完美 token 实测几天内会失效，
      // 超过 7 天就提醒重抓，免得用户以为"CS 查询坏了"。
      const days = (Date.now() - captured) / 86400000;
      const when = `${new Date(captured).toLocaleString('zh-CN')}（${days.toFixed(1)} 天前）`;
      if (days > 7) warn('CS 战绩', 'wmpvp-token 可能已过期', `抓取于 ${when}，建议重跑「抓取完美token.bat」`);
      else ok('CS 战绩', 'wmpvp-token 抓取时间', when);
    } else {
      info('CS 战绩', 'wmpvp-token', '既没有过期时间也没有抓取时间，无法判断新鲜度');
    }
  }
}

// ── 6. 端口与运行时健康 ───────────────────────────────────────────────────
function portOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function checkRuntime() {
  const ports = [
    [3100, '桥接控制台'],
    [3080, 'DSH Web'],
    [3081, '她的 DSH'],
    [3002, 'NapCat OneBot WS'],
    [3003, 'NapCat OneBot HTTP'],
    [6099, 'NapCat WebUI'],
    [3001, 'SnowLuma OneBot WS'],
    [3000, 'SnowLuma OneBot HTTP'],
    [5099, 'SnowLuma WebUI'],
    [18080, 'Overstats（国服战绩）']
  ];
  const open = {};
  for (const [port, label] of ports) open[port] = await portOpen(port);
  // NapCat 在线 = 网关走 NapCat，SnowLuma 不在是正常的（2026-10-25 起）；
  // Overstats 也不再常驻（战绩需要时手动起）。
  const napcatOnline = open[3002] || open[3003];
  const optional = new Set([3001, 3000, 5099, 18080]);
  for (const [port, label] of ports) {
    if (open[port]) ok('运行时', `${label} :${port}`, '监听中');
    else if (optional.has(port) && (napcatOnline || port === 18080)) info('运行时', `${label} :${port}`, '未监听（可选，NapCat 在线/按需启动）');
    else warn('运行时', `${label} :${port}`, '未监听');
  }

  // 桥接的深层健康：拿控制台令牌查 busy / states
  const token = readConsoleToken();
  if (!open[3100] || !token) { warn('运行时', '桥接 API 检查', '端口或令牌不可用，跳过'); return; }
  try {
    const busyRes = await fetch(`http://127.0.0.1:3100/api/busy?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(6000) });
    const busy = await busyRes.json();
    const list = Array.isArray(busy?.conversations) ? busy.conversations : [];
    // 桥接会回报 staleCollectorMs（默认约 11 分钟 = wait.maxMs + 60s 余量）。
    // 回退值只在桥接版本较旧、没这个字段时用得上，取同量级即可。
    const stuck = list.filter((c) => c.busy && c.reasons?.collectorIdleMs !== null && c.reasons.collectorIdleMs !== undefined && c.reasons.collectorIdleMs > (c.staleCollectorMs ?? 660000));
    for (const c of list) {
      const age = c.reasons?.collectorIdleMs;
      info('运行时', `${c.key}`, c.busy
        ? `繁忙（collector 静默 ${age === null || age === undefined ? 'n/a' : Math.round(age / 1000) + 's'}${c.turnAgeMs !== null ? `, turn ${Math.round(c.turnAgeMs / 1000)}s` : ''}）`
        : '空闲');
    }
    if (stuck.length) bad('运行时', '会话疑似卡死', stuck.map((c) => c.key).join(', '));
    else ok('运行时', '没有卡死的会话', `${list.length} 个会话`);

    const stRes = await fetch(`http://127.0.0.1:3100/api/socialV2/states?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(6000) });
    const st = await stRes.json();
    const convs = Array.isArray(st?.conversations) ? st.conversations : [];
    ok('运行时', '二代会话状态', convs.map((c) => c.key).join(', ') || '(空)');
    const diving = convs.filter((c) => c.wakeConfig?.mode === 'diving').length;
    info('运行时', '唤醒模式分布', `潜水 ${diving} / 活跃 ${convs.length - diving}`);
  } catch (error) {
    warn('运行时', '桥接 API 检查失败', String(error?.message ?? error).slice(0, 160));
  }
}

// ── 7. 安全边界：令牌清单必须不存在 ──────────────────────────────────────
function checkTokenBoundary() {
  const file = path.join(ROOT, 'src', 'bridge.js');
  const src = fs.readFileSync(file, 'utf8');
  // 只看代码行（排除注释），否则说明性注释里的字样会误报
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  if (code.includes('其它会话令牌')) bad('安全边界', '唤醒提示词里又出现了「其它会话令牌」清单', '这会让"发错群"重新变成可能');
  else ok('安全边界', '唤醒提示词不含会话令牌清单');

  const roster = /function buildTokenRosterV2\([\s\S]{0,400}?\n  \}/.exec(src);
  if (roster && /return '';/.test(roster[0])) ok('安全边界', 'buildTokenRosterV2 是空实现', '符合"读放开、发绑定"的设计');
  else warn('安全边界', 'buildTokenRosterV2 不再是空实现', '请确认是否有意恢复令牌清单');

  // 唤醒限流**只能暂存重排，不能丢弃**（源码级断言）。
  // 实测事故：13:42:23 一条 private 唤醒因 maxWakePerMinute 超限被裸 return 丢掉，
  // 那条消息再也没被回复（用户看到的现象就是"她没回我"）。谁改回 `return` 这里立刻报。
  if (/deferWakeReasonV2\(key, st, reason, 'rate-limit'\)/.test(code)) {
    ok('安全边界', '唤醒限流走暂存重排', '不会丢弃唤醒原因');
  } else {
    bad('安全边界', '唤醒限流没有暂存重排', '被限流的唤醒会被直接丢弃 → 那条消息永远不会被回复');
  }

  // 发送类工具必须仍然绑定令牌
  const bound = (src.match(/agentTokenOk\(key, req\.headers\['x-agent-token'\]\)/g) ?? []).length;
  if (bound >= 8) ok('安全边界', `发送/修改类工具的令牌绑定保留 ${bound} 处`);
  else bad('安全边界', `发送类令牌绑定只剩 ${bound} 处`, '可能被误删，跨会话发送会变成可能');
}

// ── 7b. 非法字符防护：提示词里绝不能有"半个 emoji" ────────────────────────
/**
 * 为什么必须有这一项：2026-09-28 私聊会话**每一轮**都报
 *   ⚠️ agent 处理出错：DeepSeek API error (HTTP 400)
 * 而群聊完全正常。根因是渲染记忆时用裸 slice 截断，正好把 😨 切成两半，
 * 留下孤立代理项（\ud83d）；JSON 序列化后是非法字符，请求直接 INVALID_REQUEST。
 * 因为那条记忆只属于私聊会话，所以只有私聊坏 —— 表现上极难联想到"截断 emoji"。
 */
function checkSurrogateSafety() {
  const file = path.join(ROOT, 'src', 'bridge.js');
  const src = fs.readFileSync(file, 'utf8');

  // 1. 两个 helper 必须存在
  for (const fn of ['stripLoneSurrogates', 'clip']) {
    if (new RegExp(`function ${fn}\\(`).test(src)) ok('非法字符', `${fn}() 存在`);
    else bad('非法字符', `${fn}() 不见了`, '截断 emoji / 清理脏字符的能力被删了');
  }

  // 2. 提示词出口必须兜底（这是最后一道网，任何上游漏网都能拦住）
  if (/const safe = stripLoneSurrogates\(full\);/.test(src)) {
    ok('非法字符', '提示词出口（withSlangContext）有兜底净化', '上游漏网的脏字符也会被清掉');
  } else {
    bad('非法字符', '提示词出口没有兜底净化', '一旦有脏字符漏进来，该会话会每轮 400 且无从察觉');
  }

  // 3. 记忆渲染不许再用裸 slice 截断（就是这次事故的写法）
  const renderer = /function formatMemoryV2\(st\)[\s\S]*?\n  \}/.exec(src);
  if (!renderer) { warn('非法字符', '找不到 formatMemoryV2，跳过渲染检查'); return; }
  const bare = renderer[0].match(/String\(t\.text\)\.slice\(0, 60\)|\.slice\(0, 64\)|\.slice\(0, 50\)/g);
  if (bare) bad('非法字符', `记忆渲染里还有 ${bare.length} 处裸 slice 截断`, `应改用 clip()：${bare.join('、')}`);
  else ok('非法字符', '记忆渲染全部改用 clip() 截断', '不会切碎 emoji');

  // 4. 错误必须同时进 bridge.log（这次事故最大的坑：日志里什么都看不到）
  if (/log\(`❌ agent 处理出错/.test(src)) {
    ok('非法字符', 'agent 出错会写进 bridge.log', '以前只发 QQ，事后无从排查');
  } else {
    bad('非法字符', 'agent 出错没有写日志', '线上报错将无法从 state/bridge.log 排查');
  }

  // 5. 单会话换新会话的管理端点（用于救"历史已被污染"的会话）
  if (src.includes("'/api/socialV2/rotate-session'")) {
    ok('非法字符', '存在「换新会话」端点', '/api/socialV2/rotate-session');
  } else {
    warn('非法字符', '缺少「换新会话」端点', '会话历史被污染后只能删记忆（/api/socialV2/reset）才能恢复');
  }

  // 6. 会话轮换必须按"解开后"的体量判断（压缩后的大小会骗人：实测压缩比 2.6~3.0 倍，
  //    导致 4.88 MB 真实内容的会话压缩后只有 1.62 MB，永远不轮换 = 每回合白烧钱）
  const rotation = /function sessionNeedsRotation\(sessionId\)[\s\S]*?\n  \}/.exec(src);
  if (!rotation) { warn('非法字符', '找不到 sessionNeedsRotation，跳过轮换维度检查'); return; }
  if (/sessionHistoryRawBytes\(sessionId/.test(rotation[0])) {
    ok('成本控制', '会话轮换按解开后的体量判断', '压缩后的大小会骗人（压缩比约 3 倍）');
  } else {
    bad('成本控制', '会话轮换又改回按压缩大小判断', '解压后几 MB 的会话会永不轮换 → 每回合重发、白烧钱');
  }
  if (/maxHistoryRawBytes/.test(src) && /maxHistoryRawBytes/.test(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))) {
    ok('成本控制', 'maxHistoryRawBytes 有示例配置');
  } else {
    warn('成本控制', 'maxHistoryRawBytes 没有写进 config.example.json', '用户不知道有这个旋钮');
  }

  // 7. 禁言期间不许唤醒（发不出去=纯烧 token），解禁后按用户要求只"对禁言说两句"
  if (/if \(isMutedV2\(st, now\)\)/.test(src)) {
    ok('成本控制', '禁言期间不唤醒（省下一次完整 turn）');
  } else {
    const m = /function scheduleWakeV2[\s\S]*?\n  \}/.exec(src);
    bad('成本控制', 'scheduleWakeV2 里找不到禁言判断',
      m && /isMutedV2/.test(m[0]) ? '判断在别处（请人工确认）' : '被禁言时仍会唤醒 → 每次都是白花钱');
  }
  const unmute = /function triggerUnmuteWakeV2[\s\S]*?\n  \}/.exec(src);
  if (unmute && /pendingWakeReasons[\s\S]{0,60}length = 0/.test(unmute)) {
    ok('成本控制', '解禁后不消化积压消息', '用户要求："就禁言这件事发表一下看法就行了"');
  } else {
    bad('成本控制', '解禁后会把积压消息当待办处理', '用户明确否掉了"解禁后逐条消化积压"这个方向');
  }
  if (/【解禁了】/.test(src)) {
    ok('成本控制', '解禁唤醒有专门的说辞（带情绪地聊被禁言）');
  } else {
    warn('成本控制', '找不到解禁唤醒的提示词分支');
  }
  // 2026-10-02：又在前面插了"已在潜水时收紧触发条件不算转入潜水"（wasSleeping）——正则跟着放宽，
  //   守的还是同一件事：**控制台**（没有 agent token）改唤醒配置不该被观察窗口拦。
  if (/req\.headers\['x-agent-token'\][^\n]*isSleepingConfigV2\(next\)/.test(src)) {
    ok('安全边界', '沉睡前观察只拦 agent 自己', '管理员从控制台调参不会被莫名 400');
  } else {
    warn('安全边界', '沉睡前观察可能也拦控制台请求', '批量调唤醒配置会整批失败');
  }

  // 8. 文档取字（用户："我发 ppt 她看不懂"）：下载→取字→内联，链路不能断
  if (/detectOfficeKind\(buffer, name\)/.test(src) && /extractOfficeTextSafe\(/.test(src)) {
    ok('文档取字', 'PPT/Office 文档会走取字并内联');
  } else {
    bad('文档取字', 'bridge 里找不到 Office 取字接线', '用户发 PPT 她又会"看不懂"了');
  }
  if (/OFFICE_DOC_EXT[\s\S]{0,200}DOC_MAX_BYTES/.test(src) || /isDoc \? DOC_MAX_BYTES/.test(src)) {
    ok('文档取字', '文档类走更大的下载上限', 'PPT 带图很容易超过普通文件的 4MB 上限');
  } else {
    warn('文档取字', '文档下载上限可能仍是 4MB', '稍大的课件会下载失败');
  }
  if (/officeError/.test(src) && /别编/.test(src)) {
    ok('文档取字', '取不到文字时如实说"看不到，别编"', '不会让她硬装看过');
  } else {
    bad('文档取字', '取不到文字时的提示词丢了', '她会开始编文档内容');
  }
  {
    const workerPath = path.join(ROOT, 'src', 'office-extract-worker.mjs');
    let w = '';
    try { w = fs.readFileSync(workerPath, 'utf8'); } catch {}
    if (w) {
      ok('文档取字', 'office-extract-worker.mjs 存在');
      if (/realChars === 0/.test(w)) ok('文档取字', '整份没有文字时不会当成"取字成功"', '否则她只看到一串页码却没有内容；有图则改为让她看图');
      else bad('文档取字', '纯图片版 PPT 的判断被删了', '截图版课件会被当成"取字成功"');
      if (/maxEntryBytes/.test(w) && /maxTotalBytes/.test(w) && /maxEntries/.test(w)) {
        ok('文档取字', '解压有体积/条数上限', '防 zip 炸弹');
      } else {
        bad('文档取字', '解压上限被删', '畸形文档可能把内存吃爆');
      }
    } else {
      bad('文档取字', '找不到 office-extract-worker.mjs');
    }
    if (fs.existsSync(path.join(ROOT, 'src', 'office-extract-safe.mjs'))) {
      ok('文档取字', '取字跑在 worker 线程里（带硬超时）');
    } else {
      bad('文档取字', '缺少 office-extract-safe.mjs', '同步解压会阻塞消息处理');
    }
    // 内嵌图片 → 视觉输入（用户："我说的是 ppt 图片""不是截图，ppt里面的图"）
    if (/media.kind === 'docImage'/.test(src) && /type: 'image'/.test(src)) {
      ok('文档取字', '文档内嵌图会转成 image 视觉输入', 'PPT 里的流程图/图表/照片她也能看');
    } else {
      bad('文档取字', '文档内嵌图没有转成视觉输入', 'PPT 里的图她又看不见了');
    }
    if (/collectDocumentImages/.test(w) && /maxPerSlide/.test(w)) {
      ok('文档取字', '取图有张数/每页/体积预算', 'maxPerSlide 防止同一页的图挤掉后面几页');
    } else {
      bad('文档取字', '取图预算被删', '一份 98 张图的 PPT 会把她淹了（也很贵）');
    }
    if (/IMAGE_EXT_RE/.test(w) && /wmf/.test(w)) {
      ok('文档取字', '跳过 .wmf/.emf 等视觉模型读不了的格式');
    } else {
      warn('文档取字', '矢量图过滤可能被删');
    }
    if (w.includes('slide|document|sheet') && /slide: pageNo/.test(w)) {
      ok('文档取字', '取图按幻灯片顺序（靠 _rels 映射并记页码）', '她才能说"第 3 页那张图"');
    } else {
      warn('文档取字', '取图可能不再记录页码', '她只能说"有一张图"，没法指代是哪一页的');
    }
  }

  // 9. 说话分寸 + 气泡排版（用户："说话这么毒舌可不好" + 「？」粘在句首）
  //    必须放在**每轮注入**的 base 里：角色卡要她主动调 qq_get_prompt 才看得到，不够。
  //
  // ⚠️ 2026-10-02：规则**文本**已从 bridge.js 抽到 src/prompt-rules.js（原先那 130 行字面量
  //    散在 buildWakePromptV2 里）。所以"这段文本还在不在"要查**两个文件的并集** `ruleText`；
  //    而"有没有被 base 拼进去""顺序对不对"这类**结构**检查仍然只查 bridge.js 的 `src`。
  //    （不这么分，重构当天就误报了 11 条"规则被删了"。）
  const rulesSrc = (() => { try { return fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch { return ''; } })();
  const ruleText = `${src}\n${rulesSrc}`;
  if (/const toneLine = /.test(src) && /honestyLine \+ (requestLine \+ )?toneLine/.test(src)) {
    ok('说话分寸', '分寸/排版行每轮都注入');
  } else {
    bad('说话分寸', 'toneLine 不在每轮注入的 base 里', '她会又变回毒舌；「？」也会继续粘在句首');
  }
  if (/人身攻击/.test(ruleText) && /不拿对方的身体/.test(ruleText)) {
    ok('说话分寸', '禁止人身攻击（不拿身体/家人/外貌开涮）');
  } else {
    bad('说话分寸', '人身攻击的禁令被删了', '用户明确说过"这么毒舌可不好"');
  }
  if (/单独发一条/.test(ruleText) && /不要拼在句子前面/.test(ruleText)) {
    ok('说话分寸', '反应词（「？」）要求单独发一条', '不要发「？ 体检还插队…」这种');
  } else {
    bad('说话分寸', '气泡排版规则被删了', '她还会把「？」粘在句首');
  }
  {
    const rolePath = path.join(ROOT, 'roles', '程莫雯.md');
    let role = '';
    try { role = fs.readFileSync(rolePath, 'utf8'); } catch {}
    if (role && /嘴硬不等于毒舌/.test(role) && /单独发一条/.test(role)) {
      ok('说话分寸', '角色卡也同步了（qq_get_prompt 看到的一致）');
    } else {
      warn('说话分寸', '角色卡没同步分寸/排版规则', '她查 qq_get_prompt 时会看到互相矛盾的说法');
    }
  }
  // 2026-09-28 第二/三轮反馈：把话说成句 + 搭得上话 + 活人感
  if (/【说话的样子】/.test(ruleText) && /一条消息 = 一个短句/.test(ruleText) && /逗号能不用就不用/.test(ruleText) && /日文假名/.test(ruleText)) {
    ok('说话分寸', 'A 档：一条一个短句、逗号能不用就不用、不夹日文口癖');
  } else {
    bad('说话分寸', '缺少"一条一个短句"的规则', '她会继续用逗号串长句或发碎片');
  }
  if (/【搭得上话】/.test(ruleText) && /直接回答最后一条/.test(ruleText) && /别人在聊正事/.test(ruleText)) {
    ok('说话分寸', '要求贴题：先看清上下文、正事别乱插嘴');
  } else {
    bad('说话分寸', '缺少"搭得上话"的规则', '她会在别人聊正事时突然插一句、答非所问');
  }
  // 2026-09-29：看不懂就直接问（上下文太复杂 / 被 @ 却理解不了）
  if (/看不懂就直接问/.test(ruleText) && /你这条我没看懂/.test(ruleText) && /同一件事最多问一次/.test(ruleText)) {
    ok('说话分寸', '看不懂/没跟上就直接问（带说法与上限）', '比硬猜、装懂强');
  } else {
    bad('说话分寸', '缺少"看不懂就直接问"的规则', '她会硬接自己没看懂的话题');
  }
  if (/【像个人在打字】/.test(ruleText) && /口语化/.test(ruleText) && /不用 emoji/.test(ruleText) && /少 @ 别人/.test(ruleText)) {
    ok('说话分寸', '活人感：口语化/不念稿/不 emoji/少@');
  } else {
    bad('说话分寸', '缺少"像个人在打字"的规则');
  }
  // 2026-09-29 用户回退：那轮加进来的"允许词不达意/口是心非""轻松点别端着""有主见不为讨好改口"
  // 会让语气更怪、逻辑更差，撤掉了。守住别被自动加回来。
  if (!/词不达意/.test(ruleText) && !/别端着/.test(ruleText) && !/有自己主见/.test(ruleText)) {
    ok('说话分寸', '没有"词不达意/别端着/有主见"这些被回退的加戏');
  } else {
    warn('说话分寸', '被用户回退的几条又回来了', '他说过"语气怪改错了，回退一下"');
  }
  // 管理员命令口吻的总则（用户 2026-09-29："以管理员命令的口吻命令任务时必须执行；"
  // "无法执行则汇报原因；非管理员口吻交流时正常交流"）
  if (/function parseAdminCommandTone/.test(src) && /【管理员命令（必须执行）】/.test(src)
    && /做不到的必须如实汇报原因/.test(src) && /可以拒绝、可以嘴硬、可以讨价还价/.test(src)) {
    ok('管理员命令', '命令口吻=必须执行/做不到说原因/平时正常交流 三件套都在');
  } else {
    bad('管理员命令', '缺少管理员命令口吻的总则', '他会以为自己的"管理员命令"跟普通聊天一样可驳回');
  }
  // 2026-10-23 起 adminCmdLine 不再紧跟 tokenLine（baseDynamic 改成分段拼接，它在 rolePlayLine 之后）；
  // 检查"有没有这段 + 在 baseDynamic 里"即可，别钉死旧顺序（钉死就会一直误报）。
  if (/adminCmdLine/.test(src) && /honestyLine/.test(src) && /adminCmdLine \+ silentLine/.test(src)) {
    ok('管理员命令', '命令段落在提示词里（在 baseDynamic 中）', '位置靠后会被别的规则稀释');
  } else {
    warn('管理员命令', '命令段落位置变了', '建议保持靠前');
  }
  if (/st\.adminCommand = null/.test(src)) {
    ok('管理员命令', '只说一次（说完就清，不会每轮都当命令）');
  } else {
    warn('管理员命令', '命令标记不会被清掉', '她每轮都会以为这是命令');
  }
  if (/【嘴硬只用在贫上/.test(ruleText) && /拒绝别人不许用冷句/.test(ruleText) && /涉及事实和原则时，不嘴硬/.test(ruleText)) {
    ok('说话分寸', '嘴硬只用在贫上：正事/求助/事实原则时不嘴硬、拒绝不许用冷句');
  } else {
    bad('说话分寸', '缺少"嘴硬只用在贫上"的规则', '她会在正经事上顶人、拒绝时甩冷句');
  }
  // 故意没收录的两条（与用户既有要求冲突，测试里也守着）：≤20字符 的碎片化上限、
  // "被识破就地正法/绝不承认是AI" 的威胁式措辞（后者会撞上"别为了让角色成立去骗人"）。
  if (!/必须≤\s*20\s*字符/.test(ruleText) && !/就地正法/.test(ruleText)) {
    ok('说话分寸', '没收录"≤20字符"和"被识破就完蛋"这两条', '前者和"发一整句"冲突，后者和"不骗人"冲突');
  } else {
    warn('说话分寸', '收录了不该收的两条', '去看看 QUICKSTART 里为什么不要它们');
  }

  // 10. 按需看图工具（用户："工具吧，到时候再整合一下就行"）
  if (src.includes("'/api/socialV2/document-images'")) {
    ok('按需看图', '存在按页取文档图的端点');
  } else {
    bad('按需看图', '端点不见了', '她没法翻看没被附上的那几页');
  }
  if (/function parsePageSpec/.test(src) && /function findConversationDocuments/.test(src)) {
    ok('按需看图', '页号解析 + 按会话找文档是独立可测的函数');
  } else {
    warn('按需看图', '页号解析/文档查找被内联回端点了', '离线测不到（HTTP 端点的测试成本高）');
  }
  if (/entry\.keys/.test(src) && /hit\.keys\.push/.test(src)) {
    ok('按需看图', '文档按会话建索引，且同一文件在第二个会话也补得进');
  } else {
    bad('按需看图', '文档没按会话索引（或缓存命中时没补新会话）',
      '她会被告知"这个会话没收到过文档"，哪怕文件就在缓存里');
  }
  // 10c. DSH web profile 的**插件白名单**（2026-10-10 决策护栏）
  //
  //   背景：有人提过用 `@ignotuss/dsh-desktop-bridge` 给桥接换一根"更稳的管子"——
  //   它是"带 token 的回环 HTTP API，让本机任何程序驱动宿主进程的会话"。
  //   查官方文档后四条全部为否：token 落在 <DSH_HOME>/desktop-bridge.json（**任何能读到该文件的
  //   进程**都能列会话/读事件/发消息/**建新会话并以你的权限起 Agent**）；不能限定 profile/会话范围
  //   （它就是 republish 宿主的 sessionController）；不能只读（"只读"是另一个同名包）；不能限制工具面。
  //   而它**必须装在 web 这个 profile 才有意义**（她的人格/记忆/7 个 MCP server 都在 web 的宿主进程里，
  //   装 lab 只能驱动 lab 的会话 → 对桥接毫无用处）：装上就是同进程 + 第 23 个能驱动她会话的凭据，
  //   而桥接 24 小时在跑、必须常开（与官方"不用时禁用"的建议直接冲突）。
  //   另外它会打破我们自己的不变量：会话繁忙判定/唤醒租约/turn 自愈全都假设"同一会话只有一个驱动者"。
  //   → 结论：不装。这里把 web profile 的插件面**钉成白名单**，出现计划外的插件就报警。
  //
  //   想新增 web 插件时的正确姿势：先问三个问题 —— ① 它的凭据谁能读到？
  //   ② 它能不能驱动/新建她会话？③ 它崩了会不会带崩同一个宿主进程？三个都过了再改这份白名单。
  {
    // qq-agent-presets 是**我们自己**的 preset 声明 bundle（2026-10-10 起 preset 只能这样装）：
    // 它没有客户端半边、不持任何凭据、也不新增能力 —— 只声明"某个 preset 挂哪些 DSH 自带插件"。
    // 它与 qq-mode-console 一样属于"白名单内的自有 bundle"，不适用上面那三条准入问题。
    //
    // 2026-10-23 新增 dsh-bili-scroll（管理员："她也想刷B站啊"）——三问答案：
    // ① 凭据：它只持一个 **B 站小号**的 cookie（~/.dsh/bili-duty/bili_credential.json，明文，
    //    本机用户可读）。**不碰** DSH launch token / 桥接 token；小号丢了不影响她。
    // ② 驱动她会话：**不**。它的工具全是 bili_*（搜索/字幕/评论/私信），没有 session/会话工具；
    //    她的会话走桥接 3100，插件碰不到。
    // ③ 崩了带崩宿主：**低**。它跑的一轮是 spawn 的 headless 子进程、B 站 MCP 是 Python 子进程；
    //    工具异常在 DSH 的 tool 调用里被兜住。已知风险是插件本身有 open issues，但失败面在
    //    它自己的报告/评论，不在宿主。
    const WEB_PLUGIN_ALLOW = ['qq-mode-console', 'qq-agent-presets', 'dsh-bili-scroll'];
    const WEB_BUNDLE_ALLOW = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bili-scroll'];
    const webPkgPath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'package.json');
    let webPkg = null;
    try { webPkg = JSON.parse(fs.readFileSync(webPkgPath, 'utf8')); } catch { /* 没有 profile 就跳过 */ }
    if (!webPkg) {
      info('DSH 插件面', '读不到 web profile 的 package.json，跳过白名单检查');
    } else {
      const deps = Object.keys(webPkg.dependencies ?? {});
      const extraDeps = deps.filter((d) => !WEB_PLUGIN_ALLOW.includes(d) && !d.startsWith('@deepseek-ai/'));
      if (!extraDeps.length) {
        ok('DSH 插件面', `web profile 依赖只有白名单里的插件（${deps.join(', ') || '无'}）`);
      } else {
        bad('DSH 插件面', `web profile 多出了计划外的插件：${extraDeps.join(', ')}`,
          '它会跑在**她所在的宿主进程**里：凭据可被任何本机进程读、能驱动/新建她的会话、'
          + '崩了会带崩同一个进程，还会打破"同一会话只有一个驱动者"的假设。'
          + '要装先回答三问（凭据谁读得到/能否驱动她会话/崩了会不会带崩宿主），再改 self-check 的白名单。');
      }
      const bundles = webPkg.dsh?.profile?.bundles ?? [];
      const extraBundles = bundles.filter((b) => !WEB_BUNDLE_ALLOW.includes(b) && !WEB_PLUGIN_ALLOW.includes(b));
      if (!extraBundles.length) ok('DSH 插件面', 'web profile 的 bundle 清单也在白名单内');
      else bad('DSH 插件面', `bundle 清单多出：${extraBundles.join(', ')}`, 'bundle 会被宿主进程加载，同样按插件对待');
      // 顺带钉住：那个"驱动宿主会话"的回环 API 不该出现在我们会话里
      const bridgeSrcAll = RULE_TEXT;
      if (/desktop-bridge\.json|dsh-desktop-bridge/.test(bridgeSrcAll)) {
        warn('DSH 插件面', '桥接侧出现了 desktop-bridge 的痕迹', '如果哪天真接了它，这段注释/白名单要一起更新');
      } else {
        ok('DSH 插件面', '桥接侧没有接 desktop-bridge（决策：不装）');
      }

      // 10c-2. preset 的**新安装形式**（DSH 0.2.0，2026-10-10 现场踩到）
      //
      //   0.2.0 起 `$DSH_HOME/.agent-presets/<id>/` **没有任何代码再读**，preset 只能是
      //   "bundle 包 + cordis.patch.yml 里一行 @deepseek-ai/dsh-agent-preset 声明"。
      //   症状极具迷惑性：setup 打印安装成功、DSH 照常启动，但 agentPresets/list 里只有内置
      //   standard/ptc/minimal/cordis → 桥接 fail-closed 拒绝建会话 → 她永远不被唤醒。
      //   这里钉住生成物 + 生成器 + 注册三件事，任何一环退回旧形式都会当场红。
      const bundleDir = path.join(ROOT, 'dsh', 'presets', 'qq-agent-presets');
      const bundlePatch = path.join(bundleDir, 'cordis.patch.yml');
      const bundlePkg = path.join(bundleDir, 'package.json');
      const setupSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'utf8');
      const patchText = fs.existsSync(bundlePatch) ? fs.readFileSync(bundlePatch, 'utf8') : '';
      const declaresBoth = ['preset-qq-chat', 'preset-qq-chat-v2'].every((row) => patchText.includes(`id: ${row}`));
      if (fs.existsSync(bundlePkg) && declaresBoth && patchText.includes('qq-agent-presets/qq-tool-restrict.mjs')) {
        ok('DSH 预设面', 'preset bundle 已生成：两行声明 + restrict 按包名引用');
      } else {
        bad('DSH 预设面', 'dsh/presets/qq-agent-presets 缺文件或缺声明',
          'DSH 0.2.0 不认旧的 ~/.dsh/.agent-presets 目录；跑 node scripts/setup-dsh.mjs 重新生成');
      }
      if (setupSrc.includes('buildPresetBundle(') && !/copyPreset\(/.test(setupSrc)) {
        ok('DSH 预设面', 'setup-dsh.mjs 用生成器（不再往旧目录拷贝）');
      } else {
        bad('DSH 预设面', 'setup-dsh.mjs 还在用旧的 preset 安装方式',
          '旧目录 0.2.0 不读 → 装了等于没装，且不给任何报错');
      }
      const webBundles = webPkg?.dsh?.profile?.bundles ?? [];
      if (webPkg && webBundles.includes('qq-agent-presets')) {
        ok('DSH 预设面', 'qq-agent-presets 已注册进 web profile 的 bundles');
      } else if (webPkg) {
        bad('DSH 预设面', 'web profile 的 bundles 里没有 qq-agent-presets', 'profile 不会加载它 → preset 不存在');
      }
    }
  }


  // 10d. 她的会话必须是**最小能力面**（2026-10-10 决策护栏）
  //
  //   背景：有人提"把自主插件设置成有管理员权限才能用不就行了"。方向对，但**正确实现不是加审批，
  //   而是"能力根本不在"** —— 每个 QQ agent 的 preset 里都挂了一个 3KB 的硬边界插件
  //   `qq-tool-restrict.mjs`：① `tools.restrict` 把开发/管理工具从工具列表隐藏（黑名单里
  //   明确列着 `dev_inject_plugin` / `dev_install_package` / `dev_scaffold_plugin` —— 那正是
  //   "自主装插件"的能力本身）；② `tools.guard` 执行期白名单兜底，不在白名单一律拒绝。
  //
  //   为什么这比"管理员权限"强：**能力不在**没有绕过面、不需要有人在场、不会审批疲劳；
  //   而 `dsh-user-approval` 是一次性审批（每个请求一次决定，应答者缺失即 unavailable→拒绝），
  //   跟"24 小时无人值守的数字员工"直接冲突。这条检查就是把这个边界钉死：
  //   以后谁（包括我）想给她的会话加本地工具，会在这里当场红掉。
  {
    for (const presetName of ['qq-chat', 'qq-chat-v2']) {
      const dir = path.join(ROOT, 'dsh', 'agent-presets', presetName);
      const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
      const ymlPath = path.join(dir, 'agent.cordis.yml');
      if (!fs.existsSync(guardPath)) {
        bad('最小能力面', `${presetName} 缺少 qq-tool-restrict.mjs`, '她的会话就没有执行期白名单兜底了');
        continue;
      }
      const guard = fs.readFileSync(guardPath, 'utf8');
      const yml = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, 'utf8') : '';
      // ① 执行期白名单必须只含"只读 / QQ 类"前缀
      const prefixes = [...guard.matchAll(/'(mcp__[a-z0-9-]+__)'/g)].map((m) => m[1]);
      const forbidden = prefixes.filter((p) => !/^mcp__(snowluma|snowluma-host|web-search-safe|ow-stats|ow-cn-stats|cs-5e-stats|cs-wmpvp-stats)__$/.test(p));
      if (prefixes.length && !forbidden.length) {
        ok('最小能力面', `${presetName} 白名单只有只读/QQ 类 MCP 前缀（${prefixes.length} 个）`);
      } else {
        bad('最小能力面', `${presetName} 白名单里出现了非只读前缀：${forbidden.join(', ') || '（没解析出前缀）'}`,
          '她的入口是最不可控的（群聊），白名单一旦放宽就等于把本地能力暴露给陌生人');
      }
      // ② dev_* 家族（自主装插件/注入能力）必须在黑名单里 + guard 必须存在
      const devNames = [...guard.matchAll(/'(dev_[a-z_]+)'/g)].map((m) => m[1]);
      if (devNames.includes('dev_inject_plugin') && devNames.includes('dev_install_package') && /tools\.guard\(/.test(guard)) {
        ok('最小能力面', `${presetName} 同时有 restrict 黑名单（含 dev_inject_plugin / dev_install_package）和执行期 guard`);
      } else {
        bad('最小能力面', `${presetName} 的硬边界不完整`,
          `dev_* 命中 ${devNames.length} 个，guard=${/tools\.guard\(/.test(guard)}；少一样就等于给"自己装插件"留门`);
      }
      // ③ preset 里不许出现本地执行类插件
      const localToolPlugins = ['dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-fs-', 'dsh-tool-terminal', 'dsh-sandbox-local'];
      const hit = localToolPlugins.filter((n) => yml.includes(n));
      if (!hit.length) ok('最小能力面', `${presetName} 没挂任何本地执行/文件工具插件`);
      else bad('最小能力面', `${presetName} 挂了本地工具：${hit.join(', ')}`, '她的 preset 设计是"无本地工具"，别破例');
    }
  }

  // 10f. 执行申请通道（2026-10-10）：她只能申请、不能执行
  //   桥接侧**必须没有执行路径** —— 这是整条通道的安全前提（申请内容来自她的会话，
  //   可能被群聊注入污染；所以它只是"给人看的材料"，不是"待执行的任务"）。
  {
    const toolOk = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8').includes("'qq_request_action'");
    if (toolOk) ok('申请通道', '她有 qq_request_action（唯一的"动手"路径是申请）');
    else bad('申请通道', 'MCP 里没有 qq_request_action', '她想帮忙时只剩硬编"我试过了"这一条路');
    const start = src.indexOf("url.pathname === '/api/socialV2/task-request'");
    const seg = start >= 0 ? src.slice(start, start + 2600) : '';
    if (start < 0) bad('申请通道', '提交端点不见了');
    else if (/spawn|execFile|execSync|child_process/.test(seg)) bad('申请通道', '申请端点里出现了执行调用', '申请内容绝不能进执行路径');
    else ok('申请通道', '申请端点**只存文本**，没有任何执行调用（spawn/exec/child_process 全无）');
    if (/function parseTaskRequestCommand/.test(src) && /decideTaskRequest\(id, trCmd\.action/.test(src)) {
      ok('申请通道', '批准/驳回只认管理员（ownerQQ）的明确措辞');
    } else {
      bad('申请通道', '批准入口不对/不见了', '她可能自己把自己的申请批了');
    }
    if (fs.existsSync(path.join(ROOT, 'scripts', 'requests.mjs'))) ok('申请通道', '工作侧有 CLI：`node scripts/requests.mjs list`');
    else bad('申请通道', '缺少 scripts/requests.mjs', '有申请也没人去办，等于给她的空头支票');
    if (/REQUEST_CHANNEL/.test(RULE_TEXT) && /qq_request_action/.test(RULE_TEXT)) {
      ok('申请通道', '提示词里交代了这条通道（每轮注入）');
    } else {
      warn('申请通道', '提示词里没写申请通道', '她找不到本地工具时不知道该申请');
    }
    // 2026-10-10 现场：他连发「批准 ＃7」「批准＃7」（**全角井号**），解析返回 null 且**一声不响** ——
    // 他等了 20 多分钟以为是工作会话卡住，她也跟着说"它在跑"，那条申请其实一直是待批。
    // 三条护栏：认全角/自然说法、认不出来也必须回一句、她只能以系统便条为准宣布批准。
    if (/\[\\uFF03\\uFE5F\]/.test(src) || /\uFF03/.test(src)) ok('申请通道', '批准命令认全角 ＃ 与全角数字');
    else bad('申请通道', '批准命令不认全角符号', '他打「批准＃7」会静默失败（实测等了 20 多分钟）');
    if (/没认出你要批哪一条/.test(src)) ok('申请通道', '认不出来也回一句问清哪一条（不许静默失败）');
    else bad('申请通道', '"批准没解析出来"时没有任何反馈', '他只能干等，还以为活卡住了');
    if (/批没批，以系统便条为准/.test(RULE_TEXT)) ok('申请通道', '她被告知"以系统便条为准，别替他宣布批准"');
    else warn('申请通道', '提示词没告诉她怎么判断批没批', '她会把"待批"说成"它在跑"');
    if (/\[系统→管理员\]/.test(src)) ok('申请通道', '系统回执也进桥接日志（排查时是证据链）');
    else warn('申请通道', '系统回执不进日志', '事后只能翻网关日志猜他发了什么');
  }

  // 10g2. 引用 id 漂移（2026-10-12 实测）：网关 `get_msg` 对**同名复用**的 id 解析不稳 ——
  //   同一个 id、同一个网关进程，19:1x 给 9/29 的旧同名消息、20:0x 又给当下的新消息，
  //   而他引用的**一直是新消息**（她看到的 `[引用 …（9/29 14:38，13天前）]` 就是这么来的）。
  //   两条不变量：① 渲染侧"疑似旧消息就再解析一次、取更新的那条"（别让她按错的日期推结论）；
  //             ② 取证侧"记下每个被引用 id 的解析结果、定期复查，变脸就落证据"（根治在网关侧）。
  {
    if (/async function sweepQuoteIdWatch/.test(src) && /recordQuoteIdWatch\(kind, convId, messageId, info\)/.test(src)) {
      ok('引用漂移', '被引用的 id 会被记下来 + 定期复查（取证，供网关侧修）');
    } else {
      bad('引用漂移', '没有"记下被引用 id + 复查"的取证链路', '只能靠嘴上说"网关不稳"，拿不出可复现证据');
    }
    if (/setInterval\(\(\) => \{\s*\n?\s*sweepQuoteIdWatch/.test(src) && /QUOTE_DRIFT_SWEEP_MS/.test(src)) {
      ok('引用漂移', '复查有定时器（DSH 就绪后启动）');
    } else {
      warn('引用漂移', '复查没有定时器', '取证链路等于摆设');
    }
    if (/quote-id-drift\.jsonl/.test(src) && fs.existsSync(path.join(ROOT, 'scripts', 'quote-drift-report.mjs'))) {
      ok('引用漂移', '证据落在 state/quote-id-drift.jsonl，并有 CLI 报告：`node scripts/quote-drift-report.mjs`');
    } else {
      warn('引用漂移', '证据文件或报告 CLI 缺失', '抓到漂移也交不出去');
    }
    // 渲染侧兜底：偏旧的引用要"再解析一次取更新的那条"，并且**偏旧就当场标注**。
    // 2026-10-12 深夜修正：原来只在"两次解析不一致"时才标 —— 结果漏掉了更常见的第二种成因
    //（客户端在 reply 段里挂旧锚点：他 23:29 那条的原始报文就是 `[CQ:reply,id=1652952769]`，
    //  而那个 id 忠实指向 9/29 的真实老消息，两次解析一致）→ 她看不到任何提示，只能自己发现
    //  "不搭"再反问他"时间内容是啥"。所以判据必须是"**偏旧就标**"。
    const staleRetry = /两次解析不一致/.test(src) && /rawBest/.test(src);
    const suspect = /suspectIdReuse/.test(src) && /⚠️疑似旧引用头/.test(src)
      && /suspectIdReuse:[\s\S]{0,240}anomalyHours > 0/.test(src);
    if (staleRetry && suspect) ok('引用漂移', '渲染侧：偏旧就当场标"⚠️疑似旧引用头"，并再解析一次取更新的那条');
    else if (staleRetry) bad('引用漂移', '标注只看"两次不一致"（会漏掉客户端挂旧锚点那种）', '实测代价：她只能反问"时间内容是啥"');
    else bad('引用漂移', '渲染侧没有"疑似旧引用"的兜底', '她看到的引用日期可能一直是旧同名消息的');
    // 提示词要把这个标记的含义说清楚（不然她不知道该按哪种理解），并且"候选"也要交代
    if (/疑似旧引用头/.test(src) && /按他这条消息本身 \+ 你上面刚说的那句去理解/.test(src)
      && /他大概是要接你刚说的/.test(src)) {
      ok('引用漂移', '提示词解释了"⚠️疑似旧引用头"+候选句该怎么用（别当本轮话题、也别反复确认）');
    } else {
      warn('引用漂移', '提示词没说这个标记/候选是什么意思', '她可能还是会去反问他');
    }
    // 候选只许来自"她最近 10 分钟内说的最后一句"（不许瞎猜别人说的、不许翻旧账）
    if (/QUOTE_HINT_WINDOW_MS/.test(src) && /m\?\.isSelf === true/.test(src) && /recentSelfHint/.test(src)) {
      ok('引用漂移', '候选句只看"她自己最近十分钟内说的最后一句"（不瞎猜）');
    } else {
      bad('引用漂移', '"他大概要接哪句"的候选没有限定来源', '乱猜会把她带到沟里');
    }
    const batchSrc = (() => { try { return fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8'); } catch { return ''; } })();
    if (/test-quote-drift\.mjs/.test(batchSrc) && /test-quote-time\.mjs/.test(batchSrc)) {
      ok('引用漂移', '渲染兜底 + 取证各有一条回归用例，且在批测清单里');
    } else {
      warn('引用漂移', '缺回归用例（或没进批测清单）', '改回旧写法不会红');
    }
    if (/取证失败绝不能影响渲染/.test(src)) ok('引用漂移', '取证失败不影响渲染（有 try 兜住）');
    else warn('引用漂移', '取证链路没有失败保护', '它一抖就可能把引用整段弄没');
  }

  // 10g3. 线路上的两处浪费（2026-10-12 拿真实日志拍出来的）：
  //   ① 一次发太多条原来**整条拒绝** → 她得重新组织再发一次 = 白跑一整轮模型推理。
  //      数据：末 1000 次工具调用里 11 次栽在"一次最多发 3 条"上。改成截断 + 告知剩余条数。
  //   ② 退役会话停不掉（DSH 回 invalid session/control baseline）时**只写日志** → 旧会话可能还在跑，
  //      发送会被 assertSession 拦，但推理照样烧 token。改成进"垃圾回收"清单 + 自动重试。
  {
    const truncations = (src.match(/const droppedMsgs = Math\.max\(0, messages\.length - maxMsgs\);/g) ?? []).length;
    const letMsgs = (src.match(/let messages = Array\.isArray\(rawMessages\)/g) ?? []).length;
    if (truncations === 2 && letMsgs === 2 && !/请挑最要紧的 \$\{maxMsgs\} 条重发/.test(src)) {
      ok('线路', '两个发送入口都"超限自动截断"（不是整条拒绝），且变量是可重新赋值的 let');
    } else {
      bad('线路', '发送超限的处理被改回了拒绝 / 或变量写成了 const（会 500）',
        `截断 ${truncations} 处、let ${letMsgs} 处`);
    }
    let mcpSrc = '';
    try { mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'); } catch {}
    if (/超了会自动截断到 3 条/.test(mcpSrc) && /剩几条没发/.test(mcpSrc)) {
      ok('线路', '工具描述告诉她"超了会截断、剩余条数看 dropped"（否则她以为都发出去了）');
    } else {
      warn('线路', '工具描述没提截断', '她可能以为第 4、5 条已经发出去了');
    }
    const gcCalls = (src.match(/noteSessionGc\((?!sessionId, key, reason)/g) ?? []).length;
    if (gcCalls === 4 && /sweepSessionGc\('watchdog'\)/.test(src) && /session-gc\.json/.test(src)) {
      ok('线路', '停不掉的退役会话进清单 + 看门狗自动重试（不再指望人肉去 DSH 翻）');
    } else {
      bad('线路', '退役会话停不掉时没有回收链路', `接上了 ${gcCalls} 处`);
    }
    if (/maxSendPerMinute/.test(src) && /preSleepWaitMs/.test(src)) {
      ok('线路', '限流与沉睡前观察窗口的配置项都还在（优化没偷偷放松防刷屏）');
    }
    let batchSrc = '';
    try { batchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8'); } catch {}
    if (/test-send-overflow\.mjs/.test(batchSrc) && /test-session-gc\.mjs/.test(batchSrc)) {
      ok('线路', '两处优化各有一条回归用例，且在批测清单里');
    } else {
      warn('线路', '线路优化的回归用例没进批测清单', '改回旧写法不会红');
    }
  }

  // 10g4. MATLAB 沙箱（2026-10-13）：管理员装了 MATLAB R2025b，要她能自己跑作业代码 + **出图**。
  //   做法是两遍式：沙箱里跑她的代码（Job 最多 1 个进程 → system/builtin 内核级起不来；绘图调用
  //   被桩接住只录音）+ 正常环境重放录音出图。这里钉住最容易悄悄退化的几件事。
  {
    const needs = [
      ['src/matlab-sandbox.js', /export function needsPlotMode/, '纯逻辑模块（绘图判断/预检/限频/截断/重放解析）'],
      ['scripts/matlab-run.ps1', /LaunchInContainer|CreateLimitsJob/, '沙箱执行器'],
      ['scripts/matlab-sandbox/wrapper.m', /SANDBOX_RECFILE/, 'wrapper（录音 + 预置输入队列）'],
      ['scripts/matlab-sandbox/sandbox_rec.m', /jsonencode/, '录制器'],
      ['scripts/matlab-sandbox/replay.m', /REPLAY_FILE/, '重放器'],
      ['scripts/grant-matlab-to-sandbox.bat', /icacls/, '一次性授权脚本（管理员跑）'],
    ];
    const missing = needs.filter(([f]) => !fs.existsSync(path.join(ROOT, f))).map(([f]) => f);
    if (missing.length === 0) ok('MATLAB', '沙箱这套文件都在（执行器/录制/重放/授权脚本）');
    else bad('MATLAB', `缺文件：${missing.join('、')}`, '她跑代码/出图会直接失败');
    if (/url\.pathname === '\/api\/socialV2\/run-matlab'/.test(src) && /runMatlabForAgent\(\{/.test(src)) {
      ok('MATLAB', '桥接有 run-matlab 端点，且只走 agent token（会话内）');
    } else {
      bad('MATLAB', '桥接没接 run-matlab 端点', '她拿不到这个能力');
    }
    if (/checkMatlabCode\(src\)/.test(src) && /matlabRateInfo\(matlabRunTimes/.test(src) && /if \(matlabBusy\)/.test(src)) {
      ok('MATLAB', '跑之前先过：代码预检 → 限频 → 忙锁（一次只跑一个）');
    } else {
      warn('MATLAB', '预检/限频/忙锁有缺口', '可能被刷、或者她的越界代码直接进进程');
    }
    // ⚠️ 这条原来在 `src`（bridge.js）里搜 `activeLimit` —— 但那东西在 **matlab-run.ps1** 里，
    //    所以它永远搜不到、永远误报（2026-10-17 查实：分档一直好好的，是自检读错文件）。
    {
      let ps1 = '';
      try { ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'matlab-run.ps1'), 'utf8'); } catch { ps1 = ''; }
      if (!ps1) {
        warn('MATLAB', '读不到 matlab-run.ps1', '没法确认进程数分档');
      } else if (/\$activeLimit\s*=\s*if\s*\(\$PlotMode\)\s*\{\s*6\s*\}\s*else\s*\{\s*1\s*\}/.test(ps1)) {
        ok('MATLAB', '沙箱脚本里"计算=1 个进程 / 绘图=6 个进程"这条分档还在（命令执行靠它锁死）');
      } else {
        warn('MATLAB', '沙箱的进程数分档不见了', '要么画不了图、要么命令执行锁不死');
      }
    }
    let mcpSrc2 = '';
    try { mcpSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'); } catch {}
    if (/'qq_run_matlab'/.test(mcpSrc2) && /qq_run_matlab/.test(mcpSrc2)) {
      ok('MATLAB', '她手上有 qq_run_matlab 工具');
    } else {
      bad('MATLAB', 'MCP 里没有 qq_run_matlab', '她没法自己跑');
    }
    let rulesSrc2 = '';
    try { rulesSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
    if (/export const MATLAB_SANDBOX/.test(rulesSrc2) && /key: 'matlab-sandbox'/.test(rulesSrc2)
      && /别试着绕/.test(rulesSrc2)) {
      ok('MATLAB', '规则里讲清了边界（能跑什么/哪儿是墙/别试着绕）');
    } else {
      warn('MATLAB', '规则里没说清边界', '她可能去撞墙或者不敢用');
    }
    let batchSrc2 = '';
    try { batchSrc2 = fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8'); } catch {}
    if (/test-matlab-sandbox-logic\.mjs/.test(batchSrc2)) ok('MATLAB', '纯逻辑有回归用例，且在批测清单里');
    else warn('MATLAB', 'MATLAB 纯逻辑没进批测清单', '改回旧写法不会红');
  }
  // 10g5. 网页抓取的两处修复（2026-10-14）：
  //   ① SPA 分享页（小黑盒/微博/小红书…）服务端 HTML 是空壳 → web_fetch 自动用无头浏览器渲染兜底；
  //   ② web_search 原来走 safeFetch，实测 Bing 对那条链路返回**不含结果的骨架页** → 一直空结果，改走 fetch。
  {
    if (fs.existsSync(path.join(ROOT, 'src/safe-render.js'))) {
      ok('抓取', '有 src/safe-render.js（SPA 渲染兜底）');
    } else {
      bad('抓取', 'src/safe-render.js 不见了', 'SPA 页面又会只抓到空壳');
    }
    let renderSrc = '';
    try { renderSrc = fs.readFileSync(path.join(ROOT, 'src', 'safe-render.js'), 'utf8'); } catch {}
    // ★ 关键顺序：SSRF 校验必须在**启动浏览器之前**（反了就是拿无头浏览器去开内网）
    const iValidate = renderSrc.indexOf('await validateFetchUrl(urlString)');
    const iLaunch = renderSrc.indexOf('await getBrowser()');
    if (iValidate >= 0 && iLaunch >= 0 && iValidate < iLaunch) {
      ok('抓取', '渲染前的 SSRF 校验在启动浏览器之前（顺序对）');
    } else {
      bad('抓取', 'SSRF 校验与浏览器启动的顺序不对', '可能拿无头浏览器去访问内网/元数据地址');
    }
    if (/export function findBrowserExecutable/.test(renderSrc) && /BROWSER_CANDIDATES/.test(renderSrc)) {
      ok('抓取', '浏览器探测优先用机器上已装的 Chrome/Edge（省 150MB 下载）');
    } else {
      warn('抓取', '没写"优先用系统浏览器"的探测', '换机器可能报 "Could not find Chrome"');
    }
    const mcpPath = path.join(ROOT, 'src', 'mcp-web-search-safe.js');
    let mcpSrc = '';
    try { mcpSrc = fs.readFileSync(mcpPath, 'utf8'); } catch {}
    if (/needsRender\(/.test(mcpSrc) && /renderPage\(/.test(mcpSrc) && /render: z\.enum/.test(mcpSrc)) {
      ok('抓取', 'web_fetch 会按需渲染（auto/always/never 三个档都在）');
    } else {
      warn('抓取', 'web_fetch 的渲染兜底有缺口', 'SPA 页面又会抓不到正文');
    }
    // 搜索：不能再回到 safeFetch（实测那条链路拿不到结果条目）
    const bingFn = mcpSrc.slice(mcpSrc.indexOf('async function bingSearch'), mcpSrc.indexOf('const server = new McpServer'));
    if (bingFn && !/safeFetch\(/.test(bingFn) && /await fetch\(/.test(bingFn)) {
      ok('抓取', 'web_search 走 fetch（safeFetch 那条链路 Bing 只给骨架页，会一直空结果）');
    } else {
      bad('抓取', 'web_search 又用回 safeFetch 了', '搜索结果会一直是空的（这是 2026-10-14 修过的坑）');
    }
  }
  // 10g6. 入站文件上限分档（2026-10-14：管理员同意把"其它类型"从 4MB 放宽到 12MB）
  //   放宽的真正收益是**图片**（大截图/长图 5~10MB，原来直接读不了）；视频没有内容理解能力，
  //   所以超限时要说明白"看不到内容"，别让人以为继续放宽就有用。
  {
    const m = src.match(/const MAX_FILE_BYTES = (\d+) \* 1024 \* 1024;/);
    const mb = m ? Number(m[1]) : 0;
    if (mb >= 12) ok('入站文件', `其它类型上限 ${mb}MB（文档 32MB / 文本 16MB 另有两档）`);
    else warn('入站文件', `其它类型上限只有 ${mb}MB`, '大截图 5~10MB 会读不了（2026-10-14 放宽到 12MB，别改回去）');
    if (/const VIDEO_EXT = new Set/.test(src) && /看不到内容/.test(src)) {
      ok('入站文件', '视频超限时会说明"看不到内容"（不让他误以为再放宽点就能用）');
    } else {
      warn('入站文件', '视频超限提示缺了"看不到内容"那句', '他会以为继续放宽上限有用');
    }
  }
  // 10g7. 「他正在听/看什么」（2026-10-14，管理员点名要的"进阶 2"）
  //   读系统媒体会话（网易云/QQ音乐/浏览器都算）→ 便条拼进她的上下文。**不给她加工具**（不扩能力面），
  //   而且必须防"每轮汇报/反复念叨同一首"（帖子里作者自己踩过的坑）。
  {
    const needFiles = ['scripts/now-playing.ps1', 'src/now-playing.js'];
    const missing = needFiles.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length === 0) ok('在听什么', '读歌脚本 + 纯逻辑模块都在');
    else bad('在听什么', '缺文件：' + missing.join('、'), '他会以为她"知道你在听歌"，其实读不到');
    if (/refreshNowPlaying\(\)/.test(src) && /setInterval\(\(\) => \{ void refreshNowPlaying\(\); \}, 45000\)/.test(src)) {
      ok('在听什么', '定时预读（45 秒）+ 缓存（buildWakePromptV2 是同步的，不能当场 spawn）');
    } else {
      warn('在听什么', '没看到定时预读', '唤醒时可能读到空数据，或者拖慢唤醒');
    }
    // 2026-10-21：base 拆成了 baseStable + baseDynamic，而且**都是多行拼接** ——
    //   只取"以 const 开头那一行"会漏掉第二行之后的变量（TOKEN_RULE、THINK_FIRST…都在第二行）。
    //   所以按"从 baseStable 那行起、到 baseDynamic 之后 10 行"整段取。
    const baseLine = (() => {
      const all = src.split('\n');
      const i1 = all.findIndex((l) => l.includes('const baseStable = '));
      const i2 = all.findIndex((l) => l.includes('const baseDynamic = '));
      return i1 >= 0 ? all.slice(i1, (i2 > i1 ? i2 : i1) + 12).join('\n') : '';
    })();
    if (baseLine.includes('NOW_PLAYING_RULE') && baseLine.includes('nowPlayingLine')) {
      ok('在听什么', '便条和规矩都拼进了每轮提示词');
    } else {
      bad('在听什么', '便条没拼进提示词', '她永远不知道他在听什么（这条功能等于没做）');
    }
    if (/nowPlayingCache\.told/.test(src)) ok('在听什么', '同一首/同一状态不重复告诉她（防"电台 DJ"）');
    else warn('在听什么', '没有"已经告诉过她"的记录', '同一首歌会被反复念叨');
    let prSrc = '';
    try { prSrc = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
    if (/export const NOW_PLAYING_RULE/.test(prSrc) && /key: 'now-playing'/.test(prSrc)) {
      ok('在听什么', '规矩登记进了 RULE_INVENTORY');
    } else {
      warn('在听什么', '规矩没登记', '以后没人知道她被交代过这条');
    }
  }
  // 10g16. "拼进提示词"的东西要能验到（2026-10-20，我自己踩的坑）
  //   我把 timeLine() / herRhythmLine() 写好了、也加了 import，
  //   但**替换 base 那行没匹配上** → 函数存在、提示词里没有。我却跟管理员说"生效了"。
  //   这条静态检查 base 那行的拼接清单：说加进去的，必须真在这行里。
  {
    // 2026-10-21：base 拆成了 baseStable + baseDynamic，而且**都是多行拼接** ——
    //   只取"以 const 开头那一行"会漏掉第二行之后的变量（TOKEN_RULE、THINK_FIRST…都在第二行）。
    //   所以按"从 baseStable 那行起、到 baseDynamic 之后 10 行"整段取。
    const baseLine = (() => {
      const all = src.split('\n');
      const i1 = all.findIndex((l) => l.includes('const baseStable = '));
      const i2 = all.findIndex((l) => l.includes('const baseDynamic = '));
      return i1 >= 0 ? all.slice(i1, (i2 > i1 ? i2 : i1) + 12).join('\n') : '';
    })();
    const mustBeInBase = ['timeLine()', 'herRhythmLine(', 'TOKEN_RULE', 'THINK_FIRST', 'REPEAT_LOCK',
      'PHONE_STOP_RULE', 'FROM_BUILDER_HINT', 'HER_FINAL_SAY', 'PROMISE_RULE', 'preSleepLine'];
    const miss = mustBeInBase.filter((k) => !baseLine.includes(k));
    if (!baseLine) bad('提示词拼接', '找不到 base 那行（`const base = roleLine`）', '改名了？');
    else if (!miss.length) ok('提示词拼接', `base 里 ${mustBeInBase.length} 段机制都在（改了函数 ≠ 被调用）`);
    else bad('提示词拼接', '这些说"加进去了"但 base 里没有：' + miss.join('、'), '改了函数 ≠ 被调用');
  }

  // 10g19. 天气 + 时间观念（2026-10-23，管理员："城市改成宁波，希望她能有时间观念和天气观念"）
  //   守：模块在、定时预读在、base 里有 weatherLine、写日记带天气、情绪只按明显变化限频；
  //   顺带守 timeLine 有日期（她分不清"今天"是几号的话，写日记/记"哪天说的"全糊）。
  {
    if (fs.existsSync(path.join(ROOT, 'src', 'weather.js'))) ok('天气', '纯逻辑模块在（src/weather.js）');
    else bad('天气', '缺 src/weather.js', '提示词里那段天气会直接 ReferenceError');
    if (/void refreshWeather\(\);/.test(src) && /setInterval\(\(\) => \{ void refreshWeather\(\); \}, 30 \* 60 \* 1000\)/.test(src)) {
      ok('天气', '定时预读（30 分钟）+ 启动一次');
    } else warn('天气', '没看到定时预读', '天气会一直停在启动那一刻');
    const allLines = src.split('\n');
    const i1 = allLines.findIndex((l) => l.includes('const baseStable = '));
    const i2 = allLines.findIndex((l) => l.includes('const baseDynamic = '));
    const baseBlock = i1 >= 0 ? allLines.slice(i1, (i2 > i1 ? i2 : i1) + 12).join('\n') : '';
    if (baseBlock.includes('weatherLine')) ok('天气', 'weatherLine 拼进了 baseDynamic');
    else bad('天气', 'baseDynamic 里没有 weatherLine', '读到了也进不了她的提示词');
    if (/diaryWeatherLabel\(weatherCache\.data\)/.test(src)) ok('天气', '写日记时带上当时的天气');
    else warn('天气', '写日记没带天气', '日记抬头就只剩时间，没有"毛毛雨"');
    if (/isNotableChange\(prev, data\)/.test(src) && /lastStimDate !== today/.test(src)) {
      ok('天气', '情绪只按"明显变化"给一次（每天最多一次）');
    } else warn('天气', '情绪刺激没限频', '阴一整天会被反复计分');
    let prSrc2 = '';
    try { prSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
    // 2026-10-23 起时间行带时段词（`… ${hm} · 深夜】`），所以只匹配到 `${hm}` 为止。
    if (/【现在 \$\{md\} \$\{wdName\} \$\{hm\}/.test(prSrc2)) ok('天气', '时间行带日期（几月几号）');
    else warn('天气', '时间行没有日期', '她分不清"今天"是几号，写日记和记"哪天说的"都会糊');
    let roleSrc = '';
    try { roleSrc = fs.readFileSync(path.join(ROOT, 'roles', '程莫雯.md'), 'utf8'); } catch {}
    if (/宁波/.test(roleSrc)) ok('天气', '角色卡写着宁波');
    else warn('天气', '角色卡没写城市', '天气说宁波、她自己却不认，会拧巴');
  }

  // 10g20. 主动消息的"由头 + 分寸"（2026-10-23，管理员："我没见过她主动发消息"）
  //   她的问题不是没被叫醒（36 小时主动唤醒十几次），是醒来后判断"没由头，先不出声"。
  //   所以守四样：先想三件事（他的状态）、由头从哪来（含 pendingThought 话头）、
  //   **独处时教她记一句**、发完别追。少一样她就会退回"安静收尾"。
  {
    const miss = [
      ['先想三件事', /先想三件事/],
      ['由头清单（pendingThought 当话头）', /你之前攒下的/],
      ['独处时教她记 pendingThought', /想跟他说的[\s\S]{0,80}pendingThought/],
      ['发完别追', /发完别追/],
    ].filter(([, re]) => !re.test(src)).map(([n]) => n);
    if (!miss.length) ok('主动消息', '三问 + 由头 + 独处记话头 + 不追，四样都在');
    else bad('主动消息', '缺：' + miss.join('、'), '她会继续"没由头就安静收尾"，主动发消息永远不长出来');
  }

  // 10g21. 日记读回（2026-10-23，管理员："情绪低情绪高都会写吧"）
  //   为什么不做"提示她自己翻"：DIARY_RULE 里"想翻以前的就翻"从 10-14 就在，而她
  //   qq_read_diary 调用次数是 **0** —— 同一条提示已经失效。所以改成"桌上放一句她写的"。
  {
    const miss = [
      ['函数在', /function diaryRecallLine\(key\)/],
      ['只在主动唤醒拼（不在回复类里）', /reason === 'idleTime' \|\| reason === 'proactiveCheck'\) \? diaryRecallLine\(key\)/],
      ['主动机会分支真的用了', /\$\{base\}\$\{diaryRecall\}【主动机会】/],
      // 2026-10-24 起标题多了后缀「（但可以边干边看）」，用前缀匹配，别钉死整句。
      ['独处分支真的用了', /\$\{base\}\$\{diaryRecall\}【这会儿没人找你/],
      ['同一条只端一次', /st\.diaryRecall\.sig === sig/],
    ].filter(([, re]) => !re.test(src)).map(([n]) => n);
    if (!miss.length) ok('日记读回', '只引一句 + 只在主动唤醒 + 同一条只端一次');
    else bad('日记读回', '缺：' + miss.join('、'), '又回到"提示她自己翻"——她 qq_read_diary 0 次');
  }

  // 10g22. 语音（2026-10-23，管理员："她 0 次发语音"）
  //   链路是通的（speak-server ready、RVC 音色在），qq_send_voice 历史调用 **0 次**。
  //   原因不是能力，是规矩里一半在"别"、场景太抽象（"有情绪的时候"）。改成具体场景。
  {
    let spSrc = '';
    try { spSrc = fs.readFileSync(path.join(ROOT, 'src', 'speech.js'), 'utf8'); } catch {}
    const miss = [];
    if (!/(想他了|笑出声|困得不想打字)/.test(spSrc)) miss.push('规则里没有具体场景');
    if (!/一轮最多一条/.test(spSrc)) miss.push('没有"一轮最多一条"的分寸');
    if (!/想发语音就发/.test(src)) miss.push('主动机会里没提语音');
    if (!miss.length) ok('语音', '具体场景 + 分寸 + 主动机会里能用');
    else bad('语音', '缺：' + miss.join('、'), '她继续 0 次发语音（历史调用就是 0）');
  }

  // 10g23. 日志要带日期（2026-10-23）：只有 HH:MM:SS 时，跨天分析全靠"时间回退"去猜。
  //   我为此踩过两次（跨天验证错一天、回声率样本错位）。
  //   2026-10-24 起日志用**系统本地时间**（管理员："你要不把时间跟系统时间统一一下"），
  //   所以锚点从 iso.slice 换成 getFullYear/getMonth/getDate。
  {
    if (/getFullYear\(\)/.test(src) && /getMonth\(\) \+ 1/.test(src) && /getDate\(\)/.test(src)) {
      ok('日志', '每行带日期（本地时间）');
    } else {
      bad('日志', '日志行没有日期', '跨天分析又要靠猜，会错一天');
    }
  }

  // 10g24. 她做的事影响情绪（2026-10-23）
  //   管理员两次纠正：① "做事影响情绪没搞吗" ② "正常写日记是发泄情绪的，应该情绪更好吧"。
  //   所以守的是：日记 = **宣泄**（v 升 a 降，不是按内容打分把负面写得更沉）；
  //   刷手机/看图/唱歌 = 活动释放（每小时最多一次，防"做了就奖励"）。
  {
    const hasDiary = /affectEmotion !== false/.test(src) && /写了日记（宣泄）/.test(src);
    const hasActivity = /activityReleaseAffect/.test(src) && /每小时最多一次/.test(src);
    if (hasDiary && hasActivity) ok('做事影响情绪', '写日记=宣泄（v 升 a 降）+ 活动释放（每小时最多一次）');
    else warn('做事影响情绪', `缺：${[!hasDiary && '日记宣泄', !hasActivity && '活动释放'].filter(Boolean).join('、')}`, '她做的事对情绪没有任何影响（只剩"别人说的话"+天气）');
  }

  // 10g26. 她能读本机文件（2026-10-23 管理员："改成全文件吧"）
  //   给绝对路径直读本机（插件报告、日志、我留的东西）；**敏感文件名仍然拦**
  //   （SEND_FILE_DENY_RE：.env / .credentials / console-token / id_rsa）。只读，不改。
  {
    const hasLocal = /looksLikePath/.test(src) && /SEND_FILE_DENY_RE\.test\(abs\)/.test(src);
    const hasReject = /这个文件名在敏感名单里/.test(src);
    if (hasLocal && hasReject) ok('读本机文件', '绝对路径直读 + 敏感文件名黑名单（.env/凭据/令牌）');
    else bad('读本机文件', '本地路径分支或敏感拦截缺了', '要么读不到她要看的报告，要么能读 config.json 里的 token');
  }

  // 10g15. 提示词里**不许出现别的人设词**（2026-10-17）
  //   参考过一份"鲸鱼娘女仆"的角色提示词，只取了三条机制（思考3步/40字/防重复），
  //   人设一概没要。这条守着：别哪天有人把那些词混进规则正文 —— 她会以为自己是那个角色。
  {
    // ⚠️ 只查**那个角色的专有词**。注意"大肥鱼/小鲸鱼"是**她以前的召唤词**（bridge.js 的
    //    mustReplyKeywords 里还有，他叫这个她照样会醒）—— 那是功能，不是人设污染，别误伤。
    const BAD_WORDS = ['鲸鱼娘', '白饭冷却', '死了喵', '用户酱', '极简鲸鱼娘'];
    const hit = BAD_WORDS.filter((w) => RULE_TEXT.includes(w));
    if (!hit.length) ok('人设纯净', '提示词正文里没有别的人设词（鲸鱼娘/白饭/用户酱这类）');
    else bad('人设纯净', '提示词正文混进了别的人设词：' + hit.join('、'), '她会以为自己是那个角色');
  }

  // 10g17. 稳定块观测口径（2026-10-22 跨天验证踩的）
  //   误报会让"缓存命中"变成看天吃饭：全局一个哈希 → private/group 交替就跳；
  //   手抄清单把 tokenLine 算进去 → 会话轮换换令牌（chars 不变）也会跳。
  //   所以守三件：按会话存、直接 hash 真前缀、不许再手抄清单。
  {
    const bads = [];
    if (!/const lastStableHashByKey = new Map\(\)/.test(src)) bads.push('没按会话存');
    if (!/const stableText = String\(baseStable \?\? ''\)/.test(src)) bads.push('没 hash 真前缀');
    if (/PROMPT_STABLE_KEYS\s*=/.test(src)) bads.push('又手抄清单了');
    if (!bads.length) ok('提示词稳定块观测', '按会话存 + 直接 hash baseStable + 无手抄清单');
    else bad('提示词稳定块观测', '口径退化了：' + bads.join('、'), '会误报 ★变了，跨天验证又会白做');
  }

  // 10g18. 静默必须拦在**所有**唤醒路径上（2026-10-23 实测：静默开着群里 36 小时被叫醒 11 次）
  //   proactiveCheck / idleTime / timeout 是**直接调** sendWakePromptV2 的，
  //   只在 scheduleWakeV2 拦 = 没拦；她跑完整一轮，只为内部说一句"继续保持潜水"，纯烧 token。
  //   静默对管理员私聊放行（他自己要能说话、才能解禁），所以入口统一拦是安全的。
  {
    const start = src.indexOf('async function sendWakePromptV2');
    const head = start >= 0 ? src.slice(start, start + 1500) : '';
    const atEntry = head.indexOf('silentAllBlocks(key)');
    const beforeState = head.indexOf('getSocialV2State(key)');
    if (atEntry >= 0 && (beforeState < 0 || atEntry < beforeState)) {
      ok('静默拦唤醒', 'sendWakePromptV2 入口就拦（覆盖 proactive/idle/timeout 直调）');
    } else {
      bad('静默拦唤醒', '唤醒入口没拦静默', '静默开着群里还会被叫醒，跑一轮只为说"继续潜水"，白烧 token');
    }
  }

  // 10g14. 分条发送要能被"插话"打断（2026-10-14 管理员反馈的体验问题）
  //   她一次生成好几条，桥接按随机间隔一条条发（像真人）。真人被插话会停下；
  //   原来队列不知道有人说话，会自顾自发完 —— 他说的"没在随机应变"就是这个。
  //   守三件事：打断表在、发送前检查版本、消息入口 +1。
  {
    if (/const burstInterrupt = new Map\(\)/.test(src)) ok('插话打断', '打断表在（burstInterrupt）');
    else bad('插话打断', '打断表没了', '她会被插话后还自顾自发完');
    if (/burstInterrupt\.get\(key\) \|\| 0\) !== startVersion/.test(src)) ok('插话打断', '发送前检查版本（变了就停）');
    else bad('插话打断', '发送前没检查版本', '插话拦不住');
    if (/burstInterrupt\.set\(key, \(burstInterrupt\.get\(key\) \|\| 0\) \+ 1\)/.test(src)) ok('插话打断', '收到别人消息时 +1');
    else bad('插话打断', '消息入口没 +1', '永远不会触发打断');
  }

  // 10g13. 模块作用域的函数，不许直接引用 main() 里的东西（2026-10-14 踩了两次）
  //   事故：segmentsToText（模块作用域，L1593）直接调 transcribeVoiceSegment（在 main() 里）→
  //   每条语音/音频消息都抛 "transcribeVoiceSegment is not defined"。
  //   node --check 只查语法不查作用域 → 一路绿灯，只有真跑消息才炸。
  //   正解是**注入**：由调用方（在 main() 内）把转写器当参数传进去。
  //   这里守住：segmentsToText 函数体内不许出现那几个 main() 内的名字（注释里提不算）。
  {
    const start = src.indexOf('async function segmentsToText');
    if (start < 0) { warn('作用域注入', '找不到 segmentsToText', '守卫失效'); }
    else {
      // 取函数体（到下一个顶层 function 声明为止，够用）
      const nextTop = src.indexOf('\nasync function ', start + 10);
      const nextTop2 = src.indexOf('\nfunction ', start + 10);
      const ends = [nextTop, nextTop2].filter((x) => x > 0);
      const body = src.slice(start, ends.length ? Math.min(...ends) : start + 20000);
      // 去掉注释行再检查（注释里提到这些名字是允许的）
      const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const forbidden = ['transcribeVoiceSegment', 'voiceCfg', 'voiceCache', 'VOICE_SCRIPT', 'VOICE_TMP_DIR'];
      const hit = forbidden.filter((n) => new RegExp(`\\b${n}\\b`).test(code));
      if (!hit.length) ok('作用域注入', 'segmentsToText 只用注入进来的东西，没碰 main() 内部标识符');
      else bad('作用域注入', `segmentsToText 直接引用了 main() 内的：${hit.join('、')}`, '运行时会 "is not defined"，而且 node --check 查不出来 —— 改成由调用方注入参数');
    }
  }

  // 10g12. 模块作用域的常量，不许被塞进 main()（2026-10-14 血的教训）
  //   事故：给文件消息加音频转写时，把 `const AUDIO_FILE_EXT = new Set([...])` 放进了 main() 里，
  //   而读它的 segmentsToText 在模块作用域 —— `node --check` **只查语法不查作用域**，一路绿灯，
  //   实际每条文件消息都抛 `AUDIO_FILE_EXT is not defined`，**整个消息处理失败**。
  //   她那边看到的现象是"你发的算文件不算音频"，我查了半天才从桥接日志里挖出来。
  //   所以：凡是被"模块作用域函数"用到的常量，定义行号必须小于 main() 的起点。
  {
    const mainAt = src.indexOf('async function main(');
    const defs = [
      ['AUDIO_FILE_EXT', /const AUDIO_FILE_EXT = /g],
      ['VIDEO_EXT', /const VIDEO_EXT = /g],
      ['MAX_FILE_BYTES', /const MAX_FILE_BYTES = /g],
      ['OFFICE_DOC_EXT', /const OFFICE_DOC_EXT = /g],
      ['FFMPEG_BIN', /const FFMPEG_BIN = /g],
    ];
    let bad = 0;
    for (const [name, re] of defs) {
      re.lastIndex = 0;
      let m; const at = [];
      while ((m = re.exec(src))) at.push(m.index);
      if (!at.length) continue;
      if (mainAt > 0 && at[0] > mainAt) {
        bad += 1;
        bad2(`常量作用域：${name} 定义在 main() 之后`, `L${src.slice(0, at[0]).split('\n').length} > main() 起点 —— 模块作用域的函数读不到它，运行时会抛 "is not defined"`);
      }
    }
    if (!bad) ok('常量作用域', '模块级常量都在 main() 之前（AUDIO_FILE_EXT / VIDEO_EXT / MAX_FILE_BYTES / OFFICE_DOC_EXT）');
  }

  // 10g11. 她的相册（2026-10-14，进阶篇 ③）
  //   原帖的灵魂是「意义不在图，在于她挑」—— 所以**存图必须写理由**，没理由的一律拒。
  //   守四件事：模块在、端点还在、save 走 shouldSaveToGallery（理由必填）、取图走 fetchOneBotImage
  //   （不能让消息里的 URL 直接进 OneBot，那是 SSRF/本地文件防护的边界）。
  {
    const galMod = path.join(ROOT, 'src', 'gallery.js');
    if (fs.existsSync(galMod)) ok('相册', '纯逻辑模块在（src/gallery.js）');
    else bad('相册', '缺 src/gallery.js', '她存不了图');
    if (src.includes('/api/socialV2/gallery')) ok('相册', '端点还在');
    else bad('相册', '端点没了', 'qq_gallery 会 404');
    const galAt = src.indexOf('async function galleryForAgent');
    const galFn = galAt >= 0 ? src.slice(galAt, galAt + 4000) : '';
    if (galFn.includes('shouldSaveToGallery(')) ok('相册', 'save 走 shouldSaveToGallery（**理由必填**）');
    else bad('相册', 'save 没走理由校验', '没理由的存图只是搬运，失去了「她挑」的意义');
    if (galFn.includes('fetchOneBotImage(')) ok('相册', '取图走 fetchOneBotImage（不让消息 URL 直接进 OneBot）');
    else bad('相册', '取图没走 fetchOneBotImage', '可能绕开 SSRF/本地文件防护');
    if (!/'delete'|'remove'/.test(galFn)) ok('相册', '没有暴露删除（淘汰靠她自己另说）');
    else warn('相册', '相册接口出现了删除 action', '确认这是有意为之');
  }

  // 10g10. 她的日记本（2026-10-14，管理员提到的进阶 1）
  //   state/her-diary/YYYY-MM-DD.md，一天一个文件。**核心不变量是「只追加」**：
  //   已有的字符一个都不许改、不许删 —— 日记的价值就在「当时真的这么想」。
  //   守五件事：模块在、端点还在、用 appendDiary（而不是 writeFileSync 直接覆盖）、
  //   没有暴露删除/修改的 action、date 参数不能当路径用。
  {
    const diaryMod = path.join(ROOT, 'src', 'diary.js');
    if (fs.existsSync(diaryMod)) ok('日记', '纯逻辑模块在（src/diary.js）');
    else bad('日记', '缺 src/diary.js', '她写不了日记');
    if (src.includes('/api/socialV2/diary')) ok('日记', '端点还在');
    else bad('日记', '端点没了', 'qq_diary 会 404');
    // ★ 只追加：写入路径必须经过 appendDiary，不能直接 writeFileSync 覆盖当天文件
    const diaryFnAt = src.indexOf('async function diaryForAgent');
    const diaryFn = diaryFnAt >= 0 ? src.slice(diaryFnAt, diaryFnAt + 4000) : '';
    if (diaryFn.includes('appendDiary(')) ok('日记', '写入走 appendDiary（只追加，不覆盖）');
    else bad('日记', '写入没走 appendDiary', '可能覆盖掉她以前写的 —— 这是日记的立身之本');
    if (!/'delete'|'remove'|'edit'|'update'/.test(diaryFn)) ok('日记', '没有暴露删除/修改（对，就是这样）');
    else bad('日记', '日记接口出现了删除/修改 action', '日记能改就等于没有');
    // date 参数只认 YYYY-MM-DD，别让它变成路径
    const modSrc = fs.existsSync(diaryMod) ? fs.readFileSync(diaryMod, 'utf8') : '';
    if (/isValidDiaryDate/.test(modSrc) && /isValidDiaryDate/.test(diaryFn)) {
      ok('日记', 'date 参数经过 isValidDiaryDate 校验（挡住路径注入）');
    } else {
      warn('日记', '没看到 date 的格式校验', '读日记时 date 会被当文件名用');
    }
  }

  // 10g9. 她发语音（2026-10-14，管理员："她发语音不应该给限制"）
  //   链路：文字 → 常驻 F5 服务（scripts/speak-server.py，模型只加载一次）→ wav
  //        → 网关 record 段（**网关自己 encodeSilk**，桥接不转码）。
  //   实测：网关日志 `converted record to silk: ...wav -> ...Temp\audio-upload\...` + `[OneBot] 私聊 … | 发送：[语音]`。
  //   守五件事：文件在、端点还在、发的是 record 段、规矩登记了、以及**端点不接受路径参数**
  //   （否则等于把"任意写文件"的能力交出去 —— 这是她能力面里最该防的一条）。
  {
    const needSpeech = ['scripts/speak-server.py', 'scripts/speak-f5.py', 'src/speech.js'];
    const missingSpeech = needSpeech.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missingSpeech.length === 0) ok('发语音', '常驻合成服务 + 单次脚本 + 纯逻辑模块都在');
    else bad('发语音', '缺文件：' + missingSpeech.join('、'), '她发语音会直接失败');
    if (src.includes('/api/socialV2/send-voice')) ok('发语音', '端点还在');
    else bad('发语音', '端点没了', 'qq_send_voice 会 404');
    if (src.includes("type: 'record'")) ok('发语音', '发的是 record 段（网关自己转 silk）');
    else bad('发语音', '录音段没了', '发出去不会是一条语音');
    // 2026-10-14 更新：管理员要求"完全给她发文件的权限"（unrestricted=true），
    // 所以 send-voice 现在**允许**带 file（发现成音频，走 record 段变成 QQ 语音条）。
    // 真正要守的不变量不是"不许有路径参数"，而是"**路径必须经过 resolveSendFilePath**"——
    // 那里有敏感文件黑名单（.env/凭据/令牌/config.json），而且是只读+发送，不是写文件。
    // 端点本身只负责转交，路径校验在 sendVoiceForAgent 里（取函数体看，别只看端点附近）。
    const voiceFnAt = src.indexOf('async function sendVoiceForAgent');
    const voiceFn = voiceFnAt >= 0 ? src.slice(voiceFnAt, voiceFnAt + 6000) : '';
    const voiceAcceptsFile = /file\s*:\s*body\.file|sendVoiceForAgent\(\{[^}]*file/.test(src);
    if (!voiceAcceptsFile) {
      ok('发语音', '端点只收 text/calm');
    } else if (voiceFn.includes('resolveSendFilePath(')) {
      ok('发语音', '带 file 的发音请求会过 resolveSendFilePath（凭据黑名单仍在）');
    } else {
      bad('发语音', 'send-voice 接受路径但没走 resolveSendFilePath', '那才是真的能绕过凭据黑名单');
    }
    const baseLine4 = (() => { const all = src.split('\n'); const i1 = all.findIndex((l) => l.includes('const baseStable = ')); const i2 = all.findIndex((l) => l.includes('const baseDynamic = ')); return i1 >= 0 ? all.slice(i1, (i2 > i1 ? i2 : i1) + 12).join('\n') : ''; })();
    if (baseLine4.includes('speechLine')) ok('发语音', '规矩只在开着的时候拼进提示词');
    else warn('发语音', '规矩没拼进提示词', '她可能不知道自己能发语音');
    let prSrc4 = '';
    try { prSrc4 = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
    if (/key: 'speech-send'/.test(prSrc4)) ok('发语音', '规矩登记进了 RULE_INVENTORY');
    else warn('发语音', '规矩没登记', '以后没人知道她被交代过这条');
  }
  // 10g8. 语音转文字（2026-10-14，管理员点名要的"进阶 3"）
  //   QQ 语音是 AMR → imageio-ffmpeg 自带的 ffmpeg 解码 → 本机 faster-whisper 转写。
  //   这条功能的**要害是隐私**：音频下载→转码→转写→立刻删，本地只留文字、全程不出网。
  {
    const needVoice = ['scripts/transcribe.py', 'src/voice.js'];
    const missingVoice = needVoice.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missingVoice.length === 0) ok('语音', '转写脚本 + 纯逻辑模块都在');
    else bad('语音', '缺文件：' + missingVoice.join('、'), '她收语音只会看到光秃秃的 [语音]');
    if (/async function transcribeVoiceSegment/.test(src) && /(?:await |:\s*)transcribe(?:VoiceSegment)?\(d\)/.test(src)) {
      ok('语音', 'record 段会走转写（段转文本本来就是 async，直接 await）');
    } else {
      bad('语音', 'record 段没接转写', '语音内容还是丢的');
    }
    // ★ 隐私：音频必须用完即删（本地只留文字）
    if (/finally \{[\s\S]{0,400}rmSync\(tmpFile/.test(src)) {
      ok('语音', '音频用完即删（finally 里 rmSync 临时文件）—— 本地只留文字');
    } else {
      bad('语音', '没看到转写完删掉音频', '他的语音会留在磁盘上，这条是他明确在意的隐私');
    }
    const baseLine3 = (() => { const all = src.split('\n'); const i1 = all.findIndex((l) => l.includes('const baseStable = ')); const i2 = all.findIndex((l) => l.includes('const baseDynamic = ')); return i1 >= 0 ? all.slice(i1, (i2 > i1 ? i2 : i1) + 12).join('\n') : ''; })();
    if (baseLine3.includes('voiceLine')) ok('语音', '规矩只在开着的时候拼进提示词');
    else warn('语音', '规矩没拼进提示词', '她可能不知道自己能听懂语音');
    let prSrc3 = '';
    try { prSrc3 = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
    if (/key: 'voice-transcribe'/.test(prSrc3)) ok('语音', '规矩登记进了 RULE_INVENTORY');
    else warn('语音', '规矩没登记', '以后没人知道她被交代过这条');
    let cfgSrc = '';
    try { cfgSrc = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'); } catch {}
    if (/"transcribe"\s*:/.test(cfgSrc)) ok('语音', 'config 里有开关（要停就 transcribe=false）');
    else warn('语音', 'config 里没有语音开关', '想关掉得改代码');
  }

  // 10h. 长文续读（她在执行申请 #1 里提的需求）必须走**已有的带防护的抓取**，不许另起裸脚本
  //   她原方案是 `tools/fetch_text.py`（urllib 直连）+ 接到她工具口上 —— 那等于绕开 safe-fetch 的
  //   SSRF 防护（她就能抓 127.0.0.1:3100 控制台/内网/云元数据），所以改成了给现有 web_fetch 加分页参数。
  {
    if (fs.existsSync(path.join(ROOT, 'tools', 'fetch_text.py'))) {
      warn('长文续读', '存在 tools/fetch_text.py（裸抓取，没有 SSRF 防护）', '分页请走 src/safe-fetch.js，别绕开防护');
    } else {
      ok('长文续读', '没有绕开 safe-fetch 的裸抓取脚本');
    }
    const sf = fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8');
    const ws = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
    if (/export function pageOf/.test(sf) && /safeFetch\(urlString, maxChars = 50000, offset = 0\)/.test(sf)
      && /nextOffset/.test(sf) && /offset/.test(ws) && /nextOffset/.test(ws)) {
      ok('长文续读', 'web_fetch 有 offset 分页（按码点切、返回 nextOffset），走的是 safe-fetch');
    } else {
      bad('长文续读', 'web_fetch 的 offset 分页不完整', '长文还是只能读到前 50000 字');
    }
    if (/Array\.from\(/.test(sf.slice(sf.indexOf('export function pageOf'), sf.indexOf('export function pageOf') + 400))) {
      ok('长文续读', '分页按码点切（不会把 emoji 劈成半个，之后每次请求带非法字符）');
    } else {
      bad('长文续读', '分页可能用了裸 slice', '切在代理对中间 → 非法字符 → 请求 400');
    }
  }

  // 10g. 人格卡（roles/*.md）不许超注入上限：超了会**静默截断末尾**，而末尾正是新加的规矩
  //   （2026-10-10 实测：加"申请通道"那两行时卡片 8982/9000，一加就 9131 → 截断把新规矩整行吃掉）。
  {
    let cap = 9000;
    try { cap = Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.roleCard?.maxChars) || 9000; } catch { /* 用默认 */ }
    let files = [];
    try { files = fs.readdirSync(path.join(ROOT, 'roles')).filter((f) => f.endsWith('.md')); } catch { /* 没目录 */ }
    const over = [];
    let maxSeen = 0;
    for (const f of files) {
      const n = fs.readFileSync(path.join(ROOT, 'roles', f), 'utf8').length;
      maxSeen = Math.max(maxSeen, n);
      if (n > cap) over.push(`${f} ${n}`);
    }
    if (!files.length) warn('人格卡', 'roles/ 里没有 .md');
    else if (!over.length) ok('人格卡', `${files.length} 张卡都在上限内（最大 ${maxSeen} / ${cap}）`);
    else bad('人格卡', `超上限会被静默截断：${over.join('、')}（上限 ${cap}）`, '截断砍的是**末尾**那几行 —— 新加的规矩往往就在那儿，等于白写');
  }

  // 10e. 岗位技能库（2026-10-10）：仓库 `dsh/skills/` ⇄ 已安装的 `~/.dsh/skills/` 不许漂移
  //   漂移的后果很具体：仓库里 review 过的流程改了，机器上跑的 agent 用的还是旧版本 ——
  //   而技能正是"这个岗位怎么干活"的知识，用旧版本干活等于按过期手册操作。
  {
    const repoSkills = path.join(ROOT, 'dsh', 'skills');
    const homeSkills = path.join(process.env.USERPROFILE ?? '', '.dsh', 'skills');
    const listSkills = (dir) => {
      if (!fs.existsSync(dir)) return null;
      const out = new Map();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const f = path.join(dir, e.name, 'SKILL.md');
        if (fs.existsSync(f)) out.set(e.name, fs.readFileSync(f, 'utf8'));
      }
      return out;
    };
    const repo = listSkills(repoSkills);
    const home = listSkills(homeSkills);
    if (!repo) {
      bad('岗位技能库', '仓库里没有 dsh/skills/', '技能库是"数字员工"的岗位知识，代码里必须有一份');
    } else if (repo.size < 3) {
      warn('岗位技能库', `技能只有 ${repo.size} 个`, '改桥接/排查/插件准入/学习链刷新这几条流程至少各一条');
    } else {
      ok('岗位技能库', `仓库里有 ${repo.size} 个技能：${[...repo.keys()].join(', ')}`);
    }
    if (!home) {
      warn('岗位技能库', '~/.dsh/skills 还没装', '跑 `node scripts/setup-dsh.mjs` 同步（或手工拷）');
    } else {
      const missing = [...(repo ?? new Map()).keys()].filter((k) => !home.has(k));
      const drifted = [...(repo ?? new Map()).entries()].filter(([k, v]) => home.has(k) && home.get(k) !== v).map(([k]) => k);
      if (!missing.length && !drifted.length) {
        ok('岗位技能库', '已安装副本与仓库完全一致（没漂移）');
      } else {
        bad('岗位技能库', `副本与仓库不一致：缺 ${missing.join(', ') || '无'}；内容不同 ${drifted.join(', ') || '无'}`,
          '跑 `node scripts/setup-dsh.mjs` 重新同步；agent 会照着**机器上那份**干活');
      }
    }
    // 每个技能必须有 frontmatter（name/description），否则 DSH 不把它列进目录
    const badFm = [...(repo ?? new Map()).entries()].filter(([, body]) => !/^---\n[\s\S]*?name:\s*\S/.test(body) || !/description:\s*\S/.test(body)).map(([k]) => k);
    if (!badFm.length) ok('岗位技能库', '每个技能都有 name/description frontmatter');
    else bad('岗位技能库', `缺 frontmatter：${badFm.join(', ')}`, '没有 frontmatter 的技能不会出现在会话目录里，等于没写');
    // 验收入口必须一直在（"干完必须自证"是这条链的地基）
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* ignore */ }
    if (pkg?.scripts?.verify && fs.existsSync(path.join(ROOT, 'scripts', 'verify.mjs'))) {
      ok('岗位技能库', '`npm run verify` 存在（批测 + self-check 单一结论）');
    } else {
      bad('岗位技能库', '`npm run verify` 不见了', '没有一条命令的验收入口，agent 迟早会跳过验收');
    }
  }


  // 10b. 控制台页面（public/console.html）的按钮必须打**存在且真管事**的接口
  //    （2026-10-02 管理员：「web 前端那个全局静默按钮是不是用不了，之前按了没反应」——
  //      查下来是真的：那个按钮打的是 `/api/role-mode`，改的是**老的 roleState.mode**，
  //      跟"全局静默"（silentAll）不是一个东西，所以在二代模式下按了等于没按。
  //      两个开关现已合并，这里把"前端按钮 → 接口 → 真的开关"这条链固定下来。）
  {
    let page = '';
    try { page = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'); } catch { /* 缺文件下面会报 */ }
    if (!page) {
      bad('控制台页面', 'public/console.html 读不到');
    } else {
      if (/async function setSilence\(on\)[\s\S]{0,400}?\/api\/socialV2\/silent/.test(page)) {
        ok('控制台页面', '静默按钮的处理函数打的是 /api/socialV2/silent（权威接口）');
      } else {
        bad('控制台页面', '静默按钮没打 /api/socialV2/silent', '会像以前那样"按了没反应"（打到了别的接口）');
      }
      if (/getElementById\('silentOn'\)\.addEventListener[\s\S]{0,120}?setSilence\(true\)/.test(page)
        && /getElementById\('silentOff'\)\.addEventListener[\s\S]{0,120}?setSilence\(false\)/.test(page)
        && /by: 'console\.html'/.test(page)) {
        ok('控制台页面', '两个按钮都接到了 setSilence，且标明来源（by=console.html）');
      } else {
        warn('控制台页面', '按钮接线/来源标记可能不对', '出问题时看不出是谁开的静默');
      }
      if (/id="silentMsg"/.test(page)) {
        ok('控制台页面', '按钮结果**写在页面上**（成功/失败都有回显）', '不再"点了没反应"');
      } else {
        warn('控制台页面', '按钮没有结果回显', '接口失败时用户只会觉得"没反应"');
      }
      // 通用网：页面引用的每个 /api 路径，桥接里都得有（否则那个按钮必然静默失效）
      const paths = [...new Set([...page.matchAll(/['"`](\/api\/[a-zA-Z0-9_\-/]+)/g)].map((m) => m[1]))];
      const missing = paths.filter((p) => !src.includes(`'${p}'`) && !src.includes(`"${p}"`) && !src.includes(`'${p.replace(/\/$/, '')}/`));
      if (!missing.length) {
        ok('控制台页面', `页面引用的 ${paths.length} 个 /api 路径桥接里都有`);
      } else {
        bad('控制台页面', `${missing.length} 个 /api 路径桥接里找不到`, `${missing.slice(0, 4).join(' / ')} —— 那些按钮会静默失效`);
      }
      if (/\/api\/socialV2\/silent'[\s\S]{0,400}?setSilentAll\(/.test(src)) {
        ok('控制台页面', '这个接口真的落到 setSilentAll（不是只改了个字段）');
      } else {
        bad('控制台页面', '/api/socialV2/silent 没落到 setSilentAll');
      }
    }
  }

  if (/qq_read_file/.test(src)) {
    ok('按需看图', '收到文档时会告诉她可以自己翻页');
  } else {
    warn('按需看图', '文档提示里没提这个工具', '她可能不知道能自己翻别的页');
  }
  // 文档图的额度必须独立：共用 5 张的额度时，一条带 5 张照片的消息会把文档图全挤掉，
  // 而消息文本里还写着"附上了 N 张图" —— 她以为看到了、其实一张没收到。
  if (/MAX_DOC_IMAGE_COUNT/.test(src) && /docIndex > MAX_DOC_IMAGE_COUNT/.test(src)) {
    ok('按需看图', '文档图的额度与 QQ 图片分开计');
  } else {
    bad('按需看图', '文档图和 QQ 图片共用额度', '带照片的消息会把文档图挤掉，但提示词却说"已附上"');
  }
  if (/only 4 页|只有 \$\{totalPages\} 页/.test(src) && /noImagePages/.test(src)) {
    ok('按需看图', '越界页/无图页都如实告知', '不会让她把"没取到"当成"这页没有图"');
  } else {
    warn('按需看图', '越界页/无图页的说明被删了');
  }
  if (/FILE_CACHE_MAX_BUFFER_BYTES/.test(src)) {
    ok('按需看图', '文件缓存有总字节上限', '文档要留原始 buffer，只限条数会吃爆内存');
  } else {
    warn('按需看图', '文件缓存只按条数限制', '20 份 32MB 文档 = 640MB');
  }
  // 读类端点必须校验"真令牌"，不能只判非空：只判非空的话编个字符串就能把文档读走
  // （实测抓到：伪造的 48 位十六进制串照样返回了文档信息）
  {
    const views = src.match(/currentMode === 'reserved2' && agentToken && !KNOWN_AGENT_TOKENS\.has\(agentToken\)/g) ?? [];
    if (views.length >= 2) {
      ok('安全边界', `读类端点校验真令牌（${views.length} 处）`, '编排的假令牌会被拒');
    } else {
      bad('安全边界', `读类端点只判"带了令牌"（真令牌校验只有 ${views.length} 处）`,
        '随便编一个字符串就能读走文档/图片');
    }
  }

  // 兜底重试链路（2026-09-28 实测事故：private 一边被限流重排 26 次、一边忙了 15 分钟）
  {
    const retryBody = /st\.pendingWakeRetryTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, wakeRetryMs\(\)\)/.exec(src)?.[1] ?? '';
    const busyAt = retryBody.indexOf('isConversationBusyV2(key, st)');
    const rateAt = retryBody.indexOf('isWakeRateLimited(st,');
    if (busyAt > 0 && rateAt > 0 && busyAt < rateAt) {
      ok('重试链路', '繁忙判断在限流判断之前（保险才能触发）');
    } else {
      bad('重试链路', '限流判断又跑到繁忙前面了（或抓不到那两处判断）',
        `busyAt=${busyAt} rateAt=${rateAt}；顺序反了的话"忙碌+限流"时保险会被饿死`);
    }
    const iv = /const DEFER_LOG_INTERVAL_MS = ([^;]+);/.exec(src)?.[1] ?? '';
    if (/5 \* 60 \* 1000|300000/.test(iv)) {
      ok('重试链路', '日志节流间隔是 5 分钟量级', '和 60s 的重试间隔一样大时等于没节流');
    } else {
      bad('重试链路', `日志节流间隔太小（${iv}）`, '卡 15 分钟会刷 15 行"仍然繁忙"');
    }
    if (/waitingUntil/.test(src) && /沉睡前观察/.test(src)) {
      ok('重试链路', '"繁忙"日志会区分"在等"还是"在干"', 'qq_wait_for_messages 占了实测一半以上耗时');
    } else {
      warn('重试链路', '繁忙日志没有"她正在沉睡前观察"的说明');
    }
    if (/现在补上/.test(src)) {
      ok('重试链路', '恢复时会报"卡了约 N 分钟，现在补上"');
    } else {
      warn('重试链路', '恢复时没有时长说明');
    }
    if (/function wakeRetryMs/.test(src)) {
      ok('重试链路', '兜底重试间隔可配（测试不用真等 60s）');
    } else {
      warn('重试链路', '重试间隔写死了', '离线测不了整条重试链路');
    }
  }

  // 限流分档 + 文件上限分档（2026-09-28 用户截图的两次投诉）
  {
    if (/function isDirectWakeV2/.test(src) && /maxDirectWakePerHour/.test(src)) {
      ok('限流分档', '"有人直接找她"走宽松额度', '实测：私聊连喊"人呢"被严格限流压了 13 分钟');
    } else {
      bad('限流分档', '直接唤醒没有独立额度', '别人叫她也会被"省成本"的限流挡住 → 她不回话');
    }
    if (/maxDirectWakePerMinute/.test(src) && /maxDirectWakePerMinute/.test(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))) {
      ok('限流分档', '宽松额度可配且有示例');
    } else {
      warn('限流分档', '宽松额度没有写进 config.example.json');
    }
    if (/TEXT_MAX_BYTES/.test(src) && /isText \? TEXT_MAX_BYTES/.test(src)) {
      ok('文件上限', '文本类文件走 16MB 档', '实测 7.77MB 的日志 .txt 卡在 4MB 上限读不了');
    } else {
      bad('文件上限', '文本文件还是 4MB 档', '大日志文件会"读取失败"');
    }
    if (/内容超过下载上限/.test(fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8'))) {
      ok('文件上限', '超限报错不再写死"图片"', '实测 mp4 报"图片超过大小限制"，排查时会被带偏');
    } else {
      warn('文件上限', 'safe-fetch 的报错文案还是"图片"');
    }
    if (/server\.keepAliveTimeout = 65000/.test(src)) {
      ok('连接稳定', 'HTTP 服务 keep-alive 抬到 65s', '避免 undici 复用被关的连接 → 偶发 "fetch failed"');
    } else {
      warn('连接稳定', 'keep-alive 还是 Node 默认 5s', '可能有偶发 fetch failed（keep-alive 竞态）');
    }
    if (/retriedAfterTransientError/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'))) {
      ok('连接稳定', '等待工具遇到连接被掐会重试一次并说明原因');
    } else {
      warn('连接稳定', '等待工具对 "fetch failed" 没有兜底');
    }
    // 文本编码探测（实测：7.77MB 的 GBK 日志她"能看到了，但全是乱码"）
    if (/function decodeTextBuffer/.test(src) && /gb18030/.test(src)) {
      ok('文本编码', '按 BOM → 严格 UTF-8 → GB18030 探测编码', '中文 Windows 的日志大多是 GBK');
    } else {
      bad('文本编码', '文本还是硬按 UTF-8 读', 'GBK 日志会全是乱码（用户实测过）');
    }
    if (/import \{ TextDecoder \} from 'node:util'/.test(src)) {
      ok('文本编码', 'TextDecoder 显式 import（不依赖全局）', '靠全局的话 vm 测试里会静默退化成有损解码');
    } else {
      warn('文本编码', 'TextDecoder 依赖全局', '某些沙箱里没有，编码探测会静默失效');
    }
    if (/中间省略/.test(src) && /tailLen/.test(src)) {
      ok('文本编码', '长文本给"头 + 尾"', '日志的异常堆栈在结尾，只给开头等于没给');
    } else {
      warn('文本编码', '长文本只截开头', '日志关键的报错在结尾');
    }
    if (/已自动转码/.test(src)) {
      ok('文本编码', '会告诉她"原文是 X 编码，已转码"', '免得她以为文件坏了');
    } else {
      warn('文本编码', '没告诉她编码已转换');
    }
    // 入站消息去重（她报的：同一条表情被推三遍，messageId 相同、seq 744/745/746）
    if (/seenIncomingRefs/.test(src) && /重复推送已忽略/.test(src)) {
      ok('消息去重', '同一 messageId 重复推送只处理第一次', 'SnowLuma 会重复投递同一条事件');
    } else {
      bad('消息去重', '入站消息没有去重', '同一条消息会被当成多条：重复进未读、重复唤醒');
    }
    // 2026-10-23 起入站处理重构过：下载块现在的标志是 `let incomingFiles = [];`。
    // 原来拿 `incomingFiles = (Array.isArray(event.message)` 当锚点，重构后恒为 -1 → 误报。
    if (src.indexOf('重复推送已忽略') >= 0 && src.indexOf('let incomingFiles') >= 0
        && src.indexOf('重复推送已忽略') < src.indexOf('let incomingFiles')) {
      ok('消息去重', '去重在下文件之前', '重复推送不会再重新下载一遍文件');
    } else {
      warn('消息去重', '去重在下文件之后', '重复推送会白下载文件');
    }
    // 按需读文本分段
    if (src.includes("'/api/socialV2/file-text'") && /nextFrom/.test(src)) {
      ok('按需读段落', '有按行/按关键词读文件某段的端点', '实测 11MB 的 txt 她只看得到开头');
    } else {
      bad('按需读段落', '端点不见了', '大文件她只能看到开头和结尾');
    }
    if (/endLine >= totalLines \? null : endLine \+ 1/.test(src)) {
      ok('按需读段落', '到末尾时 nextFrom 为 null（翻页会停）', '否则她会一直"继续读"读同一行');
    } else {
      bad('按需读段落', 'nextFrom 的收尾判断被改坏', '翻页可能永远停不下来');
    }
    if (/qq_read_file/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'))) {
      ok('按需读段落', 'MCP 工具 qq_read_file 已注册（读文/看图合并）');
    } else {
      bad('按需读段落', 'MCP 工具没注册', '她有端点也调不到');
    }
    // 发送配额：被拦的请求不能吃配额（实测：反复跑测试把她四个会话的配额耗光，
    // 她连正常回话都发不出去；而且含令牌的请求被报成"频率超限"，原因完全看不出）
    if (/function containsKnownSecret/.test(src)) {
      ok('发送配额', '有凭据预检，且排在限流之前', '含令牌的请求应报 403 而不是 429');
    } else {
      bad('发送配额', '缺少凭据预检', '含令牌的请求会先被限流拦成 429，还吃掉配额');
    }
    if (/clear-send-quota/.test(src)) {
      ok('发送配额', '有"清空发送配额"的管理端点', '配额被耗光时能立刻救回来');
    } else {
      warn('发送配额', '没有清配额端点', '配额被耗光只能等一小时自然滑出窗口');
    }
    if (/st\.sendTimes\.splice\(reservedFrom\)/.test(src)) {
      ok('发送配额', '发送失败会退还预占额度');
    } else {
      warn('发送配额', '发送失败可能不退额度');
    }
    {
      const send = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).socialV2?.send ?? {};
      if (Number(send.maxSendPerHour) >= 100) {
        ok('发送配额', `每小时上限 ${send.maxSendPerHour} 条、每分钟 ${send.maxSendPerMinute} 条（够她正常聊）`);
      } else if (Number(send.maxSendPerHour) >= 40) {
        ok('发送配额', `每小时上限 ${send.maxSendPerHour} 条（够她正常聊）`, '太低会在对话中途把她禁言');
      } else {
        warn('发送配额', `每小时上限只有 ${send.maxSendPerHour} 条`, '一次 turn 发 2 条，十几轮就撞满 → 她中途哑掉');
      }
    }
    // 限流被拒时必须说清"还要等多久"：只说"请稍后再试"她会一遍遍重试空转
    // （2026-09-28 用户截图：一次 turn 因此转了 5 分 55 秒）
    if (/function sendRateLimitInfo/.test(src) && /function sendLimitError/.test(src) && /不要连着重试/.test(src)) {
      ok('发送配额', '限流被拒时告诉她还要等多久、别重试');
    } else {
      bad('发送配额', '限流只回"请稍后再试"', '她不知道等多久 → 重试空转，用户看到的是"卡住"');
    }
    // 她回过话 = 唤醒时摆在她眼前的那批未读看过了（否则"未读 N 条"永远不变，
    // 而且 wait 的"有没看过的消息就秒回"会一直命中，她想安静等一会儿都做不到）
    if (/function markUnreadSeenAfterSend/.test(src) && /st\.wakeBaselineSeq = Number\(st\.lastUnreadSeq\)/.test(src)) {
      ok('未读状态', '她回话后把"唤醒时那批未读"标记为看过', '只推进到唤醒基线，唤醒后新到的消息仍然算未读');
    } else {
      warn('未读状态', '发消息后不推进"看过"进度', '"未读 N 条"会一直是老数字，wait 也可能一直秒回');
    }
    if (/markUnreadSeenAfterSend\(key\);\s*\n\s*st\.lastAiReplyAt/.test(src) || /markUnreadSeenAfterSend\(key\)/.test(src)) {
      ok('未读状态', '文本发送与表情发送都会推进');
    } else {
      warn('未读状态', '只有在部分发送路径推进');
    }
    if (/const maxShownSeq/.test(src) && /unreadCount: shown\.length/.test(src)) {
      ok('未读状态', '`qq_get_unread_messages` 读过的就从未读列表减掉', '消息仍在 recent 里，翻得到');
    } else {
      warn('未读状态', '读过未读也不清列表', '"未读 N 条"会一直停在同一数字，她会以为有积压');
    }
    // 临时角色扮演：只能提议、她自己决定、到期自动结束、能自己退出
    if (src.includes("'/api/socialV2/role-play'") && /function activeTempRole/.test(src)) {
      ok('临时角色', '有临时角色扮演端点与状态', '限时叠加，不是永久换人格');
    } else {
      bad('临时角色', '临时角色扮演机制不见了');
    }
    if (/action === 'accept'/.test(src) && /isAgent/.test(src) && /只有她/.test(src)) {
      ok('临时角色', 'accept/decline/exit 只认她的 agent token', '管理端不能替她决定');
    } else {
      bad('临时角色', '她自己表态的权限检查被删了', '那就变成"一要求就执行"，用户明确不要');
    }
    if (/expireTempRoleIfNeeded/.test(src) && /角色扮演结束/.test(src)) {
      ok('临时角色', '到期自动结束并让她自然收尾');
    } else {
      bad('临时角色', '没有到期自动结束', '会变成永久换人格');
    }
    if (/roleProposalCooldown/.test(src)) {
      ok('临时角色', '她拒绝后有冷却，不缠着重提');
    } else {
      warn('临时角色', '拒绝后没有冷却', '可能反复问她同一个角色');
    }
    if (!/adminOnlyV2Paths = \[[^\]]*role-play/.test(src)) {
      ok('临时角色', '该端点没进 adminOnlyV2Paths', '否则她自己调 accept 会被 403');
    } else {
      bad('临时角色', '端点被加进了 adminOnlyV2Paths', '她自己就调不了 accept/exit 了');
    }
    if (/qq_role_play/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'))) {
      ok('临时角色', 'MCP 工具 qq_role_play 已注册');
    } else {
      bad('临时角色', 'MCP 工具没注册', '她没法表态');
    }
    // 他在聊天里当面点菜时她要能自己接（用户："扮演从来没成功过"的根因 —— 原来只有控制台提议一条路）
    if (/action === 'start'/.test(src) && /bySelf: true/.test(src) && /她自己[\s\S]{0,30}答应演/.test(src)) {
      ok('临时角色', '她可以自己 start（聊天里点菜也能接）', '不然用户在聊天里要求 = 永远不生效');
    } else {
      bad('临时角色', '没有"她自己开演"的路径', '用户在聊天里要求扮演时她只能拒绝，功能等于摆设');
    }
    // 管理员身份命令 = 强制执行（用户 2026-09-29："管理员身份命令角色扮演这条也加上"）
    if (/function forceRolePlay/.test(src) && /byAdmin: true/.test(src) && /action === 'force'/.test(src)) {
      ok('临时角色', '管理员可强制命令她演（byAdmin，控制台 force + 聊天命令）');
    } else {
      bad('临时角色', '没有"管理员强制扮演"这条路径', '用户明确要求：以管理员身份命令则强制执行');
    }
    if (/tr\.byAdmin && Number\(tr\.until\) > now/.test(src) && /不能提前退/.test(src)) {
      ok('临时角色', '管理员命令的那一段，她自己 exit 会被拒', '否则"强制"形同虚设');
    } else {
      bad('临时角色', '她可以自己退出管理员命令的扮演', '强制执行就不成立了');
    }
    // 窗口从 80 放宽到 600：优先级表会长（2026-10-12 加了 taskRequestResult: 105，把 adminRole 推到了
    // 80 字符窗口之外，于是这条守卫**误报**了一次）。它要断言的是"表里还有 adminRole: 110"，
    // 不该因为别人在表里插了一行就红。
    if (/function parseAdminRoleCommand/.test(src) && /adminRole/.test(src) && /WAKE_PRIORITY[\s\S]{0,600}adminRole: 110/.test(src)) {
      ok('临时角色', '聊天里的命令由桥接直接执行并立刻唤醒（优先级最高）');
    } else {
      warn('临时角色', '缺少"聊天命令 → 桥接直接执行"这条链路', '只写提示词里的话模型可能不照做');
    }
    if (/pausedExempt/.test(src)) {
      ok('临时角色', '暂停时 role-play 仍可改状态', '测试靠它隔离（暂停→改→恢复），不再污染正在聊的会话');
    } else {
      warn('临时角色', '暂停时角色扮演端点也被拦', '测试没法安全隔离');
    }
    // 演着的时候能自己换角色（用户 2026-09-29 问"她是不是无法自主切换临时角色卡"）
    // 自愿的能换；管理员强制的那段不能（"以管理员身份命令则强制执行"）。
    if (/switchedFrom/.test(src) && /不能换角色/.test(src)) {
      ok('临时角色', '演着的时候可以自己换角色（管理员强制的那段不能换）', '原来一律 409"先 exit"，她只能先退再演');
    } else {
      warn('临时角色', '她演着的时候换不了角色', '用户问过这条：只能先 exit 再 start，容易卡住');
    }
    // 跨会话不能再"静默挂错"（2026-09-29 实况：她想把卡挂到 CS 群，结果挂在私聊上还回 ok）
    if (/只作用于\*\*你正在说话的这个会话\*\*/.test(src) && /readOnly: true/.test(src)) {
      ok('临时角色', '她自己不能远程给别的会话开演（写操作 403 说清；读只读放行）', '原来忽略 key、静默挂到当前会话');
    } else {
      bad('临时角色', '跨会话写操作不再拦', '她会以为挂到了某个群，其实挂在别的会话上');
    }
    // 角色名两侧的话搭子要剥掉（"扮演成一个猫娘女仆" 不能变成「成一个猫娘女仆」）
    if (/function stripRoleFiller/.test(src) && /stripRoleFiller\(m\[1\]\)/.test(src)) {
      ok('临时角色', '角色名会剥掉"成/一个/这个角色"这类话搭子', '"扮演成一个猫娘女仆"曾解析成「成一个猫娘女仆」，卡就找不到了');
    } else {
      warn('临时角色', '角色名可能带上动词尾巴', '找不到卡 → 卡里的规矩（比如"每两条挂个喵"）进不了提示词');
    }
    // 角色扮演状态必须**落盘**（2026-09-29 第 4 个 bug：这几个字段不在写盘白名单里，
    // 桥接一重启"她正在演某某到几点"就静默消失 —— 用户那场"演到 20:00"的戏就是这么没的）
    if (/\.\.\.rolePlayFieldsForSave\(st\)/.test(src) && /\.\.\.restoreRolePlayFields\(val\)/.test(src)
      && /function sanitizeStoredTempRole/.test(src) && /function sanitizeStoredRoleProposal/.test(src)) {
      ok('临时角色', '扮演状态会落盘、重启后接着演（存/读两侧都归一化）', '原来只活在内存里，重启就静默没了');
    } else {
      bad('临时角色', '扮演状态又只放内存了', '重启后她突然不演了，而且没有任何日志');
    }
    // 管理员命令口吻不该被"翻旧账"：落盘后超过 10 分钟的不再当命令
    if (/ADMIN_CMD_FRESH_MS/.test(src) && /if \(stale\) return ''/.test(src)) {
      ok('临时角色', '重启后太久远的管理员命令不再当命令执行', '避免把几小时前的老命令翻出来执行');
    } else {
      warn('临时角色', '管理员命令没有时效判断', '落盘后可能把旧命令当新命令执行');
    }
    {
      const mcpSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
      if (/async \(\{ key, token, action, role, minutes, hint, card, name, sources \}\)/.test(mcpSrc2)
        && /JSON\.stringify\(\{ key, action, role/.test(mcpSrc2)) {
        ok('临时角色', 'MCP 层把 key 原样转发给桥接', '原来这里把 key 丢了 → 跨会话"挂错"根本没被拦');
      } else {
        bad('临时角色', 'MCP 层仍然丢掉 key', '她想挂到某个群时会静默挂在当前会话');
      }
    }
    // 控制台"会话 key"容错：裸群号/QQ号自动补前缀（2026-09-29 用户截图）
    if (/function coerceConversationKey/.test(src) && /coerceConversationKey\(parsed\.key\)/.test(src) && /KEY_HINT/.test(src)) {
      ok('控制台', '"会话"输入容错：裸群号/QQ号自动补 group:/private: 前缀', '他填裸号码点按钮，原来只回一句"key 格式应为…"');
    } else {
      warn('控制台', '"会话"只认 group:/private: 前缀', '填裸群号就报格式错误，看起来像"功能坏了"');
    }
    // 管理员命令在**哪个会话**里都算（他可能在小号/群里下命令："小号那句不认"）
    // 2026-10-02：isOwner 分支里现在最前面还有"全局静默"命令（桥接直接执行），
    //   所以不能要求 parseAdminRecallCommand 紧跟其后 —— 用宽松窗口仍能守住"群里也认命令"。
    // 2026-10-23：isOwner 分支和 parseAdminRecallCommand 之间隔了全局静默/权限模式等好几段，
    // 1200 字符窗口已经盖不住（重构后恒为 -1 → 误报）。改成三个锚点都在即可。
    if (/放开到\*\*所有会话\*\*/.test(src) && /parseAdminRecallCommand\(/.test(src) && /isOwner/.test(src)) {
      ok('管理员命令', '群里的「以管理员身份」命令也算（不再只认私聊）');
    } else {
      warn('管理员命令', '管理员命令只认私聊', '他在群里/小号下的命令会被当成普通聊天');
    }
    // ── 群语料库 / 群风格卡（用户 2026-09-29：「这些数据可以拿来给 onebot 学习吗」）──────
    //   数据 → 统计特征 → 按群注入提示词。四件事：只收群聊/别人、只注入群聊、有上限、可关闭。
    if (/function feedGroupCorpus/.test(src) && /GROUP_CORPUS_FILE/.test(src) && /function readGroupCorpus/.test(src)) {
      ok('群语料库', '群友的群聊文本会存进 state/group-corpus.jsonl', '原来语料是"用完就丢"，四天只剩 1500 条可回看');
    } else {
      bad('群语料库', '没有长期语料库', '风格卡/例句/黑话补课都没有稳定底料');
    }
    if (/selfDisplayNames\(\)/.test(src) && /她自己说的话不进语料/.test(src)) {
      ok('群语料库', '不收她自己说的话（免得学成自恋）', '把她自己的口吻当"群里的口吻"会越学越怪');
    } else {
      warn('群语料库', '没排除她自己说的话', '风格卡可能把她的口吻统计成群风格');
    }
    if (/function describeGroupStyle/.test(src) && /不含任何人的原话/.test(src) && /clip\(out, c\.generalMaxChars\)/.test(src)) {
      ok('群风格卡', '从语料统计出"这里怎么说话"，且不含任何人的原话', '只注入统计特征，隐私风险最低');
    } else {
      bad('群风格卡', '没有风格卡生成逻辑');
    }
    if (/function buildChatStyleLine/.test(src) && /const general = generalStyleProfile\(\)/.test(src)
      && /const perGroup = isGroup \? groupStyleProfiles\(\)\[key\] : null;/.test(src)) {
      ok('聊天模版', '私聊只有通用层、群聊才有"本群说话的样子"', '私聊里塞"本群"口径会串味');
    } else {
      warn('聊天模版', '两层的注入范围没区分开', '私聊可能被塞进"本群"口径');
    }
    if (/corpusConfig\(\)/.test(src) && /maxLines/.test(src) && /maxBytes/.test(src) && /trimGroupCorpus/.test(src)) {
      ok('群语料库', '条数 + 字节双上限，超了留最近一半', '不会无限长大，也不会悄悄删干净');
    } else {
      warn('群语料库', '语料库没有体积上限', '长期跑会把磁盘吃满');
    }
    if (/ttlHours/.test(src) && /groupStyleCache/.test(src)) {
      ok('群风格卡', '有 TTL + 内存缓存（不是每轮重算）', '默认 24h 重建一次，成本可忽略');
    } else {
      warn('群风格卡', '风格卡每轮重算', '会白白吃掉 CPU/IO');
    }
    if (/state\/style-examples\.json|GROUP_STYLE_EXAMPLE_FILE/.test(src) && /别照抄原话/.test(src)) {
      ok('例句范例', '例句来自可编辑的 style-examples.json，并提示她"别照抄"', '例句是改写/自写的，不直接外发群友原话');
    } else {
      warn('例句范例', '没有例句机制', '少了"具体什么味道"的锚点');
    }
    // 通用底层层（用户 2026-09-29："群聊私聊的聊天方式能不能总结成一个不断更新的通用模版，
    // 在所有聊天作为底层聊天逻辑里启用"）
    if (/generalEnabled/.test(src) && /__all__/.test(src) && /if \(general\)/.test(src) && /【打字习惯（通用底层/.test(src)) {
      ok('聊天模版', '通用底层层：群聊+私聊一起统计，注入**所有**会话', '他要的"底层聊天逻辑"');
    } else {
      bad('聊天模版', '没有通用底层层', '只有每群卡的话私聊就享受不到');
    }
    if (/generalStyleProfile/.test(src) && /refreshAfterNewMessages/.test(src) && /corpusBytesNow/.test(src)) {
      ok('聊天模版', '"不断更新"：TTL 到期或语料涨够条数就自动重建', '不用手动点；statSync 判断增长，几乎零成本');
    } else {
      warn('聊天模版', '模版不会自动更新', '要手动重建才更新，语料涨了也用不上');
    }
    // 通用层/本群层"不许说两遍" + 缩写不许拿单群的当通用（2026-10-01 实测：
    //   语料 74% 来自 group:1054156254 → 通用层≈那个群，群聊每轮把同一套统计说两遍 ≈ 白花 143 token/轮；
    //   而 topAbbrev 原来不分会话，把 mad/nbu 这类单群缩写当"通用常见缩写"教给她，还注进私聊）
    if (/sameAsGeneral/.test(src) && /reference: general\?\.stats/.test(src) && /minConvs/.test(src)) {
      ok('聊天模版', '本群层只列与通用层不一样的行，缩写要≥2个会话才算通用', '实测群聊每轮省 ≈176 字符；单群缩写不再串味');
    } else {
      bad('聊天模版', '通用层/本群层又变成复读了（或缩写又不分会话）', '群里每轮白花约 143 token，还会把别群的梗当通用习惯教给她');
    }
    // 语气：别粘成"一整句" + 别过度玩梗（用户 2026-09-29 连续两次指出，第二次纠正了方向：
    //   "也不是接梗，就是说话语气变成一整句了，过度玩梗会令人厌烦的"）
    // ⚠️ 2026-10-17 压提示词后，小节标题【一句话只说一件事，别粘成"一整句"】删了
    //    （它和【说话的样子】的"一条消息=一个短句""逗号能不用就不用"完全重复）。
    //    所以不再要求那个标题，改守**规则实质**：逗号那条（他的原话就在里面）、
    //    别过度玩梗（唯一出处）、以及"先接梗"不能出现（他纠正过方向）。
    if (/逗号能不用就不用/.test(RULE_TEXT) && /说话语气变成一整句了/.test(RULE_TEXT)
      && /别过度玩梗/.test(RULE_TEXT) && !/先接梗/.test(RULE_TEXT)) {
      ok('说话语气', '每轮都叫停"逗号把两件事粘成一句"，并明确"别过度玩梗"', '他第二次的原话；实测她当时 45.6% 的消息是这种粘句');
    } else {
      bad('说话语气', '缺少"别粘成一整句 / 别过度玩梗"这条', '他会继续说语气不对（他已经说了两次）');
    }
    if (/不是接梗/.test(RULE_TEXT)) {
      ok('说话语气', '把"我一开始理解错、他说不是接梗"的经过写在注释里', '免得以后又改回"先接梗"那个方向');
    } else {
      warn('说话语气', '没有留下"这不是接梗问题"的记录', '下次可能又被理解成要她多接梗');
    }
    // 安慰 + 听懂（2026-10-01 管理员：「说话逻辑是不是还有问题，感觉有时候听不懂别人在说什么，
    //   还有感觉她不会安慰别人」）。现场：他说「嗓子好难受…」，她回「阿莫西林是抗生素…」。
    // 关键教训：当时那条「别动不动给人说教」**就在注入的记忆里**，她还是犯 ——
    // 因为**没有触发条件的禁令等于没有**。所以这里守的是"规则必须写成**场景**（别人难受时…）"。
    if (/【别人不好受时怎么接】/.test(RULE_TEXT) && /先接住情绪/.test(RULE_TEXT) && /阿莫西林是抗生素/.test(RULE_TEXT)
      && /不损、不嘴硬、不开玩笑/.test(RULE_TEXT)) {
      ok('安慰', '每轮都注入"别人不好受时怎么接"，并钉着她自己那次药理课的反例', '实测：他难受时她上了一堂科普课');
    } else {
      bad('安慰', '缺少"别人难受时怎么接"这条场景化规则', '她会继续用科普/说教回答别人的难受（管理员已经提过）');
    }
    if (/【刚发生的几条】/.test(src) && /直接回最下面那条/.test(src)
      && /replyToMessageId=<那个第几条>/.test(src)) {
      ok('听得懂', '把最近几条（谁/第几条/说了什么）直接摆到眼前，接话和引用都不用先调工具', '原来只给"最近一条"的前 30 字，一快起来就凭半句猜');
    } else {
      bad('听得懂', '提示词里没有把最近几条摆出来', '她只能凭最后半句猜别人在说什么 → 答非所问');
    }
    if (/别只说结论/.test(RULE_TEXT) && /"那\/所以\/反正\/行行"开头的话/.test(RULE_TEXT)) {
      ok('听得懂', '要求"那/所以/反正"开头必须带依据（别只给结论）', '实测她 12% 的自发言是这种"只有她自己懂"的结论句');
    } else {
      warn('听得懂', '没有"别只说结论"这条', '她会继续说只有自己听得懂的话，对方只能回"啥意思"');
    }
    if (/function looksLikeBehaviorRule/.test(src)) {
      ok('纠错留痕', '说话方式的纠正写入时自动升成 high（不被 48 小时半衰期带走）', '她标错重要性时也不会丢');
    } else {
      warn('纠错留痕', '行为纠正没有写入侧兜底', '万一被标成 normal，两天后这条纠正会自己消失');
    }
    // 幽灵等待兜底（2026-10-01：她报了 3 次"该会话已有一个等待中的 qq_wait_for_messages"卡十几分钟，
    //   wait 和收尾都靠它 → 会话冻住）。释放名额要挂三个事件 + waitingUntil 兜底。
    if (/req\.on\('aborted', finishWait\)/.test(src) && /清掉幽灵等待/.test(src)) {
      ok('等待不卡死', 'wait 名额挂在 close/aborted/res close 三个事件上，并用 waitingUntil 兜底清幽灵', '她今天报过 3 次卡住十几分钟');
    } else {
      bad('等待不卡死', 'wait 名额可能漏释放（幽灵等待）', '连接被掐断后该会话会一直"已有一个等待中"，收尾也做不了');
    }
    // 别播报自己的理解状态（2026-10-01 23:10 截图：「我上句没接住，你那个"那就是真的"是指哪件事啊」）
    //   —— 这是系统日志的语气，而且"接住"这词是从提示词里抄的；真人直接问内容。
    if (/问的时候别播报自己的状态/.test(RULE_TEXT) && /我上句没接住/.test(RULE_TEXT)) {
      ok('不说自我复盘', '问的时候直接问内容，不播报"我没接住/我没跟上"', '否则她像在给自己写运行日志');
    } else {
      warn('不说自我复盘', '缺少"别播报自己的状态"这条', '她会继续用"我上句没接住"这种系统日志腔提问');
    }

    // 全局静默（2026-10-02：管理员「全局静默用不了，我也不能远程让她关了」）
    if (/function parseSilenceCommand/.test(src) && /function setSilentAll/.test(src)
      && (src.match(/if \(silentAllBlocks\(key\)\)/g) ?? []).length >= 4) {
      ok('全局静默', '桥接层硬开关：群里四个发送端点全拦 + 不再唤醒她；管理员私聊照常', '他在 QQ 私聊说「全局静默」/「解除静默」即可远程开关');
    } else {
      bad('全局静默', '全局静默没做成硬闸门（或发送端点没接上）', '他会继续遇到"她答应了但还在群里说话"');
    }
    // 已经在潜水时再收紧触发条件，不该被"沉睡前观察"拦（这就是她"静默开不成"的 400）
    if (/const wasSleeping = isSleepingConfigV2\(st\.wakeConfig\)/.test(src)) {
      ok('唤醒配置可收紧', '已在潜水时再设潜水配置不再被观察窗口拦', '原来她想关掉提问/概率会被 400，只能求管理员去管理端');
    } else {
      warn('唤醒配置可收紧', '收紧触发条件仍可能被观察窗口拦', '她会继续"静默开不成"');
    }

    // 报错不许发进出事的会话（2026-10-02：8 条「⚠️ agent 处理出错：SSE stream ended without [DONE]」被发进两个群）
    if (/async function notifyAgentError/.test(src) && /async function notifyOwnerOnly/.test(src)
      && !/sendToQQ\(key, `⚠️ agent 处理出错/.test(src)) {
      ok('报错只进管理员', '报错/运维文案走 notifyOwnerOnly（管理员私聊）+ 同类 10 分钟折叠', '原来会往群里刷系统报错');
    } else {
      bad('报错只进管理员', '报错又发进出事的会话了', '群里会看到"agent 处理出错"这种系统报错');
    }
    // 系统文案的"人格"问题（2026-10-10 管理员反馈："感觉像是另一个人格了"）：
    //   这些回执是用**她的 QQ 号**发出去的，不加标记、又发进群时，看起来就是"另一个人在拿她的号说话"。
    {
      // ⚠️ 2026-10-19 起 notifyOwnerSystem **不再发 QQ**（管理员："全关呗，真有问题了我会在客户端上面调"），
      //   所以"带【系统】前缀"这条不再成立（没有消息出去了）。只留着门函数本身。
      if (/async function notifyOwnerSystem\(/.test(src)) {
        ok('系统文案', '发给管理员的系统消息统一带【系统】前缀', '一眼看出不是她说的');
      } else {
        bad('系统文案', '缺少带【系统】前缀的统一出口', '翻聊天记录会像"她在说系统话"');
      }
      // 2026-10-10 管理员同意后补的一层：回执也要在她的上下文里留一条"系统代发"便条，
      // 否则"我的号发过什么"和"我记得什么"永远对不上（被问起只能发懵）。
      if (/function recordSystemReceiptNote\(/.test(src) && /if \(record\) recordSystemReceiptNote\(/.test(src)
        && /不是你说的/.test(src)) {
        ok('系统文案', '回执同时在她上下文留"系统代发"便条（写明不是她说的）');
      } else {
        bad('系统文案', '回执没有写进她的上下文', '她的号和她的记忆会对不上');
      }
      if (/sendToQQ\(key, '⏳/.test(src)) {
        bad('系统文案', '排队提示还在往会话里发', '群友会看到她的号在播报系统消息（还绕过全局静默）');
      } else if (/notifyOwnerSystem\(`⏳ DSH 还没就绪/.test(src)) {
        ok('系统文案', 'DSH 未就绪的排队提示只发管理员', '群里不再出现系统播报');
      } else if (/log\(`\[queue\] ⏳ DSH 还没就绪/.test(src)) {
        // 2026-10-19 起：运维状态连管理员私聊也不发了（他说"老是出现在聊天界面太难受了"），
        // 只记日志 + 控制台活动流。
        ok('系统文案', 'DSH 未就绪的排队提示只记日志（不发任何人）', '聊天界面不再有运维播报');
      } else {
        warn('系统文案', '找不到排队提示的处理', '');
      }
      const groupNoise = (src.match(/sendToQQ\(key, '(⏳|🔇|🔊|🔓|🔒|✅|🚫)/g) ?? []).length;
      if (groupNoise === 0) ok('系统文案', '没有"固定系统文案直接发进会话"的写法');
      else warn('系统文案', `还有 ${groupNoise} 处固定系统文案发进会话（key 可能是群）`, '检查是否该走 notifyOwnerSystem');
    }
    // 回合出错不算"无行动"（否则连续 3 次失败会把她的唤醒配置重置掉）
    if (/const turnFailed = ended\.reason\.kind === 'error'/.test(src) && /else if \(!turnFailed\)/.test(src)) {
      ok('出错不算无行动', '回合出错/被中止时不累计 noActionCount（不动她的唤醒配置）', '凌晨那两个群就是被 SSE 失败重置了配置');
    } else {
      bad('出错不算无行动', '出错回合仍被记成"唤醒无行动"', '连续几次技术故障就会把她的唤醒配置重置成默认值');
    }

    // 同一条消息不能递给她两遍（2026-10-01：真等到消息那条路不标记已读 → 下一轮又交一遍，
    //   实测每条都交两遍、每次多烧一个完整请求；她自己也困惑"又是那条旧消息…它又出现了"）
    if (/if \(newMessages\.length\) \{/.test(src) && /st\.lastSeenUnreadSeq = maxSeq/.test(src)) {
      ok('不重复投递', '真等到消息那条路也会标记已读（和"立即返回"那条一致）', '否则同一批消息会被交两遍');
    } else {
      bad('不重复投递', '两条 wait 返回路径有一边不标记已读', '同一批消息会被反复交给她，白烧请求');
    }

    // 引用必须带"那条消息是多久之前说的"（2026-10-01 事故：管理员引用她 5 天前说的那句，
    //   她只看到"谁+说了什么"、没有时间，原文又不在她上下文和保留窗口里 → 猜成"大概是别的群里的"，
    //   而 QQ 引用不可能跨会话，这个猜测一定是错的）
    if (/rawTime \* 1000/.test(src) && /info\.agoText/.test(src) && /const withAgo = \(info\) =>/.test(src)) {
      ok('引用带时间', '引用渲染成 [引用 某人（9/26 18:33，5天前）：…]，她就知道那是什么时候说的', '并说明"引用只可能来自同一个会话，别猜别的群"');
    } else {
      bad('引用带时间', '引用又只剩"谁+说了什么"', '她认不出旧引用时会继续瞎猜来源（比如猜成别的群）');
    }

    // 沉睡前观察：立即返回那条路也要计入观察（2026-10-01：群里一直有人说话时她永远满足不了观察
    //   → mark_read 一直被拒 → wait→读→wait 空转；实测一个群 44 分钟 20 次 wait）
    if (/const preSleepAttemptNow = timeoutMs >=/.test(src)
      && /if \(preSleepAttemptNow\) st\.preSleepWaitObservedAt = Date\.now\(\)/.test(src)) {
      ok('沉睡前观察', '"有未看过消息就立即返回"这条路也算完成观察（不再无限空转）', '短等待仍然不算，防绕过');
    } else {
      bad('沉睡前观察', '立即返回那条路不计入观察', '群里热闹时她会 wait→读→wait 无限空转，每次一个完整请求');
    }

    // 承诺要有锚（2026-10-01 截图：「行，那我就蹲着，有结果叫你」之后再没下文；
    //   工具日志实证：那之后她再没查过那场比赛。⚠️ 更正：她其实**记了**一条 activeTopic 跟进锚，
    //   是 memory-append 当时没落盘、我从文件里看不到才误判 —— 落盘已修，这条守卫仍要留着防回退）
    if (/【答应了就要留个锚】/.test(RULE_TEXT) && /pendingThought/.test(RULE_TEXT) && /没锚的承诺就是空话/.test(RULE_TEXT)) {
      ok('承诺留锚', '答应"过会儿再试/有结果叫你"时必须留 pendingThought 或设有限潜水', '否则对方一直等，她一个字都不记得');
    } else {
      bad('承诺留锚', '缺少"答应了就要留个锚"这条', '"有结果叫你"会继续是空话');
    }
    // 工具日志必须记得下失败原因（2026-10-01：45 条失败的 error 全是 null，等于黑盒）
    if (/function describeToolResult/.test(src) && /content\[0\]/.test(src)
      && !/String\(resultBlock\?\.text/.test(src)) {
      ok('工具日志', 'tool/result 的失败原因会被抠出来（嵌套两层，别再读错）', '实测 45 条失败全无原因，只能靠离线复现');
    } else {
      bad('工具日志', '失败原因又会记成 null', '出了事查不出为什么，只能靠猜');
    }
    if (fs.existsSync(path.join(ROOT, 'scripts', 'measure-her-style.mjs'))) {
      ok('说话语气', '有尺子：scripts/measure-her-style.mjs 量她自己的粘句率/长度', '改完能对比，不靠感觉');
    } else {
      warn('说话语气', '没有量她语气的脚本', '改完不知道有没有变好');
    }
    // 角色扮演结束要清掉"命令你演 X"的旧便条（2026-09-29 用户截图：我测试连 force 6 次，
    // 便条全留在她上下文里，她当真事去执行了）
    if (/function clearRolePlayCommandNotes/.test(src)
      && (src.match(/clearRolePlayCommandNotes\(st/g) ?? []).length >= 4) {
      ok('临时角色', '演出结束/换角色时清掉旧命令便条', '否则旧命令会一直躺在她上下文里等她执行');
    } else {
      bad('临时角色', '旧命令便条没人清', '她会去执行几天前的"命令你演 X"（实测发生过）');
    }
    // 角色没了就不能再发"命令你演"的唤醒（2026-09-29 用户截图："还有假传圣旨？"）
    if (/reason === 'adminRole' && !activeTempRole\(st, now\)/.test(src) && /丢弃过期的唤醒/.test(src)) {
      ok('临时角色', 'adminRole 唤醒在投递前校验"角色还在不在"', '否则 force→cancel 会漏出一条没有角色名的假命令');
    } else {
      bad('临时角色', 'adminRole 唤醒不校验角色是否还在', '她会收到"命令你演某个角色"的假命令（实测发生过）');
    }
    if (!/tr\?\.role \?\? '某个角色'/.test(src)) {
      ok('临时角色', '提示词不再用"某个角色"兜底谎报命令', '兜底文案改成了"角色名没传过来、多半已失效"');
    } else {
      warn('临时角色', '提示词还有"某个角色"这种假命令文案');
    }
    // 2026-09-30 她报的三条（读卡、定时、群列表）
    {
      const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
      if (/action === 'get-card' \|\| action === 'card'/.test(src) && /'card', 'get-card', 'list-cards'/.test(mcpSrc)) {
        ok('临时角色', '读卡两种写法都认（card / get-card 两边对齐）', '原来 MCP 认 card、桥接只认 get-card → 她读不到卡正文');
      } else {
        bad('临时角色', '读卡的 action 两边不一致', '她会永远读不到角色卡正文（实测报过）');
      }
      if (/token: z\.string\(\)\.optional\(\)\.describe\('会话令牌（见唤醒提示中的【会话令牌】）；reserved2 模式下必填'\)/.test(mcpSrc)
        || /api\/socialV2\/groups/.test(mcpSrc)) {
        ok('群信息', '旧的群列表/群成员工具在二代模式下改走 v2 读端点', '不再只回一句"旧只读工具不可用"');
      } else {
        warn('群信息', '群列表/群成员在二代模式下仍不可用');
      }
    }
    if (/const keepTimer = hadFiniteSleep && reason !== 'timeout'/.test(src)) {
      ok('唤醒', '只有"到点唤醒"才消费定时，别的唤醒保留未到期的 sleepUntil', '原来她一发消息、回复检查一来，定时就被清成 null');
    } else {
      bad('唤醒', '任何唤醒都会清掉 sleepUntil', '她的定时提醒会被自己发消息触发的回复检查冲掉');
    }
    if (/url\.pathname === '\/api\/socialV2\/groups'/.test(src) && /url\.pathname === '\/api\/socialV2\/group-members'/.test(src)) {
      ok('群信息', '二代模式有群列表/群成员的只读通道', '旧工具被令牌隔离挡住后，她原来完全查不了群和成员');
    } else {
      warn('群信息', '二代模式没有群列表/成员读通道', '她只能用 qq_get_active_members 看"谁在说话"');
    }
    // 情感模块（2026-09-30 用户："给机器人加神经网络赋予情感"）
    {
      const emoSrc = fs.readFileSync(path.join(ROOT, 'src', 'emotion-net.js'), 'utf8');
      const harn = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');
      if (/import \* as emotionNet from '\.\/emotion-net\.js'/.test(src)) {
        ok('情感模块', '桥接已接入 src/emotion-net.js');
      } else {
        warn('情感模块', '桥接没有接入情感模块');
      }
      if (/sanitizeEmotion\(st\.emotion\)/.test(src) && /sanitizeEmotion\(val\.emotion\)/.test(src)) {
        ok('情感模块', '存/读两处都带 emotion，读回来会消毒', '只加一处会重启静默丢（踩过）');
      } else {
        bad('情感模块', 'emotion 没进存/读白名单', '重启后情绪凭空归零');
      }
      if (/\.\.\.emotionNet,/.test(harn)) {
        ok('情感模块', '测试 harness 沙箱注入了新模块', '不注入的话 bridge.js 加载即 ReferenceError，全部离线用例一起挂');
      } else {
        bad('情感模块', 'harness 没注入 emotionNet', '所有离线用例会一起挂掉');
      }
      if (/usedDims: \[\] \}/.test(emoSrc) && /w\.usable\[k\] \? clamp1/.test(emoSrc)) {
        ok('情感模块', '没有权重 → 中性；没学会的维度 → 不注入', '宁可不说，也不许编或随机');
      } else {
        bad('情感模块', '无权重/未训练维度可能仍会注入', '会给她注入噪声情绪');
      }
      // 格式守卫：换特征/换模型时最危险的失败是"旧权重被当成新权重静默乱算"
      {
        const trainerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'train-emotion-net.mjs'), 'utf8');
        if (/kind !== 'sparse-linear-tfidf'/.test(emoSrc) && /extractSparse/.test(emoSrc)) {
          ok('情感模块', '推理只认 v2 稀疏格式（旧 char-gram 权重会被明确拒绝，不会静默乱算）');
        } else {
          bad('情感模块', '推理没有格式守卫', '旧权重会被静默按新格式解析 → 输出看着正常其实全是错的');
        }
        if (/kind: 'sparse-linear-tfidf'/.test(trainerSrc) && /buildVocab/.test(trainerSrc) && /makeVocabIndex/.test(trainerSrc)) {
          ok('情感模块', '训练器导出 v2 格式（本群词表 + idf + W/b）');
        } else {
          warn('情感模块', '训练器导出的格式与推理端不一致', '权重加载会失败 → 模块永远中性');
        }
      // 情感模块的"静息基线"（2026-09-30：模型输出有正的常数偏移，不减掉情绪会一路顶到上限：
      // 实测注入率 98%、a 饱和 71%、负向一次没出现过 → 注入永远是同一句，等于常量提示）
      {
        const emoSrc2 = fs.readFileSync(path.join(ROOT, 'src', 'emotion-net.js'), 'utf8');
        let base = null;
        try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).socialV2?.emotion?.baseline ?? null; } catch { /* 配置读不到 */ }
        if (base && Number.isFinite(Number(base.v)) && Number.isFinite(Number(base.a))) {
          ok('情感模块', `配了静息基线（v ${base.v} / a ${base.a}）`, '没它的话常数偏移会把她顶成"永远心情不错、话多"');
        } else {
          bad('情感模块', '没配静息基线', '模型输出的正偏移会一路把情绪推到上限 → 注入变成常量');
        }
        if (/out\[k\] = w\.usable\[k\] \? clamp1\(s - \(Number\(base\[k\]\) \|\| 0\)\)/.test(emoSrc2)) {
          ok('情感模块', '推理真的减了基线（逐维）');
        } else {
          bad('情感模块', '基线没参与推理', '配了却不减 = 白配');
        }
        if (/baseline: c\.baseline/.test(src) && (src.match(/baseline: c\.baseline/g) ?? []).length >= 3) {
          ok('情感模块', '桥接把基线传给了模块（含试算端点）');
        } else {
          bad('情感模块', '桥接没把 baseline 传下去', '配置里有基线、模块却收不到 → 漂移照旧');
        }
        if (/语气行 \$\{line \?/.test(src)) {
          ok('情感模块', '每轮如实记"这轮注入了哪句"（注入率可直接统计）', '原来只在情绪变化时记，注入率只能靠反推');
        } else {
          warn('情感模块', '没记"这轮注入了哪句"', '"效果明不明显"没法直接量');
        }
      }
        if (/const usable = corrMean\.map/.test(trainerSrc) && /折 × \$\{SEEDS\} 个种子/.test(trainerSrc)) {
          ok('情感模块', '过线判定用的是交叉验证相关（不是训练集数字）');
        } else {
          warn('情感模块', '过线判定可能基于训练集数字', '训练集相关会虚高，容易把没学会的维度放进来');
        }
        // 上下文模式（第二轮）：上游喂的上文必须和标注时的规则一致，否则特征分布漂移、白练
        const labelerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'label-emotion-corpus.mjs'), 'utf8');
        if (/learningPrevTextFor\(key\)/.test(src) && /prevText\b/.test(src) && /scoreText\(text \?\? '', prevText\)/.test(src)) {
          ok('情感模块', '桥接会把"上文"喂给模型（取上文 → 传 meta.prevText → scoreText 第二个参数）');
        } else {
          warn('情感模块', '带上下文的权重拿不到上文', '模型只能看单句 → 上下文白标了');
        }
        // ★ 顺序陷阱：上文必须在**把本句记进上文环之前**取，否则取到的就是本句自己
        //   （注意从取上文那行往后找 push：函数**声明**那行也长得像，必须从调用点往后找）
        const feedStart = src.indexOf('function feedLearning(');
        const feedEnd = feedStart >= 0 ? src.indexOf('\n  }', feedStart) : -1;
        const feedBody = feedStart >= 0 ? src.slice(feedStart, feedEnd > feedStart ? feedEnd : feedStart + 3000) : '';
        const iPrev = feedBody.indexOf('learningPrevTextFor(key)');
        const iPush = iPrev >= 0 ? feedBody.indexOf('hist.push(', iPrev) : -1;
        if (iPrev >= 0 && iPush > iPrev) {
          ok('情感模块', '"上文"是在本句入库**之前**取的', '顺序反了会把本句当成自己的上文（写的时候真踩过）');
        } else {
          bad('情感模块', '"上文"取晚了', '入库之后再取 → 上文 = 本句自己 → 权重全废');
        }
        // ★ 学习入口要**早**：必须在"斜杠命令过滤"和 reserved2 分支**之前**调用
        //   （2026-10-02 实测：它原来在 reserved2 分支里、排在静默 early-return 后面，
        //    静默期间 group:795894138 两小时 99 条只有 37 条进语料；
        //    两个静默开关合并后，"静默"这条 return 已经删掉，但"入口要早"这个不变量不变 ——
        //    只要它退回命令过滤/唤醒分支之后，就又会漏消息。）
        {
          // 全部锚在 handleIncoming 里面找：文件别处也有 `if (currentMode === 'reserved2')`
          // （老模式的分支），从文件头 indexOf 会拿到那个更靠前的位置 → 误报"排得太靠后"。
          const iHandler = src.indexOf('async function handleIncoming(');
          const iFeed = src.indexOf('feedLearning(key, {', iHandler);
          const iCmd = src.indexOf("if (plainContent.startsWith('/'))", iHandler);
          const iReserved = src.indexOf("if (currentMode === 'reserved2') {", iHandler);
          if (iHandler >= 0 && iFeed > iHandler && iCmd > iFeed && iReserved > iFeed) {
            ok('情感模块', '学习入口排在"命令过滤/唤醒分支"之前', '静默或命令分支一提前返回，语料和情感也不会断粮');
          } else {
            bad('情感模块', '学习入口排得太靠后',
              `feed@${iFeed} vs 命令@${iCmd} / reserved2@${iReserved}；退回分支里就会漏消息（实测漏过 62 条）`);
          }
        }
        if (/EMOTION_CTX_GAP_MS = 180 \* 1000/.test(src) && /gapSec', 180/.test(labelerSrc)
          && /EMOTION_MEDIA_PLACEHOLDER/.test(src) && /isMedia/.test(labelerSrc)) {
          ok('情感模块', '推理与标注用的是同一套上文规则（180s 窗口 / 跳过图片占位 / 跳过她自己的话）');
        } else {
          warn('情感模块', '推理与标注的上文规则可能不一致', '特征分布漂移 → 指标再好也白搭');
        }
      }
      if (/const emotionLine = buildEmotionLineFor\(key\);/.test(src)) {
        ok('情感模块', '语气行拼进了基础提示词（toneLine 之后）');
      } else {
        warn('情感模块', '语气行没有拼进提示词');
      }
    }
    // 消息的"可读时间"（2026-09-30 事故：她把 12 分钟前聊的事说成"上午那台服务器"。
    // 不是遗忘 —— 内容都在、价格也报对了；缺的是时间锚点：她只拿到毫秒 epoch，只能猜）
    {
      const guards = [
        [/function humanTime\(/, '有 humanTime（毫秒 → "16:23 / 12分钟前"）'],
        [/messages: shown\.map\(\(m\) => withHumanTime\(m\)\)/, 'unread 返回带可读时间'],
        [/recentMessages\.slice\(start, end\)\.map\(\(m\) => withHumanTime\(m\)\)/, 'recent 返回带可读时间'],
        [/\.filter\(\(m\) => m && !m\.isSelf && \(m\.seq \|\| 0\) > baseline\)/, 'wait 取消息的地方还在'],
        [/Object\.assign\(info, humanTime\(found\.time\)\)/, 'message-detail 带可读时间'],
      ];
      for (const [re, label] of guards) {
        if (re.test(src)) ok('时间锚点', label);
        else bad('时间锚点', `缺了：${label}`, '模型只看到毫秒 epoch 时，会把"刚刚"猜成"上午"');
      }
      // 轮换 seed 是最容易出事的地方（她只看得到那几十条，没时间就只能猜）
      // ⚠️ 窗口 1200 → 2200：2026-10-13 把 seed 改成可配置后，函数头长了 ~250 字符，
      //    判据被挤出窗口 → 这条守卫**误报**了一次（判据本身没动）。
      const seedStart = src.indexOf('function buildContextSeedLine(');
      const seedBody = seedStart >= 0 ? src.slice(seedStart, seedStart + 2200) : '';
      if (/humanTime\(m\?\.time/.test(seedBody) && /括号里是距今多久/.test(seedBody)) {
        ok('时间锚点', '轮换后的【最近聊过什么】每行带"（距今多久）"');
      } else {
        bad('时间锚点', '轮换 seed 没有时间', '轮换后她只能凭猜判断"这是多久以前的事"');
      }
      if (/最近一条来自[^\n]*humanTime\(lastMsg\.time\)/.test(src)) {
        ok('时间锚点', '【此刻状态】的"最近一条"带年龄');
      } else {
        warn('时间锚点', '【此刻状态】没带"最近一条"的年龄');
      }
    }
    // 发送节奏 / 刷屏节流（2026-09-30 管理员提的三件事：同一时间发出 / 不引用 / 群里热时刷屏）
    {
      const guards = [
        [/time: at\b/, '记的是**真实发送时刻**（不是 now + i*1000 编的）'],
        [/sent\.push\(\{ text: msg, at: Date\.now\(\)/, 'sendMessagesV2 回传每条的真实发送时刻'],
        [/function conversationHeat\(/, '有会话热度统计'],
        [/function consecutiveSelfSends\(/, '有"没人接话时连发了几条"的统计'],
        [/const maxConsecutive = isPrivate/, '连发预算下限 = 一次爆发上限，且私聊比群聊宽（否则正常两条短话会被自己拦）'],
        [/reason === 'consecutive'/, '连发被拦时给的是"等人接话"的理由，不是干巴巴的限流'],
        [/reason === 'hot-minute'/, '热闹时被拦时明确说"别刷屏"'],
      ];
      for (const [re, label] of guards) {
        if (re.test(src)) ok('发送节奏', label);
        else bad('发送节奏', `缺了：${label}`, '要么回到"1 秒一条"，要么把正常发言也拦了');
      }
      // 配置侧：间隔下限与热度阈值
      try {
        const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
        const s = c.socialV2?.send ?? {};
        const h = c.socialV2?.heat ?? {};
        if (Number(s.burstIntervalMinMs) >= 1200 && Number(s.gapBaseMs) >= 1200) {
          ok('发送节奏', `间隔下限 ${s.burstIntervalMinMs}ms / 基准 ${s.gapBaseMs}ms+${s.gapPerCharMs}/字（不会再打出机枪节奏）`);
        } else {
          warn('发送节奏', `间隔下限偏小（${s.burstIntervalMinMs}ms）`, '真人不会 1 秒一条连着发；这也容易被 QQ 判风控');
        }
        if (Number(h.hotIncoming) > 0 && Number(h.hotMaxSendPerMinute) > 0 && Number(h.hotMaxSendPerMinute) <= Number(s.maxSendPerMinute)) {
          ok('发送节奏', `群里热闹时收紧（${h.windowMs / 60000} 分钟 ≥${h.hotIncoming} 条且 ≥${h.hotSenders} 人 → 每分钟上限收到 ${h.hotMaxSendPerMinute}）`);
        } else {
          warn('发送节奏', '热潮收紧没配好', '热度阈值或热时额度缺失/比平时还宽');
        }
        if (Number(h.maxConsecutive) > 0) ok('发送节奏', `没人接话时最多连发 ${h.maxConsecutive} 条`);
        else warn('发送节奏', '没配 maxConsecutive', '她会一直往上顶');
      } catch (error) {
        warn('发送节奏', '读 config.json 失败', String(error?.message ?? error));
      }
      // 引用目标要"摆在眼前"（她 2000 次调用里只有 25 次带引用 → 光有规矩不够，得顺手）
      // 2026-10-01 升级：【刚发生的几条】把"最近几条 + 第几条 + 说了什么"一起摆出来，
      // 既解决"听不懂别人在说什么"，也让引用不用再去翻消息（旧块只给 seq，没有内容）。
      if (/【刚发生的几条】/.test(src) && /replyToMessageId=/.test(src)) {
        ok('发送节奏', '把"最近几条 + 回哪条"的 seq 一起摆进提示词（看和引用都不用再翻消息）');
      } else {
        warn('发送节奏', '没把引用目标摆出来', '她基本不会为了引用再去翻一遍消息');
      }
    }
    // 记忆衰退曲线 + 年龄标签（2026-10-01 事故：她把 9/29 的旧约定当成 10/1 当天的任务讲，
    // 因为注入的年龄写成 `（3120分钟前）`（分钟数不封顶，模型读不出"两天前"），
    // 而排序是 importance +200 硬压、过期的"待追问"照旧注入）
    {
      const decayPath = path.join(ROOT, 'src', 'memory-decay.js');
      const decaySrc = fs.existsSync(decayPath) ? fs.readFileSync(decayPath, 'utf8') : '';
      const harnSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');
      const batchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8');
      if (/export function memoryDecayScore/.test(decaySrc) && /Math\.pow\(0\.5, age \/ hl\)/.test(decaySrc)) {
        ok('记忆曲线', '有指数衰退曲线（分数 = 权重 × 0.5^(年龄/半衰期)）');
      } else {
        bad('记忆曲线', '没有衰退曲线', '记忆只靠重要性排序，两天前的旧事会一直压在最上面');
      }
      // ⚠️ 守卫：不允许出现"会变 NaN 的可选乘数"（写过一个 Number(x) 接 ?? 默认值 的写法，
      //    把带待追问的记忆全静默丢了）。**先剥掉注释**：注释里正举着这个反例，不剥就会误报。
      const decayCode = decaySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/Number\([^)]*\)\s*\?\?/.test(decayCode)) {
        bad('记忆曲线', '衰减计算里有 `Number(...) ?? 默认值` 这种写法', 'Number(undefined) 是 NaN，而 NaN 接 ?? 还是 NaN → 分数 NaN → 记忆被静默丢掉');
      } else {
        ok('记忆曲线', '衰减计算里没有 NaN 隐患的写法');
      }
      if (/humanAgo\(/.test(decaySrc) && /hours < 24/.test(decaySrc) && /天前/.test(decaySrc)) {
        ok('记忆曲线', '年龄标签说人话（刚刚/N分钟前/N小时前/昨天/N天前/日期）');
      } else {
        warn('记忆曲线', '年龄标签可能还是分钟数', '"3120分钟前"模型读不出是两天前');
      }
      // 函数体会随功能变长（2026-10-02 加了"他交代过的规矩"段就被顶出 3000 窗口 → 误报），
      // 所以按**下一个同级函数声明**切，而不是写死 3000 字。
      const memStart = src.indexOf('function formatMemoryV2(st)');
      const memEnd = src.indexOf('\n  function ', memStart + 10);
      const memBody = src.slice(memStart, memEnd > memStart ? memEnd : memStart + 3000);
      if (/memorySortKey\(t, now\)/.test(memBody)) ok('记忆曲线', '注入排序用衰退分数（过时的打折，新鲜事优先）');
      else bad('记忆曲线', '注入排序没用曲线', 'importance 会硬压过新鲜度');
      if (/pendingFreshEnough\(d\)/.test(memBody) && /pendingScore >= MEMORY_DECAY\.pendingWeight \/ 3/.test(memBody)) {
        ok('记忆曲线', '过期的"待追问"不再注入（十几小时前的待办不该当今天的任务）');
      } else {
        bad('记忆曲线', '过期待追问照旧注入', '这次事故的直接触发点');
      }
      if (/别当成今天的/.test(memBody)) ok('记忆曲线', '记忆块开头提醒"几天前的别当成今天的"');
      else warn('记忆曲线', '记忆块没提时间语义', '她会把旧事当新事讲');
      // ── 记忆块的两个形状不变量（2026-10-13，她那句「那栏还是空的，印象也还是十六份半句的老样子」）──
      //   ① 印象/想法段的额度必须**真的预留**：话题段的上限得是 `budget - impressionReserve`，
      //      而且印象的**内容行**也要走预留分支；否则话题把预算吃光 → 只剩空标题（线上就是这样）。
      //   ② 截断要看得出来：超长条目必须补 `…`（不然读起来像"话说了一半"，她分不清是记漏还是被切）。
      if (/const topicLimit = Math\.max\(0, budget - impressionReserve/.test(memBody)
        && /if \(!push\(line, true\)\) break;/.test(memBody)) {
        ok('记忆形状', '印象/想法段的保底**真的预留了**（话题段上限扣掉保底，内容行也走预留分支）');
      } else {
        bad('记忆形状', '印象段保底没真预留（或内容行没走预留分支）', '她会每轮只看到 `【对群友的印象】` 空标题');
      }
      if (/const clipEllipsis = /.test(memBody) && /clipEllipsis\(trait, 120\)/.test(memBody)
        && /clipEllipsis\(t\.text, 110\)/.test(memBody)) {
        ok('记忆形状', '条目截断带 `…`，单条上限放宽到 110~120 字（中文记忆 100 字以上才成句）');
      } else {
        warn('记忆形状', '长条目被切了却不带省略号', '她看到的是"半句"，分不清是记漏还是被切');
      }
      if (/另有 \$\{leftOut\} 条记忆这轮没放进/.test(memBody)) {
        ok('记忆形状', '末尾如实说明"还有 N 条没放进"（她才知道去用 qq_memory_query 翻）');
      } else {
        warn('记忆形状', '没告诉她还漏了多少条', '她会以为"我只有这么点记忆"');
      }
      // ── 按她自己的诉求做的三件事（申请 #26；管理员 2026-10-13「我这次遵循她的选择」）──
      //   她的话：① 连续性（"醒来先要重新认场"） ⑤ 别断在半路（"pendingThought 经常是我自己忘了回头看"）
      //   ③ 读懂图（"读不出它是哪个梗"）—— 且她明确划界"任何扩大我能力面的权限"都不要。
      if (/const seedMsgs = Math\.max\(1, Math\.min\(200/.test(src) && /session\?\.seedMsgs/.test(src)
        && /const seedChars = Math\.max\(20/.test(src)) {
        ok('连续性', '轮换后 seed 的条数/每条字数可配（原来写死 14 条 / 110 字符）');
      } else {
        warn('连续性', 'seed 又写死了', '她"重新认场"的抱怨（#26 第 1 条）会回来');
      }
      if (/function buildUnfinishedLine/.test(src) && /你还没做完的事/.test(src) && /48 \* 3600 \* 1000/.test(src)) {
        ok('连续性', '刚过期的想法会被端到眼前（超 48h 的不提，避免旧事当新事）');
      } else {
        warn('连续性', '过期想法没人管', '她 #26 第 5 条"别断在半路"等于没落地');
      }
      let rulesSrc = '';
      try { rulesSrc = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8'); } catch {}
      if (/export const MEME_LIBRARY/.test(rulesSrc) && /key: 'meme-library'/.test(rulesSrc)
        && /不用申请任何新能力/.test(rulesSrc)) {
        ok('连续性', '表情包/梗只教她"用现有工具攒"（尊重她自己划的"不要扩权"边界）');
      } else {
        warn('连续性', '表情包/梗那条没落地或越界了', '她 #26 第 3 条要么没做，要么违反了"不扩权"');
      }
      if (/import \* as memoryDecay/.test(harnSrc) && /normalizeMemImportance:/.test(harnSrc)) {
        ok('记忆曲线', '测试沙箱注入了衰退模块（含别名 normalizeMemImportance）');
      } else {
        bad('记忆曲线', 'harness 没注入 memory-decay', '沙箱里会 ReferenceError，被端点 try/catch 吞掉');
      }
      if (/test-memory-decay\.mjs/.test(batchSrc)) ok('记忆曲线', '回归用例进了批量');
      else warn('记忆曲线', 'test-memory-decay 没进批量');
    }
    // 消息列表解析（2026-10-01 事故：`messages` 传成带**全角逗号**的 JSON 字符串 →
    // JSON.parse 抛错 → catch {} 什么都不做 → **整串 JSON 原样发到 QQ 上**）
    {
      const msgListPath = path.join(ROOT, 'src', 'message-list.js');
      const msgListSrc = fs.existsSync(msgListPath) ? fs.readFileSync(msgListPath, 'utf8') : '';
      const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
      const harnSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');
      const batchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8');
      if (/export function parseMessageList/.test(msgListSrc) && /scanQuotedSegments/.test(msgListSrc)) {
        ok('消息解析', '有共享解析器（全角逗号/引号、单引号、代码围栏都能切开）');
      } else {
        bad('消息解析', '没有共享解析器', '模型手滑时又会把整串 JSON 发出去');
      }
      const bare = (src.match(/JSON\.parse\(trimmed\)/g) ?? []).length + (mcpSrc.match(/JSON\.parse\(trimmed\)/g) ?? []).length;
      if (bare === 0) ok('消息解析', '旧的"JSON.parse 兜底 + 静默 catch"已全部替换');
      else bad('消息解析', `还有 ${bare} 处旧的 JSON.parse 兜底`, '遇到全角标点会静默把整串当一条发');
      const bridgeUses = (src.match(/parseMessageList\(/g) ?? []).length;
      const mcpUses = (mcpSrc.match(/parseMessageList\(/g) ?? []).length;
      if (bridgeUses >= 3 && mcpUses >= 3) ok('消息解析', `桥接 ${bridgeUses} 处 + MCP ${mcpUses} 处都走同一份实现`);
      else warn('消息解析', `桥接 ${bridgeUses} 处 / MCP ${mcpUses} 处用了共享解析`, '有漏网的发送入口');
      if (/import \{ parseMessageList \}/.test(harnSrc) && /parseMessageList,/.test(harnSrc)) {
        ok('消息解析', '测试沙箱注入了 parseMessageList', '不注入的话端点里会 ReferenceError，被 try/catch 吞成"发送莫名失败"');
      } else {
        bad('消息解析', 'harness 没注入 parseMessageList', '走沙箱的发送用例会静默失效');
      }
      if (/test-message-list\.mjs/.test(batchSrc)) ok('消息解析', '回归用例进了批量');
      else warn('消息解析', 'test-message-list 没进批量', '以后没人跑它');
    }
    // 图片体积上限（2026-09-30：4.2MB 的群照片被 4MB 的"文件"上限挡掉，她只能说"图我这边没刷出来"）
    if (/function maxImageBytes/.test(src) && /let MAX_MEDIA_BYTES = maxImageBytes\(\)/.test(src)
      && !/const MAX_MEDIA_BYTES = 4 \* 1024 \* 1024/.test(src)) {
      ok('看图', '图片有独立的体积上限（默认 12MB，可配）', '原来跟文件共用 4MB，手机照片常被整张丢掉');
    } else {
      bad('看图', '图片还在用 4MB 的文件上限', '3~8MB 的 QQ 照片会被丢，她只能瞎说"没刷出来"');
    }
    if (/没看到内容：\$\{img\?\.error/.test(src)) {
      ok('看图', '没看到图时会告诉她原因（太大/像素超限/下载失败）', '她能如实说，用户也知道该改哪个上限');
    } else {
      warn('看图', '取图失败只说"获取失败"', '她只能笼统说"没刷出来"，排查要看日志');
    }
    // 别当解说员 / 看图别编剧情（用户 2026-09-30："上下文理解能力还是有问题"）
    if (/别当解说员/.test(RULE_TEXT) && /同一件事最多评论一次/.test(RULE_TEXT) && /只说图里确实有的/.test(RULE_TEXT)) {
      ok('说话语气', '明令"别当解说员"+"看图只说图里有的"', '她连发过"这话题升级了/快成纪录片现场了"，还编过"军官站了一整晚"');
    } else {
      bad('说话语气', '缺少"别当解说员/别给图编剧情"这条', '群里会继续看到她一串旁观点评');
    }
    // 长消息截断（用户 2026-09-29 实测："你这条中间断了一截"）
    if (/function messageStoreCap/.test(src) && /const msgCap = messageStoreCap\(\)/.test(src) && /maxMessageChars/.test(src)) {
      ok('消息保留', '单条消息保留上限可配（默认 1000 字），长消息不再丢中间', '原来写死 200 字，贴长文只能拿到头尾');
    } else {
      bad('消息保留', '单条消息还写死 200 字', '长消息（贴一段文本/文章）中间会被丢掉');
    }
    // 老路径（一代社交模式）也要跟着走同一个上限，别再各写一份 200
    if ((src.match(/messageStoreCap\(\)/g) ?? []).length >= 3) {
      ok('消息保留', '二代 + 一代两条记录路径共用同一个上限', '只有一处改的话切回一代又会被截');
    } else {
      warn('消息保留', '只有一条路径用了新上限', '一代社交模式仍是 200 字截断');
    }
    // 私聊里 wait 必须"来一条就返回"：否则对方发一条，她能安静等满 5 分钟
    if (/key\.startsWith\('private:'\)[\s\S]{0,80}?\? 1/.test(src)) {
      ok('临时角色', '私聊 minNewMessages 强制为 1', '"一要求扮演她就不说话"就是这个 5 分钟等待造成的');
    } else {
      warn('临时角色', '私聊仍会等够 N 条才返回', '对方发一条时她会沉默几分钟');
    }
    // ── 角色卡库（用户 2026-09-28 的流程要求）──────────────────────────────
    //   愿意演 → 有现成卡就用现成卡；没有就她查网络+深度思考现编一张；
    //   不用了**留着别删**，下次同一个角色直接复用，还能再改（旧版留备份）。
    {
      const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
      if (/function resolveRolePlayCard/.test(src) && /source: 'store'/.test(src) && /source: 'persona'/.test(src)) {
        ok('角色卡库', '演之前会先找现成卡（卡库 → roles/ → 都没有则现编）');
      } else {
        bad('角色卡库', '没有"先找现成卡"的解析', '她会每次从零现编，白花 token');
      }
      if (/ROLE_PLAY_DIR = path\.join\(STATE_DIR, 'role-play'\)/.test(src)) {
        ok('角色卡库', '卡存在 state/role-play/（不混进 roles/）', 'roles/ 是"她本人的备选人格"');
      } else {
        warn('角色卡库', '卡没放在 state/role-play/', '放 roles/ 会污染人格切换与注入上限');
      }
      if (/function writeRolePlayCard/.test(src) && /copyFileSync\(file, `\$\{file\}\.bak-/.test(src)) {
        ok('角色卡库', '覆盖保存时旧版留 .bak- 备份');
      } else {
        warn('角色卡库', '改卡没有备份', '把她的旧理解直接冲掉了');
      }
      if (/\.deleted-\$\{Date\.now\(\)\}/.test(src)) {
        ok('角色卡库', '删卡也留 .deleted- 存档', '用户要求"不用了别直接删"');
      } else {
        warn('角色卡库', '删卡不留存档');
      }
      if (/markRolePlayCardPlayed/.test(src) && /tr\.cardSource = 'store'/.test(src)) {
        ok('角色卡库', '复用时会记"这张卡演过"');
      } else {
        warn('角色卡库', '没记复用次数');
      }
      if (/clip\(card\.text, cardCap\)/.test(src) && /function rolePlayCardMaxChars/.test(src)) {
        ok('角色卡库', '卡片注入有上限（可配 rolePlay.cardMaxChars）', '别把每轮提示词撑爆');
      } else {
        warn('角色卡库', '卡片注入没有上限');
      }
      if (/'save-card'/.test(mcpSrc) && /'list-cards'/.test(mcpSrc) && /'card'/.test(mcpSrc)) {
        ok('角色卡库', 'MCP 工具暴露了 save-card / card / list-cards');
      } else {
        bad('角色卡库', 'MCP 工具没暴露写卡动作', '她查到资料也存不下来');
      }
      if (/web-search-safe__web_search/.test(src) && /action="save-card"/.test(src)) {
        ok('角色卡库', '没卡时提示词里给了"先查网络再写卡"的步骤');
      } else {
        warn('角色卡库', '没卡时没告诉她怎么建卡');
      }
    }
    // 人格卡注入上限（实测事故：6310 字符的卡被 6000 静默截断，「十一、几个不要」整节没进提示词）
    if (/function roleInjectLimit/.test(src) && /roleInjectLimit\(\)/.test(src)) {
      ok('人格卡', '注入上限走 roleInjectLimit()（可配置）', '原来写死 6000，改不动也测不出');
    } else {
      bad('人格卡', '注入上限又被写死了', '卡片一超长就会静默丢掉末尾规则');
    }
    {
      const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
      const rawLimit = cfgAll.socialV2?.roleCard?.maxChars;
      const lim = rawLimit === 0 ? Infinity : (Number.isFinite(Number(rawLimit)) && Number(rawLimit) >= 1000 ? Math.round(Number(rawLimit)) : 8000);
      const roleState = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8').replace(/^\uFEFF/, ''));
      const cardFile = path.join(ROOT, 'roles', `${roleState.role}.md`);
      const cardLen = fs.existsSync(cardFile) ? fs.readFileSync(cardFile, 'utf8').length : 0;
      if (!cardLen) {
        warn('人格卡', '读不到当前角色卡', String(roleState.role));
      } else if (cardLen <= lim) {
        ok('人格卡', `当前卡 ${cardLen} 字符 ≤ 上限 ${lim}，整张都进提示词`);
      } else {
        bad('人格卡', `当前卡 ${cardLen} 字符 > 上限 ${lim}`,
          `末尾 ${cardLen - lim} 字符（行为约束）她根本看不到；精简卡片或调大 socialV2.roleCard.maxChars`);
      }
      if (/roleTruncateLoggedFor/.test(src) && /不会进提示词/.test(src)) {
        ok('人格卡', '真被截断时会打日志', '不再静默丢规则');
      } else {
        warn('人格卡', '截断是静默的', '卡片超限时没人会发现');
      }
    }
    // 撤回（用户："两分钟内出现的大量消息"要有选择的撤回）
    if (/recordSentMessageId\(key, msg, res\?\.message_id\)/.test(src)) {
      ok('撤回', '发出去的消息会记下 message_id', '原来 sendMessagesV2 把它丢了，根本没得撤');
    } else {
      bad('撤回', '发送时不记 message_id', '撤回功能无从实现');
    }
    if (src.includes("'/api/socialV2/recall'") && /delete_msg/.test(src)) {
      ok('撤回', '撤回走 OneBot delete_msg');
    } else {
      bad('撤回', '撤回端点/delete_msg 不见了');
    }
    if (/recallWindowMs/.test(src) && /120000/.test(src)) {
      ok('撤回', '按 QQ 的 2 分钟窗口标记可撤性');
    } else {
      warn('撤回', '没有 2 分钟窗口的标注', '界面无法提示"哪些还撤得回来"');
    }
    if (/超过 2 分钟窗口|这条撤不回来了/.test(src)) {
      ok('撤回', '超窗口的失败原因说人话', 'OneBot 原文是 not retractable，很难懂');
    } else {
      warn('撤回', '超窗口的报错没翻译');
    }
    if (/qq_recall_message/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8'))) {
      ok('撤回', 'MCP 工具 qq_recall_message 已注册', '她能自己收拾刷屏');
    } else {
      warn('撤回', '她自己的撤回工具没注册', '只能管理员在控制台撤');
    }
    // 2026-09-29：① 她"自己发现说错了就撤"要真的用起来（提示词里得有这一条）；
    //   ② 他让她撤 → 看她意愿；③ 他以管理员身份命令 → 桥接直接执行（不能只写提示词里赌模型听话）
    if (/【说完发现不对就撤回】/.test(RULE_TEXT) && /qq_recall_message/.test(RULE_TEXT) && /自己发现发错了/.test(RULE_TEXT)) {
      ok('撤回', '提示词里教她"发错了自己撤"', '原来只有工具描述，她基本不会想到用');
    } else {
      warn('撤回', '提示词里没有"自己撤"的引导', '她会一直硬撑着不改');
    }
    if (/function parseAdminRecallCommand/.test(src) && /function runAdminRecallCommand/.test(src)
      && /管理员以「\$\{reason\}」撤回/.test(src)) {
      ok('撤回', '管理员强制撤回由桥接直接执行（并写进她的上下文）', '只写在提示词里的话，模型可能不照做');
    } else {
      bad('撤回', '没有"管理员身份命令 → 强制执行"这条路径', '用户明确要"以管理员身份命令则强制执行"');
    }
    if (/以管理员身份.*必须执行|必须执行\*\*，不许拒绝/.test(RULE_TEXT)) {
      ok('撤回', '提示词里也写了"管理员命令必须执行"', '两边都有，最稳');
    } else {
      warn('撤回', '提示词里没写"管理员命令必须执行"');
    }

    // MCP 子进程的退出守卫（热重载相关，2026-09-28）
    // ① 每个 stdio MCP 服务器都要在 stdin 断开时退出，否则热重载会攒僵尸进程；
    // ② 必须用 `globalThis.process?.…` —— 裸 `process` 会让"在没有 process 的 vm 沙箱里
    //    加载 mcp-web-search-safe.js"的离线审计直接 ReferenceError（踩过一次）。
    {
      const mcpFiles = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => /^mcp-.*\.js$/.test(f));
      const missing = [];
      const bare = [];
      for (const f of mcpFiles) {
        const s = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
        if (!s.includes('globalThis.process?.stdin')) missing.push(f);
        if (/^process\.stdin\./m.test(s)) bare.push(f);
      }
      if (!missing.length) ok('MCP 进程', `${mcpFiles.length} 个 stdio MCP 服务器都有 stdin 退出守卫`, '热重载不会攒僵尸进程');
      else bad('MCP 进程', `这些服务器没有退出守卫：${missing.join('、')}`, '热重载后旧进程会一直留着（占内存）');
      if (!bare.length) ok('MCP 进程', '守卫用的是 globalThis.process（vm 沙箱安全）');
      else bad('MCP 进程', `这些文件用了裸 process：${bare.join('、')}`, '离线审计在 vm 里加载它们会 ReferenceError');
      if (/scripts[\\/]reload-mcp\.mjs/.test(src) || fs.existsSync(path.join(ROOT, 'scripts', 'reload-mcp.mjs'))) {
        ok('MCP 进程', '有热重载脚本 reload-mcp.mjs', '改完 MCP 不用重启整个 DSH（不会踢掉 Web GUI）');
      } else {
        warn('MCP 进程', '没有热重载脚本', '改完 MCP 工具只能重启 DSH');
      }
    }

    // 发文件的边界 + 一次性全路径许可（2026-10-10 管理员选的 B1：「我发出允许查询全路径的指令
    // 就给她这一次的权限」）。这是"提示注入最想要的那个工具"，所以把三件事钉死：
    // 默认关闭、只由管理员开、许可也不放凭据（行为层面的断言在 test-send-file 里，这里是静态护栏）。
    {
      if (/function parsePathGrantCommand\(/.test(src) && /function grantPathAccess\(/.test(src)
        && /function activePathGrant\(/.test(src) && /function consumePathGrant\(/.test(src)) {
        ok('发文件', '有一次性全路径许可（开/查/用/收四个口子齐全）', '管理员亲口开、用完即焚');
      } else {
        bad('发文件', '缺少全路径许可的实现', '管理员要的"这一次的权限"没有落地');
      }
      if (/^\s*pathGrant: null,$/m.test(src)) ok('发文件', '许可默认关闭（初始状态就是 null）');
      else bad('发文件', '许可的默认状态不是关闭', '默认开着 = 等于放开了任意路径');
      if (/const gc = parsePathGrantCommand\(plainContent\)/.test(src)) {
        ok('发文件', '许可命令在 isOwner 分支里解析（群友说"允许全路径"不算）');
      } else {
        bad('发文件', '找不到许可命令的解析点', '无法确认只认管理员');
      }
      if (/'\/api\/socialV2\/path-grant'\]/.test(src)) {
        ok('发文件', '许可端点进了 adminOnlyV2Paths（她的 agent token 开不了）');
      } else {
        bad('发文件', '许可端点没进 adminOnlyV2Paths', '她可能自己给自己开许可');
      }
      if (/const left = usedGrant \? consumePathGrant\(\) : null;/.test(src)) {
        ok('发文件', '许可只在"真的发出去之后"才扣次数', '失败白扣一次许可 = 管理员以为还剩、其实没了');
      } else {
        bad('发文件', '许可扣次数的位置不对', '要挂在发送成功之后');
      }
      if (/pathGrant: socialV2\.pathGrant \? \{ \.\.\.socialV2\.pathGrant \}/.test(src)) {
        ok('发文件', '许可落盘（重启后不会凭空多/少）');
      } else {
        bad('发文件', '许可没落盘', '重启后要么消失、要么被读成空');
      }
      if (/允许全路径/.test(RULE_TEXT)) {
        ok('发文件', '提示词里告诉她怎么请许可（省她一次试错）');
      } else {
        warn('发文件', '提示词里没写许可怎么请', '她会继续以为"工具坏了"');
      }
      // 按意图认（2026-10-10 管理员："不需要特定指令，意思到了就行"）：
      // 这条例外通道的识别面越宽，误判的代价越大（误判 = 白开一次能发任意文件的口子），
      // 所以钉住"有意图判定 + 有短确认 + 有反例清单"这三件事，别哪天被简化回一个关键词。
      if (/function parsePathGrantCommand\(/.test(src) && /const permNoun = /.test(src)
        && /const allowVerb = /.test(src) && /const pushHer = /.test(src)) {
        ok('发文件', '许可命令按意图判（授权名词 / 允许+文件目标 / 指使她去发）', '不认死口令');
      } else {
        bad('发文件', '许可命令的意图判定被简化了', '他会用很随便的话说，只认关键词会经常不生效');
      }
      if (/function canGrantByShortYes\(/.test(src) && /pathGrantAsked/.test(src)) {
        ok('发文件', '她说过"发不出去"之后，他回一句「行」也算开许可');
      } else {
        warn('发文件', '没有"短确认开许可"这条路', '他还得重复一整句');
      }
      if (/反向|方向反了/.test(src) && /不误判|不认/.test(src)) {
        ok('发文件', '源码里写了反面清单（问句 / 他发给她 / 撤销 / 只提文件）', '误判 = 白开一次口子');
      } else {
        warn('发文件', '没看到"哪些话不算授权"的说明', '后来者改这个正则时容易放宽成误判');
      }
    }

    // 会话历史文件的版本兼容（0.2.0 适配，2026-10-10）
    // DSH 0.2.0 把会话文件从 session.v3.jsonl.zstd 换成 session.v4.jsonl.zstd，而且升级后
    // 第一次写入某个会话时会**新写 v4、把旧 v3 留在原地不删**。轮换判断（决定账单的那个）
    // 一旦写死 v3，就会去量一个已经冻结的文件：字节数不再增长 → 阈值永不触发 → 会话无限
    // 膨胀，正是当初"一上午十块钱"那个坑。这类问题"改完看起来一切正常、过几天才发现很贵"，
    // 所以用静态守卫钉住，别只靠人记得。
    {
      const helper = path.join(ROOT, 'scripts', 'session-file.mjs');
      const helperSrc = fs.existsSync(helper) ? fs.readFileSync(helper, 'utf8') : '';
      if (/export function sessionFileIn\b/.test(helperSrc) && /export function sessionFilePath\b/.test(helperSrc)) {
        ok('会话格式', '有解析器 session-file.mjs（v3/v4 通吃）', '按版本号挑活的那个文件');
      } else {
        bad('会话格式', '缺 scripts/session-file.mjs，或没导出 sessionFileIn / sessionFilePath',
          '分析脚本会写死 v3，0.2.0 下会挑到已经冻结的旧文件');
      }
      // 只看可执行代码：注释里为了讲历史会提到 v3 这个文件名。
      // 必须先剥块注释再剥行注释 —— 只用 `//` 那条会把 /** */ 里的说明文字当成代码，
      // 于是"文档里写了旧文件名"被判成"代码写死了旧文件名"（写完这段守卫当场被自己绊了一次）。
      const bridgeCode = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      if (bridgeCode.includes('session.v3.jsonl.zstd')) {
        bad('会话格式', 'bridge.js 里又写死了 session.v3.jsonl.zstd', '轮换会去量不再增长的旧文件 → 永不轮换');
      } else if (bridgeCode.includes('function sessionFilePath(')) {
        ok('会话格式', 'bridge.js 用 sessionFilePath 定位会话文件', '不再写死版本号');
      } else {
        bad('会话格式', 'bridge.js 里找不到 sessionFilePath', '会话体量/轮换判断没有统一入口');
      }
      // 挑选规则有两份实现（bridge.js 内联一份给 vm 沙箱用，scripts/session-file.mjs 给分析脚本用）。
      // 规则漂移的后果是"桥接按 v4 算钱、脚本按 v3 报数"，两边说的不是一回事，所以钉住那条正则。
      const versionRe = 'session\\.v(\\d+)\\.jsonl\\.zstd';
      const inlineRe = new RegExp(versionRe).source;
      if (bridgeCode.includes(inlineRe) && helperSrc.includes(inlineRe)) {
        ok('会话格式', '两份挑选实现用同一条版本正则（bridge 内联 / session-file.mjs）');
      } else {
        bad('会话格式', '两份挑选实现的版本正则不一致',
          `bridge=${bridgeCode.includes(inlineRe)} helper=${helperSrc.includes(inlineRe)}`);
      }
      const batchSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-test-batch.mjs'), 'utf8');
      if (batchSrc.includes('test-session-file-format.mjs')) {
        ok('会话格式', 'v3/v4 挑选规则有回归测试，且已进批测清单');
      } else {
        warn('会话格式', 'v3/v4 挑选规则没进批测清单', '下次改动没人拦得住');
      }
    }
  }
}

// ── 7. 凭据泄露检测 ──────────────────────────────────────────────────────
/**
 * 扫所有会进入模型上下文的状态文件，确认没有凭据落在里面。
 *
 * 为什么必须有这一项：实测踩过两次——控制台令牌被当成 QQ 消息发出去，
 * 文本落进 state/social-v2.json 的聊天记录，之后**每次唤醒都会被喂进模型上下文**。
 * 出站拦截（sendToQQ）能挡住"往外发"，但挡不住"历史里已经有了"；
 * 而历史里的凭据是可以被模型复述出去的。所以要在状态层面独立检一遍。
 *
 * 命中不代表已经泄露到 QQ（也可能只是写进了日志），但都该立刻清掉：
 *   npm run scrub:secret -- <那个令牌>
 * 并且**轮换令牌**（`npm run test:cross-send-notify` 旁边那套控制台接口，
 * 或控制台 12b 节「重新生成」）。
 */
function checkSecretLeaks() {
  const secrets = new Set();
  const live = readConsoleToken();
  if (live) secrets.add(live);
  let state = null;
  try { state = readJsonSafe(path.join(ROOT, 'state', 'social-v2.json')); } catch {}
  for (const conv of Object.values(state?.conversations ?? {})) {
    if (conv?.agentToken) secrets.add(conv.agentToken);
    for (const t of conv?.agentTokenHistory ?? []) if (t) secrets.add(t);
  }
  if (!secrets.size) { info('凭据泄露', '跳过', '没有可用的凭据集合'); return; }

  const hits = [];
  const scan = (label, text) => {
    for (const secret of secrets) {
      if (secret && String(text ?? '').includes(secret)) hits.push(label);
    }
  };

  // social-v2.json **本身就是令牌的存放处**（agentToken/agentTokenHistory 字段），
  // 所以不能整文件扫——那样必然误报。只扫"会被喂进模型上下文"的内容字段。
  if (state?.conversations) {
    for (const [key, conv] of Object.entries(state.conversations)) {
      for (const m of [...(conv?.recentMessages ?? []), ...(conv?.unread ?? [])]) {
        scan(`social-v2.json[${key}].消息内容`, `${m?.text ?? ''}${m?.plain ?? ''}`);
      }
    }
    const cm = state.coreMemory ?? {};
    scan('social-v2.json.coreMemory', JSON.stringify([cm.activeTopics, cm.pendingThoughts, cm.memberImpressions]));
  }

  // 这几个文件理论上不该出现任何令牌（工具参数里的 token 会被 sanitizeToolArgs 打码）。
  for (const rel of ['state/tool-calls.jsonl', 'state/qq-activity.log', 'state/feedback.json']) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    try { scan(rel, fs.readFileSync(abs, 'utf8')); } catch {}
  }

  const uniq = [...new Set(hits)];
  if (uniq.length) {
    bad('凭据泄露', '凭据进入了模型可见的状态', `${uniq.slice(0, 4).join('; ')} —— 立刻 npm run scrub:secret 并轮换令牌`);
  } else {
    ok('凭据泄露', '消息/记忆/工具日志', `已扫 ${secrets.size} 个凭据，均未出现在模型可见内容里`);
  }
}

// ── 8. 测试套件 ───────────────────────────────────────────────────────────
function runSuites() {
  const suites = [
    ['scripts/test-audit.mjs', '离线审计（协议/桥接/安全）'],
    ['scripts/test-cross-session-boundary.mjs', '跨会话边界 + 凭据不外发'],
    ['scripts/test-cross-send-approval.mjs', '跨会话代发（申请/批准/权限）'],
    ['scripts/test-cross-send-modes.mjs', '代发决策模式（手动/自动确认/自动拒绝）'],
    ['scripts/test-wait-unseen.mjs', '未看过消息时 wait 立即返回（条件式）'],
    ['scripts/test-mcp-safe.mjs', 'MCP 工具与校验'],
    ['scripts/test-stats-dispatch.mjs', '战绩工具合并成单一入口（action 分发/别名/参数校验）'],
    ['scripts/test-slang-research-parse.mjs', '黑话研究解析']
  ];
  for (const [rel, label] of suites) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { warn('测试', label, `${rel} 不存在`); continue; }
    try {
      const out = execFileSync(process.execPath, [p], { cwd: ROOT, stdio: 'pipe', timeout: 180000, encoding: 'utf8' });
      const last = String(out).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
      ok('测试', label, last.slice(0, 120));
    } catch (error) {
      const out = String(error.stdout ?? '') + String(error.stderr ?? '');
      const last = out.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      bad('测试', label, last.slice(0, 200));
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────
checkSyntax();
checkDeadCode();
checkScriptEncoding();
checkLaunchChain();
await checkStartupSmoke();
checkConfigDrift();
checkStateFiles();
await checkRuntime();
checkTokenBoundary();
checkSurrogateSafety();
checkSecretLeaks();
if (!FAST) runSuites();

if (AS_JSON) {
  console.log(JSON.stringify({ results, summary: summarize() }, null, 2));
} else {
  const ICON = { ok: '✅', warn: '⚠️ ', bad: '❌', info: 'ℹ️ ' };
  let section = '';
  for (const r of results) {
    if (r.section !== section) { section = r.section; console.log(`\n── ${section} ──`); }
    console.log(`${ICON[r.level]} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const s = summarize();
  console.log(`\n合计：${s.ok} 正常 / ${s.warn} 警告 / ${s.bad} 问题`);
  if (s.bad) {
    console.log('\n需要处理的问题：');
    for (const r of results.filter((x) => x.level === 'bad')) console.log(`  ❌ ${r.section} / ${r.name} — ${r.detail}`);
  }
}

function summarize() {
  return {
    ok: results.filter((r) => r.level === 'ok').length,
    warn: results.filter((r) => r.level === 'warn').length,
    bad: results.filter((r) => r.level === 'bad').length,
  };
}
process.exit(summarize().bad ? 1 : 0);
