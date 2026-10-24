/**
 * 把历史语料灌进长期语料库 state/group-corpus.jsonl（幂等，可重复跑）。
 *
 * 为什么需要：长期语料库是 2026-09-29 才加的，之前四天的群聊散在四处
 * （黑话 evidence / 近期消息 / 群归档 / 活动日志预览）。灌一遍之后，
 * "群风格卡 / 例句 / 黑话补课"就只需要读一个文件。
 *
 * 只灌**群聊里别人说的话**；她自己的话、系统提示、私聊都不进。
 *
 * 用法：node scripts/seed-group-corpus.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const FILE = path.join(STATE, 'group-corpus.jsonl');
const DRY = process.argv.includes('--dry');
const GROUPS_ONLY = process.argv.includes('--groups-only');
const BOT = new Set(['今晚吃兔兔']);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// 已存在的行（去重用）
const existing = new Set();
if (fs.existsSync(FILE)) {
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); existing.add(`${r.g}|${r.s}|${r.x}`); } catch { /* 坏行忽略 */ }
  }
}

const rows = [];
const seen = new Set();
const add = (sender, text, group, at) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const s = String(sender ?? '').trim();
  if (!t || !s || BOT.has(s)) return;
  if (!String(group ?? '').startsWith('group:')) return;
  const k = `${group}|${s}|${t}`;
  if (seen.has(k) || existing.has(k)) return;
  seen.add(k);
  let ts = Number(at) || 0;
  if (ts > 0 && ts < 1e12) ts *= 1000;
  rows.push({ t: ts || Date.now(), g: String(group), s, x: t.slice(0, 400) });
};

// ① 黑话 evidence
for (const e of Object.values(readJson(path.join(STATE, 'slang.json')) ?? {})) {
  for (const ev of e?.evidence ?? []) add(ev?.sender, ev?.text, ev?.key, ev?.time);
}
// ② 当前状态 + 旧快照
const socialFiles = [path.join(STATE, 'social-v2.json')];
for (const d of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
  if (d.startsWith('_backup-')) socialFiles.push(path.join(STATE, d, 'social-v2.json'));
}
for (const f of socialFiles) {
  const st = readJson(f);
  for (const [key, conv] of Object.entries(st?.conversations ?? {})) {
    const isGroup = key.startsWith('group:');
    // 通用底层模版要覆盖私聊，所以私聊也灌（可以通过 --groups-only 关掉）
    if (!isGroup && GROUPS_ONLY) continue;
    for (const m of [...(conv?.recentMessages ?? []), ...(conv?.unread ?? [])]) {
      if (!m || m.isSelf || m.system) continue;
      const sender = (!isGroup && m.sender === '私聊') ? (m.isOwner ? '管理员' : '对方') : m.sender;
      add(sender, m.text, key, m.time);
    }
  }
}
// ③ 群归档
for (const f of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
  if (!/^archived-group-\d+\.json$/.test(f)) continue;
  const arch = readJson(path.join(STATE, f));
  const list = Array.isArray(arch) ? arch : (arch?.messages ?? Object.values(arch ?? {}));
  const gkey = `group:${f.match(/\d+/)?.[0]}`;
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object' || m.isSelf || m.system) continue;
    add(m.sender, m.text, m.group ?? gkey, m.time);
  }
}
// ④ 活动日志预览（只有时分秒 → 用今天补上，精度够用）
try {
  const lines = fs.readFileSync(path.join(STATE, 'qq-activity.log'), 'utf8').split(/\r?\n/);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const line of lines) {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(group:\d+)\s+.*?消息已入未读：(.+)$/.exec(line.trim());
    if (!m) continue;
    const ts = today.getTime() + Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000;
    add('(activity-log)', m[5], m[4], ts);
  }
} catch { /* 没有就算了 */ }

console.log(`已存在 ${existing.size} 条；本次可灌入 ${rows.length} 条（${[...new Set(rows.map((r) => r.g))].join(', ')}）`);
if (DRY || !rows.length) process.exit(0);
fs.appendFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const total = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).length;
console.log(`已写入 state/group-corpus.jsonl，现在共 ${total} 条`);
