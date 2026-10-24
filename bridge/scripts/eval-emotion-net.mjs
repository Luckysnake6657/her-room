/**
 * 评测现成的情感权重（给人看的两三个数就够）。
 *
 * ⚠️ 这里**不自己实现前向**，而是直接用生产模块 `src/emotion-net.js`（configure + scoreText），
 *    这样测的就是桥上真正跑的那条路径 —— 自己重写一版前向只会测出"我以为的推理"。
 *
 * 三种数字，别看错：
 *   - 【权重文件里的 OOF 指标】：8 种子交叉验证算出来的，**这才是泛化能力**（权威数字）
 *   - 【随机划分重训一次】：用同样的超参、1 个种子重训一遍，验证"权重文件确实能复现"（--cv，默认开）
 *   - 【全量再算一遍】：模型见过全部数据，数字偏高，只用来**看例子**（--set all）
 *
 * 用法：
 *   node scripts/eval-emotion-net.mjs               # 复现检查 + 例子
 *   node scripts/eval-emotion-net.mjs --no-cv       # 跳过重训，只看权重文件里的指标 + 例子
 *   node scripts/eval-emotion-net.mjs --limit 400   # 例子只看多少条
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as emotionNet from '../src/emotion-net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEIGHTS = path.join(ROOT, 'state', 'emotion-weights.json');
const TRAINER = path.join(ROOT, 'scripts', 'train-emotion-net.mjs');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(argOf('--limit', 8)) || 8;
const NO_CV = argv.includes('--no-cv');

if (!fs.existsSync(WEIGHTS)) { console.error(`没有 ${WEIGHTS} —— 先跑 node scripts/train-emotion-net.mjs`); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(WEIGHTS, 'utf8'));
// 带上下文的权重：标签与特征都得按同一份走（权重文件里记了用的哪个标签文件）
const CTX = raw.context === true;
const LABELS = path.resolve(ROOT, raw.labelsFile || (CTX ? 'state/emotion-labels-ctx.jsonl' : 'state/emotion-labels.jsonl'));
const pct = (x) => (x * 100).toFixed(1) + '%';

emotionNet.configure({ weightsPath: WEIGHTS });
const info = emotionNet.weightsInfo();
const opts = emotionNet.currentOptions();
console.log(`权重文件：${WEIGHTS}`);
console.log(`  格式 ${raw.kind ?? '未知（旧版？）'}${CTX ? '（带上下文：本句 + 上文）' : ''}｜词表 ${info.vocabSize ?? '—'} + 手写 ${info.handDim ?? '—'}｜训练样本 ${info.samples ?? '—'}｜${info.trainedAt ?? '—'}`);
console.log(`  标签 ${raw.labelsFile ?? '(未记录)'}｜注入门限 |相关| ≥ ${opts.minCorr}｜可用维度 ${(info.usable ?? []).map((u, i) => (u ? 'vad'[i] : '')).filter(Boolean).join('/') || '（无）'}`);

// ── ① 权重文件里的 OOF 指标（权威） ──────────────────────────────────────
const m = raw.metrics ?? {};
if (Array.isArray(m.corr)) {
  console.log(`\n【权重文件里的交叉验证指标】（${raw.seeds ?? '?'} 种子 × ${raw.folds ?? '?'} 折，out-of-fold）`);
  console.log(`  相关 v/a/d      = ${m.corr.map((c, k) => c.toFixed(3) + (m.corrSd ? '±' + m.corrSd[k].toFixed(3) : '')).join(' / ')}`);
  if (m.spearman) console.log(`  排序相关        = ${m.spearman.map((c) => Number(c).toFixed(3)).join(' / ')}`);
  if (m.dir) console.log(`  方向一致率      = ${m.dir.map(pct).join(' / ')}`);
  if (m.balAccMatched) console.log(`  平衡准确(切档)  = ${m.balAccMatched.map(pct).join(' / ')}（瞎猜 33.3%）`);
  if (m.oofMse !== undefined) console.log(`  MSE ${Number(m.oofMse).toFixed(4)}（全零基线 ${Number(m.baseMse).toFixed(4)}）`);
  if (Array.isArray(m.usable)) console.log(`  过线判定        = ${m.usable.map((u, k) => `${'vad'[k]} ${u ? '过线' : '没过'}`).join('｜')}`);
}

// ── ② 复现检查：同超参重训一次（写临时文件，不碰正式权重） ────────────────
if (!NO_CV) {
  const tmp = path.join(ROOT, 'state', `_repro-emotion-${process.pid}.json`);
  console.log('\n【复现检查】用权重文件里的超参重训 1 个种子（临时文件，不覆盖正式权重）…');
  try {
    const args = [TRAINER, '--seeds', '1', '--out', tmp, '--labels', LABELS];
    if (CTX) args.push('--context');
    const h = m.hyper ?? {};
    for (const [k, v] of Object.entries({ epochs: h.epochs, lr: h.lr, batch: h.batch, l2: h.l2, folds: h.folds, minCount: h.minCount, maxSize: h.maxSize })) {
      if (v !== undefined && v !== null) args.push('--' + k, String(v));
    }
    if (h.weightExtremes) args.push('--weightExtremes');
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    for (const line of out.split('\n')) if (/种子交叉验证】相关|过线判定/.test(line)) console.log('  ' + line.trim());
    const mine = m.corr ?? [];
    const got = (out.match(/相关 v\/a\/d\s+=\s+([\d.]+)±[\d.]+ \/ ([\d.]+)±[\d.]+ \/ ([\d.]+)±[\d.]+/) ?? []).slice(1).map(Number);
    if (got.length === 3 && mine.length === 3) {
      const diff = got.map((g, k) => Math.abs(g - mine[k]));
      const worst = Math.max(...diff);
      console.log(`  与权重文件差：${diff.map((d, k) => 'vad'[k] + ' ' + d.toFixed(3)).join(' / ')}（单种子本来就有 ±0.01 抖动）`);
      console.log(worst <= 0.05 ? '  ✅ 复现得上（权重文件确实按这套流程训出来的）' : '  ⚠️ 差得有点多 —— 权重文件可能是别的超参训的，建议重训');
    }
  } catch (err) {
    console.log(`  ⚠️ 复现检查没跑成：${err?.message ?? err}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 没生成就算了 */ }
  }
}

// ── ③ 全量再算一遍（模型见过这些数据，数字偏高，只用来看例子） ────────────
const rows = [];
for (const line of fs.readFileSync(LABELS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const r = JSON.parse(line); if (r.text && (!CTX || r.prev)) rows.push(r); } catch { /* 坏行 */ }
}
const pearl = (A, B) => {
  const n = A.length;
  if (!n) return 0;
  const ma = A.reduce((s, x) => s + x, 0) / n;
  const mb = B.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};
const P = [[], [], []], G = [[], [], []], hit = [0, 0, 0], conf = [0, 0, 0];
const samples = [];
for (const r of rows) {
  const s = emotionNet.scoreText(r.text, r.prev ?? '');
  const out = [s.v, s.a, s.d], gold = [Number(r.v) || 0, Number(r.a) || 0, Number(r.d) || 0];
  for (let k = 0; k < 3; k++) {
    P[k].push(out[k]); G[k].push(gold[k]);
    if (Math.abs(gold[k]) >= 0.2) { conf[k]++; if (Math.sign(out[k]) === Math.sign(gold[k])) hit[k]++; }
  }
  samples.push({ text: r.text, out, gold });
}
console.log(`\n【全量再算一遍】${rows.length} 条（模型训练时见过，数字天然偏高，只用来验证"生产路径能跑通"）`);
console.log(`  相关 v/a/d = ${[0, 1, 2].map((k) => pearl(P[k], G[k]).toFixed(3)).join(' / ')}｜方向一致率 ${[0, 1, 2].map((k) => pct(hit[k] / Math.max(1, conf[k]))).join(' / ')}`);

const sorted = samples.slice().sort((a, b) => b.gold[0] - a.gold[0]);
const show = (s) => `  ${s.text.replace(/\s+/g, ' ').slice(0, 24).padEnd(26)} 预测 v${s.out[0].toFixed(2)} a${s.out[1].toFixed(2)} d${s.out[2].toFixed(2)} ｜ 老师 v${s.gold[0].toFixed(2)} a${s.gold[1].toFixed(2)} d${s.gold[2].toFixed(2)}`;
console.log(`\n例子（按老师 v 排序取两端，各 ${LIMIT} 条）：`);
console.log('— 老师觉得最正面 —');
for (const s of sorted.slice(0, LIMIT)) console.log(show(s));
console.log('— 老师觉得最负面 —');
for (const s of sorted.slice(-LIMIT)) console.log(show(s));
console.log('\n判读：泛化能力看【权重文件里的交叉验证指标】；方向一致率明显高于 50% 才算"能分辨好话坏话"。');
