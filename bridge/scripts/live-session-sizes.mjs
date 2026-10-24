// 当前在用会话的体积对照：只有这些历史会在每回合被重发（=真花钱的部分）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const state = JSON.parse(fs.readFileSync('state/sessions.json', 'utf8'));
const map = state.sessions || {};

function sizeOf(sessionId) {
  for (const dir of fs.readdirSync(base)) {
    // 每回合重发的是**活的那个**会话文件：升级后 v3 冻结，量它等于量历史快照
    const f = sessionFileIn(path.join(base, dir, sessionId));
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const starts = [];
    let i = buf.indexOf(MAGIC);
    while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
    let bytes = 0;
    let frames = 0;
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try { bytes += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).length; frames++; } catch {}
    }
    return { bytes, frames };
  }
  return null;
}

console.log('=== 当前在用会话（每回合重发的就是这些）===');
let total = 0;
for (const [key, sid] of Object.entries(map)) {
  const s = sizeOf(sid);
  if (!s) { console.log(`  ${key.padEnd(22)} ${sid.slice(0, 20)}…  ⚠️ 找不到文件`); continue; }
  total += s.bytes;
  const mb = (s.bytes / 1048576).toFixed(2);
  console.log(`  ${key.padEnd(22)} ${sid.slice(0, 20)}…  ${mb.padStart(6)} MB  ${String(s.frames).padStart(5)} 帧`);
}
console.log(`\n合计 ${(total / 1048576).toFixed(2)} MB`);
console.log('提示：轮换阈值看的是**解开后**的体量（socialV2.session.maxHistoryRawBytes，默认 1.5 MB）。');
console.log('      压缩后的大小会骗人（约 3 倍），别拿它当成本依据。');
