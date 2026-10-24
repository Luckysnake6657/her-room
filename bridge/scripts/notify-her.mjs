#!/usr/bin/env node
/**
 * 把进度 / 结果**交给她**（2026-10-14 管理员澄清后的正确方向）。
 *
 * 管理员原话：「我的意思让你把进度和结果发给给她，在我需要的时候让她转述给我，
 * 不是让你直接通过 QQ 给我交流」。
 *
 * 所以这个脚本是「我 → 她」：把事实写进她的上下文，**她知道** → 他问起时她用自己的话转述。
 * 不要用它替他发言，也不要拿它当我直接联系他的通道（那条是 report-to-owner.mjs，
 * 只在**紧急/他明确要求**时用）。
 *
 * 用法：
 *   node scripts/notify-her.mjs "要说给她的事实"
 *   node scripts/notify-her.mjs --file state/her-brief.md
 *   node scripts/notify-her.mjs "..." --dry
 *
 * 走桥接 `/api/console/notify-ai`（body: { key, message } + 控制台令牌）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_KEY = 'private:984776985';

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
  console.error('用法: node scripts/notify-her.mjs "要说给她的事实" [--file 路径] [--dry]');
  process.exit(2);
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
const consoleUrl = String(process.env.BRIDGE_CONSOLE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');

if (dry) {
  console.log(`[dry] 将交给她（${message.length} 字）:\n${message}`);
  process.exit(0);
}

const res = await fetch(`${consoleUrl}/api/console/notify-ai?token=${encodeURIComponent(consoleToken)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: OWNER_KEY, message }),
  signal: AbortSignal.timeout(30000),
}).catch((error) => ({ ok: false, status: 0, statusText: String(error?.message ?? error) }));

const body = typeof res.json === 'function' ? await res.json().catch(() => ({})) : {};
if (!res.ok || (body && body.ok === false)) {
  console.error(`送达失败：HTTP ${res.status ?? '?'} ${body?.error ?? res.statusText ?? ''}`);
  process.exit(1);
}
console.log(`已交给她（${message.length} 字）—— 他知道的时候她会转述。`);
