/**
 * 记忆的"衰退曲线"与时间标签（2026-10-01）。
 *
 * ## 起因（管理员截图："她都记忆紊乱了"）
 * 她 10/1 13:46 说「**早上那集**无职你补了没」，接着又断言「**你自己说的**中午看一集，让我看完整跟你聊」。
 * 查记忆库发现真相应有尽有 —— 那是 **9/29**（两天前）的两条：
 * ```
 * [normal] 9/29 09:36  中午看一集《无职转生》，看完跟他说感想（他之前让我中午看，我还没看）
 * [high]   9/29 12:13  ★答应他：中午这集《无职转生》看好之后跟他说一声… 待追问：这集无职看下来的感受
 * ```
 * 三个问题叠加：
 *   ① **时间标签等于没有**：注入时写的是 `（3120分钟前）` —— 分钟数不封顶，模型读不出"这是两天前"；
 *   ② **排序靠 importance 硬压**：`high` 直接 +200 分，一条两天前的 high 压过所有新鲜事，
 *      而"新鲜度"只是 <1h +30 / <6h +15 / >24h −10 的台阶，衰减根本不是曲线；
 *   ③ **过期的"待追问"照旧注入**：那条 high 的 pendingQuestion（"这集无职看下来的感受"）两天了还挂着，
 *      于是她把两天前的待办当成今天的任务，还说成是"你自己说的"。
 *
 * ## 这里给什么
 * - `memoryDecayScore(entry, now)`：`分数 = 重要性权重 × 0.5^(年龄/半衰期)`（真正的指数衰退），
 *   待追问/待办**单独用更短的半衰期**（它是"现在要做的事"，两天前就该作废）。
 * - `humanAgo(ms, now)`：人能读的年龄（刚刚 / 12分钟前 / 3小时前 / 2天前 / 9/28 15:02）。
 * - `isStale(entry, now)`：超过"新鲜窗口"就值得提醒她"可能已过时"。
 *
 * 纯函数、无依赖、可离线验证（见 scripts/test-memory-decay.mjs）。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const MEMORY_DECAY = {
  /** 半衰期：越重要衰减越慢（不是"永不过期"，只是慢） */
  halfLifeMs: {
    low: 12 * HOUR,          // 随口一提：半天淡一半
    normal: 48 * HOUR,       // 默认：两天淡一半
    high: 21 * 24 * HOUR,    // 约定/承诺：三周淡一半
  },
  /** 重要性权重（**故意压得比较平**：避免一条两天前的 high 压死所有新鲜事） */
  weight: { low: 1, normal: 2, high: 3 },
  /** 待追问/待办：它代表"现在该做的事"，半衰期很短 */
  pendingHalfLifeMs: 6 * HOUR,
  pendingWeight: 3,
  /** 超过这个年龄 → 标签里加"可能已过时"（按重要性分档） */
  staleAfterMs: {
    low: 3 * HOUR,
    normal: 24 * HOUR,
    high: 7 * 24 * HOUR,
  },
  /** 衰减到这个分数以下就不注入了（**仍然留在库里**，也能 qq_memory_query 搜到） */
  minInjectScore: 0.04,
  /** 排序时给"已过时"打个折：过时的往后排（但**不丢**）——
   *  为什么需要：一条两天前的 ★high（承诺）分数 2.8，会排在刚刚发生的普通事（2.0）前面，
   *  于是她每轮先读到的是旧事（正是"把两天前当今天"的温床）。打 6 折后新鲜事优先，
   *  而"过时的 high"仍然排在"过时的 normal"前面（重要性没被抹掉）。 */
  stalePenalty: 0.6,
};

export function normalizeImportance(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'low' || v === 'high' ? v : 'normal';
}

export function memoryHalfLifeMs(importance) {
  return MEMORY_DECAY.halfLifeMs[normalizeImportance(importance)];
}

/** 指数衰退系数：0.5^(年龄/半衰期)。年龄缺失或为 0 → 1（当作"刚刚"，宁可高估新鲜度也别误删） */
export function decayFactor(ageMs, halfLifeMs) {
  const hl = Number(halfLifeMs);
  if (!Number.isFinite(hl) || hl <= 0) return 1;
  const age = Number(ageMs);
  if (!Number.isFinite(age) || age <= 0) return 1;
  return Math.pow(0.5, age / hl);
}

/** 记忆条目的"最后被提起"时间：优先 lastMentionAt，其次 at/createdAt */
export function memoryLastAt(entry) {
  const e = entry ?? {};
  const t = Number(e.lastMentionAt) || Number(e.at) || Number(e.createdAt) || 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * 记忆打分：重要性权重 × 衰退系数（+ 待追问的短期加成）。
 * @returns {{score:number, decay:number, ageMs:number, stale:boolean, pendingScore:number}}
 */
export function memoryDecayScore(entry, now = Date.now()) {
  const e = entry ?? {};
  const importance = normalizeImportance(e.importance);
  const lastAt = memoryLastAt(e);
  const ageMs = lastAt ? Math.max(0, now - lastAt) : 0;
  const decay = decayFactor(ageMs, MEMORY_DECAY.halfLifeMs[importance]);
  // ⚠️ 别在这里放"可选乘数"：写过一个 `Number(e.pendingFresh) ?? 1`，
  //    而 `Number(undefined)` 是 NaN、`NaN ?? 1` 还是 NaN → 分数变 NaN →
  //    **任何带待追问的记忆都被静默丢掉**（用例当场抓到）。要么算得出来，要么算 0/1，别留 NaN 的口子。
  const pendingDecay = e.pendingQuestion ? decayFactor(ageMs, MEMORY_DECAY.pendingHalfLifeMs) : 0;
  const pendingScore = pendingDecay * MEMORY_DECAY.pendingWeight;
  const score = MEMORY_DECAY.weight[importance] * decay + pendingScore;
  const staleAfter = MEMORY_DECAY.staleAfterMs[importance];
  return {
    score,
    decay,
    ageMs,
    stale: !!lastAt && ageMs > staleAfter,
    pendingScore,
    lastAt,
    importance,
  };
}

/** 该不该把这条注入提示词（衰退到 minInjectScore 以下就不占了，库里仍然留着） */
export function isMemoryInjectable(entry, now = Date.now()) {
  return memoryDecayScore(entry, now).score >= MEMORY_DECAY.minInjectScore;
}

/** 注入时的排序键：衰退分数 ×（过时则打折）。新鲜事优先，但过时的东西不会被丢掉 */
export function memorySortKey(entry, now = Date.now()) {
  const d = memoryDecayScore(entry, now);
  return d.score * (d.stale ? MEMORY_DECAY.stalePenalty : 1);
}

/** 人能读的年龄：刚刚 / N分钟前 / N小时前 / 昨天 / N天前 / 9/28 15:02 */
export function humanAgo(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Math.max(0, now - t);
  if (diff < MINUTE) return '刚刚';
  const mins = Math.round(diff / MINUTE);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.round(diff / HOUR);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.round(diff / (24 * HOUR));
  if (days === 1) return '昨天';
  if (days < 14) return `${days}天前`;
  const d = new Date(t);
  const n = new Date(now);
  const pad = (x) => String(x).padStart(2, '0');
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()} ${clock}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
