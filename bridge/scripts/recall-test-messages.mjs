// 撤回"自检残留"消息：把测试期间误发进私聊的那些消息从 QQ 里删掉。
//
// 背景：跨会话代发的通知曾经会推给主人私聊，加上测试里故意发"含令牌的消息"，
// 结果在用户私聊里留下了一串测试垃圾（用户投诉过）。这些消息的 id 没被桥接记录，
// 所以只能回头找网关（SnowLuma OneBot）要历史，再逐条 delete_msg。
//
// 用法：
//   node scripts/recall-test-messages.mjs                          # 只列出候选（私聊）
//   node scripts/recall-test-messages.mjs --recall                 # 真的撤回
//   node scripts/recall-test-messages.mjs --group 1124778377       # 查某个群
//   node scripts/recall-test-messages.mjs --group 1124778377 --recall
//   node scripts/recall-test-messages.mjs --contains 别的关键词
//
// ⚠️ QQ 撤回窗口约 2 分钟。超时的消息网关会返回 ok 但其实没删掉，只能手动删。
import fs from 'node:fs';
import { JUNK_SUBSTRINGS, isTestMessage } from './lib/test-message-junk.mjs';

const ROOT = 'D:/qq-bridge';
const args = process.argv.slice(2);
const DO_RECALL = args.includes('--recall');
const extra = (() => {
  const i = args.indexOf('--contains');
  return i >= 0 ? args[i + 1] : null;
})();
const groupId = (() => {
  const i = args.indexOf('--group');
  return i >= 0 ? args[i + 1] : null;
})();

const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const accessToken = cfg.snowluma?.accessToken || '';
const owner = Number(cfg.ownerQQ);

// 只删我们自己造的、特征明确的测试文本，避免误删正常聊天。
// 规则和 purge-test-messages-from-state.mjs 共用一份，避免两处不一致。
const NEEDLES = extra ? [...JUNK_SUBSTRINGS, extra] : JUNK_SUBSTRINGS;
const isJunk = isTestMessage;

async function onebot(action, params) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

/** 递归把消息段/字符串拍平成纯文本。 */
function plainOf(msg) {
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.map(plainOf).join('');
  if (msg && typeof msg === 'object') {
    if (typeof msg.text === 'string') return msg.text;
    if (msg.data) return plainOf(msg.data);
  }
  return '';
}

const history = groupId
  ? await onebot('get_group_msg_history', { group_id: Number(groupId), count: 100 })
  : await onebot('get_friend_msg_history', { user_id: owner, count: 100 });
const list = history?.data?.messages ?? history?.data ?? [];
if (!Array.isArray(list) || !list.length) {
  console.log(`没拿到${groupId ? `群 ${groupId} ` : '私聊'}历史，返回：`, JSON.stringify(history).slice(0, 300));
  process.exit(0);
}

const hits = [];
for (const item of list) {
  const text = plainOf(item.message ?? item.raw_message ?? '');
  if (!isJunk(text)) continue;
  hits.push({ id: item.message_id ?? item.messageId ?? item.id, time: item.time, text });
}

console.log(`扫到${groupId ? `群 ${groupId} 的` : '私聊'} ${list.length} 条历史，命中测试残留 ${hits.length} 条：\n`);
for (const h of hits) {
  const t = h.time ? new Date(Number(h.time) * 1000).toLocaleString('zh-CN') : '?';
  console.log(`  id=${h.id}  ${t}  ${h.text.replace(/\n/g, ' / ').slice(0, 90)}`);
}

if (!hits.length) {
  console.log('没有需要清理的。');
  process.exit(0);
}
if (!DO_RECALL) {
  console.log('\n（只是列出。真要撤回请加 --recall）');
  process.exit(0);
}

console.log('\n开始撤回…');
let okCount = 0;
for (const h of hits) {
  if (!h.id) { console.log(`  跳过（没有 id）: ${h.text.slice(0, 40)}`); continue; }
  try {
    const r = await onebot('delete_msg', { message_id: h.id });
    const ok = r?.status === 'ok' || r?.retcode === 0;
    console.log(`  ${ok ? '✅' : '❌'} ${h.id}  ${ok ? '已撤回' : JSON.stringify(r).slice(0, 120)}`);
    if (ok) okCount++;
  } catch (error) {
    console.log(`  ❌ ${h.id}  ${error?.message ?? error}`);
  }
}
console.log(`\n撤回成功 ${okCount}/${hits.length} 条`);
if (okCount < hits.length) {
  console.log('（QQ 通常只允许撤回一定时间内的消息；超时的需要手动在客户端删除）');
}
