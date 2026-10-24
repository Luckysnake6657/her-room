// 把已经泄露进聊天记录里的凭据文本擦掉。
//
// 场景：控制台令牌曾被当成一条 QQ 消息发出去（测试失误），文本落在
// state/social-v2.json 的 recentMessages 里，之后每次唤醒都会被喂进模型上下文。
// 令牌本身已经轮换作废，但让它留在历史里没有任何好处。
//
// 必须在桥接**停止**时改：运行中的桥接持有内存副本，任何一次状态保存都会覆盖回去。
// 所以这里先杀进程、改文件、等守护窗口把它拉起来，再验证改动还在。
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const FILE = 'D:/qq-bridge/state/social-v2.json';
const NEEDLES = process.argv.slice(2);
if (!NEEDLES.length) {
  console.error('用法: node scripts/scrub-secret-from-state.mjs <要擦掉的字符串> [...]');
  process.exit(1);
}

const bridgePids = () => {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'src.bridge.js' } | Select-Object -ExpandProperty ProcessId\"",
      { encoding: 'utf8', timeout: 20000 }
    );
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
};

const pids = bridgePids();
console.log('停止桥接进程:', pids.length ? pids.join(', ') : '（没有在跑）');
for (const pid of pids) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 20000 }); } catch {}
}

// 等进程真的退出
for (let i = 0; i < 20 && bridgePids().length; i++) {
  await new Promise((r) => setTimeout(r, 500));
}
if (bridgePids().length) { console.error('桥接没停下来，放弃（避免改动被覆盖）'); process.exit(1); }

let raw = fs.readFileSync(FILE, 'utf8');
let total = 0;
for (const needle of NEEDLES) {
  if (!needle) continue;
  const n = raw.split(needle).length - 1;
  if (n) { raw = raw.split(needle).join('***已擦除***'); total += n; }
  console.log(`  「${needle.slice(0, 12)}…」出现 ${n} 次`);
}
fs.writeFileSync(FILE, raw, 'utf8');
console.log(`已擦除 ${total} 处`);

// 等守护窗口把桥接拉起来（start.bat 循环：5 秒重试）
console.log('等待桥接被守护窗口拉起…');
let up = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (bridgePids().length) { up = true; break; }
}
console.log(up ? '桥接已重新启动' : '⚠️ 桥接还没起来，检查 start.bat 窗口');

// 验证擦除没有被覆盖回去
await new Promise((r) => setTimeout(r, 3000));
const after = fs.readFileSync(FILE, 'utf8');
const stillThere = NEEDLES.filter((n) => n && after.includes(n));
console.log(stillThere.length ? `❌ 仍有残留：${stillThere.length} 个` : '✅ 状态文件里已无该凭据');
process.exit(stillThere.length ? 1 : 0);
