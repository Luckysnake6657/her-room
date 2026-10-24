/**
 * 训练情感网络（第二轮：**词级稀疏 tf-idf + 线性层**，5 折交叉验证）。
 *
 * 第一版（char-gram 哈希 + 32 隐层 MLP）验证集相关只有 0.29/0.31/0.39，最佳轮次出现在第 1 轮。
 * 这一版换特征：词表来自**本群自己的语料**（1~4 字片段，出现 ≥ minCount 次）+ tf-idf + L2 归一化，
 * 另拼 12 维手写特征；模型就是最简神经网络（单线性层，稀疏前向只累加非零项）。
 *
 * 为什么用 5 折交叉验证而不是一个 15% 的验证集：
 *   1675 条里切 251 条做验证时，**选轮次的噪声**比模型差异还大 —— 实测验证集相关 0.51/0.50/0.44，
 *   换到测试集只有 0.34/0.26/0.41。交叉验证让每条样本都当过验证样本（out-of-fold），
 *   数字稳定得多，也把全部数据用上。
 *
 * 两个分类指标（都要跟"多数类基线"比）：
 *   - balAccRaw：预测值直接按 ±0.15 切档 —— 会被"输出被压向 0"拖死，仅作对照
 *   - **balAccMatched**：把预测值按**同样比例**切成 负/中/正（等价于挑一个最优阈值），
 *     衡量的是"排序能力"，不受缩放影响 —— 这个才是"能不能分辨正负"的真指标
 *
 * 用法：node scripts/train-emotion-net.mjs [--epochs 20] [--lr 0.02] [--l2 3e-4] [--minCount 5] [--maxSize 3000] [--folds 5] [--weightExtremes]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HAND_DIM, CTX_DIM, VOCAB_DEFAULTS, buildVocab, makeVocabIndex, extractSparse, denseFeatures, contextFeatures,
} from '../src/emotion-features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'state', 'group-corpus.jsonl');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
// 默认写正式权重；--out 用来写到别处（评测脚本做"复现性检查"时不想覆盖正式权重）
const OUT = path.isAbsolute(argOf('--out', '')) ? argOf('--out', '') : path.join(ROOT, argOf('--out', path.join('state', 'emotion-weights.json')));
const EPOCHS = Number(argOf('--epochs', 4)) || 4;
const LR = Number(argOf('--lr', 0.008)) || 0.008;
const L2 = Number(argOf('--l2', 0.001)) || 0.001;
const BATCH = Number(argOf('--batch', 32)) || 32;
const FOLDS = Math.max(2, Number(argOf('--folds', 5)) || 5);
const MIN_COUNT = Number(argOf('--minCount', 5)) || 5;
const MAX_SIZE = Number(argOf('--maxSize', 3000)) || 3000;
// 极端情感的样本才是信息量所在（"中性"占多数）；--weightExtremes 给 |y| 大的样本更高权重
const WEIGHT_EXTREMES = has('--weightExtremes');
// --fraction 0.5：只用一半训练数据（画学习曲线用，看"数据还值不值得加"）
const FRACTION = Math.min(1, Math.max(0.05, Number(argOf('--fraction', 1)) || 1));
// --no-save：只报指标不写权重（画曲线/做实验时用，免得把正式权重覆盖成"半量数据"版本）
const NO_SAVE = has('--no-save');
const ONLY = String(argOf('--only', 'vad'));   // 只训练/评估哪些维度：vad / v
// --context：用"上文 + 本句"当特征，标签取**带上下文标的那份**（state/emotion-labels-ctx.jsonl）。
// 特征排布：稀疏 block1（本句，索引 0..V-1）+ 稀疏 block2（上文，索引 V..2V-1）+ 手写（本句 12 + 上文性质 3）
const CTX = has('--context');
const OUT_DIM = 3;
const TAU = 0.15;                              // 三分类切档阈值

// ── 数据 ─────────────────────────────────────────────────────────────────
const LABELS = path.resolve(ROOT, argOf('--labels', path.join('state', CTX ? 'emotion-labels-ctx.jsonl' : 'emotion-labels.jsonl')));
if (!fs.existsSync(LABELS)) {
  console.error(`没有 ${LABELS} —— 先跑 node scripts/label-emotion-corpus.mjs${CTX ? ' --context' : ''}`);
  process.exit(2);
}
const rows = [];
const seen = new Set();
for (const line of fs.readFileSync(LABELS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (!r.text || seen.has(r.h)) continue;
  if (CTX && !r.prev) continue;               // 带上下文模式：没有上文的样本不能用
  seen.add(r.h);
  rows.push({ text: r.text, prev: String(r.prev ?? ''), y: [Number(r.v) || 0, Number(r.a) || 0, Number(r.d) || 0] });
}
if (rows.length < 50) { console.error(`样本太少（${rows.length} 条），至少 50 条再训练`); process.exit(2); }
console.log(`标签文件 ${path.relative(ROOT, LABELS)}`);

const corpusTexts = [];
if (fs.existsSync(CORPUS)) {
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const t = String(JSON.parse(line).x ?? '').trim(); if (t) corpusTexts.push(t); } catch { /* 坏行跳过 */ }
  }
}
const idfDocs = corpusTexts.length ? corpusTexts : rows.map((r) => r.text);
// 词表用"语料 + 本句 + 上文"一起建（两个块共用一份词表，只是索引区间不同）
const vocabList = buildVocab([...corpusTexts, ...rows.map((r) => r.text), ...rows.map((r) => r.prev)], { minCount: MIN_COUNT, maxSize: MAX_SIZE });
const vocab = makeVocabIndex(vocabList, idfDocs);
const V = vocab.size;
if (!V) { console.error('词表为空 —— 语料/标签太少'); process.exit(2); }

const feats = rows.map((r) => extractSparse(r.text, vocab));
const prevFeats = CTX ? rows.map((r) => extractSparse(r.prev, vocab)) : null;
const hand = CTX
  ? rows.map((r) => Float64Array.from([...denseFeatures(r.text), ...contextFeatures(r.prev)]))
  : rows.map((r) => denseFeatures(r.text));
const HAND_TOTAL = CTX ? HAND_DIM + CTX_DIM : HAND_DIM;
const weight = rows.map((r) => (WEIGHT_EXTREMES ? 0.3 + Math.max(...r.y.map(Math.abs)) : 1));
const trainDims = ONLY === 'v' ? [0] : [0, 1, 2];
console.log(`样本 ${rows.length} 条${CTX ? '（带上下文）' : ''}｜词表 ${V} 个（minCount ${MIN_COUNT}，从 ${idfDocs.length} 条语料统计）｜稀疏 ${CTX ? `2×${V}` : V} + 手写 ${HAND_TOTAL} 维｜训练维度 ${trainDims.join(',')}`);
console.log(`超参 lr ${LR}｜batch ${BATCH}｜L2 ${L2}｜epochs ${EPOCHS}｜${FOLDS} 折｜极端样本加权 ${WEIGHT_EXTREMES ? '开' : '关'}`);

// 打乱流的固定种子（可复现；折划分另有每种子自己的种子，见 foldsFor）
let seed = 20260930;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ── 模型：单线性层（最简神经网络），输出 clamp 到 [-1,1] ────────────────────
// 特征排布：[0,V) 本句稀疏 ｜ [V,2V) 上文稀疏（仅 --context）｜尾部 HAND_TOTAL 维手写
const PREV_OFF = V;                                  // 上文块的起始索引
const HAND_OFF = CTX ? 2 * V : V;                    // 手写块起始索引
const NFEAT = HAND_OFF + HAND_TOTAL;
const W = Array.from({ length: OUT_DIM }, () => new Float64Array(NFEAT));
const B = new Float64Array(OUT_DIM);
const mW = Array.from({ length: OUT_DIM }, () => new Float64Array(NFEAT));
const vW = Array.from({ length: OUT_DIM }, () => new Float64Array(NFEAT));
const mB = new Float64Array(OUT_DIM);
const vB = new Float64Array(OUT_DIM);
const gW = Array.from({ length: OUT_DIM }, () => new Float64Array(NFEAT));
const gB = new Float64Array(OUT_DIM);
let step = 0;
const BC1 = 0.9, BC2 = 0.999, EPS = 1e-8;

function resetModel() {
  for (let k = 0; k < OUT_DIM; k++) { W[k].fill(0); mW[k].fill(0); vW[k].fill(0); gW[k].fill(0); }
  B.fill(0); mB.fill(0); vB.fill(0); gB.fill(0);
  step = 0;
}

function predict(i) {
  const { idx, val } = feats[i];
  const pv = CTX ? prevFeats[i] : null;
  const h = hand[i];
  const out = new Float64Array(OUT_DIM);
  for (let k = 0; k < OUT_DIM; k++) {
    const Wk = W[k];
    let s = B[k];
    for (let j = 0; j < idx.length; j++) s += Wk[idx[j]] * val[j];
    if (pv) for (let j = 0; j < pv.idx.length; j++) s += Wk[PREV_OFF + pv.idx[j]] * pv.val[j];
    for (let d = 0; d < HAND_TOTAL; d++) s += Wk[HAND_OFF + d] * h[d];
    out[k] = s > 1 ? 1 : s < -1 ? -1 : s;
  }
  return out;
}

/**
 * 一轮训练。逐样本 Adam + 大 lr 会直接发散（实测训练 MSE 0.44 ≫ 全猜 0 的 0.084），
 * 所以累积一个 mini-batch 的梯度取平均再更新。用 Nesterov 式双指针遍历，
 * 每个样本**归一化权重**（除以样本权重和），保证加权后梯度尺度量级不变。
 */
function trainEpoch(list) {
  let loss = 0, wsum = 0;
  const shuffled = list.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  for (let s = 0; s < shuffled.length; s += BATCH) {
    const batch = shuffled.slice(s, s + BATCH);
    for (let k = 0; k < OUT_DIM; k++) gW[k].fill(0);
    gB.fill(0);
    let bn = 0;
    for (const i of batch) {
      const out = predict(i);
      const wi = weight[i];
      const { idx, val } = feats[i];
      const pv = CTX ? prevFeats[i] : null;
      const h = hand[i];
      bn += wi;
      for (const k of trainDims) {
        const e = out[k] - rows[i].y[k];
        loss += wi * e * e; wsum += wi;
        if (out[k] >= 1 || out[k] <= -1) continue;   // clamp 饱和区梯度为 0
        const g = wi * 2 * e;
        const gWk = gW[k];
        for (let j = 0; j < idx.length; j++) gWk[idx[j]] += g * val[j];
        if (pv) for (let j = 0; j < pv.idx.length; j++) gWk[PREV_OFF + pv.idx[j]] += g * pv.val[j];
        for (let d = 0; d < HAND_TOTAL; d++) gWk[HAND_OFF + d] += g * h[d];
        gB[k] += g;
      }
    }
    if (!bn) continue;
    step++;
    const c1 = 1 - Math.pow(BC1, step), c2 = 1 - Math.pow(BC2, step);
    for (const k of trainDims) {
      const Wk = W[k], mWk = mW[k], vWk = vW[k], gWk = gW[k];
      for (let f = 0; f < NFEAT; f++) {
        const grad = gWk[f] / bn + L2 * Wk[f];
        mWk[f] = BC1 * mWk[f] + (1 - BC1) * grad;
        vWk[f] = BC2 * vWk[f] + (1 - BC2) * grad * grad;
        Wk[f] -= LR * (mWk[f] / c1) / (Math.sqrt(vWk[f] / c2) + EPS);
      }
      const gb = gB[k] / bn;
      mB[k] = BC1 * mB[k] + (1 - BC1) * gb;
      vB[k] = BC2 * vB[k] + (1 - BC2) * gb * gb;
      B[k] -= LR * (mB[k] / c1) / (Math.sqrt(vB[k] / c2) + EPS);
    }
  }
  return wsum ? loss / wsum : 0;
}

// ── 指标 ─────────────────────────────────────────────────────────────────
const pearson = (a, b) => {
  const n = a.length;
  if (!n) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};
const ranks = (arr) => {
  const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
  const r = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
};
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const bucketOf = (x) => (x > TAU ? 2 : x < -TAU ? 0 : 1);

/** 平衡准确率：各类真实样本的召回平均（某个真实类一个样本都没有时才跳过） */
function balancedFrom(goldCls, correctCls) {
  const recalls = goldCls.map((tot, c) => (tot ? correctCls[c] / tot : null)).filter((x) => x !== null);
  return recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : 0;
}

function metricsFromPreds(preds, idxList) {
  const n = idxList.length;
  const dims = [0, 1, 2].map((k) => {
    const p = [], g = [];
    for (const i of idxList) { p.push(preds[i][k]); g.push(rows[i].y[k]); }
    const goldCls = [0, 0, 0];
    const okRaw = [0, 0, 0];      // 直接按 ±0.15 切档时，每个真实类猜对的条数
    let mse = 0, hit = 0, conf = 0;
    for (let i = 0; i < n; i++) {
      mse += (p[i] - g[i]) ** 2;
      const gc = bucketOf(g[i]);
      goldCls[gc]++;
      if (bucketOf(p[i]) === gc) okRaw[gc]++;
      if (Math.abs(g[i]) >= 0.2) { conf++; if (Math.sign(p[i]) === Math.sign(g[i])) hit++; }
    }
    // matched：按**真实类比例**切预测值（等价于挑一个最优阈值），衡量排序能力、不受缩放影响
    const sorted = p.slice().sort((a, b) => a - b);
    const c1 = Math.min(n - 1, Math.floor((goldCls[0] / Math.max(1, n)) * n));
    const c2 = Math.min(n - 1, Math.floor(((goldCls[0] + goldCls[1]) / Math.max(1, n)) * n));
    const cut1 = sorted[Math.max(0, c1)];
    const cut2 = sorted[Math.max(0, c2)];
    const okMatched = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const pc = p[i] <= cut1 ? 0 : p[i] <= cut2 ? 1 : 2;
      if (pc === bucketOf(g[i])) okMatched[bucketOf(g[i])]++;
    }
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    return {
      mse: n ? mse / n : 0,
      corr: pearson(p, g),
      spearman: spearman(p, g),
      dir: conf ? hit / conf : 0,
      // 平衡准确率的"瞎猜"水平是 33%（不随类别不平衡变化）；普通准确率的基线才是"全猜多数类"
      balAccMatched: balancedFrom(goldCls, okMatched),
      balAccRaw: balancedFrom(goldCls, okRaw),
      plainAccMatched: n ? sum(okMatched) / n : 0,
      plainAccRaw: n ? sum(okRaw) / n : 0,
      majority: n ? Math.max(...goldCls) / n : 0,
      goldCls,
      recallMatched: goldCls.map((tot, c) => (tot ? Number((okMatched[c] / tot).toFixed(3)) : null)),
      predSpread: n ? Math.sqrt(p.reduce((s, x) => s + x * x, 0) / n) : 0,
    };
  });
  return { mse: dims.reduce((s, d) => s + d.mse, 0) / OUT_DIM, dims };
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const show = (m) => `相关 ${m.dims.map((d) => d.corr.toFixed(2)).join('/')}｜排序相关 ${m.dims.map((d) => d.spearman.toFixed(2)).join('/')}｜平衡准确 ${m.dims.map((d) => pct(d.balAccMatched)).join('/')}`;

/**
 * 训练预算固定 EPOCHS 轮、**不做任何"挑最好的一轮/最好的配置"**，而是换成：
 *   ① 固定轮数（曲线在 2~6 轮之间是平台，挑峰值的收益全在噪声里）；
 *   ② 跑 SEEDS 个不同种子（折划分 + 打乱顺序都不同），报**均值 ± 标准差**。
 * 线性模型的"多种子平均"等于"权重平均"，推理侧零成本 —— 所以最终权重直接取各种子平均。
 */
const SEEDS = Math.max(1, Number(argOf('--seeds', 8)) || 8);
const allIdx = rows.map((_, i) => i);
const baseM = metricsFromPreds(rows.map(() => new Float64Array(OUT_DIM)), allIdx);
console.log(`\n基线（全零输出）OOF MSE ${baseM.mse.toFixed(4)}｜${show(baseM)}｜全猜多数类普通准确 ${baseM.dims.map((d) => pct(d.majority)).join('/')}`);

function foldsFor(s) {
  let sd = s;
  const r = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
  const ord = rows.map((_, i) => i);
  for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
  const fo = new Array(rows.length);
  ord.forEach((idx, pos) => { fo[idx] = pos % FOLDS; });
  return fo;
}

const sumW = Array.from({ length: OUT_DIM }, () => new Float64Array(NFEAT));
const sumB = new Float64Array(OUT_DIM);
const seedMetrics = [];
console.log(`\n交叉验证：${FOLDS} 折 × ${SEEDS} 个种子（每折训练时该折完全不参与，训练预算固定 ${EPOCHS} 轮）…`);
for (let s = 0; s < SEEDS; s++) {
  const sd = 20260930 + s * 7919;
  const fo = foldsFor(sd);
  const oof = rows.map(() => new Float64Array(OUT_DIM));
  for (let f = 0; f < FOLDS; f++) {
    const tr = allIdx.filter((i) => fo[i] !== f);
    const va = allIdx.filter((i) => fo[i] === f);
    // 学习曲线用：每个折再随机抽 fraction（抽一次、整折固定）
    let trUse = tr;
    if (FRACTION < 1) {
      const sh = tr.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      trUse = sh.slice(0, Math.max(30, Math.round(tr.length * FRACTION)));
    }
    resetModel();
    for (let e = 1; e <= EPOCHS; e++) trainEpoch(trUse);
    for (const i of va) oof[i].set(predict(i));
  }
  const m = metricsFromPreds(oof, allIdx);
  seedMetrics.push({ seed: sd, m });
  console.log(`种子 ${sd}  OOF MSE ${m.mse.toFixed(4)}｜${show(m)}`);
  if (NO_SAVE) continue;
  // 该种子在**全部数据**上重训一份，累加进平均权重
  resetModel();
  for (let e = 1; e <= EPOCHS; e++) trainEpoch(allIdx);
  for (let k = 0; k < OUT_DIM; k++) {
    const Wk = W[k], sk = sumW[k];
    for (let f = 0; f < NFEAT; f++) sk[f] += Wk[f];
    sumB[k] += B[k];
  }
}
// 线性模型 → 权重平均 ≡ 预测平均
if (!NO_SAVE) for (let k = 0; k < OUT_DIM; k++) {
  W[k].set(sumW[k].map((x) => x / SEEDS));
  B[k] = sumB[k] / SEEDS;
}

const meanOf = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
const sdOf = (arr) => (arr.length < 2 ? 0 : Math.sqrt(arr.reduce((s, x) => s + (x - meanOf(arr)) ** 2, 0) / (arr.length - 1)));
const perDim = (f) => [0, 1, 2].map((k) => seedMetrics.map((sm) => f(sm.m.dims[k])));
const corrSeed = perDim((d) => d.corr);
const spearSeed = perDim((d) => d.spearman);
const dirSeed = perDim((d) => d.dir);
const balSeed = perDim((d) => d.balAccMatched);
const mseSeed = seedMetrics.map((sm) => sm.m.mse);
// 每维各类召回：跨种子平均（null 表示该真实类样本为 0，跳过）
const recallSeed = [0, 1, 2].map((k) => [0, 1, 2].map((c) => {
  const vals = seedMetrics.map((sm) => sm.m.dims[k].recallMatched[c]).filter((x) => x !== null);
  return vals.length ? meanOf(vals) : null;
}));
const spreadSeed = [0, 1, 2].map((k) => meanOf(seedMetrics.map((sm) => sm.m.dims[k].predSpread)));
const corrMean = corrSeed.map(meanOf);
const corrSd = corrSeed.map(sdOf);
const r3 = (x) => Number(x.toFixed(3));

// 门限：**均值**过 minCorr 才允许注入；均值减一个标准差还过线才算"稳"（只报给人看）
const GATE = Number(argOf('--gate', 0.4)) || 0.4;
const usable = corrMean.map((c) => Math.abs(c) >= GATE);
const solid = corrMean.map((c, k) => Math.abs(c) - corrSd[k] >= GATE);

const round = (arr, n = 6) => Array.from(arr, (x) => Number(Number(x).toFixed(n)));
const payload = {
  version: 2,
  kind: 'sparse-linear-tfidf',
  trainedAt: new Date().toISOString(),
  samples: rows.length,
  labelsFile: path.relative(ROOT, LABELS).split(path.sep).join('/'),
  folds: FOLDS,
  seeds: SEEDS,
  ensemble: 'mean-weights',
  vocab: vocabList.map((v) => v.token),
  idf: round(Array.from(vocab.idf), 4),
  vocabSize: V,
  handDim: HAND_TOTAL,
  // 带上下文模式：特征排布是 [本句稀疏 V][上文稀疏 V][手写 HAND_TOTAL]，推理端要按这个比例还原
  context: CTX,
  ctxDim: CTX ? CTX_DIM : 0,
  outDim: OUT_DIM,
  W: W.map((row) => round(Array.from(row))),
  B: round(Array.from(B), 6),
  metrics: {
    // 全部是 out-of-fold 数字，且没有"挑轮次/挑配置"带来的乐观偏差
    oofMse: Number(meanOf(mseSeed).toFixed(5)),
    oofMseSd: Number(sdOf(mseSeed).toFixed(5)),
    baseMse: Number(baseM.mse.toFixed(5)),
    corr: corrMean.map(r3),
    corrSd: corrSd.map(r3),
    spearman: spearSeed.map((a) => r3(meanOf(a))),
    dir: dirSeed.map((a) => r3(meanOf(a))),
    balAccMatched: balSeed.map((a) => r3(meanOf(a))),
    balAccRaw: baseM.dims.map((d, k) => r3(meanOf(perDim((x) => x.balAccRaw)[k]))),
    plainAccMatched: baseM.dims.map((d, k) => r3(meanOf(perDim((x) => x.plainAccMatched)[k]))),
    majority: baseM.dims.map((d) => r3(d.majority)),
    recallMatched: recallSeed.map((row) => row.map((x) => (x === null ? null : r3(x)))),
    goldCls: baseM.dims.map((d) => d.goldCls),
    predSpread: spreadSeed.map(r3),
    epochsRun: EPOCHS,
    hyper: { lr: LR, batch: BATCH, l2: L2, epochs: EPOCHS, folds: FOLDS, seeds: SEEDS, minCount: MIN_COUNT, maxSize: MAX_SIZE, weightExtremes: WEIGHT_EXTREMES, only: ONLY, fraction: FRACTION },
    gate: GATE,
    usable,
    // 均值减一个标准差仍过线 → "稳"；只有稳的维度才值得长期依赖
    solid,
  },
};
if (NO_SAVE) {
  console.log('\n（--no-save：只报指标，没写权重、也没在全体数据上重训）');
} else {
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');
}
console.log(`\n【${SEEDS} 种子交叉验证${FRACTION < 1 ? `，只用 ${(FRACTION * 100).toFixed(0)}% 训练数据` : ''}】相关 v/a/d   = ${corrMean.map((c, k) => c.toFixed(3) + '±' + corrSd[k].toFixed(3)).join(' / ')}`);
console.log(`【${SEEDS} 种子交叉验证】排序相关     = ${spearSeed.map((a) => r3(meanOf(a)).toFixed(3)).join(' / ')}`);
console.log(`【${SEEDS} 种子交叉验证】方向一致率   = ${dirSeed.map((a) => pct(meanOf(a))).join(' / ')}`);
console.log(`【${SEEDS} 种子交叉验证】平衡准确(切档) = ${balSeed.map((a) => pct(meanOf(a))).join(' / ')}（瞎猜 33.3%）`);
console.log(`【${SEEDS} 种子交叉验证】普通准确(切档) = ${baseM.dims.map((d, k) => pct(meanOf(perDim((x) => x.plainAccMatched)[k]))).join(' / ')}（全猜多数类 ${baseM.dims.map((d) => pct(d.majority)).join(' / ')}）`);
console.log(`【${SEEDS} 种子交叉验证】v 维各类召回 = ${recallSeed[0].map((r, i) => ['负', '中', '正'][i] + ' ' + (r === null ? '—' : pct(r))).join(' / ')}（真实类样本 ${baseM.dims[0].goldCls.join('/')}）`);
console.log(`【${SEEDS} 种子交叉验证】MSE ${meanOf(mseSeed).toFixed(4)}±${sdOf(mseSeed).toFixed(4)}（全零基线 ${baseM.mse.toFixed(4)}）｜预测值 RMS ${spreadSeed.map((x) => x.toFixed(2)).join('/')}`);
console.log(`\n过线判定（|相关| ≥ ${GATE}）：${corrMean.map((c, k) => `${'vad'[k]} ${c.toFixed(3)}${usable[k] ? ' 过线' : ' 没过'}${solid[k] ? '（均值-1sd 也过线，稳）' : ''}`).join('｜')}`);
if (!NO_SAVE) console.log(`权重写入 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)}KB，词表 ${V}，${SEEDS} 种子权重平均）`);
