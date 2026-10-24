/**
 * 回归测试：**引用 id 漂移取证**（2026-10-12）。
 *
 * 现场：网关（SnowLuma）的 `get_msg` 对**同名复用**的 id 解析不稳 —— 同一个 id、同一个网关进程
 * （自 2026-10-11 19:11 起没重启），19:1x 解析出 9/29 的旧同名消息、20:0x 又解析出当下的新消息，
 * 而管理员引用的**一直是新消息**。渲染侧靠"疑似时再解析一次、取更新的那条"兜底；
 * 这个用例管的是**取证**那半：把"这个 id 现在解析成什么"记下来，定期复查，变脸就落一条证据，
 * 好拿可复现的原始记录去找网关那边，而不是"我们觉得它不稳"。
 *
 * 这里锁死四件事：
 *   [1] 没变脸 → 不写证据（不许狼来了）；
 *   [2] 变脸（时间差 > 1 分钟）→ 写证据 + 标记 flipped + 不重复计数；
 *   [3] message_seq 变了也算变脸（最硬的判据）；
 *   [4] 别把网关压着：每次复查有条数上限；超过 48h 的老记录标记过期不再查。
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123 } });
try {
  h.setMode('reserved2');
  const driftLines = () => {
    try { return fs.readFileSync(h.QUOTE_DRIFT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  // 每个用例都从干净的监视列表 / 证据文件开始：不然上一个用例盯着的 id 会被下一个用例的 fixture 判成"变脸"
  const resetWatch = () => { fs.rmSync(h.QUOTE_WATCH_FILE, { force: true }); fs.rmSync(h.QUOTE_DRIFT_FILE, { force: true }); };

  console.log('\n[1] 解析结果稳定 → 不写证据（不许狼来了）');
  {
    resetWatch();
    const nowSec = Math.floor(Date.now() / 1000);
    h.setGetMessageFixture((id) => ({ message_id: Number(id), message_seq: 100, time: nowSec, sender: { user_id: 984776985, nickname: '甲' }, message: [{ type: 'text', data: { text: '稳定那条' } }] }));
    h.recordQuoteIdWatch('private', 984776985, '-111', { time: nowSec * 1000, text: '稳定那条', messageSeq: 100 });
    const drifted = await h.sweepQuoteIdWatch('test');
    check('没变脸 → 抓到 0 条', drifted === 0, `drifted=${drifted}`);
    check('证据文件里没有记录', driftLines().length === 0, JSON.stringify(driftLines()));
    check('盯着的那条还在（复查次数 +1）', (h.readQuoteWatch().find((x) => x.id === '-111')?.checks ?? 0) >= 1);
  }

  console.log('\n[2] 时间变脸（> 1 分钟）→ 落证据 + 标 flipped + 不重复计数');
  {
    resetWatch();
    const firstSec = Math.floor((Date.now() - 13 * 24 * 3600 * 1000) / 1000);   // 13 天前的"旧同名"
    const nowSec = Math.floor(Date.now() / 1000);                              // 复查时变成"当下的新消息"
    h.recordQuoteIdWatch('private', 984776985, '-222', { time: firstSec * 1000, text: '旧同名', messageSeq: 754835313 });
    h.setGetMessageFixture((id) => ({ message_id: Number(id), message_seq: 3433, time: nowSec, sender: { user_id: 984776985, nickname: '甲' }, message: [{ type: 'text', data: { text: '当下的新消息' } }] }));
    const d1 = await h.sweepQuoteIdWatch('test');
    const recs = driftLines();
    check('抓到 1 条漂移', d1 === 1, `drifted=${d1}`);
    check('证据里两个答案都在（时间 + seq）',
      recs.length === 1 && Number(recs[0].first.time) === firstSec * 1000 && Number(recs[0].second.time) === nowSec * 1000
      && Number(recs[0].first.messageSeq) === 754835313 && Number(recs[0].second.messageSeq) === 3433,
      JSON.stringify(recs[0] ?? {}).slice(0, 240));
    check('条目被标 flipped', h.readQuoteWatch().find((x) => x.id === '-222')?.flipped === true);
    const d2 = await h.sweepQuoteIdWatch('test');
    check('同一条不再重复报', d2 === 0 && driftLines().length === 1, `d2=${d2} lines=${driftLines().length}`);
  }

  console.log('\n[3] message_seq 变了也算变脸（最硬的判据）');
  {
    resetWatch();
    const nowSec = Math.floor(Date.now() / 1000);
    h.recordQuoteIdWatch('group', 456, '-333', { time: nowSec * 1000, text: '同名', messageSeq: 111 });
    h.setGetMessageFixture((id) => ({ message_id: Number(id), message_seq: 999, time: nowSec, sender: { user_id: 984776985, nickname: '甲' }, message: [{ type: 'text', data: { text: '同名但另一条' } }] }));
    const d = await h.sweepQuoteIdWatch('test');
    check('seq 不同 → 抓到', d === 1, `drifted=${d}`);
    check('证据里记下了两次的 seq', /"messageSeq":\s*111/.test(JSON.stringify(driftLines())) && /"messageSeq":\s*999/.test(JSON.stringify(driftLines())));
  }

  console.log('\n[4] 别把网关压着 + 老记录过期');
  {
    // 造一批（超过每次上限）稳定条目，验证"每次复查有条数上限"
    resetWatch();
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i += 1) h.recordQuoteIdWatch('private', 984776985, `-9${i}`, { time: nowSec * 1000, text: `填${i}`, messageSeq: 500 + i });
    h.setGetMessageFixture((id) => ({ message_id: Number(id), message_seq: 500 + Number(String(id).slice(2)), time: nowSec, sender: { user_id: 984776985, nickname: '甲' }, message: [{ type: 'text', data: { text: '填' } }] }));
    const checksBefore = new Map(h.readQuoteWatch().map((x) => [x.id, Number(x.checks) || 0]));
    await h.sweepQuoteIdWatch('test');
    const delta = h.readQuoteWatch().reduce((n, x) => n + Math.max(0, (Number(x.checks) || 0) - (checksBefore.get(x.id) ?? 0)), 0);
    check('每次复查有条数上限（≤12）', delta <= 12 && delta > 0, `本次复查了 ${delta} 条`);
    // 老记录：超过 48h 不再查（单独放一条，别被上限截断）
    resetWatch();
    h.recordQuoteIdWatch('private', 984776985, '-888', { time: nowSec * 1000, text: '老', messageSeq: 1 });
    const list = h.readQuoteWatch();
    const old = list.find((x) => x.id === '-888');
    old.at = Date.now() - 49 * 3600 * 1000;
    fs.writeFileSync(h.QUOTE_WATCH_FILE, JSON.stringify(list), 'utf8');
    await h.sweepQuoteIdWatch('test');
    const after = h.readQuoteWatch().find((x) => x.id === '-888');
    check('超 48h 的老记录被标过期、不再复查', after?.expired === true && Number(after?.checks ?? 0) === 0,
      JSON.stringify({ expired: after?.expired, checks: after?.checks }));
  }

  console.log('\n[5] 源码级：取证有调度、渲染侧会记录');
  {
    const src = fs.readFileSync('src/bridge.js', 'utf8');
    check('定期复查有定时器（并在 DSH 就绪后启动）', /QUOTE_DRIFT_SWEEP_MS/.test(src) && /setInterval\(\(\) => \{\s*\n?\s*sweepQuoteIdWatch/.test(src));
    check('解析引用时会记录（recordQuoteIdWatch）', /recordQuoteIdWatch\(kind, convId, messageId, info\)/.test(src));
    check('取证失败不许影响渲染（有 try 包裹 + 注释）', /取证失败绝不能影响渲染/.test(src));
  }
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
