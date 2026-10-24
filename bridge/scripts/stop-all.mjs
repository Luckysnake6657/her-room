// 一键停掉整套（QQAI 退出时调它）：桥接 / 她的 DSH / 语音 / Overstats。
// NapCat 默认也停（它 hook 的 QQ 会退，下次开 QQAI 再拉起 + 扫码）。
// 用法：node scripts/stop-all.mjs [--keep-napcat]
import { execSync } from 'node:child_process';

const keepNapcat = process.argv.includes('--keep-napcat');
const log = (m) => console.log(`[stop] ${m}`);

function ps(command) {
  try { return execSync(`powershell -NoProfile -Command "${command}"`, { encoding: 'utf8', timeout: 15000 }).trim(); } catch { return ''; }
}
function portPid(port) {
  const out = ps(`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess }`);
  const pid = Number(String(out).split(/\s+/).filter(Boolean)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function killPid(pid, label) {
  if (!pid) return;
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 15000 }); log(`已停 ${label} (PID ${pid})`); }
  catch { log(`${label} (PID ${pid}) 停止失败（可能已退出）`); }
}

// 端口 → 名字
const targets = [
  [3100, '桥接'],
  [3081, '她的 DSH'],
  [3111, '语音'],
  [18080, 'Overstats'],
];
for (const [port, name] of targets) killPid(portPid(port), name);

if (!keepNapcat) {
  // NapCat：杀掉它的 boot 进程 + 它 hook 的 QQ（QQ 会一起退）
  const napcat = ps("Get-CimInstance Win32_Process -Filter \"Name='NapCatWinBootMain.exe'\" | Select-Object -ExpandProperty ProcessId");
  const pids = String(napcat).split(/\s+/).filter(Boolean).map(Number);
  for (const pid of pids) killPid(pid, 'NapCat');
  // 它拉起的 QQ（NapCat 的 boot 进程退了，QQ 通常也退；保险起见再清一次无窗口的）
  const qq = ps("Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Select-Object -ExpandProperty Id");
  for (const pid of String(qq).split(/\s+/).filter(Boolean).map(Number)) killPid(pid, 'QQ（NapCat 的）');
}

log('完成');
