/**
 * 全局静默开关（命令行版）—— 管理员也可以直接在 QQ 私聊里说「全局静默」/「解除静默」。
 *
 * 背景（2026-10-02）：管理员让她"群聊静默"，她**做不到**——
 *   ① 在群里改唤醒条件被"沉睡前观察"闸门拦（400）；
 *   ② 在私聊改群的唤醒条件被跨会话限制拦（403，"修改只能在本会话内执行"）。
 *   于是她只能嘴上答应，3 分钟内又在群里接了 4 条，他最后说"我求你了"。
 * 现在这是桥接层的硬开关：开了之后所有群**一个字都发不出去**、也不再唤醒她（省 token），
 *   只有管理员私聊照常（他还要能跟她说话、才能解禁）。
 *
 * 用法：
 *   node scripts/silent-all.mjs            # 看当前状态
 *   node scripts/silent-all.mjs on         # 全局静默
 *   node scripts/silent-all.mjs off        # 解除
 */
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';

const token = readConsoleToken() || (fs.existsSync('state/console-token') ? fs.readFileSync('state/console-token', 'utf8').trim() : '');
const BASE = 'http://127.0.0.1:3100';
const arg = String(process.argv[2] ?? '').toLowerCase();

const cur = await fetch(`${BASE}/api/socialV2/activity`, { headers: { 'x-console-token': token } })
  .then((r) => r.json()).catch(() => null);
if (!cur) { console.log('读不到桥接状态（桥接没在跑？）'); process.exit(1); }
console.log('当前:', cur.silentAll?.on ? `🔇 全局静默中（${new Date(cur.silentAll.at).toLocaleString('zh-CN')} 由 ${cur.silentAll.by} 开）` : '🔊 正常');

if (arg !== 'on' && arg !== 'off') {
  console.log('用法: node scripts/silent-all.mjs on|off');
  process.exit(0);
}
const res = await fetch(`${BASE}/api/socialV2/silent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ on: arg === 'on', by: 'silent-all.mjs' }),
});
const json = await res.json().catch(() => null);
console.log(res.status, json?.note ?? json?.error ?? '');
