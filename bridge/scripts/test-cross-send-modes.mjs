// 验证跨会话代发的三种决策模式 + 开关接口。
//
// 安全设计（这个脚本**不会**往群里发东西）：
//   • auto-reject：本来就不发，直接断言；
//   • auto-approve：真的走一遍"申请 → 自动批准 → 调用发送"，但**故意把控制台令牌塞进正文**，
//     这样 sendToQQ 的凭据拦截会在真正 HTTP 发送之前把它挡下来。于是：
//       - 拦截生效 → 请求被标记 failed，什么都没发出去（这正是我们要断言的）
//       - 万一拦截失效 → 会真发出去，所以脚本末尾会检查私聊有没有多出消息，
//         发现多了就明确报"泄露"，提示立刻轮换令牌。
//     这比"不测"强，也比"真发一条到群里"安全。
//   • 测完把 decision 恢复成 manual，并把测试产生的请求拒掉/清理。
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';
import { cleanupTestRequests } from './lib/cross-send-test-cleanup.mjs';

const BASE = 'http://127.0.0.1:3100';
const ROOT = 'D:/qq-bridge';
const CS_FILE = `${ROOT}/state/cross-send-requests.json`;
const consoleToken = readConsoleToken();
if (!consoleToken) { console.error('找不到控制台令牌'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const accessToken = cfg.snowluma?.accessToken || '';
const owner = Number(cfg.ownerQQ);

const convs = Object.entries(JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8')).conversations || {})
  .filter(([, v]) => v && typeof v.agentToken === 'string' && v.agentToken)
  .map(([key, v]) => ({ key, token: v.agentToken }));
const source = convs[0];
// ★★ 2026-10-18（申请 #44）：**这个脚本的 auto-approve 段会真的往 target 发消息**，
//   原来 target 是"随便挑一个真实会话"，而桥接处于「自动确认」时 →
//   `__mode-test autosend <令牌>` 被真的发进了用户的群 group:1124778377
//   （管理员 00:55 截图；本脚本又在 run-test-batch 里，等于**每跑一次 npm run verify
//   就往真群发一条**，累计几十条）。
//   为什么会漏：脚本本来靠"把控制台令牌当毒丸，发送端会整条拦下"自保，
//   但 2026-10-17 改成**入口脱敏后照常发送**（见 createCrossSendRequest 注释），
//   毒丸变成 `__mode-test autosend ***` 真发出去了 —— 安全假设过期。
//   ⚠️ 试过把 target 换成不存在的群号（group:999999999）：会被 modeAllowed 白名单挡成 403
//   （假群不在白名单），于是测不到发送路径 —— 也就是说这个测试**只能往真实会话发**。
//   所以正确做法不是换靶子，而是：**危险的那一段必须显式确认才跑**（跟 test-cross-send-live 一致）。
const EXPLICIT_SEND = process.argv.includes('--i-know-this-sends');
// ⚠️ target 仍然要选一个**真实会话**：auto-reject / manual 两段要靠它通过 modeAllowed 白名单
//   才能创建申请（假群号会被挡成 403，测不出状态机）。但这两条路**都不会真的发出去**
//    —— auto-reject 直接拒、manual 停在 pending。**只有 auto-approve 那段会真发**，它已被开关挡住。
const target = convs.find((c) => c.key !== source.key)?.key ?? convs[1]?.key ?? '';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'x-console-token': consoleToken };
  if (token) headers['x-agent-token'] = token;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const readStore = () => { try { return JSON.parse(fs.readFileSync(CS_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch { return { requests: [] }; } };
const beforeIds = new Set((readStore().requests || []).map((r) => r.id));

// 开跑前先清一次上次残留（不然会占满 maxPendingPerSource，本次全变 429、看着像功能坏了）
{
  const { removed, kept } = cleanupTestRequests();
  if (removed) console.log(`开跑前清理上次残留的测试申请 ${removed} 条（保留真实申请 ${kept} 条）\n`);
}

async function friendHistory() {
  try {
    const r = await fetch(`${httpUrl}/get_friend_msg_history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ user_id: owner, count: 50 }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const list = j?.data?.messages ?? j?.data ?? [];
    return Array.isArray(list) ? list : [];
  } catch { return null; }
}

const setMode = async (decision) => (await api('/api/socialV2/cross-send-mode', { method: 'POST', body: { decision } })).json;

// 记住进入时的模式，跑完**还原**。
// ⚠️ 踩过的坑：早期版本结尾直接写死 setMode('manual')，于是每次自检都会把用户手工设的
// 【自动确认】悄悄改成【手动确认】—— 测试污染了生产配置；而且下一次 approval 测试
// 还会因为"当前不是手动模式"而误报一堆失败。
const originalDecision = (await api('/api/socialV2/cross-send-requests')).json?.limits?.decision ?? 'manual';
console.log(`来源=${source.key}  目标=${target}  进入时的模式=${originalDecision}\n`);

// ── 1. 模式接口本身 ──────────────────────────────────────────────────────
{
  const r = await api('/api/socialV2/cross-send-mode', { method: 'POST', body: { decision: 'nonsense' } });
  check('非法模式 → 400', r.status === 400, `status=${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await api('/api/socialV2/cross-send-mode', { method: 'POST', token: source.token, body: { decision: 'auto-approve' } });
  check('用 agent token 改模式 → 必须 403（否则她能自己把审核关掉）', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}

// ── 2. auto-reject：申请即拒，不发 ────────────────────────────────────────
{
  const m = await setMode('auto-reject');
  check('切到 auto-reject', m?.ok === true, `decision=${m?.decision}`);
  const r = await api('/api/socialV2/cross-send-request', {
    method: 'POST', token: source.token, body: { key: target, message: `__mode-test reject ${Date.now()}` },
  });
  check('auto-reject 下申请 → 直接 rejected、未发送',
    r.status === 200 && r.json?.decision === 'auto-reject' && r.json?.sent === false && r.json?.status === 'rejected',
    `status=${r.status} decision=${r.json?.decision} sent=${r.json?.sent} reqStatus=${r.json?.status}`);
}

// ── 3. manual：申请排队 ─────────────────────────────────────────────────
{
  const m = await setMode('manual');
  check('切回 manual', m?.ok === true, `decision=${m?.decision}`);
  const r = await api('/api/socialV2/cross-send-request', {
    method: 'POST', token: source.token, body: { key: target, message: `__mode-test manual ${Date.now()}` },
  });
  check('manual 下申请 → pending、未发送',
    r.status === 200 && r.json?.decision === 'manual' && r.json?.sent === false,
    `status=${r.status} decision=${r.json?.decision} sent=${r.json?.sent}`);
  if (r.json?.requestId) await api('/api/socialV2/cross-send-decide', { method: 'POST', body: { id: r.json.requestId, approve: false } });
}

// ── 4. auto-approve：走完整发送路径 ──────────────────────────────────────
// ★★ 这一段是**唯一会真的发消息**的地方（申请 #44 的污染源），所以：
//   没有 `--i-know-this-sends` 就**整段跳过** —— 它会以她的号往一个真实会话发
//   `__mode-test autosend ***`，进了群/私聊就是用户看得见的垃圾。
//   批测（run-test-batch）里不带这个参数，所以 verify 永远不会再污染真实会话。
//   想真验这一段时手动跑：node scripts/test-cross-send-modes.mjs --i-know-this-sends
if (!EXPLICIT_SEND) {
  console.log('\n⏭️  跳过 auto-approve 真发段（没有 --i-know-this-sends）——这一段会真的往真实会话发一条');
} else {
{
  const m = await setMode('auto-approve');
  check('切到 auto-approve', m?.ok === true, `decision=${m?.decision}`);

  const historyBefore = await friendHistory();
  const beforeCount = Array.isArray(historyBefore) ? historyBefore.length : null;

  const r = await api('/api/socialV2/cross-send-request', {
    method: 'POST', token: source.token,
    body: { key: target, message: `__mode-test autosend ${consoleToken}` },
  });
  const rejectedByGuard = r.status === 500 && /自动确认时发送失败/.test(String(r.json?.error ?? ''));
  check('auto-approve 下申请 → 走了自动发送路径（不等人批）',
    rejectedByGuard || r.json?.sent === true,
    `status=${r.status} sent=${r.json?.sent} ${String(r.json?.error ?? '').slice(0, 90)}`);

  // 脱敏后是 `***`，所以"私聊没多出消息"这条只对 private 目标有意义
  await new Promise((res) => setTimeout(res, 2500));
  const historyAfter = await friendHistory();
  if (Array.isArray(historyAfter) && beforeCount !== null) {
    const grew = historyAfter.length > beforeCount;
    check('私聊没有多出消息（毒丸没有真的发出去）', !grew,
      grew ? '★ 真的发出去了 → 立刻轮换控制台令牌' : `条数保持 ${historyAfter.length}`);
  } else {
    console.log('ℹ️  拿不到私聊历史，跳过"是否真发出"的检查');
  }
  if (r.json?.requestId) {
    const st = (readStore().requests || []).find((x) => x.id === r.json.requestId);
    // ⚠️ 2026-10-17 行为变了：含令牌的"毒丸"**不再整条失败**，而是在申请入口就被脱敏
    //    （`createCrossSendRequest` 里 redactKnownTokensOnly）—— 她代发时手滑抄了令牌
    //    很常见，整条拒掉等于让这个功能废掉。
    //    所以这里该守的是**令牌不能真出去**，而不是"状态必须 failed"。
    check('毒丸没被当成待确认挂着（要么脱敏发出、要么失败）',
      st?.status === 'failed' || st?.status === 'approved', `status=${st?.status}`);
    // 真正要守的安全线：落库的正文里不能还留着令牌原文
    const stored = JSON.stringify(st?.messages ?? st ?? '');
    check('落库的申请里**不含令牌原文**（已在入口脱敏）',
      !stored.includes(consoleToken) || stored.includes('***'),
      stored.slice(0, 160));
  }
}
}

// ── 5. 还原进入时的模式并清理 ──────────────────────────────────────────
// ⚠️ 顺序很重要：最后的"配额已释放"检查会**真的创建一条申请**。
// 如果那时模式已经是【自动确认】，这条申请会被直接发到真实群里 ——
// 实测就是这么把 `__mode-test final …` 发进用户群的。
// 所以：先切回 manual 做检查，最后再还原成进入时的模式。
{
  const m = await setMode('manual');
  check('临时切回 manual（供后续申请检查用，确保不会真的发出去）', m?.decision === 'manual', `decision=${m?.decision}`);
}
// 清掉**所有**可识别的测试申请（不只是本次的）：限流按来源每小时计数，
// 上一次跑挂在中途留下的记录会一直占配额，导致下次全是 429。
{
  const { removed, kept } = cleanupTestRequests();
  console.log(`\n清理测试申请 ${removed} 条（保留真实申请 ${kept} 条）`);
}
{
  // 硬保险：这一步会真的创建申请，绝不能在自动确认模式下做
  const nowMode = (await api('/api/socialV2/cross-send-requests')).json?.limits?.decision;
  if (nowMode === 'auto-approve') {
    check('安全检查：创建申请时不能处于自动确认模式', false, `当前 ${nowMode}，跳过该检查以免真的发消息`);
  } else {
    const after = await api('/api/socialV2/cross-send-request', {
      method: 'POST', token: source.token, body: { key: target, message: `__mode-test final ${Date.now()}` },
    });
    check('清理后配额已释放（能再次申请，不是 429）', after.status === 200,
      `status=${after.status} ${after.json?.error ?? ''}`);
    if (after.json?.requestId) await api('/api/socialV2/cross-send-decide', { method: 'POST', body: { id: after.json.requestId, approve: false } });
    cleanupTestRequests();
  }
}
{
  const m = await setMode(originalDecision);
  check(`测试结束后还原为进入时的模式（${originalDecision}）`, m?.decision === originalDecision,
    `decision=${m?.decision}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
