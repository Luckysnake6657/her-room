/**
 * 回归测试：会话历史文件必须按「活的那个」来量（v3/v4 并存时不能量错）。
 *
 * 背景（2026-10-10 实测踩到）：DSH 0.2.0 把会话格式升到 v4，文件名变成
 * session.v4.jsonl.zstd；而升级后第一次写入某个会话时，DSH 会**新写一个 v4 文件、
 * 把旧的 v3 留在同一个目录里不删**。如果代码写死 session.v3.jsonl.zstd，就会一直去量
 * 那个已经冻结的旧文件：字节数不再增长 → 轮换阈值永远不触发 → 会话无限膨胀，
 * 正是当初「一上午十块钱」那个坑的翻版。
 *
 * 真机数据（我的会话目录，同一个会话）：
 *   v3：压缩 36.8 MB / 26916 帧 / 解开 120.61 MB  ← 升级后冻结
 *   v4：压缩 19.5 MB /    45 帧 / 解开 120.67 MB  ← 活的
 * 解开大小一样（说明"按解开字节算钱"这套算法本身没变），但轮换量错文件就全废了。
 *
 * 这里锁死四件事：
 *   1) 只存在哪个版本就用哪个版本（单版本场景不能因为改名而失效）；
 *   2) 两个版本并存时按**版本号**挑，而不是按 mtime（mtime 会被复制/触碰之类的外部动作翻新）；
 *   3) 版本号按**数值**比大小（v10 不能被字典序判成小于 v4）；
 *   4) 总量与轮换判断读的是 v4 那个活文件 —— 回归防线：量错文件 = 永不轮换。
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

const RAW_LIMIT = 3 * 1024 * 1024; // maxHistoryRawBytes

const bridge = await bridgeHarness({
  config: { socialV2: { session: { maxHistoryRawBytes: RAW_LIMIT } } },
});

try {
  // 让 cfg.sessionCwd 指向 harness 的临时目录（harness 也把 USERPROFILE 指过去了），
  // 这样会话文件路径完全可预测，不会碰到真机上的会话。
  bridge.cfg.sessionCwd = bridge.temp;
  const slug = bridge.sessionStorageSlug(bridge.temp);
  const dirOf = (sid) => path.join(bridge.temp, '.dsh', 'sessions', slug, sid);

  // 高度可压缩的假聊天文本：一帧约 170 KB（解开后）
  const chunk = '{"type":"message","text":"' + '今天群里在聊战绩，谁谁又连甩了几个号，我接了两句。'.repeat(2000) + '"}\n';

  /** 按真实格式（zstd 逐帧拼接）写一个指定版本名的会话文件。 */
  function writeVer(sid, ver, count, { mtime } = {}) {
    const dir = dirOf(sid);
    fs.mkdirSync(dir, { recursive: true });
    const parts = Array.from({ length: count }, () => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
    const buf = Buffer.concat(parts);
    const file = path.join(dir, `session.v${ver}.jsonl.zstd`);
    fs.writeFileSync(file, buf);
    if (mtime) {
      const t = new Date(mtime);
      fs.utimesSync(file, t, t);
    }
    return { compressed: buf.length, raw: count * Buffer.byteLength(chunk, 'utf8'), file };
  }

  console.log('\n[1] 只有 v3（升级前遗留、还没被 0.2.0 碰过）→ 用 v3');
  const onlyV3 = writeVer('session-only-v3', 3, 2);
  check('sessionFilePath 挑到 session.v3.jsonl.zstd',
    path.basename(bridge.sessionFilePath('session-only-v3')) === 'session.v3.jsonl.zstd',
    `挑到 ${path.basename(bridge.sessionFilePath('session-only-v3'))}`);
  check('sessionHistoryRawBytes 量与文件一致',
    bridge.sessionHistoryRawBytes('session-only-v3') === onlyV3.raw,
    `实际=${bridge.sessionHistoryRawBytes('session-only-v3')} 期望=${onlyV3.raw}`);

  console.log('\n[2] 只有 v4（升级后的新会话）→ 用 v4');
  const onlyV4 = writeVer('session-only-v4', 4, 2);
  check('sessionFilePath 挑到 session.v4.jsonl.zstd',
    path.basename(bridge.sessionFilePath('session-only-v4')) === 'session.v4.jsonl.zstd',
    `挑到 ${path.basename(bridge.sessionFilePath('session-only-v4'))}`);
  check('sessionHistoryBytes 也认 v4',
    bridge.sessionHistoryBytes('session-only-v4') === onlyV4.compressed,
    `实际=${bridge.sessionHistoryBytes('session-only-v4')} 期望=${onlyV4.compressed}`);

  console.log('\n[3] v3 与 v4 并存，且 v3 的 mtime **更新** → 仍必须用 v4');
  // 这是最容易写错的一种：按 mtime 挑就会挑到那个已经冻结的 v3。
  const mixedOld = writeVer('session-mixed', 3, 25, { mtime: Date.now() });          // 大、mtime 新
  const mixedNew = writeVer('session-mixed', 4, 2, { mtime: Date.now() - 3600_000 }); // 小、mtime 旧
  check('前提成立：v3 的 mtime 确实比 v4 新',
    fs.statSync(mixedOld.file).mtimeMs > fs.statSync(mixedNew.file).mtimeMs);
  check('并存时按版本号挑到 v4（不是按 mtime 挑到 v3）',
    path.basename(bridge.sessionFilePath('session-mixed')) === 'session.v4.jsonl.zstd',
    `挑到 ${path.basename(bridge.sessionFilePath('session-mixed'))}`);
  check('量的是 v4 的体量（= 小文件），不是那个已冻结的大 v3',
    bridge.sessionHistoryRawBytes('session-mixed') === mixedNew.raw,
    `实际=${bridge.sessionHistoryRawBytes('session-mixed')} 期望=${mixedNew.raw}（大 v3 是 ${mixedOld.raw}）`);

  console.log('\n[4] 活文件超标 → 轮换仍然触发（量错文件就永远不会触发）');
  const bigV4 = writeVer('session-big-v4', 4, 25);
  check('前提成立：v4 解开后超过 raw 上限', bigV4.raw > RAW_LIMIT, `raw=${bigV4.raw}`);
  check('sessionNeedsRotation 判定为需要轮换（>0）', bridge.sessionNeedsRotation('session-big-v4') > 0,
    `返回 ${bridge.sessionNeedsRotation('session-big-v4')}（0 = 不轮换 = 每回合白烧钱）`);

  console.log('\n[5] 版本号必须按数值比大小（v10 不能被字典序判成小于 v4）');
  writeVer('session-v10', 4, 2);
  const ten = writeVer('session-v10', 10, 3);
  check('并存 v4 与 v10 时挑到 v10',
    path.basename(bridge.sessionFilePath('session-v10')) === 'session.v10.jsonl.zstd',
    `挑到 ${path.basename(bridge.sessionFilePath('session-v10'))}`);
  check('量的是 v10 的体量', bridge.sessionHistoryRawBytes('session-v10') === ten.raw);

  console.log('\n[6] 边界安全');
  const emptyDir = dirOf('session-empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  check('目录里没有任何会话文件 → 返回空串（不抛）', bridge.sessionFilePath('session-empty') === '');
  check('目录不存在 → 返回空串（不抛）', bridge.sessionFilePath('session-nope') === '');
  check('空 sessionId → 返回空串（不抛）', bridge.sessionFilePath('') === '');
  check('没文件时体量按 0 处理', bridge.sessionHistoryRawBytes('session-empty') === 0
    && bridge.sessionHistoryBytes('session-empty') === 0
    && bridge.sessionNeedsRotation('session-empty') === 0);
  check('无关文件不会被当成会话文件', (() => {
    fs.writeFileSync(path.join(emptyDir, 'session.v3.jsonl'), 'x');      // 少了 .zstd
    fs.writeFileSync(path.join(emptyDir, 'notes.txt'), 'x');
    return bridge.sessionFilePath('session-empty') === '';
  })());
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
