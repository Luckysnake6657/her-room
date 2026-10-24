/**
 * 情绪余波（AffectResidue，2026-10-14）。
 *
 * 问题：她的 PAD 是**每个会话一份**（`st.emotion`）—— 群里被怼了，切到私聊
 * **立刻恢复原样**，等于"换个屋子就失忆"。真人是**一个情绪**：一件事影响一整天。
 *
 * 做法：把每个会话的情绪沉淀成一份**跨会话的余波**，生成"语气行"时**混一点进来**当底色。
 *
 * 三个分寸（都照实测调的）：
 *   1. **只当背景，不主导** —— 权重 0.3，超过就变成"私聊时莫名情绪化"；
 *   2. **只取"别的会话"的余波** —— 否则本会话刚更新的会被自己再吃一遍，等于把情绪翻倍；
 *   3. **衰减比会话内慢** —— 会话内 3 小时半衰，余波 6 小时：余波是"今天这个劲儿"，比"刚才那句话"留得久。
 *
 * 纯逻辑在这里（存读盘由桥接做），方便离线测。
 */

/** 余波在最终 PAD 里占的权重（0~1）。0.3 = "带一点底色，但压不过当前情绪"。 */
export const RESIDUE_WEIGHT = 0.3;

/** 余波半衰期：6 小时（比会话内的 3 小时慢一倍 —— "今天这个劲"，不是"刚才那句话"）。 */
export const RESIDUE_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

/** 沉淀时的融合系数：新情绪只占 35%，避免一次小波动就把底色冲掉。 */
export const RESIDUE_BLEND = 0.35;

/** 低于这个强度就不值得记（|v| 和 |a| 都太小 = 中性，记了也是噪声）。 */
export const RESIDUE_MIN_STRENGTH = 0.12;

const clamp1 = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

/** 强度：取效价和唤醒度里更明显的那个。 */
export function residueStrength(pad) {
  const v = Math.abs(clamp1(pad?.[0]));
  const a = Math.abs(clamp1(pad?.[1]));
  return Math.max(v, a);
}

/** 一次情绪波动值不值得沉淀成余波。 */
export function shouldDeposit(pad, { minStrength = RESIDUE_MIN_STRENGTH } = {}) {
  return residueStrength(pad) >= minStrength;
}

/** 按时间衰减一份余波。 */
export function decayResidue(entry, now = Date.now(), halfLifeMs = RESIDUE_HALF_LIFE_MS) {
  const dt = Math.max(0, now - Number(entry?.updatedAt ?? now));
  const factor = Math.pow(0.5, dt / Math.max(60000, halfLifeMs));
  const pad = Array.isArray(entry?.pad) ? entry.pad : [0, 0, 0];
  return pad.map((x) => clamp1(x * factor));
}

/**
 * 把这次的情绪融进余波（慢融合，不是覆盖）。
 * 返回新的 `{ pad, updatedAt }`。
 */
export function blendResidue(previous, pad, now = Date.now(), blend = RESIDUE_BLEND) {
  const prev = decayResidue(previous, now).slice();
  const next = [0, 1, 2].map((i) => clamp1(prev[i] * (1 - blend) + clamp1(pad?.[i]) * blend));
  return { pad: next, updatedAt: now };
}

/**
 * 除自己以外、所有会话的余波**平均**（各自先按时间衰减）。
 * 为什么要排除自己：本会话刚更新的 PAD 已经体现在 `st.emotion` 里了，
 * 余波里再吃一遍等于把同一份情绪算两次。
 */
export function othersResidue(sessions, selfKey, now = Date.now(), halfLifeMs = RESIDUE_HALF_LIFE_MS) {
  const entries = Object.entries(sessions ?? {}).filter(([k]) => k !== selfKey);
  if (!entries.length) return [0, 0, 0];
  const decayed = entries.map(([, e]) => decayResidue(e, now, halfLifeMs));
  return [0, 1, 2].map((i) => clamp1(decayed.reduce((sum, p) => sum + p[i], 0) / decayed.length));
}

/** 把会话 PAD 和外部余波合成"最终 PAD"。 */
export function mixPad(pad, residue, weight = RESIDUE_WEIGHT) {
  const w = Math.max(0, Math.min(1, Number(weight) || 0));
  const r = [0, 1, 2].map((i) => clamp1(residue?.[i]));
  // ★ **没有余波时原样返回**。第一版直接把 base 乘 (1-w) —— 于是"别的会话没情绪"时
  //   当前会话的情绪也被打 0.7 折，等于所有情绪都被无端减弱。
  //   test-emotion 一次挂了 5 条（语气行被压到阈值下、不再注入）就是它。
  if (w === 0 || r.every((x) => x === 0)) return [0, 1, 2].map((i) => clamp1(pad?.[i]));
  return [0, 1, 2].map((i) => {
    const base = clamp1(pad?.[i]);
    const mixed = clamp1(base * (1 - w) + clamp1(residue?.[i]) * w);
    // ★ 余波只当"底色"，**不许把当前情绪的符号翻过来**（别把"有点开心"变成"有点难过"）。
    //   翻面时只允许"减弱到一半" —— 这样群里的坏心情能压暗私聊里的好心情，
    //   但不会让她的情绪凭空反号（那看着就像"情绪错乱"）。
    if (base !== 0 && mixed !== 0 && Math.sign(mixed) !== Math.sign(base)) return clamp1(base * 0.5);
    return mixed;
  });
}

/** 解析落盘的余波文件（宽容：坏数据当空）。 */
export function parseResidueStore(text) {
  try {
    const o = JSON.parse(String(text ?? '') || '{}');
    const sessions = {};
    for (const [k, v] of Object.entries(o?.sessions ?? {})) {
      if (!Array.isArray(v?.pad) || v.pad.length !== 3) continue;
      sessions[k] = { pad: v.pad.map(clamp1), updatedAt: Number(v.updatedAt) || 0 };
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

/** 余波文件最多留几个会话（按最近更新）。 */
export function trimResidueStore(store, max = 40) {
  const entries = Object.entries(store?.sessions ?? {});
  if (entries.length <= max) return store;
  const keep = entries.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0)).slice(0, max);
  return { sessions: Object.fromEntries(keep) };
}
