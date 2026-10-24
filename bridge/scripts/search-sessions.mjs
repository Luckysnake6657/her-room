/**
 * 在**所有** DSH 会话日志里搜一段文本 —— 回答"她到底在哪儿说过这句"。
 * 会话日志是多个 zstd 帧拼接的，按魔数逐帧解。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const NEEDLE = process.argv[2] ?? '自来熟';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BASE = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const T = (t) => new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function readText(file) {
  const buf = fs.readFileSync(file);
  const starts = []; let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'); } catch { /* 坏帧 */ }
  }
  return text;
}

const files = [];
for (const dir of fs.readdirSync(BASE)) {
  for (const sid of fs.readdirSync(path.join(BASE, dir))) {
    // 升级后 v3 冻结：搜"她到底在哪儿说过这句"必须搜活的那个文件
    const f = sessionFileIn(path.join(BASE, dir, sid));
    if (fs.existsSync(f)) files.push({ f, dir, sid, size: fs.statSync(f).size });
  }
}
files.sort((a, b) => b.size - a.size);
console.log(`共 ${files.length} 个会话文件，按大到小搜「${NEEDLE}」…\n`);

let found = 0;
for (const { f, dir, sid, size } of files) {
  let text;
  try { text = readText(f); } catch { continue; }
  if (!text.includes(NEEDLE)) continue;
  found++;
  console.log(`✅ 命中：${dir}\\${sid}（压缩 ${(size / 1024 / 1024).toFixed(2)} MB）`);
  const lines = text.split('\n').filter(Boolean);
  for (const l of lines) {
    if (!l.includes(NEEDLE)) continue;
    try {
      const e = JSON.parse(l);
      if (e.type === 'tool/call') {
        console.log(`   ${T(e.time)} [工具] ${String(e.data?.name ?? '').replace(/^mcp__[a-z-]+__/, '')} ${String(e.data?.arguments ?? '').slice(0, 220)}`);
      } else if (e.type === 'assistant/message') {
        for (const b of e.data?.message?.content ?? []) {
          if (String(b.text ?? '').includes(NEEDLE)) console.log(`   ${T(e.time)} [${b.type}] ${String(b.text).replace(/\s+/g, ' ').slice(0, 220)}`);
        }
      } else if (e.type === 'user/message') {
        const t = (e.data?.content ?? []).map((x) => x.text ?? '').join('');
        if (t.includes(NEEDLE)) console.log(`   ${T(e.time)} [收到的提示词] …${t.slice(Math.max(0, t.indexOf(NEEDLE) - 80), t.indexOf(NEEDLE) + 120)}…`);
      }
    } catch { /* 跳过 */ }
  }
  console.log('');
}
if (!found) console.log('❌ 所有会话日志里都没有这段文本 —— 说明它**不是她发出去的 QQ 消息**');
