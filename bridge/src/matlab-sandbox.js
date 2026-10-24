/**
 * MATLAB 沙箱的**纯逻辑**（2026-10-13）。
 *
 * 为什么单独成模块：这些逻辑（要不要走绘图模式、频率够不够、输出怎么截断、重放结果怎么解析、
 * 代码预检）全都能离线测，不需要真启动 MATLAB。桥接里那层只负责"收请求 → 调脚本 → 把结果给她"。
 *
 * 背景（实测）：MATLAB R2025b 出图**必须**再起 MATLABWindow.exe，而沙箱的"最多 1 个进程"
 * 会把它一起挡掉（报 1816 配额不足）。所以做成两遍：
 *   ① 沙箱里跑她的代码（限 1 个进程 → system/builtin('system') 都是 rc=-1），
 *      绘图调用被桩函数接住、录进 sandbox_record.jsonl；
 *   ② 正常进程环境下重放录下来的调用 → 真出图。
 * 她的代码一个字不用改，而"跑系统命令"那层始终是内核级锁死的。
 */

/** 会被桩接住的绘图/图形相关函数（出现在代码里 → 走绘图模式，跑完要重放）。 */
export const MATLAB_DRAW_FNS = [
  'plot', 'plot3', 'semilogy', 'semilogx', 'loglog', 'mesh', 'meshc', 'meshz', 'surf', 'surfc', 'surfl',
  'contour', 'contourf', 'contour3', 'quiver', 'quiver3', 'bar', 'barh', 'bar3', 'bar3h', 'hist', 'histogram',
  'pie', 'pie3', 'polarplot', 'scatter', 'scatter3', 'stem', 'stem3', 'stairs', 'area', 'fill', 'fill3',
  'patch', 'errorbar', 'imagesc', 'image', 'pcolor', 'waterfall', 'ribbon', 'slice', 'subplot', 'hold',
  'title', 'xlabel', 'ylabel', 'zlabel', 'legend', 'grid', 'axis', 'xlim', 'ylim', 'zlim', 'colormap',
  'colorbar', 'shading', 'view', 'text', 'annotation', 'saveas', 'savefig', 'print', 'exportgraphics', 'figure',
];

/**
 * 这段代码要不要走绘图模式（= 跑完要重放一遍出图）。
 * 只看**函数调用形式**（`名字(`）和绘图相关关键字，避免误判普通的变量名。
 */
export function needsPlotMode(code) {
  const src = String(code ?? '');
  if (!src.trim()) return false;
  const callers = new Set();
  // 函数调用：`名字(`；排除关键字和常见的非绘图调用
  for (const m of src.matchAll(/([A-Za-z_]\w*)\s*\(/g)) callers.add(m[1]);
  for (const fn of MATLAB_DRAW_FNS) if (callers.has(fn)) return true;
  // 无括号的图形命令（`grid on`、`hold on`、`figure`）
  if (/(^|\n)\s*(grid|hold|figure|shading|colormap|colorbar|axis|view|box|clf|close|drawnow)\b/.test(src)) return true;
  return false;
}

/** 代码预检：黑名单 + 三道加强闸（`!` 转义 / `@危险函数` / 字符串里的 shell 特征）。 */
export const MATLAB_DENY_PATTERN = '\\b(system|dos|unix|winqueryreg|actxserver|webread|webwrite|urlread|urlwrite|ftp|sftp|fileread|fopen|fclose|save|load|delete|rmdir|mkdir|copyfile|movefile|dir|ls|what|type|exist|eval|evalin|assignin|feval|builtin|str2func|matlabFunction|javaObject|py\\.)\\b';
export const MATLAB_EXTRA_DENY = [
  { re: /(^|\s)!/, name: 'bang 转义（!cmd 直接执行系统命令）' },
  { re: /@\s*(system|dos|unix|winqueryreg|actxserver|javaObject|py)/, name: '危险函数的句柄（@system 之类）' },
  { re: /(cmd(\.exe)?|powershell|pwsh|wscript|cscript|mshta|System32|\/c\s)/i, name: 'shell 特征字符串' },
];

/**
 * 预检她的代码。返回 `{ ok, hits }`：`ok:false` 时 `hits` 是被禁东西的名字（给她看的）。
 * ⚠️ 这是"提高门槛"，不是隔离 —— 真正内核级那层在沙箱的"最多 1 个进程"。
 */
export function checkMatlabCode(code, { denyPattern = MATLAB_DENY_PATTERN, extra = MATLAB_EXTRA_DENY } = {}) {
  const src = String(code ?? '');
  const hits = [];
  if (denyPattern) {
    const rx = new RegExp(denyPattern, 'g');
    for (const m of src.matchAll(rx)) if (!hits.includes(m[0])) hits.push(m[0]);
  }
  for (const x of extra) if (x.re.test(src) && !hits.includes(x.name)) hits.push(x.name);
  return { ok: hits.length === 0, hits };
}

/** 频率上限（每分钟/每小时）。`times` 是历史时间戳数组（毫秒）。 */
export function matlabRateInfo(times, now, { maxPerMinute = 2, maxPerHour = 10 } = {}) {
  const list = Array.isArray(times) ? times.map(Number).filter((t) => Number.isFinite(t)) : [];
  const inMinute = list.filter((t) => now - t < 60_000).length;
  const inHour = list.filter((t) => now - t < 3_600_000).length;
  if (maxPerMinute > 0 && inMinute >= maxPerMinute) {
    return { limited: true, reason: 'minute', retryAfterSec: 60 - Math.floor((now - Math.max(...list.filter((t) => now - t < 60_000))) / 1000) };
  }
  if (maxPerHour > 0 && inHour >= maxPerHour) return { limited: true, reason: 'hour', retryAfterSec: 600 };
  return { limited: false, inMinute, inHour };
}

/** 输出截断：太长就切，并明确告诉她"被截断了、要看全就说一声"。 */
export function truncateMatlabOutput(text, max = 4000) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…（输出太长，已截断到 ${max} 字符）`, truncated: true };
}

/** 解析重放脚本的输出：拿到"哪几张图出来了"和失败原因。 */
export function parseReplayOutput(text) {
  const files = [];
  const warns = [];
  let done = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('REPLAY_DONE')) done = true;
    else if (t.startsWith('REPLAY_FILE ')) files.push(t.slice('REPLAY_FILE '.length).trim());
    else if (t.startsWith('REPLAY_WARN')) warns.push(t.slice('REPLAY_WARN '.length).trim());
  }
  return { done, files, warns };
}

/** 统计"这次跑了多久 / 有没有图 / 退出码"，写审计用（一行 JSON）。 */
export function matlabAuditEntry({ key, code, exitCode, ms, plot, files, truncated, reason }) {
  return {
    at: new Date().toISOString(),
    key: String(key ?? ''),
    code: String(code ?? '').slice(0, 2000),
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    ms: Number.isFinite(Number(ms)) ? Number(ms) : null,
    plot: plot === true,
    files: Array.isArray(files) ? files.slice(0, 20) : [],
    truncated: truncated === true,
    ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
  };
}
