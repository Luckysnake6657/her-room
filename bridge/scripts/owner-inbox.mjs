#!/usr/bin/env node
/**
 * 读管理员通过 QQ 转达给我的话（2026-10-14）。
 *
 * 他没法一直在电脑前，所以说的是「你向 QQ 机器人报告进程，我向机器人转达需求」。
 * 桥接会在**管理员私聊**里识别「转达给助手：xxx」，把原话追加到 state/owner-inbox.jsonl。
 * 这个脚本就是收件箱：
 *
 *   node scripts/owner-inbox.mjs            # 看有哪些（默认最近 20 条）
 *   node scripts/owner-inbox.mjs --all      # 全看
 *   node scripts/owner-inbox.mjs --clear    # 看完清空（清前会打印出来）
 *
 * 不自动清空：宁可重复读一遍，也别把他说的话弄丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'owner-inbox.jsonl');
const args = process.argv.slice(2);

if (!fs.existsSync(FILE)) {
  console.log('收件箱是空的（还没有人转达过）。');
  process.exit(0);
}
const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return { ts: '?', text: l }; }
});
const show = args.includes('--all') ? rows : rows.slice(-20);
if (!show.length) {
  console.log('收件箱是空的。');
  process.exit(0);
}
console.log(`管理员转达（共 ${rows.length} 条，显示 ${show.length} 条）：`);
for (const r of show) {
  const t = String(r.ts ?? '?').replace('T', ' ').slice(0, 19);
  console.log(`\n[${t}]\n${r.text}`);
}
if (args.includes('--clear')) {
  fs.writeFileSync(FILE, '');
  console.log(`\n（已清空 ${rows.length} 条）`);
}