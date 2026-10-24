/**
 * 情感网络（在线推理部分）：纯 JS、零依赖、确定性、无随机。
 *
 * 分工：
 *   - **语义映射**（文本 → PAD）由一个**离线训练**的最简神经网络负责，权重在
 *     `state/emotion-weights.json`（由 `scripts/train-emotion-net.mjs` 用 LLM 标注的数据训练出来）。
 *     模型 = 单线性层 + clamp，输入 = **本群词表的稀疏 tf-idf**（约 3000 维）+ 12 维手写特征。
 *     稀疏前向只累加非零项（实测 ~100µs/条，0 网络调用）。
 *   - **时间动力学**（惯性 + 衰减）在本地用可读参数算：指数衰减 `0.5^(Δt/半衰期)` + 每次刺激的增益。
 *     两者分开是为了"行为可解释、可回归"——情绪变了能说清是哪一步造成的。
 *
 * 安全约定（都是踩过的坑）：
 *   1. 权重缺失/损坏/维度对不上/是旧格式 → **整个模块静默变中性**（不注入任何东西），坚决不退化成随机输出；
 *   2. 只有训练时**相关系数过线**的维度才允许注入（v/a/d 分开判定），没学会的维度不许编；
 *   3. 中性不注入（省 token）；
 *   4. 注入的是**弱倾向**、并明说"可以忽略，别硬演"；
 *   5. 从磁盘读回的状态必须消毒（NaN / 越界 / 脏键）。
 */

import fs from 'node:fs';

import { HAND_DIM, CTX_DIM, extractSparse, denseFeatures, contextFeatures } from './emotion-features.js';

const DEF = {
  // 情绪半衰期：3 小时（2026-10-14 从 1h 调长）。
  // 理由：真人被气到/被逗笑，**半天都带着那个底色**，1 小时就淡掉太快了 ——
  // 她那句"以后少端着"之后如果 1 小时就恢复原样，人会察觉"她切换得太干脆"。
  // 3h 大致是"当天那个劲儿"的量级；再长会堆（多次刺激叠着不散），就不像了。
  halfLifeMs: 3 * 60 * 60 * 1000,
  gain: 0.35,                   // 每次刺激把情绪推动多少（0~1）
  neutralThreshold: 0.18,       // 各维度绝对值都低于它 → 视为中性，不注入
  maxChars: 120,                // 注入行长度上限（token 预算）
  minCorr: 0.4,                 // 训练时相关系数低于它 → 该维度不注入
  // ★ 静息基线（**这两个数是量出来的，不是猜的**）：模型在 3297 条真实语料上的**预测均值**。
  //   为什么必须有它（2026-09-30 实测）：模型输出带**正的常数偏移**（v +0.046、a +0.277），而偏移
  //   **不会衰减** → pad 一路往上限爬，最后顶死在 1.00。实测后果：124 次变化里 98% 都在注入、
  //   a 饱和 71%、负向**一次都没出现过**，注入永远是同一句「心情不错；话会比平时多一点」——
  //   等于挂了个常量提示，信息量为 0（而且一直在推她"多说点"）。
  //   减掉偏移后（完整语料重放）：注入 96%→35%、负向 0%→9%、饱和 59%→0%、语气组合 3→7 种。
  baseline: null,               // [v,a,d] 或 {v,a,d}；null/缺省 = 不减（旧行为）
};

let opt = { ...DEF };
let weights = null;             // { W, B, V, vocab:{map,idf,size}, usable, corr, metrics, mtimeMs }
let weightsPath = '';
let loadError = null;           // 上一次加载失败的原因（给自检/控制台看，不刷日志）

/** 归一化基线：只接受数字，别的当 0（脏配置不许悄悄改变行为） */
function normalizeBaseline(raw) {
  if (!raw) return [0, 0, 0];
  const at = (k) => {
    const v = Array.isArray(raw) ? raw[k] : raw?.['vad'[k]];
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  };
  return [at(0), at(1), at(2)];
}

/** 桥接启动时注入配置与权重路径。 */
export function configure({ weightsPath: p, ...rest } = {}) {
  opt = { ...DEF, ...rest };
  opt.baseline = normalizeBaseline(opt.baseline);
  if (p) weightsPath = p;
  weights = null;               // 强制重新加载
  loadError = null;
  return { ...opt, weightsPath };
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ⚠️ 必须是**真数字**：Number(null) === 0 会把坏权重悄悄变成 0，看着能跑其实是错的。
const strictNum = (x) => typeof x === 'number' && Number.isFinite(x);
const strictNums = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every(strictNum);

/**
 * 读权重（带 mtime 缓存）。任何异常/格式不符 → null（模块变中性）。
 * 只认 v2 稀疏格式；旧版 char-gram MLP 的权重会被明确拒绝（loadError 记原因）。
 */
function loadWeights() {
  if (!weightsPath) { loadError = 'no-weights-path'; return null; }
  let st;
  try { st = fs.statSync(weightsPath); } catch { loadError = 'missing-file'; return null; }
  if (weights && weights.mtimeMs === st.mtimeMs) return weights;
  try {
    const raw = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
    if (raw?.kind !== 'sparse-linear-tfidf') { loadError = `wrong-kind:${raw?.kind ?? 'none'}`; return null; }
    const vocabList = Array.isArray(raw.vocab) ? raw.vocab : null;
    if (!vocabList?.length || !vocabList.every((t) => typeof t === 'string' && t.length)) { loadError = 'bad-vocab'; return null; }
    const V = vocabList.length;
    // 带上下文模式：特征排布 [本句稀疏 V][上文稀疏 V][手写 HAND_DIM + CTX_DIM]
    const ctx = raw.context === true;
    const handDim = HAND_DIM + (ctx ? CTX_DIM : 0);
    const inDim = (ctx ? 2 : 1) * V + handDim;
    if (Number(raw.handDim) !== handDim || Number(raw.vocabSize) !== V) { loadError = 'dim-mismatch'; return null; }
    if (ctx && Number(raw.ctxDim) !== CTX_DIM) { loadError = 'dim-mismatch'; return null; }
    if (!Array.isArray(raw.W) || raw.W.length !== 3 || !raw.W.every((row) => Array.isArray(row) && row.length === inDim && row.every(strictNum))) {
      loadError = 'bad-W'; return null;
    }
    if (!strictNums(raw.B) || raw.B.length !== 3) { loadError = 'bad-B'; return null; }
    // idf 允许缺失（退化成全 1，等于纯 tf）；给了就必须同长
    let idf;
    if (raw.idf === undefined || raw.idf === null) idf = new Float64Array(V).fill(1);
    else if (Array.isArray(raw.idf) && raw.idf.length === V && raw.idf.every(strictNum)) idf = Float64Array.from(raw.idf);
    else { loadError = 'bad-idf'; return null; }

    const map = new Map();
    for (let i = 0; i < V; i++) map.set(vocabList[i], i);
    const corr = Array.isArray(raw.metrics?.corr) ? raw.metrics.corr.map((c) => num(c, 0)) : [0, 0, 0];
    while (corr.length < 3) corr.push(0);
    const usable = Array.isArray(raw.metrics?.usable)
      ? raw.metrics.usable.map(Boolean)
      : corr.map((c) => Math.abs(c) >= opt.minCorr);
    while (usable.length < 3) usable.push(false);
    weights = {
      W: raw.W.map((row) => Float64Array.from(row)),
      B: Float64Array.from(raw.B),
      V, inDim, handDim, ctx,
      vocab: { map, idf, size: V },
      usable,
      corr,
      metrics: raw.metrics ?? null,
      mtimeMs: st.mtimeMs,
      trainedAt: raw.trainedAt ?? null,
      samples: raw.samples ?? null,
    };
    loadError = null;
    return weights;
  } catch (err) {
    loadError = `parse-fail:${err?.message ?? 'unknown'}`;
    return null;
  }
}

/** 权重/训练指标（给控制台和自检看）。 */
export function weightsInfo() {
  const w = loadWeights();
  if (!w) return { loaded: false, weightsPath, error: loadError, note: '没有可用权重 → 情感模块保持中性（不注入）' };
  return {
    loaded: true, weightsPath, kind: 'sparse-linear-tfidf',
    vocabSize: w.V, handDim: w.handDim, inDim: w.inDim, hidden: 0, context: !!w.ctx,
    corr: w.corr, usable: w.usable,
    metrics: w.metrics ? {
      oofMse: w.metrics.oofMse, baseMse: w.metrics.baseMse,
      spearman: w.metrics.spearman, dir: w.metrics.dir,
      balAccMatched: w.metrics.balAccMatched, majority: w.metrics.majority,
      splits: w.metrics.splits ?? w.metrics.folds,
    } : null,
    trainedAt: w.trainedAt, samples: w.samples,
  };
}

const clamp1 = (x) => Math.max(-1, Math.min(1, x));

/**
 * 文本 → PAD 刺激。没有权重就返回中性（**绝不返回随机值**）。
 *
 * ★ 返回值已经**减掉静息基线**（`opt.baseline`）：中性消息应当给出 ≈0 的刺激，
 *   否则那个正的常数偏移会一路把情绪推向上限（见 DEF.baseline 的注释）。
 * @param {string} text 本句
 * @param {string} [prevText] 上文（同群紧邻的前一句；只有带上下文的权重会用到）
 * @returns {{v:number,a:number,d:number,usedDims:number[]}}
 */
export function scoreText(text, prevText = '') {
  const w = loadWeights();
  if (!w) return { v: 0, a: 0, d: 0, usedDims: [] };
  const { idx, val } = extractSparse(text, w.vocab);
  const pv = w.ctx ? extractSparse(prevText, w.vocab) : null;
  const dense = denseFeatures(text);
  const ctxF = w.ctx ? contextFeatures(prevText) : null;
  const handOff = w.ctx ? 2 * w.V : w.V;
  const base = Array.isArray(opt.baseline) ? opt.baseline : [0, 0, 0];
  const out = [0, 0, 0];
  const usedDims = [];
  for (let k = 0; k < 3; k++) {
    const Wk = w.W[k];
    let s = w.B[k];
    for (let j = 0; j < idx.length; j++) s += Wk[idx[j]] * val[j];
    if (pv) for (let j = 0; j < pv.idx.length; j++) s += Wk[w.V + pv.idx[j]] * pv.val[j];
    for (let d = 0; d < w.handDim; d++) s += Wk[handOff + d] * (d < HAND_DIM ? dense[d] : ctxF[d - HAND_DIM]);
    out[k] = w.usable[k] ? clamp1(s - (Number(base[k]) || 0)) : 0;   // 没学会的维度一律 0，不许编
    if (w.usable[k]) usedDims.push(k);
  }
  return { v: out[0], a: out[1], d: out[2], usedDims };
}

/**
 * 短句降权系数（2026-10-23）：词袋线性模型对 2~3 字的句子最不准（只有一两个 token），
 * 判错代价却和长句一样大 —— 实测「没招」v=-0.42，而它在训练集里就被标成 -0.4：
 * 模型没错，是"群友抱怨"的语境被套到了"他对她说"。
 * **不是按长度一刀切**：笑（哈哈）/夸（屌）/骂（滚）的信息就在那个词里，短也不降；
 * 纯标点（"？""！"）没有信息 → 0（不给刺激）；其余 1~3 字 → 0.5。
 */
export function shortTextScale(text) {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  if (/^[\s?？!！.。…~～]+$/.test(t)) return 0;                 // 纯标点：没信息
  if (/(哈哈|嘿嘿|嘻嘻|笑死|绷|233|hhh|www|厉害|牛|nb|强|赞|好耶|可爱|谢谢|喜欢|爱|傻|笨|滚|菜|垃圾|废物|屎)/i.test(t)) return 1;
  const n = [...t].length;
  return n <= 3 ? 0.5 : 1;
}

/**
 * 调侃降权（2026-10-23 管理员："我说笨蛋只是调侃一下啊，怎么这就惹她生气了"）。
 * 「笨蛋/傻瓜/傻子」这类词在**打情骂俏**和**真吵架**里都出现，词袋模型分不清 ——
 * 实测「笨蛋程莫雯」把她的 v 压下去 0.17。所以含这些词时刺激只算 0.3：
 * 真吵架还有脏话/长句/连发这些信号兜底，不靠这一个词。
 */
export function teaseScale(text) {
  return /(笨蛋|傻瓜|小笨蛋|傻子|蠢货|呆子|坏蛋|臭家伙)/.test(String(text ?? '')) ? 0.3 : 1;
}

/** 消毒从磁盘读回的情绪状态。 */
export function sanitizeEmotion(raw) {  const now = Date.now();
  const pad = Array.isArray(raw?.pad) ? raw.pad : [];
  const p = [0, 1, 2].map((i) => {
    const v = Number(pad[i]);
    return Number.isFinite(v) ? clamp1(v) : 0;
  });
  const at = Number(raw?.updatedAt);
  return {
    pad: p,
    updatedAt: Number.isFinite(at) && at > 0 && at <= now + 60000 ? at : now,
    lastEvent: typeof raw?.lastEvent === 'string' ? raw.lastEvent.slice(0, 40) : null,
  };
}

/** 指数衰减到"现在"。**会推进 updatedAt**（这样反复调用也不会重复衰减）。 */
export function applyDecay(emotion, now = Date.now()) {
  const e = sanitizeEmotion(emotion ?? {});
  const dt = Math.max(0, now - e.updatedAt);
  const factor = Math.pow(0.5, dt / Math.max(60000, opt.halfLifeMs));
  return {
    pad: e.pad.map((v) => clamp1(v * factor)),
    updatedAt: now,
    lastEvent: e.lastEvent,
  };
}

/**
 * 收到刺激/事件后的状态更新：先按时间衰减，再往刺激方向推 gain。
 * @param {object} emotion 当前状态（可含 pad/updatedAt）
 * @param {{v:number,a:number,d:number}} stim 文本刺激
 * @param {{name?:string,v?:number,a?:number,d?:number}|null} event 事件信号（被夸/被骂/被禁言/发送失败…）
 */
export function updateEmotion(emotion, stim, event = null, now = Date.now()) {
  const e = applyDecay(emotion, now);
  const s = { v: num(stim?.v, 0), a: num(stim?.a, 0), d: num(stim?.d, 0) };
  const g = Math.max(0, Math.min(1, num(opt.gain, DEF.gain)));
  const pad = [
    clamp1(e.pad[0] + g * (s.v + num(event?.v, 0))),
    clamp1(e.pad[1] + g * (s.a + num(event?.a, 0))),
    clamp1(e.pad[2] + g * (s.d + num(event?.d, 0))),
  ];
  return { pad, updatedAt: now, lastEvent: event?.name ? String(event.name).slice(0, 40) : e.lastEvent };
}

/**
 * 注入用的**弱**语气行。中性 / 无权重 / 不可用维度 → 返回空串（不注入）。
 */
export function buildEmotionLine(emotion, now = Date.now()) {
  const w = loadWeights();
  if (!w) return '';
  const e = applyDecay(emotion ?? {}, now);
  const [v, a, d] = e.pad;
  const th = num(opt.neutralThreshold, DEF.neutralThreshold);
  if (Math.abs(v) < th && Math.abs(a) < th && Math.abs(d) < th) return '';

  const bits = [];
  if (w.usable[0]) {
    if (v > th) bits.push('心情不错');
    else if (v < -th) bits.push('有点烦');
  }
  if (w.usable[1]) {
    if (a > th) bits.push('话会比平时多一点/急一点');
    else if (a < -th) bits.push('有点懒得打字');
  }
  if (w.usable[2]) {
    if (d > th) bits.push('说话有底气');
    else if (d < -th) bits.push('不太想主导话题');
  }
  if (!bits.length) return '';
  // ★ 2026-10-14：把"情绪"和"怎么表达"解耦（管理员指出的方向）。
  //   原来只有一句自然语言的"语气倾向"，还写着"可以忽略，别硬演" —— 那是**软约束**，
  //   她照不照做全看心情，表现就是"情绪挺到位，但是演出来的"。
  //   现在补一层**结构化表达姿态**（长度/追问/温度），从 PAD 硬映射出来：
  //   PAD 决定"能说什么、说多长、要不要追问"，她不参与这个判断。
  const posture = [];
  // 长度由"唤醒度低"**或**"效价低"决定 —— 沮丧/低落时话也会变短，
  // 不只是"懒得打字"那种（第一版只看 a，导致"沮丧+没底气"被判成正常长度）。
  const lowEnergy = (w.usable[1] && a < -th) || (w.usable[0] && v < -th && (!w.usable[1] || a < th));
  if (lowEnergy) posture.push('句子很短：一条不超过 8 个字，能不补就不补');
  else if (w.usable[1] && a > th) posture.push('句子短，但可以多发一两条（有点急）');
  else posture.push('正常长度，跟平时一样');
  if (w.usable[0] && v < -th && (!w.usable[2] || d <= 0)) posture.push('这一轮先别追问他，等他想说');
  else if (w.usable[1] && a > th) posture.push('可以追问一句');
  if (w.usable[0] && v < -th) posture.push('冷一点：少用"呀/啦/嘛"，少用感叹号');
  else if (w.usable[0] && v > th) posture.push('暖一点：可以有语气词');
  // ⚠️ 原来这里写的是「（这是倾向，可以忽略，别硬演。）」—— 那句把一个**硬指标**降级成了
  //    "建议"，等于给她否决权。姿态是从 PAD 算出来的客观状态，不该让她随意否掉。
  //    （2026-10-14 管理员指出的方向：情绪与表达解耦、用结构化参数框定行为空间。）
  const line = `【语气倾向】${bits.join('；')}`
    + `\n【表达姿态】（照它来，别反着来）${posture.join('｜')}`;
  return opt.maxChars > 0 && line.length > opt.maxChars ? line.slice(0, opt.maxChars) : line;
}

/** 给测试/自检用：当前生效的参数。 */
export function currentOptions() {
  return { ...opt, weightsPath, loadError };
}
