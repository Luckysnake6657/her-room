// Electron 主进程：窗口 + 托盘 + 桥接 API 代理 + 服务托管（单一父子结构）。
//
// 2026-10-24（管理员："可以做成单一进程+子进程吗"）：服务不再经 launch-all，
// 直接由本进程 spawn 成子进程 —— QQAI 是唯一的主，子进程随它退出而全杀。
// 2026-10-25（"别人也能轻松部署也能轻松配置"）：路径/QQ号/端口/人格全部从
// D:\QQaibot\settings.json 读，代码里不再写死（缺省值=本机现状）。
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn, execSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

// ── 配置（唯一入口：D:\QQaibot\settings.json）──────────────────
const SETTINGS_FILE = path.join('D:', 'QQaibot', 'settings.json');
let cfg = {};
let cfgError = '';
try {
  cfg = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch (error) {
  cfgError = fs.existsSync(SETTINGS_FILE) ? `settings.json 解析失败：${error?.message ?? error}` : '缺少 settings.json';
}
cfg.ports = cfg.ports || {};

/** 配置检查：缺关键项 → 界面引导（首次向导）。 */
function configProblems() {
  const problems = [];
  if (cfgError) problems.push(cfgError);
  const bridge = cfg.bridgeDir || 'D:\\qq-bridge';
  if (!fs.existsSync(bridge)) problems.push(`桥接目录不存在：${bridge}`);
  const her = cfg.herDshDir || 'D:\\QQaibot\\dsh-her';
  if (!fs.existsSync(her)) problems.push(`她的实例目录不存在：${her}`);
  const napcat = cfg.napcatDir || 'D:\\NapCat\\app';
  if (!fs.existsSync(napcat)) problems.push(`NapCat 目录不存在：${napcat}`);
  if (!String(cfg.qq || '').trim()) problems.push('没填 QQ 号（settings.json 的 qq）');
  return problems;
}

const BRIDGE_DIR = cfg.bridgeDir || 'D:\\qq-bridge';
const HER_HOME = cfg.herDshDir || 'D:\\QQaibot\\dsh-her';
const NAPCAT_DIR = cfg.napcatDir || 'D:\\NapCat\\app';
const NODE_EXE = cfg.nodeExe || 'D:\\Program Files\\nodejs\\node.exe';
const PYTHON = cfg.pythonExe || 'C:\\Program Files\\Python312\\python.exe';
const DSH_BIN = cfg.dshBin || 'C:\\Users\\zjin6\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
// 这里不能有默认号：空了就空着，NapCat 会被跳过（免得误登别人的号）。
// 2026-10-25：原来默认 '3167579121'，别人配置空时会登成这个号。
const NAPCAT_QQ = String(cfg.qq || '').trim();
const PORT = {
  bridge: Number(cfg.ports.bridge) || 3100,
  herDsh: Number(cfg.ports.herDsh) || 3081,
  speech: Number(cfg.ports.speech) || 3111,
  napcatWs: Number(cfg.ports.napcatWs) || 3002,
  napcatWeb: Number(cfg.ports.napcatWeb) || 6099,
};
const BRIDGE_URL = `http://127.0.0.1:${PORT.bridge}`;
const TOKEN_FILE = path.join(BRIDGE_DIR, 'state', 'console-token');

let win = null;
let tray = null;

// 子进程登记表（name -> {child, port}）——退出时统一杀
const children = new Map();

function logLine(msg) {
  try {
    fs.appendFileSync(path.join(BRIDGE_DIR, 'state', 'qqai-supervisor.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
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

function openLog(file) {
  try { return fs.openSync(file, 'a'); } catch { return 'ignore'; }
}

/** 起一个子进程（无窗口），登记到 children。 */
function startChild(name, file, args, opts = {}) {
  if (children.has(name)) return children.get(name);
  try {
    const out = opts.logFile ? openLog(opts.logFile) : 'ignore';
    const child = spawn(file, args, {
      cwd: opts.cwd || BRIDGE_DIR,
      detached: false,           // 父子结构：随 QQAI 退出
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, ...(opts.env || {}) },
    });
    child.on('exit', () => { children.delete(name); logLine(`${name} exited`); });
    // spawn 失败（ENOENT：目录/可执行文件不存在）是异步 error 事件，不接就会崩主进程
    child.on('error', (error) => {
      children.delete(name);
      logLine(`${name} spawn error: ${error?.message ?? error}`);
    });
    children.set(name, child);
    logLine(`started ${name} pid=${child.pid}`);
    return child;
  } catch (error) {
    logLine(`start ${name} failed: ${error?.message ?? error}`);
    return null;
  }
}

function running(name) {
  const c = children.get(name);
  return !!c && c.exitCode === null && !c.killed;
}

/** 服务定义：check 端口 → 没就起。 */
const SERVICES = [
  {
    name: 'NapCat', port: PORT.napcatWs,
    start: () => {
      // 没有 QQ 号就别起 NapCat：不然它会默认登成 QQ 里当前登录的号（别人的大号）
      if (!NAPCAT_QQ) {
        logLine('NapCat 跳过：settings.json 没填 qq（避免误登当前登录的号）');
        return null;
      }
      return startChild('NapCat', 'cmd.exe', ['/c', path.join(NAPCAT_DIR, cfg.napcat?.launcher || 'napcat-hidden.bat'), NAPCAT_QQ],
        { cwd: NAPCAT_DIR });
    },
  },
  {
    name: '她的DSH', port: PORT.herDsh,
    start: () => startChild('她的DSH', NODE_EXE, [DSH_BIN, 'web', '--port', String(PORT.herDsh), '--no-open'],
      { cwd: HER_HOME, env: { DSH_HOME: HER_HOME }, logFile: path.join(HER_HOME, 'guard', 'logs', `server-${stamp()}.out.log`) }),
  },
  {
    name: '桥接', port: PORT.bridge,
    start: () => startChild('桥接', NODE_EXE, ['src/bridge.js'],
      { cwd: BRIDGE_DIR, env: { DSH_HOME: HER_HOME } }),
  },
  {
    name: '语音', port: PORT.speech,
    start: () => startChild('语音', PYTHON, ['scripts\\speak-server.py'],
      { cwd: BRIDGE_DIR, logFile: path.join(BRIDGE_DIR, 'state', 'speak-server.log'), env: { PYTHONIOENCODING: 'utf-8', HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' } }),
  },
];

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

/** 日期 → 星座（人设生成用）。 */
function zodiacOf(month, day) {
  const md = month * 100 + day;
  if (md >= 321 && md <= 419) return '白羊座';
  if (md >= 420 && md <= 520) return '金牛座';
  if (md >= 521 && md <= 621) return '双子座';
  if (md >= 622 && md <= 722) return '巨蟹座';
  if (md >= 723 && md <= 822) return '狮子座';
  if (md >= 823 && md <= 922) return '处女座';
  if (md >= 923 && md <= 1023) return '天秤座';
  if (md >= 1024 && md <= 1122) return '天蝎座';
  if (md >= 1123 && md <= 1221) return '射手座';
  if (md >= 1222 || md <= 119) return '摩羯座';
  if (md >= 120 && md <= 218) return '水瓶座';
  return '双鱼座';
}

let supervising = false;
/** 监督循环：每 2 秒看一遍端口，缺谁起谁（崩了自动重启，带退避防崩溃循环）。 */
async function supervise() {
  if (supervising) return;
  supervising = true;
  logLine('supervisor start');
  const fails = new Map(); // name -> 连续失败次数
  const downSince = new Map(); // name -> 端口开始不通的时间
  for (;;) {
    for (const svc of SERVICES) {
      if (await tcpAlive(svc.port)) {
        fails.delete(svc.name);
        downSince.delete(svc.name);
        continue;
      }
      if (running(svc.name)) {
        // 进程在、端口不通 = 可能假死：60 秒还不通就杀掉让下面重起
        if (!downSince.has(svc.name)) downSince.set(svc.name, Date.now());
        if (Date.now() - downSince.get(svc.name) > 60000) {
          killChild(svc.name);
          downSince.delete(svc.name);
        }
        continue;
      }
      downSince.delete(svc.name);
      const n = (fails.get(svc.name) || 0) + 1;
      fails.set(svc.name, n);
      if (n > 3) {
        // 连续起不来：指数退避（最多 60 秒一次），避免每 2 秒狂拉
        const waitMs = Math.min(60000, 2000 * 2 ** (n - 3));
        logLine(`${svc.name} 连续 ${n} 次没起来，等 ${Math.round(waitMs / 1000)}s 再试`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      svc.start();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function stopChildren() {
  for (const [name, child] of children) {
    try {
      if (child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true });
      logLine(`killed ${name} pid=${child.pid}`);
    } catch {}
  }
  children.clear();
}

/** 杀单个子进程（假死检测用）。 */
function killChild(name) {
  const child = children.get(name);
  if (!child?.pid) return;
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch {}
  children.delete(name);
  logLine(`假死，已杀 ${name} pid=${child.pid}`);
}

function consoleToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function ownerQQ() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
    return String(c.ownerQQ || '').trim();
  } catch { return ''; }
}

function agentToken() {
  const qq = ownerQQ();
  if (!/^\d{5,12}$/.test(qq)) return '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'social-v2.json'), 'utf8'));
    return s.conversations?.['private:' + qq]?.agentToken || '';
  } catch { return ''; }
}

async function bridgeRequest({ path: p, method = 'GET', body = null }) {
  const headers = { 'x-console-token': consoleToken() };
  if (/^\/api\/socialV2\/send/.test(p)) headers['x-agent-token'] = agentToken();
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(BRIDGE_URL + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json, text: text.slice(0, 500) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0e17',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png'));
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch { icon = nativeImage.createEmpty(); }
  tray = new Tray(icon);
  tray.setToolTip('AI 助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => win?.show() },
    { label: '隐藏窗口', click: () => win?.hide() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => win?.show());
}

app.whenReady().then(() => {
  ipcMain.handle('bridge', async (_e, req) => {
    try { return await bridgeRequest(req || {}); }
    catch (error) { return { status: 0, ok: false, error: String(error?.message ?? error) }; }
  });
  ipcMain.handle('console-token', () => consoleToken());
  ipcMain.handle('status', async () => {
    // 环境检测：别人有没有装 node/DSH/QQ —— 有就用，没有就引导
    let qqRunning = false;
    let dshInstalled = false;
    try {
      qqRunning = fs.existsSync('C:\\Program Files\\Tencent\\QQNT\\QQ.exe')
        || execSync("powershell -NoProfile -Command \"(Get-Process -Name QQ -ErrorAction SilentlyContinue | Measure-Object).Count\"", { encoding: 'utf8', windowsHide: true }).trim() !== '0';
    } catch {}
    try { dshInstalled = fs.existsSync(DSH_BIN); } catch {}
    return {
      bridge: await tcpAlive(PORT.bridge),
      napcat: await tcpAlive(PORT.napcatWs),
      napcatWeb: await tcpAlive(PORT.napcatWeb),
      herDsh: await tcpAlive(PORT.herDsh),
      qqInstalled: fs.existsSync('C:\\Program Files\\Tencent\\QQNT\\QQ.exe'),
      qqRunning,
      dshInstalled,
      configProblems: configProblems(),
      settingsFile: SETTINGS_FILE,
      personaName: String(cfg.personaName || '').trim() || 'AI 助手',
      qqNickname: String(cfg.qqNickname || '').trim(),
      botQQ: String(cfg.qq || '').trim(),
      ownerQQ: ownerQQ(),
      // 环境冲突检测：SnowLuma 在跑的话，同一个 QQ 号会被它 hook，NapCat 再 hook 会打架
      snowlumaRunning: (await tcpAlive(3001)) || (await tcpAlive(5099)),
      // NapCat 真需要扫码时（它生成了 qrcode.png 且是新的）才让界面显示二维码
      needQr: (() => {
        const qr = path.join(NAPCAT_DIR, 'cache', 'qrcode.png');
        try {
          const st = fs.statSync(qr);
          return { file: qr.replace(/\\/g, '/'), fresh: Date.now() - st.mtimeMs < 5 * 60 * 1000 };
        } catch { return { file: '', fresh: false }; }
      })(),
    };
  });
  // 打开 QQ（引导用：没登录时点一下）
  // 向导：选目录 / 保存配置
  // 向导：保存 API key 到她的实例（.credentials.yaml）
  // 向导：按 QQ 号生成个性化默认人设（生日/星座每人不同），写 roles/默认助手.md
  ipcMain.handle('make-persona', (_e, qq) => {
    try {
      const num = Number(String(qq || '').replace(/\D/g, '')) || 0;
      // QQ 号 → 生日（哈希到 365 天）→ 星座
      const dayOfYear = num % 365;
      const d = new Date(2024, 0, 1 + dayOfYear);
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const zodiac = zodiacOf(month, day);
      const templatePath = path.join(BRIDGE_DIR, 'roles', '默认助手.md');
      let text = '';
      try { text = fs.readFileSync(templatePath, 'utf8'); } catch { text = ''; }
      if (!text) return '';
      text = text
        .replace(/19 岁，女生，1 月 13 日生日，摩羯座/, `19 岁，女生，${month} 月 ${day} 日生日，${zodiac}`)
        .replace(/1 月 13 日/g, `${month} 月 ${day} 日`)
        .replace(/摩羯座/g, zodiac);
      const target = path.join(BRIDGE_DIR, 'roles', '默认助手.md');
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      fs.writeFileSync(target, text, 'utf8');
      return `${month} 月 ${day} 日 / ${zodiac}`;
    } catch { return ''; }
  });
  ipcMain.handle('save-persona-card', (_e, payload) => {
    try {
      const name = String(payload?.name || '').trim().replace(/[\\/:*?"<>|]/g, '');
      const text = String(payload?.text || '');
      if (!name || !text.trim()) return false;
      const dir = path.join(BRIDGE_DIR, 'roles');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${name}.md`);
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      fs.writeFileSync(target, text, 'utf8');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('save-credentials', (_e, apiKey) => {
    try {
      const f = path.join(HER_HOME, '.credentials.yaml');
      fs.mkdirSync(HER_HOME, { recursive: true });
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch {}
      const key = String(apiKey || '').trim();
      if (!key) return false;
      if (/DEEPSEEK_API_KEY:/.test(text)) {
        text = text.replace(/DEEPSEEK_API_KEY:[^\n]*/g, `DEEPSEEK_API_KEY: ${key}`);
      } else if (/refs:/.test(text)) {
        text = text.replace(/refs:[^\n]*/, `refs:\n  DEEPSEEK_API_KEY: ${key}`);
      } else {
        text = `refs:\n  DEEPSEEK_API_KEY: ${key}\n`;
      }
      fs.writeFileSync(f, text, 'utf8');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('pick-dir', async () => {
    try {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog(win, { title: '选择目录', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths?.length) return '';
      return r.filePaths[0];
    } catch { return ''; }
  });
  // 自动探测常见安装位置（向导预填用；只返回存在的那几个）
  ipcMain.handle('detect-paths', () => {
    const candidates = {
      bridgeDir: ['D:\\qq-bridge', 'C:\\qq-bridge', path.join(process.env.USERPROFILE || '', 'qq-bridge')],
      herDshDir: ['D:\\QQaibot\\dsh-her', 'C:\\QQaibot\\dsh-her', path.join(process.env.USERPROFILE || '', 'QQaibot', 'dsh-her')],
      napcatDir: ['D:\\QQaibot\\napcat', 'D:\\NapCat\\app', 'C:\\NapCat\\app'],
      desktopDir: ['D:\\QQaibot\\desktop', 'C:\\QQaibot\\desktop'],
    };
    const out = {};
    for (const [k, list] of Object.entries(candidates)) {
      out[k] = list.find((p) => { try { return !!(p && fs.existsSync(p)); } catch { return false; } }) || '';
    }
    return out;
  });
  ipcMain.handle('save-settings', (_e, patch) => {
    try {
      const current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
      const next = { ...current, ...(patch || {}) };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('launch-qq', () => {
    try {
      const qq = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
      if (fs.existsSync(qq)) { spawn(qq, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
    } catch {}
    return false;
  });
  ipcMain.handle('start-napcat', () => { SERVICES.find((s) => s.name === 'NapCat')?.start(); return true; });
  // 「重启网关」：杀掉 NapCat 子进程（含它拉起的 QQ），supervise 会自动重起
  ipcMain.handle('restart-napcat', () => {
    const c = children.get('NapCat');
    if (c?.pid) {
      try { execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch {}
      children.delete('NapCat');
    }
    // 它 hook 的 QQ 一起清（无窗口的那些）
    try {
      execSync('powershell -NoProfile -Command "Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq \'\' } | Stop-Process -Force"', { stdio: 'ignore', timeout: 15000, windowsHide: true });
    } catch {}
    return true;
  });
  // 「重启她的 DSH」：杀了子进程，supervise 自动重起（会话重建，记忆在桥接里）
  ipcMain.handle('restart-dsh', () => {
    const c = children.get('她的DSH');
    if (c?.pid) {
      try { execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch {}
      children.delete('她的DSH');
    }
    return true;
  });
  // 打开她的 DSH 日志目录 / WebUI（用系统资源管理器/浏览器）
  ipcMain.handle('open-path', (_e, p) => {
    try { require('electron').shell.openPath(String(p)); return true; } catch { return false; }
  });
  // 日记 / 情绪（右侧面板的数据源；桥接只有写日记的接口，读走文件）
  // 白名单（config.json 的 allow）——控制台显示用
  // 白名单 / 管理员 QQ 的写操作（控制台可设置）
  ipcMain.handle('save-allow', (_e, patch) => {
    try {
      const f = path.join(BRIDGE_DIR, 'config.json');
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (patch && Array.isArray(patch.private)) c.allow = { ...c.allow, private: patch.private.map(String) };
      if (patch && Array.isArray(patch.groups)) c.allow = { ...c.allow, groups: patch.groups.map(String) };
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n', 'utf8');
      return true;
    } catch { return false; }
  });
  // 天气城市（写 config.socialV2.weather，桥接读它刷新天气）
  ipcMain.handle('save-weather', (_e, city) => {
    try {
      const name = String(city || '').trim();
      if (!name) return false;
      const f = path.join(BRIDGE_DIR, 'config.json');
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      c.socialV2 = c.socialV2 || {};
      c.socialV2.weather = { ...(c.socialV2.weather || {}), city: name };
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n', 'utf8');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('save-owner', (_e, qq) => {
    try {
      const n = Number(String(qq || '').trim());
      if (!Number.isFinite(n) || n <= 0) return false;
      const f = path.join(BRIDGE_DIR, 'config.json');
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      c.ownerQQ = n;
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n', 'utf8');
      return true;
    } catch { return false; }
  });
  ipcMain.handle('read-allow', () => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
      return { private: c.allow?.private ?? [], groups: c.allow?.groups ?? [] };
    } catch { return { private: [], groups: [] }; }
  });
  ipcMain.handle('read-diary', () => {
    try {
      const dir = path.join(BRIDGE_DIR, 'state', 'her-diary');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-3);
      return files.reverse().map((f) => ({
        date: f.replace(/\.md$/, ''),
        text: fs.readFileSync(path.join(dir, f), 'utf8'),
      }));
    } catch { return []; }
  });
  // 能力清单（scripts/detect-capabilities.mjs 生成）
  // 备份她的"灵魂"：记忆/日记/情绪权重/人设 → 一个 zip（不碰 QQ/DSH 运行态）
  ipcMain.handle('backup-her', () => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const dir = path.join(BRIDGE_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `her-backup-${ts}.zip`);
      const items = [
        path.join(BRIDGE_DIR, 'state', 'social-v2.json'),
        path.join(BRIDGE_DIR, 'state', 'her-diary'),
        path.join(BRIDGE_DIR, 'state', 'emotion-weights.json'),
        path.join(BRIDGE_DIR, 'state', 'corpus'),
      ].filter((p) => fs.existsSync(p));
      if (!items.length) return '';
      const list = items.map((p) => `'${p}'`).join(',');
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path ${list} -DestinationPath '${out}' -Force"`, {
        stdio: 'ignore', timeout: 120000, windowsHide: true,
      });
      return out;
    } catch { return ''; }
  });
  ipcMain.handle('read-capabilities', () => {
    try { return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'capabilities.json'), 'utf8')); }
    catch { return null; }
  });
  ipcMain.handle('read-emotion', () => {
    try {
      const qq = ownerQQ();
      if (!/^\d{5,12}$/.test(qq)) return null;
      const s = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'social-v2.json'), 'utf8'));
      const c = s.conversations?.['private:' + qq];
      const e = c?.emotion || {};
      return { pad: e.pad || [0, 0, 0], updatedAt: e.updatedAt || 0, lastEvent: e.lastEvent || '' };
    } catch { return null; }
  });
  ipcMain.handle('open-url', (_e, u) => {
    // 2026-10-24：不跳系统浏览器 —— 用应用内的 Chromium 窗口（Electron 自带内核）
    try {
      const w = new BrowserWindow({
        width: 1100, height: 800, autoHideMenuBar: true,
        title: '内嵌页面', backgroundColor: '#0a0e17',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      w.loadURL(String(u));
      return true;
    } catch { return false; }
  });
  // 她的 DSH WebUI 要带 token（日志里那条 `dsh web: http://127.0.0.1:<port>/?token=...`）
  ipcMain.handle('her-dsh-url', () => {
    try {
      const dir = path.join(HER_HOME, 'guard', 'logs');
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('server-')).sort();
      const re = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${PORT.herDsh}/\\?token=[\\w-]+)`);
      for (const f of files.reverse()) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = re.exec(text);
        if (m) return m[1];
      }
    } catch {}
    return `http://127.0.0.1:${PORT.herDsh}`;
  });
  ipcMain.handle('ensure-services', () => { supervise(); return true; });
  // 选壁纸（系统文件对话框，只收图片）——QQ/微信那种自定义背景
  ipcMain.handle('pick-wallpaper', async () => {
    try {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog(win, {
        title: '选一张壁纸',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
      });
      if (r.canceled || !r.filePaths?.length) return '';
      return r.filePaths[0];
    } catch { return ''; }
  });
  // 字号 = 整体缩放（webFrame zoom，比改 font-size 明显得多）
  ipcMain.handle('set-zoom', (_e, factor) => {
    try {
      const f = Number(factor);
      if (win && Number.isFinite(f) && f >= 0.5 && f <= 2.5) win.webContents.setZoomFactor(f);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:maximize', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
  ipcMain.handle('win:close', () => { if (!win) return; app.isQuitting = true; app.quit(); });
  supervise();        // 主进程直接托管子进程
  createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// QQAI 退出 = 杀掉所有子进程（真正的一棵树）
let stopping = false;
app.on('before-quit', () => {
  if (stopping) return;
  stopping = true;
  logLine('QQAI quitting, stopping children');
  stopChildren();
});
