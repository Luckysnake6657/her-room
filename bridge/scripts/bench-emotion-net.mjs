/**
 * 情感网络在**本框架下的性能实测**（不是估算）：
 *   - 单条消息的推理耗时（稀疏特征 + 线性层前向）分位数；
 *   - 权重文件大小 / 常驻内存；
 *   - 预测值分布（确认不是"输出全是 0"或"全是 ±1"的退化状态）；
 *   - 拿真实语料跑一遍，统计"会注入的比例"——分两种口径：
 *       · 单句（从零状态出发）：绝大多数 0% 是**设计如此**（一条消息不该立刻改变心情）
 *       · 连续（带着状态跑，按 30 秒间隔衰减）：这才是群里真实的样子
 *   - 一次唤醒里它的固定开销（字符数 → token 估算）。
 *
 * 用法：node scripts/bench-emotion-net.mjs [--n 20000] [--gap 30]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as net from '../src/emotion-net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf('--n') + 1]) || 20000;
const GAP_S = Number(argv[argv.indexOf('--gap') + 1]) || 30;

const texts = [];
for (const line of fs.readFileSync(path.join(ROOT, 'state', 'group-corpus.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    const t = String(r.x ?? '').replace(/\s+/g, ' ').trim();
    if (t) texts.push(t);
  } catch { /* 坏行 */ }
}
if (!texts.length) { console.error('语料为空'); process.exit(2); }

const weightsPath = path.join(ROOT, 'state', 'emotion-weights.json');
net.configure({ weightsPath });
const info = net.weightsInfo();
const opts = net.currentOptions();
console.log('权重文件:', fs.existsSync(weightsPath) ? `${(fs.statSync(weightsPath).size / 1024).toFixed(0)}KB` : '（不存在）');
console.log('权重信息:', JSON.stringify(info));
console.log(`特征：稀疏 ${info.vocabSize ?? 0}（本群词表 tf-idf）+ 手写 ${info.handDim ?? 0} = ${info.inDim ?? 0} 维｜注入门限 |相关| ≥ ${opts.minCorr}\n`);

for (let i = 0; i < 500; i++) net.scoreText(texts[i % texts.length]);   // 预热 JIT

const times = [];
const n = Math.max(1000, N);
const t0 = process.hrtime.bigint();
for (let i = 0; i < n; i++) {
  const a = process.hrtime.bigint();
  net.scoreText(texts[i % texts.length]);
  const b = process.hrtime.bigint();
  times.push(Number(b - a) / 1000);
}
const total = Number(process.hrtime.bigint() - t0) / 1e6;
times.sort((a, b) => a - b);
const q = (p) => times[Math.floor(times.length * p)] ?? 0;
console.log(`推理 ${n} 次：总耗时 ${total.toFixed(0)}ms｜平均 ${(total / n * 1000).toFixed(1)}µs/条`);
console.log(`分位：p50 ${q(0.5).toFixed(1)}µs｜p90 ${q(0.9).toFixed(1)}µs｜p99 ${q(0.99).toFixed(1)}µs｜最慢 ${times[times.length - 1].toFixed(1)}µs`);

const raw = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
const floats = (raw.W ?? []).reduce((s, row) => s + row.length, 0) + (raw.B?.length ?? 0);
console.log(`权重常驻内存 ≈ ${(floats * 8 / 1024).toFixed(0)}KB（Float64；加载峰值再加一份 JSON 数组 ≈ ${(fs.statSync(weightsPath).size / 1024).toFixed(0)}KB）`);

// 预测值分布（每维）：模型退化成"全 0"或"全 ±1"都能一眼看出来
const per = [[], [], []];
for (const t of texts) { const s = net.scoreText(t); per[0].push(s.v); per[1].push(s.a); per[2].push(s.d); }
console.log('\n预测值分布（真实语料）：');
for (let k = 0; k < 3; k++) {
  const a = per[k].slice().sort((x, y) => x - y);
  const rms = Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  const zeros = a.filter((x) => x === 0).length;
  console.log(`  ${'vad'[k]}：RMS ${rms.toFixed(3)}｜p5 ${q05(a, 0.05).toFixed(2)}｜中位 ${q05(a, 0.5).toFixed(2)}｜p95 ${q05(a, 0.95).toFixed(2)}｜恰好为 0 的 ${(zeros / a.length * 100).toFixed(1)}%${info.usable?.[k] ? '' : '（该维未过线，按设计恒为 0）'}`);
}
function q05(a, p) { return a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0; }

// 注入比例：单句 vs 连续
let injectedSingle = 0;
for (const t of texts) {
  const e = net.updateEmotion({ pad: [0, 0, 0], updatedAt: Date.now() }, net.scoreText(t));
  if (net.buildEmotionLine(e)) injectedSingle++;
}
let injectedSeq = 0;
const shown = [];
const now = Date.now();
let st = { pad: [0, 0, 0], updatedAt: now };
for (let i = 0; i < texts.length; i++) {
  const at = now + i * GAP_S * 1000;
  st = net.updateEmotion(st, net.scoreText(texts[i]), null, at);
  const line = net.buildEmotionLine(st, at);
  if (line) { injectedSeq++; if (shown.length < 3) shown.push(`${texts[i].slice(0, 20)} → ${line}`); }
}
console.log(`\n注入比例（门限 ${opts.neutralThreshold}）：`);
console.log(`  单句（每次从零状态）：${(injectedSingle / texts.length * 100).toFixed(1)}%  ← 一条消息不该立刻改变心情，接近 0 是设计如此`);
console.log(`  连续（带状态、间隔 ${GAP_S}s）：${(injectedSeq / texts.length * 100).toFixed(1)}%  ← 这才是群里真实的样子`);
for (const l of shown) console.log('  ' + l);

const demo = net.buildEmotionLine({ pad: [0.5, 0.4, 0.3], updatedAt: Date.now() });
console.log(`\n非中性时的注入行：${demo.length} 字符 ≈ ${Math.round(demo.length * 0.6)} token（中性时 0）`);
console.log(`单条消息的框架开销：约 ${(total / n * 1000).toFixed(0)}µs CPU + 0 次网络请求（对比：一次唤醒的模型调用是秒级、上万 token）`);
