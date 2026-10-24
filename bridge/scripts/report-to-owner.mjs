#!/usr/bin/env node
/**
 * 把进度报告发给管理员 QQ（2026-10-14）。
 *
 * ⚠️ **定位（2026-10-14 管理员澄清后）**：这是**备用**通道，只在**紧急**或**他明确要求**时用。
 * 他要的常态是：进度**交给她**（`scripts/notify-her.mjs`），他需要时**问她、由她转述** ——
 * 不是让我绕过她直接找他。用错方向会让她反而不知道进度，也越过了"跟他说话的是她"这件事。
 *
 * 背景：管理员说他「无法一直在电脑前查看进度」，要求**由我主动向 QQ 机器人报告进程**，
 * 他再通过 QQ 转达需求。所以这个脚本就是「我 → 他」的方向。
 *
 * 用法：
 *   node scripts/report-to-owner.mjs "报告正文"
 *   node scripts/report-to-owner.mjs --file state/some-report.md
 *   node scripts/report-to-owner.mjs "正文" --dry     # 只打印，不发
 *
 * 两条实测出来的硬规矩（2026-10-14）：
 *   ① 走的是桥接 `/api/send/private`，它要**两把钥匙**：控制台令牌（查询串）+ 会话令牌（body）
 *      —— 只给会话令牌会拿到 401「请提供控制台访问令牌」。
 *   ② **单条消息不能超过 220 字**（桥接自己的限制）。所以这里自动按标点分段，逐条发。
 *
 * 注意：这是**我主动插话**的通道，不是替她说话。写给管理员本人的，语气直白一点，
 * 别用她的口吻（他明确区分「她」和「DSH 助手」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_KEY = 'private:984776985';
const MAX_CHARS = 200;      // 桥接上限 220，留点余量

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 按标点把长文切成 <= MAX_CHARS 的几条（优先在换行/句号/分号处断）。 */
function splitMessage(text, max = MAX_CHARS) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('；'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
    );
    if (cut < max * 0.5) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const fileIdx = args.indexOf('--file');
let message = '';
if (fileIdx >= 0) {
  const p = args[fileIdx + 1];
  if (!p) {
    console.error('--file 后面要给路径');
    process.exit(2);
  }
  message = fs.readFileSync(path.resolve(ROOT, p), 'utf8');
} else {
  message = args.filter((a) => !a.startsWith('--')).join(' ');
}
message = message.trim();
if (!message) {
  console.error('用法: node scripts/report-to-owner.mjs "报告正文" [--file 路径] [--dry]');
  process.exit(2);
}

const social = readJson(path.join(ROOT, 'state', 'social-v2.json'), {});
const agentToken = social?.conversations?.[OWNER_KEY]?.agentToken;
const cfg = readJson(path.join(ROOT, 'config.json'), {});
const ownerQQ = String(cfg?.socialV2?.ownerQQ ?? '984776985');

if (!agentToken) {
  console.error(`读不到 ${OWNER_KEY} 的 agent token（state/social-v2.json）—— 桥接没跑或会话没建立`);
  process.exit(3);
}

let consoleToken = String(process.env.BRIDGE_CONSOLE_TOKEN ?? '').trim();
if (!consoleToken) {
  try {
    consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    console.error('读不到 state/console-token，也没给 BRIDGE_CONSOLE_TOKEN');
    process.exit(3);
  }
}

const chunks = splitMessage(message);
if (dry) {
  console.log(`[dry] 将发给 ${OWNER_KEY}，共 ${chunks.length} 条：`);
  chunks.forEach((c, i) => console.log(`  [${i + 1}] ${c.length} 字: ${c.slice(0, 60)}...`));
  process.exit(0);
}

const consoleUrl = String(process.env.BRIDGE_CONSOLE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
let sent = 0;
for (const chunk of chunks) {
  const res = await fetch(`${consoleUrl}/api/send/private?token=${encodeURIComponent(consoleToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: agentToken, userId: ownerQQ, message: chunk }),
    signal: AbortSignal.timeout(30000),
  }).catch((error) => ({ ok: false, status: 0, statusText: String(error?.message ?? error) }));

  const body = typeof res.json === 'function' ? await res.json().catch(() => ({})) : {};
  if (!res.ok || (body && body.ok === false)) {
    const detail = body?.error ?? res.statusText ?? '';
    console.error(`第 ${sent + 1}/${chunks.length} 条失败：HTTP ${res.status ?? '?'} ${detail}`);
    process.exit(1);
  }
  sent++;
  if (sent < chunks.length) await new Promise((r) => setTimeout(r, 600));   // 别挤在一起
}
console.log(`已报告给管理员（${message.length} 字，分 ${sent} 条）`);