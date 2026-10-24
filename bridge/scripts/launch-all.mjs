#!/usr/bin/env node
/**
 * launch-all.mjs —— 一键启动整套（2026-10-24 重写版）
 *
 * 所有服务都用 spawn + windowsHide 无窗口启动（直接 spawn node/python，
 * 不经过 cmd/bat —— 那样里面的控制台程序仍会给自己开窗口）。
 *
 * 用法：
 *   node scripts/launch-all.mjs              # 起全套（已跑的服务跳过）
 *   node scripts/launch-all.mjs --status     # 只看状态
 *   node scripts/launch-all.mjs --restart    # 重启桥接
 *   node scripts/launch-all.mjs --no-open    # 不打开浏览器
 *   node scripts/launch-all.mjs --no-check   # 兼容旧参数
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

// 配置：唯一入口 D:\QQaibot\settings.json（缺省值=本机现状）
let cfg = {};
try { cfg = JSON.parse(readFileSync('D:\\QQaibot\\settings.json', 'utf8')); } catch {}
cfg.ports = cfg.ports || {};

const BRIDGE = cfg.bridgeDir || 'D:\\qq-bridge';
const OVERSTATS = cfg.overstatsDir || 'D:\\Overstats';
const SNOWLUMA = cfg.snowlumaDir || 'D:\\SnowLuma';
const NAPCAT = cfg.napcatDir || 'D:\\NapCat\\app';
const HER_HOME = cfg.herDshDir || 'D:\\QQaibot\\dsh-her';
const SHELL_EXE = cfg.shellExe || 'D:\\QQaibot\\desktop\\dist\\qqai-desktop\\QQAI.exe';
const NODE_EXE = cfg.nodeExe || 'D:\\Program Files\\nodejs\\node.exe';
const PYTHON = cfg.pythonExe || 'C:\\Program Files\\Python312\\python.exe';
const DSH_BIN = cfg.dshBin || 'C:\\Users\\zjin6\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const NAPCAT_QQ = String(cfg.qq || '3167579121');
const PORT = {
  bridge: Number(cfg.ports.bridge) || 3100,
  herDsh: Number(cfg.ports.herDsh) || 3081,
  speech: Number(cfg.ports.speech) || 3111,
  napcatWs: Number(cfg.ports.napcatWs) || 3002,
};


const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes('--status');
const NO_OPEN = argv.includes('--no-open');
const RESTART = argv.includes('--restart');

const log = (m) => console.log(`[launch] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(command) {
  try {
    return execSync(`powershell -NoProfile -Command "${command}"`, {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
  } catch { return ''; }
}

function portPid(port) {
  const out = ps(`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess }`);
  const pid = Number(String(out).split(/\s+/).filter(Boolean)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function tcpAlive(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

async function waitPort(port, { timeoutMs = 120000, label = String(port) } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpAlive(port)) return true;
    await sleep(1500);
  }
  log(`WARN: ${label} 没在 ${Math.round(timeoutMs / 1000)}s 内就绪`);
  return false;
}

async function waitHttp(url, { timeoutMs = 180000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch {}
    await sleep(2000);
  }
  log(`WARN: ${label} 没在 ${Math.round(timeoutMs / 1000)}s 内就绪`);
  return false;
}

/** 直接 spawn 程序（无窗口），输出写 logFile。 */
function spawnProc(file, args, cwd, title, logFile, extraEnv = {}) {
  try {
    const out = logFile ? openSync(logFile, 'a') : 'ignore';
    spawn(file, args, {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    }).unref();
    log(`已启动 ${title}（无窗口）`);
    return true;
  } catch (error) {
    log(`WARN: 启动 ${title} 失败：${error?.message ?? error}`);
    return false;
  }
}

function launchBat(batPath, title) {
  spawn('cmd.exe', ['/c', batPath], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(batPath),
  }).unref();
  log(`已启动 ${title}`);
}

/** NapCat：VBS 隐藏启动（window style 0），快速登录、无窗口、无需 UAC。 */
function launchNapcat() {
  try {
    spawn('wscript.exe', [path.join(NAPCAT, 'napcat-hidden.vbs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    log('已启动 NapCat（快速登录，VBS 隐藏窗口）');
  } catch (error) {
    log(`WARN: 启动 NapCat 失败：${error?.message ?? error}`);
  }
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

function shellRunning() {
  return ps("Get-Process -Name 'QQAI' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id");
}

async function main() {
  if (STATUS_ONLY) {
    const over = portPid(18080);
    const dsh = portPid(3080);
    const br = portPid(PORT.bridge);
    log('当前状态：');
    log(`  Overstats (18080) : ${over ? `运行中 PID ${over}` : '未运行'}`);
    log(`  NapCat    (3002)  : ${(await tcpAlive(PORT.napcatWs)) ? '在线（快速登录）' : '未运行'}`);
    log(`  她的 DSH  (3081)  : ${(await tcpAlive(PORT.herDsh)) ? '运行中' : '未运行'}`);
    log(`  DSH       (3080)  : ${dsh ? `运行中 PID ${dsh}` : '未运行'}`);
    log(`  桥接      (3100)  : ${br ? `运行中 PID ${br}` : '未运行'}`);
    log(`  语音      (3111)  : ${(await tcpAlive(PORT.speech)) ? '运行中' : '未运行'}`);
    log(`  桌面壳            : ${shellRunning() ? '运行中' : '未运行'}`);
    return;
  }

  if (RESTART) {
    const pid = portPid(PORT.bridge);
    if (pid) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    await sleep(2000);
  }

  // 1. Overstats —— 2026-10-24 暂时不常驻：
  //    run.py 是 python 控制台程序，自己会分配控制台（窗口藏不住），
  //    而且它启动时的 asset check 经常卡住。她的战绩工具需要时再手动起：
  //    wscript D:\Overstats\overstats-hidden.vbs
  if (!portPid(18080)) {
    log('Overstats 跳过（战绩工具按需手动起：wscript D:\\Overstats\\overstats-hidden.vbs）');
  } else log('Overstats 已在运行。');

  // 2. NapCat（网关）
  if (!(await tcpAlive(PORT.napcatWs))) {
    log('NapCat 没在跑 → 快速登录启动 ...');
    launchNapcat();
    const ok = await waitPort(PORT.napcatWs, { timeoutMs: 120000, label: 'NapCat 3002' });
    if (ok) log('OK NapCat 就绪（3002）');
    else log('WARN: NapCat 没起来（无快速登录态？看 D:\\NapCat\\app\\napcat.log）');
  } else log('OK NapCat 网关在线（3002）');

  // 3. SnowLuma（只有 NapCat 不在时才用）
  if (!(await tcpAlive(PORT.napcatWs)) && !portPid(3001)) {
    log('启动 SnowLuma ...');
    launchBat(path.join(SNOWLUMA, 'launcher.bat'), 'SnowLuma');
    await waitPort(3001, { timeoutMs: 300000, label: 'SnowLuma 3001' });
  }

  // 4. 我的 DSH（3080）
  if (!portPid(3080)) {
    log('启动 DSH（3080，无窗口）...');
    const guardDir = path.join(process.env.USERPROFILE || '', '.dsh', 'guard', 'logs');
    mkdirSync(guardDir, { recursive: true });
    const guardLog = path.join(guardDir, `server-${nowStamp()}.out.log`);
    spawnProc(NODE_EXE, [DSH_BIN, 'web', '--port', '3080', '--no-open'], BRIDGE, 'DSH', guardLog);
    await waitPort(3080, { timeoutMs: 180000, label: 'DSH 3080' });
  } else log('DSH（3080）已在运行，跳过。');

  // 5. 她的 DSH（3081）
  if (!(await tcpAlive(PORT.herDsh))) {
    log('启动她的 DSH（3081，无窗口）...');
    const herGuardDir = path.join(HER_HOME, 'guard', 'logs');
    mkdirSync(herGuardDir, { recursive: true });
    const herGuardLog = path.join(herGuardDir, `server-${nowStamp()}.out.log`);
    spawnProc(NODE_EXE, [DSH_BIN, 'web', '--port', '3081', '--no-open'], HER_HOME, '她的 DSH', herGuardLog, { DSH_HOME: HER_HOME });
    const ok = await waitPort(PORT.herDsh, { timeoutMs: 120000, label: '她的 DSH 3081' });
    if (ok) log('OK 她的 DSH 就绪');
  } else log('她的 DSH 已在运行（3081），跳过。');

  // 6. 桌面壳
  if (shellRunning()) log('桌面壳已在运行，跳过。');
  else if (existsSync(SHELL_EXE)) {
    spawn(SHELL_EXE, [], { detached: true, stdio: 'ignore' }).unref();
    log('已启动桌面壳');
  } else log('WARN: 找不到桌面壳 exe');

  // 7. 桥接（最后）
  if (!portPid(PORT.bridge)) {
    log('启动 qq-bridge（无窗口）...');
    spawnProc(NODE_EXE, ['src/bridge.js'], BRIDGE, 'qq-bridge', null, { DSH_HOME: HER_HOME });
    const ok = await waitPort(PORT.bridge, { timeoutMs: 90000, label: '桥接 3100' });
    if (ok) log('OK 桥接就绪');
    else log('WARN: 桥接未就绪，看 state/bridge.log');
  } else log('桥接已在运行，跳过。');

  // 8. 语音
  const speechAlive = await fetch('http://127.0.0.1:3111/health', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false);
  if (!speechAlive) {
    log('拉起语音合成服务（无窗口）...');
    spawnProc(PYTHON, ['scripts\\speak-server.py'], BRIDGE, '语音', path.join(BRIDGE, 'state', 'speak-server.log'), {
      PYTHONIOENCODING: 'utf-8', HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1',
    });
  } else log('语音合成服务已在跑，跳过。');

  // 汇总
  let token = '';
  try { token = readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch {}
  log('');
  log('全部就绪：');
  log(`  桥接控制台   http://127.0.0.1:3100/?token=${token}`);
  log('  桌面壳       QQAI.exe（单窗口）');
  log('  网关         NapCat（3002/3003，无窗口）');
  log('  她的 DSH     http://127.0.0.1:3081');

  if (!NO_OPEN && token) {
    try {
      spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:3100/?token=${token}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } catch {}
  }
}

main().catch((error) => {
  log(`WARN: 启动失败：${error?.message ?? error}`);
  process.exitCode = 1;
});
