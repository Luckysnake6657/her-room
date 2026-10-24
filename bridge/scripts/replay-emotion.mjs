/**
 * 情感模块参数回放（离线、用真实日志里的刺激序列）。
 *
 * 用途：调 `baseline / gain / halfLifeMs / neutralThreshold` 时**先用真实流量试**，别拍脑袋。
 * 数据来源：`state/bridge.log` 里 `[emotion] <key> a/b/c → x/y/z（刺激 sv/sa/sd）` 的每一行 —— 
 * 这是她真实会话里模型打出来的**原始刺激**（未乘 scale），时间戳到秒，可以按真实间隔做衰减重放。
 *
 * 关注的四个数：
 *   - 注入率：会注入语气行的比例（一直 90% = 等于常量提示，没信息量）
 *   - 正/负：v 正、v 负各自的比例（**负向从来没出现过**就说明被参数压住了）
 *   - 饱和：|pad| 顶到 1.0 的比例（顶住 = 卡死在最高档）
 *   - 组合种类：出现过的"v/a 档位组合"数量（种类越少越像常量）
 *   - 漂移：各维最终 pad 的均值 → 检查有没有"系统性地一直往一个方向推"
 *
 * 用法：node scripts/replay-emotion.mjs [--baseV 0.1 --baseA 0.3 --gain 0.35 --halfLife 40 --th 0.22]
 *       node scripts/replay-emotion.mjs --current   # 用 config.json 里的现值跑一遍
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2 ?? {};
const ec = cfg.emotion ?? {};
const CURRENT = argv.includes('--current');

const baseV = Number(argOf('--baseV', CURRENT ? (ec.baseline?.v ?? 0) : 0.10));
const baseA = Number(argOf('--baseA', CURRENT ? (ec.baseline?.a ?? 0) : 0.30));
const gain = Number(argOf('--gain', CURRENT ? ec.gain : 0.35));
const halfLifeMin = Number(argOf('--halfLife', CURRENT ? (Number(ec.halfLifeMs) || 3600000) / 60000 : 60));
const th = Number(argOf('--th', CURRENT ? ec.neutralThreshold : 0.18));
const scaleGroup = Number(argOf('--scaleGroup', 0.35));

// ── 抓刺激序列 ─────────────────────────────────────────────────────────────
const re = /^(\d{2}):(\d{2}):(\d{2}).*\[emotion\] (\S+) [\d.]+\/[\d.]+\/[\d.]+ → [\d.]+\/[\d.]+\/[\d.]+（刺激 ([-\d.]+)\/([-\d.]+)\/([-\d.]+)）/;
const seq = [];
let dayMs = 0, lastT = -1;
for (const line of fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8').split('\n')) {
  const m = line.match(re);
  if (!m) continue;
  const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  if (lastT >= 0 && t < lastT - 3600) dayMs += 86400;
  lastT = t;
  seq.push({ at: (dayMs + t) * 1000, key: m[4], sv: +m[5], sa: +m[6], sd: +m[7] });
}
if (!seq.length) { console.error('日志里没有 [emotion] 记录，先用一阵子再来调参'); process.exit(2); }

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
console.log(`样本：${seq.length} 条真实刺激（${new Set(seq.map((s) => s.key)).size} 个会话）`);
console.log(`  刺激均值：v ${mean(seq.map((s) => s.sv)).toFixed(3)}｜a ${mean(seq.map((s) => s.sa)).toFixed(3)}（**基线该取均值**：取中位会让 a 长期往下漂）`);
console.log(`  刺激里 v 为负的：${seq.filter((s) => s.sv < 0).length} 条（${(seq.filter((s) => s.sv < 0).length / seq.length * 100).toFixed(0)}%）`);
console.log(`\n参数：基线 v ${baseV} / a ${baseA}｜增益 ${gain}｜半衰期 ${halfLifeMin}min｜门限 ${th}｜群里 scale ${scaleGroup}`);

// ── 重放 ───────────────────────────────────────────────────────────────────
const state = new Map();
let injected = 0, vPos = 0, vNeg = 0, aPos = 0, aNeg = 0, sat = 0;
const combos = new Set();
const finals = [];
for (const s of seq) {
  const scale = s.key.startsWith('group:') ? scaleGroup : 1;
  const p = state.get(s.key) ?? { pad: [0, 0], at: s.at };
  const f = Math.pow(0.5, Math.max(0, s.at - p.at) / (halfLifeMin * 60000));
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  const pad = [
    clamp1(p.pad[0] * f + gain * ((s.sv - baseV) * scale)),
    clamp1(p.pad[1] * f + gain * ((s.sa - baseA) * scale)),
  ];
  state.set(s.key, { pad, at: s.at });
  if (Math.abs(pad[0]) >= th || Math.abs(pad[1]) >= th) injected++;
  if (pad[0] >= th) vPos++;
  if (pad[0] <= -th) vNeg++;
  if (pad[1] >= th) aPos++;
  if (pad[1] <= -th) aNeg++;
  if (Math.abs(pad[1]) >= 0.95 || Math.abs(pad[0]) >= 0.95) sat++;
  combos.add(`${pad[0] >= th ? 'v+' : pad[0] <= -th ? 'v-' : 'v0'}|${pad[1] >= th ? 'a+' : pad[1] <= -th ? 'a-' : 'a0'}`);
  if (s === seq[seq.length - 1]) for (const [k, v] of state) finals.push({ key: k, pad: v.pad });
}
const pct = (n) => `${(n / seq.length * 100).toFixed(0)}%`;
console.log(`\n重放结果：`);
console.log(`  注入率 ${pct(injected)}｜v 正 ${pct(vPos)}｜v 负 ${pct(vNeg)}｜a 正(话多) ${pct(aPos)}｜a 负(懒得打字) ${pct(aNeg)}｜顶到饱和 ${pct(sat)}`);
console.log(`  语气组合 ${combos.size} 种：${[...combos].join('、')}`);
console.log(`  各会话最终 pad（看有没有系统性偏向）：`);
for (const f of finals) console.log(`    ${f.key.padEnd(20)} v ${f.pad[0].toFixed(2)}｜a ${f.pad[1].toFixed(2)}`);
// ── 模式二：--corpus 用**完整语料**（真实消息流 + 真实模型打分）重放 ──────────
// 为什么需要它：日志里只记"情绪动了 ≥0.05"的那些消息 → 是**筛过的极端样本**，
// 拿它调参会过校正（实测候选参数会把 v 负拉到 38%，而真实流量没那么负面）。
// 语料是**完整**的别人说话流（含时间戳、按群分开），用真权重逐条打分再模拟状态 —— 这才是无偏估计。
if (argv.includes('--corpus')) {
  const emotionNet = await import('../src/emotion-net.js');
  const weights = path.join(ROOT, 'state', 'emotion-weights.json');
  emotionNet.configure({ weightsPath: weights, halfLifeMs: halfLifeMin * 60000, gain, neutralThreshold: th });
  const msgs = [];
  for (const line of fs.readFileSync(path.join(ROOT, 'state', 'group-corpus.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); const t = String(r.x ?? '').trim(); if (t && r.t) msgs.push({ t: Number(r.t), g: String(r.g ?? '?'), s: r.s, x: t }); } catch { /* 坏行 */ }
  }
  msgs.sort((a, b) => a.t - b.t);
  // 先把**模型在完整语料上的预测分布**量出来：基线要取这个分布的均值（取高了会系统性偏向"有点烦"）
  const allStim = msgs.map((m) => ({ m, s: emotionNet.scoreText(m.x) })).filter((x) => x.s.usedDims.length);
  const col = (f) => allStim.map((x) => f(x.s)).sort((a, b) => a - b);
  const meanOf = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const medOf = (arr) => arr[Math.floor(arr.length / 2)];
  const sdOf = (arr) => Math.sqrt(arr.reduce((s, x) => s + (x - meanOf(arr)) ** 2, 0) / arr.length);
  for (const [dim, f] of [['v', (s) => s.v], ['a', (s) => s.a], ['d', (s) => s.d]]) {
    const c = col(f);
    console.log(`  ${dim}：均值 ${meanOf(c).toFixed(3)}｜中位 ${medOf(c).toFixed(3)}｜标准差 ${sdOf(c).toFixed(3)}｜范围 ${c[0].toFixed(2)} ~ ${c[c.length - 1].toFixed(2)}`);
  }
  console.log('  ⚠️ 基线要取**均值**（这样平均消息对情绪没有系统性推动），取高了会整体偏向负面。');
  const st2 = new Map();
  let inj2 = 0, vp = 0, vn = 0, ap = 0, an = 0, sat2 = 0;
  const combos2 = new Set();
  for (const m of msgs) {
    const s = emotionNet.scoreText(m.x);
    if (!s.usedDims.length) continue;                     // 没权重/没过线 → 不参与
    const scale = m.g.startsWith('group:') ? scaleGroup : 1;
    const p = st2.get(m.g) ?? { pad: [0, 0], at: m.t };
    const f = Math.pow(0.5, Math.max(0, m.t - p.at) / (halfLifeMin * 60000));
    const clamp1 = (x) => Math.max(-1, Math.min(1, x));
    const pad = [clamp1(p.pad[0] * f + gain * ((s.v - baseV) * scale)), clamp1(p.pad[1] * f + gain * ((s.a - baseA) * scale))];
    st2.set(m.g, { pad, at: m.t });
    if (Math.abs(pad[0]) >= th || Math.abs(pad[1]) >= th) inj2++;
    if (pad[0] >= th) vp++;
    if (pad[0] <= -th) vn++;
    if (pad[1] >= th) ap++;
    if (pad[1] <= -th) an++;
    if (Math.abs(pad[1]) >= 0.95 || Math.abs(pad[0]) >= 0.95) sat2++;
    combos2.add(`${pad[0] >= th ? 'v+' : pad[0] <= -th ? 'v-' : 'v0'}|${pad[1] >= th ? 'a+' : pad[1] <= -th ? 'a-' : 'a0'}`);
  }
  const n2 = msgs.length;
  const pc = (x) => `${(x / n2 * 100).toFixed(0)}%`;
  console.log(`\n=== 完整语料重放（${n2} 条真实消息 / ${st2.size} 个会话，逐条用真权重打分）===`);
  console.log(`  注入率 ${pc(inj2)}｜v 正 ${pc(vp)}｜v 负 ${pc(vn)}｜a 正(话多) ${pc(ap)}｜a 负(懒得打字) ${pc(an)}｜顶到饱和 ${pc(sat2)}`);
  console.log(`  语气组合 ${combos2.size} 种：${[...combos2].join('、')}`);
  console.log('  各会话最终 pad：');
  for (const [k, v] of st2) console.log(`    ${k.padEnd(20)} v ${v.pad[0].toFixed(2)}｜a ${v.pad[1].toFixed(2)}`);
}

