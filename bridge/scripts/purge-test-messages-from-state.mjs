// 把测试垃圾消息从桥接状态里删掉。
//
// 为什么需要：测试偶尔会把消息**真的发到群里**（设计失误，已加硬保险），
// 那些消息会进 state/social-v2.json 的 recentMessages —— 于是 (1) 被喂进模型上下文，
// (2) 出现在"跨会话回声"里，她会以为自己在群里说过 `b2` 这种东西。
// QQ 侧的撤回窗口只有 2 分钟，超时就撤不掉，但**状态里可以立刻清干净**。
//
// 必须在桥接**停止**时改：运行中的进程持有内存副本，任何一次保存都会覆盖回去。
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { isTestMessage } from './lib/test-message-junk.mjs';

const FILE = 'D:/qq-bridge/state/social-v2.json';

const pids = () => {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'src.bridge.js' } | Select-Object -ExpandProperty ProcessId\"",
      { encoding: 'utf8', timeout: 20000 }
    );
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
};

for (const pid of pids()) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} }
for (let i = 0; i < 20 && pids().length; i++) await new Promise((r) => setTimeout(r, 500));
if (pids().length) { console.error('桥接没停下来，放弃（避免改动被覆盖）'); process.exit(1); }

const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let removed = 0;
const perConv = {};
for (const [key, conv] of Object.entries(s.conversations ?? {})) {
  for (const field of ['recentMessages', 'unread']) {
    if (!Array.isArray(conv[field])) continue;
    const before = conv[field].length;
    conv[field] = conv[field].filter((m) => !(m && m.isSelf !== undefined && isTestMessage(m.text ?? m.plain ?? '')));
    const n = before - conv[field].length;
    if (n) { removed += n; perConv[key] = (perConv[key] || 0) + n; }
  }
}
fs.writeFileSync(FILE, JSON.stringify(s, null, 2), 'utf8');
console.log(`已从状态里删除测试垃圾 ${removed} 条`);
for (const [k, n] of Object.entries(perConv)) console.log(`  ${k}: ${n} 条`);

console.log('等待桥接被守护窗口拉起…');
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); if (pids().length) break; }
console.log(pids().length ? '桥接已重启' : '⚠️ 桥接还没起来，检查 start.bat 窗口');

// 验证没被覆盖回去
await new Promise((r) => setTimeout(r, 3000));
const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let left = 0;
for (const conv of Object.values(after.conversations ?? {})) {
  for (const field of ['recentMessages', 'unread']) {
    for (const m of (conv[field] ?? [])) if (m && isTestMessage(m.text ?? m.plain ?? '')) left++;
  }
}
console.log(left ? `❌ 仍有 ${left} 条残留` : '✅ 状态里已无测试垃圾');
process.exit(left ? 1 : 0);
