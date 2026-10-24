/**
 * 引用 id 漂移报告：把 `state/quote-id-drift.jsonl` 里的取证记录整理成人能看的样子。
 *
 * 为什么要它（2026-10-12）：网关（SnowLuma）的 `get_msg` 对**同名复用**的 id 解析不稳 ——
 * 实测同一个 id、同一个网关进程，19:1x 解析出 9/29 的旧同名消息、20:0x 又解析出当下的新消息，
 * 而管理员引用的**一直是新消息**（表现为她那边看到 `[引用 …（9/29 14:38，13天前）]`）。
 * 桥接侧已经兜底（疑似时再解析一次、取更新的那条），但**根治在网关侧**：
 * 拿这份记录去找那边修的时候，给的是可复现的原始证据（同一 id 两个答案 + 中间隔了多久），
 * 而不是"我们觉得它不稳"。
 *
 * 用法：node scripts/quote-drift-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = path.join(ROOT, 'state', 'quote-id-watch.json');
const DRIFT = path.join(ROOT, 'state', 'quote-id-drift.jsonl');

const fmt = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toLocaleString('zh-CN') : '?');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readLines = (p) => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};

const watch = readJson(WATCH, []);
const drift = readLines(DRIFT);

console.log('引用 id 漂移报告');
console.log('='.repeat(60));
console.log(`监视中的 id：${watch.length} 个（已抓到漂移 ${watch.filter((x) => x.flipped).length} 个 / 已过期 ${watch.filter((x) => x.expired).length} 个）`);
for (const w of watch.slice(-8)) {
  console.log(`  ${w.flipped ? '⚠️' : w.expired ? '·' : ' '} id=${w.id} ${w.kind}:${w.convId}`
    + ` 记录时=${fmt(w.time)} seq=${w.messageSeq || '?'} 复查${w.checks || 0}次`
    + ` 文本「${String(w.text || '').slice(0, 30)}」`);
}
console.log('');
if (!drift.length) {
  console.log('还没有抓到漂移证据（这本身也是信息：说明这段时间网关解析是稳的，或者最近没引用过老 id）。');
} else {
  console.log(`漂移证据：${drift.length} 条（${DRIFT.replace(ROOT + path.sep, '')}）`);
  for (const d of drift) {
    const gapMin = (Number(d.first?.time) && Number(d.second?.time))
      ? Math.round(Math.abs(Number(d.second.time) - Number(d.first.time)) / 60000) : null;
    console.log(`  id=${d.id}（${d.key}）抓到于 ${d.at}（来源 ${d.reason}）`);
    console.log(`    第一次解析：${fmt(d.first?.time)}  seq=${d.first?.messageSeq ?? '?'}  「${String(d.first?.text ?? '').slice(0, 36)}」`);
    console.log(`    复查解析到：${fmt(d.second?.time)}  seq=${d.second?.messageSeq ?? '?'}`
      + (gapMin != null ? `（相差 ${gapMin} 分钟）` : ''));
  }
  console.log('');
  console.log('给网关那边的结论：同一个 message_id 在**同一进程**内解析到了两条不同消息 ——');
  console.log('  说明它的 id→消息查找没有把"同名复用"区分开（应按 message_seq + 时间做复合键，或取最新候选）。');
}
