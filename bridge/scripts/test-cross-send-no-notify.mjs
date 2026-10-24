// 验证「代发确认不再往 QQ 私聊推通知」。
//
// 怎么验：先记下私聊当前的消息条数，然后通过 API 造一条代发申请（它以前会推通知），
// 等几秒再拉一次私聊历史——如果条数没变、也没有【代发待确认】，说明通知确实关掉了。
// 最后把这条测试申请拒掉并清理，不留 pending。
//
// ⚠️ 2026-09-28 修：这个测试原来**假设申请会停在"待确认"**。但用户的常设是
//    crossSend.decision = auto-approve，于是申请被自动批准、**真的把「通知开关自检 …」
//    发进了管理员的私聊**（实测在 14:27:39 发出去一条，纯属测试垃圾；而且这样一来
//    它验的也不再是"待确认通知"）。现在：临时切成手动确认 → 断言 → 拒绝申请 → **还原**。
import { readConsoleToken } from './lib/console-token.mjs';

const ROOT = 'D:/qq-bridge';
const BASE = 'http://127.0.0.1:3100';
const fs = await import('node:fs');
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const accessToken = cfg.snowluma?.accessToken || '';
const owner = Number(cfg.ownerQQ);
const consoleToken = readConsoleToken();

async function onebot(action, params) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}
const plainOf = (m) => typeof m === 'string' ? m
  : Array.isArray(m) ? m.map(plainOf).join('')
  : (m && typeof m === 'object') ? (typeof m.text === 'string' ? m.text : (m.data ? plainOf(m.data) : '')) : '';

async function historyCount() {
  const h = await onebot('get_friend_msg_history', { user_id: owner, count: 100 });
  const list = h?.data?.messages ?? h?.data ?? [];
  return Array.isArray(list) ? list : [];
}

const idOf = (m) => String(m?.message_id ?? m?.messageId ?? m?.id ?? '');
const before = await historyCount();
const beforeIds = new Set(before.map(idOf).filter(Boolean));
console.log(`发送前私聊历史条数: ${before.length}`);

const convs = Object.entries(JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8')).conversations || {})
  .filter(([, v]) => v && typeof v.agentToken === 'string' && v.agentToken);
const source = convs.find((c) => c[0] !== `private:${owner}`) || convs[0];
// ★ 2026-10-18（申请 #44）：target 必须是一个**真实会话** —— 判断依据是实测：
//   假群号（group:999999999）会被 `modeAllowed` 白名单挡成 403，
//   于是本脚本"申请都没建成 → 当然没有通知"变成**假绿**（什么都没测到）。
//   本脚本靠下面"临时切到 manual"自保（通知只为「待确认」发），**不会真发消息**，
//   所以用真实会话当目标是安全的；真正会真发的是 test-cross-send-modes 的 auto-approve 段，
//   那一段已经加了 --i-know-this-sends 开关。
const target = convs.find((c) => c[0] !== source[0])[0];

// 临时切到手动确认：申请才会停在"待确认"（通知就是为这个状态发的）；
// 否则在 auto-approve 下会被自动批准、真的发进用户私聊 —— 测试垃圾。
const setMode = (decision) => fetch(`${BASE}/api/socialV2/cross-send-mode`, {
  method: 'POST',
  headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' },
  body: JSON.stringify({ decision }),
}).then((r) => r.json());
const originalDecision = (await (await fetch(`${BASE}/api/socialV2/cross-send-requests`, {
  headers: { 'x-console-token': consoleToken },
})).json())?.limits?.decision ?? null;
console.log(`原决策模式: ${originalDecision} → 临时切到 manual（测试结束会还原）`);

let created = null;
let ok = false;
try {
  await setMode('manual');
  const res = await fetch(`${BASE}/api/socialV2/cross-send-request`, {
    method: 'POST',
    headers: { 'x-console-token': consoleToken, 'x-agent-token': source[1].agentToken, 'content-type': 'application/json' },
    body: JSON.stringify({ key: target, message: `通知开关自检 ${Date.now()}` }),
  });
  created = await res.json();
  console.log(`申请结果: HTTP ${res.status}  id=${created?.requestId}  ${created?.error ?? ''}`);

  await new Promise((r) => setTimeout(r, 4000));
  const after = await historyCount();
  console.log(`发送后私聊历史条数: ${after.length}`);

  // 只看**这次新增**的消息。之前的实现把窗口里所有历史通知都算进来了，
  // 于是哪怕一条新通知都没发，也会报"仍然发了"——判断写错了（实测踩过）。
  const fresh = after.filter((m) => {
    const id = idOf(m);
    return id && !beforeIds.has(id);
  });
  const freshNotices = fresh.filter((m) => plainOf(m.message ?? '').includes('【代发待确认】'));
  ok = freshNotices.length === 0;
  console.log(`本次新增消息 ${fresh.length} 条，其中【代发待确认】${freshNotices.length} 条`);
  console.log(ok
    ? '✅ 通知确实不再进私聊（本次没有新增任何待确认通知）'
    : `❌ 仍然发了通知（新增 ${freshNotices.length} 条）`);
} finally {
  // 清理刚才那条测试申请（拒绝即可，不会发出去）
  if (created?.requestId) {
    await fetch(`${BASE}/api/socialV2/cross-send-decide`, {
      method: 'POST',
      headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.requestId, approve: false }),
    });
    console.log('已拒绝并清理该测试申请');
  }
  // 一定要还原用户原本的决策模式（自动确认是他特意开的）
  if (originalDecision) {
    await setMode(originalDecision);
    console.log(`已还原决策模式: ${originalDecision}`);
  }
}
process.exit(ok ? 0 : 1);
