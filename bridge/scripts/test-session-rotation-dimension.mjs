/**
 * 回归测试：会话轮换必须按"解开后"的体量判断，不能按压缩后的大小。
 *
 * 背景（2026-09-28 实测）：DSH 的会话历史是 **zstd 逐帧压缩**的，聊天文本压缩比约
 * 2.6~3.0 倍。原来的轮换判断量的是压缩后文件大小（阈值 2 MB），于是：
 *   group:795894138  压缩 1.62 MB（< 2 MB → **永不轮换**）/ 解开后 4.88 MB
 *   group:1124778377 压缩 1.04 MB（**永不轮换**）          / 解开后 2.76 MB
 * 而模型每回合重发的是**解开后**的全部内容 —— 压缩得再小也一分钱不少花。
 * 结果会话能涨到几百万字符都不轮换，这正是"一上午十块钱"的主因。
 *
 * 这里锁死：解压后超标但压缩后不超标的会话，必须判为"该轮换"。
 *
 * ⚠️ fixture 的文件名不能随便写死（2026-10-10 补）：DSH 0.2.0 把会话格式升到 v4 之后，
 * 同一个会话目录里会**同时**存在 `session.v3.jsonl.zstd`（升级那刻冻结）和
 * `session.v4.jsonl.zstd`（活的那个）。fixture 要是把版本号写死在旧的一代上，将来读取侧
 * 升级后测试就会"永远挑不到 fixture"——表现为 bridge 读到 0 字节、断言全红，看着像代码
 * 坏了，其实是 fixture 的版本号过期。所以版本号只在 writeSession 的 fileVersion 里出现一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const RAW_LIMIT = 3 * 1024 * 1024;      // maxHistoryRawBytes
const COMPRESSED_LIMIT = 2 * 1024 * 1024; // maxHistoryBytes

const bridge = await bridgeHarness({
  config: { socialV2: { session: { maxHistoryBytes: COMPRESSED_LIMIT, maxHistoryRawBytes: RAW_LIMIT } } },
});

try {
  // 让 cfg.sessionCwd 指向 harness 的临时目录，这样会话文件路径可预测
  bridge.cfg.sessionCwd = bridge.temp;
  const slug = bridge.sessionStorageSlug(bridge.temp);

  /**
   * 按真实格式写一个多帧 zstd 会话文件，返回 { compressed, raw }。
   *
   * `fileVersion` 默认写 **v3**：当前 `src/bridge.js` 的 sessionHistoryRawBytes 还写死读
   * v3。等 bridge.js 换成 v4（升级到 0.2.0 的格式）之后，把这里的默认值改成 `'v4'` 即可 ——
   * 断言用的 bridge.* 只认 bridge 自己写死的那个文件名，所以两边必须是同一代，
   * 否则测试会因为"fixture 在 v3、读取侧找 v4"而读到 0 字节。
   */
  function writeSession(sessionId, frames, fileVersion = 'v3') {
    const dir = path.join(bridge.temp, '.dsh', 'sessions', slug, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const parts = frames.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
    const buf = Buffer.concat(parts);
    // 文件名统一从这里拼，别再散落字面量：换代只需要改这个默认值
    fs.writeFileSync(path.join(dir, `session.${fileVersion}.jsonl.zstd`), buf);
    return { compressed: buf.length, raw: frames.reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0) };
  }

  // 高度可压缩的内容：模拟真实聊天文本（重复度高，压缩比大）
  // 每帧约 170 KB，25 帧 ≈ 4.2 MB（解开后），但压缩后只有几十 KB。
  const chunk = '{"type":"message","text":"' + '今天群里在聊战绩，谁谁又连甩了几个号，我接了两句。'.repeat(2000) + '"}\n';

  console.log('\n[1] 解压后超标、压缩后不超标 → 必须轮换');
  const big = writeSession('session-big', Array.from({ length: 25 }, () => chunk));
  const bigRawMB = (big.raw / 1048576).toFixed(2);
  const bigCompMB = (big.compressed / 1048576).toFixed(2);
  console.log(`     造出来的会话：解开后 ${bigRawMB} MB / 压缩后 ${bigCompMB} MB`);
  check('前提成立：解压后确实超过 raw 上限', big.raw > RAW_LIMIT, `raw=${big.raw}`);
  check('前提成立：压缩后确实低于 compressed 上限（老逻辑就是被这里骗了）',
    big.compressed < COMPRESSED_LIMIT, `compressed=${big.compressed}`);
  check('sessionHistoryRawBytes 正确累加所有帧', bridge.sessionHistoryRawBytes('session-big') === big.raw,
    `实际=${bridge.sessionHistoryRawBytes('session-big')} 期望=${big.raw}`);
  check('sessionNeedsRotation 判定为需要轮换（>0）', bridge.sessionNeedsRotation('session-big') > 0,
    `返回 ${bridge.sessionNeedsRotation('session-big')}（0 = 不轮换 = 每回合白烧钱）`);

  console.log('\n[2] 解压后未超标 → 不该轮换');
  const small = writeSession('session-small', Array.from({ length: 2 }, () => chunk));
  console.log(`     造出来的会话：解开后 ${(small.raw / 1048576).toFixed(2)} MB / 压缩后 ${(small.compressed / 1048576).toFixed(2)} MB`);
  check('解压后未超标 → 不轮换', bridge.sessionNeedsRotation('session-small') === 0,
    `raw=${small.raw}`);
  check('raw 计量与小会话一致', bridge.sessionHistoryRawBytes('session-small') === small.raw);

  console.log('\n[3] 多帧解析正确性（整文件一次解压只能拿到第一帧的老坑）');
  const many = writeSession('session-many', Array.from({ length: 50 }, (_, i) => chunk + `帧${i}\n`));
  check('50 帧全部计入（不是只算第一帧）',
    bridge.sessionHistoryRawBytes('session-many') === many.raw,
    `实际=${bridge.sessionHistoryRawBytes('session-many')} 期望=${many.raw}`);
  // 只算第一帧的话会远小于 many.raw（单帧约 1/50）
  check('不是只算了第一帧', bridge.sessionHistoryRawBytes('session-many') > many.raw * 0.9);

  console.log('\n[4] 压缩后超标也算超标（兜底分支）');
  // 几乎不可压缩的内容，让压缩后也超过 compressed 上限
  const crypto = await import('node:crypto');
  const incompressible = Array.from({ length: 12 }, () =>
    crypto.randomBytes(200 * 1024).toString('base64') + '\n');
  const dense = writeSession('session-dense', incompressible);
  check('压缩后超标的会话同样判为需要轮换', bridge.sessionNeedsRotation('session-dense') > 0,
    `compressed=${(dense.compressed / 1048576).toFixed(2)} MB raw=${(dense.raw / 1048576).toFixed(2)} MB`);

  console.log('\n[5] 边界安全');
  check('不存在的会话返回 0（不抛错）', bridge.sessionHistoryRawBytes('session-nope') === 0);
  check('空 sessionId 返回 0', bridge.sessionHistoryRawBytes('') === 0 && bridge.sessionNeedsRotation('') === 0);
  check('MAX 上限设为 0 → 关闭轮换', (() => {
    const old = bridge.cfg.socialV2.session.maxHistoryRawBytes;
    bridge.cfg.socialV2.session.maxHistoryRawBytes = 0;
    const r = bridge.sessionNeedsRotation('session-big');
    bridge.cfg.socialV2.session.maxHistoryRawBytes = old;
    return r === 0;
  })());
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
