/**
 * 情感网络的特征：**词级稀疏 tf-idf**（2026-09-30 第二轮）。
 *
 * 为什么换掉第一版的 char-gram 哈希：老师的判断其实很"词汇化"（屎/菜/屌/谢谢/亲亲），
 * 而 char 1~3 gram 挤进固定桶后区分度差、还互相碰撞 —— 第一版验证集相关只有 0.29/0.31/0.39。
 * 这一版：
 *   ① **词表来自本群自己的语料**（1~4 字 n-gram 里出现 ≥ minCount 的），不是通用分词，
 *      这样"老板/兔兔/涩涩/奶妈"这类群内说法天然在内；
 *   ② tf-idf 加权 + L2 归一化，交给一个**线性层**（最简神经网络）去学；
 *   ③ 另加 12 维手写特征（长度/标点/emoji/引用/人称…），与稀疏特征拼在一起。
 *
 * 训练与推理**共用这一份**（特征漂移 = 权重全废，这条踩过）。纯计算、无依赖、确定性。
 */

export const HAND_DIM = 12;
// 带上下文模式额外的手写特征维度（上文的性质：在骂人 / 在夸人 / 是个问句）
export const CTX_DIM = 3;
// 词表超参（训练时用；推理时从权重文件里读回来）
export const VOCAB_DEFAULTS = { minCount: 3, maxLen: 4, maxSize: 6000 };

const EMOJI = /\p{Extended_Pictographic}/u;
const LAUGH = /(哈哈|嘿嘿|嘻嘻|笑死|绷|233|hhh|www)/i;
const INSULT = /(傻|笨|滚|菜|垃圾|废物|屎)/;
const PRAISE = /(厉害|牛|nb|强|赞|好耶|可爱|谢谢|喜欢|爱)/;
const SOFT = /(吗|吧|呢|呀|嘛|哦|喵)\s*$/;
const KANA = /[\u3041-\u309f\u30a1-\u30fa]/;

/** 归一化文本（标点统一、压空白、小写） */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/！/g, '!').replace(/？/g, '?').replace(/[，、]/g, ',')
    .trim();
}

/** 12 维手写特征（不做哈希，直接进模型） */
export function denseFeatures(text) {
  const t = normalizeText(text);
  const len = [...t].length;
  return Float64Array.from([
    Math.min(1, len / 30),
    /!/.test(t) ? 1 : 0,
    /\?/.test(t) ? 1 : 0,
    /(.)\1{2,}/u.test(t) ? 1 : 0,
    EMOJI.test(t) ? 1 : 0,
    KANA.test(t) ? 1 : 0,
    LAUGH.test(t) ? 1 : 0,
    INSULT.test(t) ? 1 : 0,
    PRAISE.test(t) ? 1 : 0,
    SOFT.test(t) ? 1 : 0,
    /^@/.test(t) ? 1 : 0,
    /^\[引用/.test(t) ? 1 : 0,
  ]);
}

/** 带上下文模式用的 3 维"上文性质"特征（没有上文 → 全 0） */
export function contextFeatures(prev) {
  const t = normalizeText(prev);
  if (!t) return Float64Array.from([0, 0, 0]);
  return Float64Array.from([
    INSULT.test(t) ? 1 : 0,
    PRAISE.test(t) ? 1 : 0,
    /\?/.test(t) ? 1 : 0,
  ]);
}

/** 统计词表：语料里出现 ≥ minCount 的 1~maxLen 字片段；频次降序、同频次长词优先 */
export function buildVocab(texts, { minCount = 3, maxLen = 4, maxSize = 6000 } = {}) {
  const counter = new Map();
  for (const raw of texts) {
    const t = normalizeText(raw);
    for (let n = 1; n <= maxLen; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const g = t.slice(i, i + n);
        if (n === 1 && /[\s,!?]/.test(g)) continue;   // 单字标点没意义
        counter.set(g, (counter.get(g) ?? 0) + 1);
      }
    }
  }
  return [...counter.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => (b.count - a.count) || (b.token.length - a.token.length) || a.token.localeCompare(b.token))
    .slice(0, maxSize);
}

/** 词表 → { map, idf, size }（idf 用文档频率：ln((1+N)/(1+df)) + 1） */
export function makeVocabIndex(vocabList, docs, maxLen = 4) {
  const map = new Map();
  vocabList.forEach(({ token }, i) => map.set(token, i));
  const df = new Int32Array(vocabList.length);
  for (const raw of docs) {
    const t = normalizeText(raw);
    const seen = new Set();
    for (let n = 1; n <= maxLen; n++) {
      for (let i = 0; i + n <= t.length; i++) {
        const idx = map.get(t.slice(i, i + n));
        if (idx !== undefined) seen.add(idx);
      }
    }
    for (const idx of seen) df[idx] += 1;
  }
  const N = Math.max(1, docs.length);
  const idf = new Float64Array(vocabList.length);
  for (let i = 0; i < vocabList.length; i++) idf[i] = Math.log((1 + N) / (1 + df[i])) + 1;
  return { map, idf, size: vocabList.length };
}

/**
 * 稀疏特征：{ idx, val }（tf-idf，已 L2 归一化）。
 * 匹配方式是"词表驱动的所有 1~4 字子串"——简单、可复现，长短词都会计入。
 */
export function extractSparse(text, vocab, maxLen = 4) {
  const map = vocab?.map;
  if (!map || !map.size) return { idx: new Int32Array(0), val: new Float64Array(0) };
  const t = normalizeText(text);
  const tf = new Map();
  for (let n = 1; n <= maxLen; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const idx = map.get(t.slice(i, i + n));
      if (idx === undefined) continue;
      tf.set(idx, (tf.get(idx) ?? 0) + 1 / n);      // 短片段权重略高
    }
  }
  const idx = new Int32Array(tf.size);
  const val = new Float64Array(tf.size);
  let k = 0;
  let norm = 0;
  for (const [i, count] of [...tf.entries()].sort((a, b) => a[0] - b[0])) {
    const v = (1 + Math.log(count)) * (vocab.idf?.[i] ?? 1);
    idx[k] = i; val[k] = v; norm += v * v; k++;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < k; i++) val[i] /= norm;
  return { idx, val };
}

/** 合并成稠密向量（尺寸 = 词表 + 手写）——只给测试/调试用，训练走稀疏路径 */
export function featurize(text, vocab, maxLen = 4) {
  const { idx, val } = extractSparse(text, vocab, maxLen);
  const size = (vocab?.size ?? 0) + HAND_DIM;
  const out = new Float64Array(size);
  for (let i = 0; i < idx.length; i++) out[idx[i]] = val[i];
  const dense = denseFeatures(text);
  for (let i = 0; i < HAND_DIM; i++) out[(vocab?.size ?? 0) + i] = dense[i];
  return out;
}
