// 回归：有"她还没看过的消息"时，qq_wait_for_messages 必须**立刻返回**，不能去等。
//
// 背景（实测症状："她只回了第一句，第二条过了 5 分钟才回"）：
//   wait 的基线是 wait **开始那一刻**的 lastUnreadSeq，
//   所以"她上次读过之后、wait 开始之前"到达的消息对这次等待是**隐形**的 →
//   她会安静等满 300 秒（沉睡前观察窗口），而消息明明就躺在 unread 里。
//   实测：21:26:34 用户发 A、21:26:47 用户发 B、21:26:48 她只回了 A、
//   然后等满 5 分钟，21:31:37 才回 B。
//
// 修法：用 lastSeenUnreadSeq（她**真正看过**的位置）判断；有没看过的就立即回。
//
// 这个测试是**条件式**的：只有当某个会话真的存在"未看过消息"时才断言；
// 否则明确跳过（不假装通过）。这样它既不会假阳性，也不会因为时序碰巧而空转。
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';

const BASE = 'http://127.0.0.1:3100';
const ROOT = 'D:/qq-bridge';
const consoleToken = readConsoleToken();
if (!consoleToken) { console.error('找不到控制台令牌'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8'));
// 2026-10-22：候选必须先在**当前白名单**里 —— state 里留着已移出白名单的会话（如
// group:1054156254）的状态，挑到它调端点只会拿到 403/拒绝，被这个用例当成"没立即返回"报红，
// 而真正的原因跟 wait 一点关系都没有。白名单读 config.json（只读，不碰生产配置）。
const config = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const allowPriv = new Set((config.allow?.private || []).map(Number));
const allowGrp = new Set((config.allow?.groups || []).map(Number));
const isAllowed = (key) => {
  const m = /^(group|private):(\d+)$/.exec(key);
  if (!m) return false;
  return m[1] === 'private' ? allowPriv.has(Number(m[2])) : allowGrp.has(Number(m[2]));
};
const all = Object.entries(state.conversations || {})
  .filter(([, c]) => (Number(c.lastUnreadSeq) || 0) > (Number(c.lastSeenUnreadSeq) || 0) && (c.unread || []).length);
const skipped = all.filter(([key]) => !isAllowed(key)).map(([key]) => key);
if (skipped.length) console.log(`（跳过白名单外的会话：${skipped.join('、')}）`);
const candidates = all
  .filter(([key]) => isAllowed(key))
  .map(([key, c]) => ({ key, token: c.agentToken, unreadCount: (c.unread || []).length }));

if (!candidates.length) {
  console.log('跳过：当前没有任何"有未看过消息"的会话（条件不成立，无法断言）');
  console.log('提示：想强制验证，先在某个白名单会话里发一条消息再跑本脚本。');
  process.exit(0);
}

let pass = 0, fail = 0;
for (const c of candidates.slice(0, 3)) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/socialV2/wait`, {
    method: 'POST',
    headers: { 'x-console-token': consoleToken, 'x-agent-token': c.token, 'content-type': 'application/json' },
    // 故意给一个大 timeout：如果它真的等，就会等很久（这里靠超时兜底，避免测试卡 300 秒）
    body: JSON.stringify({ key: c.key, timeoutMs: 120000 }),
    signal: AbortSignal.timeout(20000),
  }).catch((e) => ({ _err: e }));
  const ms = Date.now() - t0;
  if (res._err) {
    console.log(`❌ ${c.key}：请求失败/超时（${ms}ms）—— 说明它没有立即返回`);
    fail++;
    continue;
  }
  const j = await res.json();
  const ok = j?.reason === 'unseen-unread' && j?.arrived === true && ms < 5000;
  console.log(`${ok ? '✅' : '❌'} ${c.key}：用了 ${ms}ms reason=${j?.reason} arrived=${j?.arrived} unreadCount=${j?.unreadCount}`);
  ok ? pass++ : fail++;
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${candidates.length} 个候选，测了 ${Math.min(3, candidates.length)} 个）`);
process.exit(fail ? 1 : 0);
