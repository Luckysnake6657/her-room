// 对比"压缩大小"（轮换阈值量的东西）与"解压大小"（真正决定 token 花费的东西）。
// 如果两者差异很大，说明轮换阈值定错了维度。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const state = JSON.parse(fs.readFileSync('state/sessions.json', 'utf8'));
const limit = 2 * 1024 * 1024;

function stat(sessionId) {
  for (const dir of fs.readdirSync(base)) {
    // 升级后 v3/v4 并存，要量的是活的那个（v4），不是已冻结的 v3
    const f = sessionFileIn(path.join(base, dir, sessionId));
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const starts = [];
    let i = buf.indexOf(MAGIC);
    while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
    let raw = 0;
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try { raw += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).length; } catch {}
    }
    return { compressed: buf.length, raw };
  }
  return null;
}

console.log('阈值 maxHistoryBytes =', (limit / 1048576).toFixed(1), 'MB（压缩后）\n');
console.log('会话'.padEnd(22), '压缩'.padStart(9), '解压'.padStart(10), '压缩倍数'.padStart(9), '  会轮换?');
for (const [key, sid] of Object.entries(state.sessions || {})) {
  const s = stat(sid);
  if (!s) continue;
  const wouldRotate = s.compressed > limit;
  console.log(
    key.padEnd(22),
    `${(s.compressed / 1048576).toFixed(2)} MB`.padStart(9),
    `${(s.raw / 1048576).toFixed(2)} MB`.padStart(10),
    `${(s.raw / s.compressed).toFixed(2)}x`.padStart(9),
    wouldRotate ? '  是' : '  ❌ 否（但解压后已很大）',
  );
}
