/**
 * 重启后的自动体检：DSH 是否按 guard 模式起来、桥接认证成功没有、模式回到 reserved2 没有、批测过不过。
 *
 * 为什么必须有它（2026-10-10 现场）：
 * 重启整套会把**正在跟管理员对话的那个 DSH** 一起换掉 —— 换完之后没人盯着看"新 DSH 的
 * launch token 桥接到底读到没有"。那天就是在这里翻的车：DSH 是手起的（不写 guard 日志），
 * 桥接一直 401，界面上每个服务都"在跑"，她一个字不说；而且因为 DSH 从未就绪，
 * 桥接的 refreshMode() 一次都没跑过，模式停在初始值 `chat`，她的 v2 工具全是 403。
 *
 * 所以这里把"结论"写清楚（restart-stack.bat 会把输出落到 state/restart-stack.log）：
 * 谁没起来、桥接有没有认证上、模式对不对，最后跑一遍 npm run verify。
 * 用法：node scripts/post-restart-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConsoleToken } from './lib/console-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'state', 'bridge.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[post-restart] ${m}`);

async function portOpen(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch { return false; }
}

/** 只读日志尾部：找"DSH 已就绪"与最近的 401，用来判断桥接到底认证上没有。 */
function logTail(lines = 120) {
  try { return fs.readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-lines); } catch { return []; }
}

async function waitFor(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(3000);
  }
  say(`⚠️ 等 ${label} 超时（${Math.round(timeoutMs / 1000)}s）`);
  return false;
}

let problems = 0;
const verdict = (ok, text) => { if (!ok) problems += 1; console.log(`[post-restart] ${ok ? '✅' : '❌'} ${text}`); };

/**
 * 只看"这一次桥接启动之后"的日志。
 * 为什么要切：重启前的告警（上一次进程留下的 401、preset 告警…）还躺在同一个文件里，
 * 直接扫尾部会把历史问题当成这次的问题，把一次干净的重启报成失败。
 */
function sinceBoot(lines) {
  const idx = lines.map((l) => l.includes('桥接已启动')).lastIndexOf(true);
  return idx === -1 ? lines : lines.slice(idx);
}

// ── 1. 桥接控制台 ──────────────────────────────────────────────────────────
say('等桥接控制台 3100 ...');
const bridgeUp = await waitFor('桥接 3100', () => portOpen(3100), 180000);
verdict(bridgeUp, bridgeUp ? '桥接控制台已监听' : '桥接控制台没起来（看 state/bridge.log）');

// ── 2. DSH 就绪 = 桥接真的认证上了 ─────────────────────────────────────────
say('等桥接认证 DSH（日志出现「DSH 已就绪」）...');
const bootLines = () => sinceBoot(logTail(600));
const ready = bridgeUp
  ? await waitFor('DSH 已就绪', () => bootLines().some((l) => l.includes('DSH 已就绪')), 180000)
  : false;
const readyLine = bootLines().filter((l) => l.includes('DSH 已就绪')).slice(-1)[0] ?? '';
verdict(ready, ready ? `桥接已认证 DSH — ${readyLine.trim()}` : '桥接没能认证 DSH（这次启动的日志里没有「DSH 已就绪」）');

if (!ready) {
  const tail = sinceBoot(logTail(60)).filter((l) => /401|token|不再可用|unauthorized/i.test(l)).slice(-3);
  for (const l of tail) say(`   证据: ${l.trim()}`);
  say('   排查方向：DSH 必须是 dsh-guard.bat 起的（手起的实例不写 launch token）；');
  say('   看 ~\\.dsh\\guard\\logs 最新一份里有没有 "?token=" 那一行。');
}

// ── 2b. preset 必须真的在 DSH 清单里 ──────────────────────────────────────
// 症状和"她不理人"一模一样：桥接会打 `⛔ 群聊/仿真会话缺少 preset "qq-chat-v2"`。
// 2026-10-10 DSH 0.2.0 改了 preset 的安装形式（旧的 ~/.dsh/.agent-presets 目录已无人读取），
// 于是"setup 打印安装成功、DSH 也照常启动，但她永远不被唤醒"。这里一次盯两层：
// 这次启动的桥接日志里有没有那条告警 + bundle 与 profile 注册是否真的就位。
const presetWarn = bootLines().some((l) => l.includes('不在 DSH 可用清单') || l.includes('未能挂载 preset'));
verdict(!presetWarn, presetWarn
  ? 'preset 没能生效（日志里有「不在 DSH 可用清单」或「未能挂载 preset」）→ 跑 node scripts/setup-dsh.mjs 后重启 DSH'
  : '桥接日志里没有 preset 告警（既没"不在清单"也没"未能挂载"）');

const presetBundleDir = path.join(ROOT, 'dsh', 'presets', 'qq-agent-presets');
const presetBundleOk = fs.existsSync(path.join(presetBundleDir, 'cordis.patch.yml'))
  && fs.existsSync(path.join(presetBundleDir, 'package.json'))
  && fs.existsSync(path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'qq-agent-presets'));
verdict(presetBundleOk, presetBundleOk
  ? 'preset bundle 已生成，且已注册进 web profile'
  : 'preset bundle 缺失或没注册进 profile → 跑 node scripts/setup-dsh.mjs');

// 2c. 端到端：重启后桥接会自动安排一次 bootstrap 唤醒（私聊，不受全局静默影响）。
// 那一次能不能投递成功，是"preset 真的可用"最直接的证据（失败会明确写「唤醒投递失败」+ 原因）。
const woke = bootLines().filter((l) => l.includes('[reserved2] 唤醒 private:'));
const wakeFailed = bootLines().some((l) => l.includes('唤醒投递失败'));
if (woke.length) {
  verdict(!wakeFailed, wakeFailed
    ? '有唤醒投递失败（原因见上面 bridge.log）'
    : `唤醒投递成功（private，共 ${woke.length} 次）— preset 真的挂上了`);
} else {
  say('（这次启动还没有 private 唤醒记录：等下一次唤醒才能确认 preset 端到端可用）');
}

// ── 3. 模式必须是 reserved2（她的 v2 工具在别的模式下全 403）────────────────
let mode = '';
if (bridgeUp) {
  try {
    const token = readConsoleToken();
    const r = await fetch(`http://127.0.0.1:3100/api/status?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    mode = String(j.mode ?? '');
    const silent = j.silentAll?.on === true;
    verdict(mode === 'reserved2', `桥接模式 = ${mode || '未知'}（要二代仿真的话必须是 reserved2）`);
    say(`   全局静默 = ${silent ? '开' : '关'}${silent ? `（${j.silentAll?.by ?? ''}）` : ''} — 这是管理员自己的开关，这里只报告不动它`);
  } catch (error) {
    verdict(false, `读 /api/status 失败：${error?.message ?? error}`);
  }
}

// ── 4. 全套验证：批测 + 自检 ───────────────────────────────────────────────
//
// 为什么要 detached + 直接 node（2026-10-10 实测）：上一次跑这一步时，日志停在
// `npm notice run node scripts/verify.mjs` 后面跟着 `^C^C^C` —— 也就是这条验证链
// 被控制台信号打断了（批测里有用例要 kill 进程，容易被同一个控制台组波及）。
// 结果就是"重启完到底行不行"没人知道，正是这个脚本要消灭的东西。
// detached 让它自成进程组，控制台信号传不进来；直接调 verify.mjs 也免得再套一层 npm。
say('跑 verify（批测 + 自检，约 2~4 分钟）...');
const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  detached: true,
  windowsHide: true,
});
if (verify.error) {
  verdict(false, `verify 起不来：${verify.error.message}`);
} else if (verify.status === null) {
  verdict(false, `verify 被信号打断（signal ${verify.signal}）—— 上面最后一行是它跑到哪一步`);
} else {
  verdict(verify.status === 0, `verify ${verify.status === 0 ? '通过' : `失败（exit ${verify.status}）— 失败项见上面，可单独重跑：node scripts/run-test-batch.mjs <用例名>`}`);
}

// ── 5. 活体适配体检（preset 清单 / 协议 / 会话格式都要 DSH 活着才测得到）─────
// 为什么不并进 `npm run verify`：那条命令要能在没有 DSH 的机器上跑（纯离线批测 + 静态自检），
// 而 verify:adaptation 是**活体**检查（要 guard token、要 DSH 在跑）。放在这里刚刚好。
// 2026-10-10 的教训：preset 装好了但 DSH 没重启，只有这种活体断言看得见。
say('跑 verify:adaptation（活体适配体检）...');
const adapt = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-dsh-adaptation.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
  detached: true,
  windowsHide: true,
});
if (adapt.error) verdict(false, `verify:adaptation 起不来：${adapt.error.message}`);
else if (adapt.status === null) verdict(false, `verify:adaptation 被信号打断（signal ${adapt.signal}）`);
else verdict(adapt.status === 0, `verify:adaptation ${adapt.status === 0 ? '通过' : `失败（exit ${adapt.status}）— 上面有逐条 ❌`}`);

say('');
say(problems === 0 ? '结论：这次重启是干净的（模式对、桥接认证上了、preset 生效、验证全过）。' : `结论：有 ${problems} 项要处理，见上面的 ❌。`);
process.exit(problems === 0 ? 0 : 1);
