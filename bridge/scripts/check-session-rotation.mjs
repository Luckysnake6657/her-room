// 会话历史轮换体检：路径算法是否真的能定位到 DSH 的会话文件 + 按**解开后**的体量
// 判断哪些会话会在下次唤醒时被轮换。
//
// ⚠️ 阈值必须量"解开后"的大小（见 bridge.js 的 sessionHistoryRawBytes 注释）：
// 会话是 zstd 逐帧压缩的，聊天文本压缩比约 3 倍，量压缩后会得出"1.6 MB，还没到阈值"
// 的假结论，而模型每回合真正重发的是 4.88 MB。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const slug = (dir) => `--${String(dir).replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`;

const ROOT = 'D:/qq-bridge';
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8').replace(/^\uFEFF/, ''));
const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(ROOT, 'state', 'agents');
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions', slug(dir));

console.log('工作目录      :', dir);
console.log('压缩后的目录名:', slug(dir));
console.log('目录存在      :', fs.existsSync(base) ? '是 ✅' : '否 ❌');
console.log('');

/** 逐帧解压累加，返回 { compressed, raw }。整文件一次解压只拿到第一帧，必须按魔数切。 */
function measure(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(MAGIC);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  let raw = 0;
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { raw += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).length; } catch {}
  }
  return { compressed: buf.length, raw, frames: starts.length };
}

const rawLimit = cfg.socialV2?.session?.maxHistoryRawBytes ?? 1536 * 1024;
const compLimit = cfg.socialV2?.session?.maxHistoryBytes ?? 2 * 1024 * 1024;
const MB = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`轮换阈值: 解开后 ${MB(rawLimit)} MB（真正决定花费的量）；压缩后 ${MB(compLimit)} MB 作为兜底`);
console.log('');

const sessions = JSON.parse(fs.readFileSync(`${ROOT}/state/sessions.json`, 'utf8').replace(/^\uFEFF/, '')).sessions || {};
let willRotate = 0;
for (const [key, sid] of Object.entries(sessions)) {
  // 写死 v3 会一直量升级前冻结的旧文件：字节数不再增长 → 轮换阈值永远不触发
  const f = sessionFileIn(path.join(base, sid));
  if (!fs.existsSync(f)) { console.log(`  ${key.padEnd(22)} （文件不存在）`); continue; }
  const m = measure(f);
  const over = (rawLimit > 0 && m.raw > rawLimit) || (compLimit > 0 && m.compressed > compLimit);
  if (over) willRotate++;
  console.log(
    `  ${key.padEnd(22)} 解开后 ${MB(m.raw)} MB / 压缩后 ${MB(m.compressed)} MB  ` +
    (over ? '→ 超过阈值，下次唤醒会轮换' : '→ 还没到阈值'),
  );
}
console.log(`\n共 ${willRotate} 个会话会在下次唤醒时轮换。`);
