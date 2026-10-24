/**
 * 回归：记忆衰退曲线 + 年龄标签（2026-10-01 事故）。
 *
 * 她的原话：「早上那集无职你补了没」→「你自己说的中午看一集，让我看完整跟你聊」，管理员一看就是记忆紊乱。
 * 真相是记忆里**有**那两条，但是 **9/29（两天前）**的：
 *   [normal] 中午看一集《无职转生》，看完跟他说感想（他之前让我中午看，我还没看）
 *   [high]   ★答应他：中午这集《无职转生》看好之后跟他说一声… 待追问：这集无职看下来的感受
 * 三个毛病：① 注入的年龄写成 `（3120分钟前）`，模型读不出"两天前"；② 排序靠 importance 硬压，
 * 两天前的 high 压过所有新鲜事；③ 过期的"待追问"照旧注入 → 她把两天前的待办当成今天的任务。
 *
 * 这里锁：曲线性质（指数、半衰期、单调）、排序翻转、标签说人话、过期待办不再注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEMORY_DECAY, memoryDecayScore, isMemoryInjectable, humanAgo, memoryHalfLifeMs, decayFactor,
} from '../src/memory-decay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-01T13:50:00+08:00').getTime();
const NOWREL = Date.now();   // 渲染类用例用真实时钟（渲染内部就是 Date.now()）
const at = (msAgo) => NOW - msAgo;

console.log('\n[1] 曲线本身：指数、半衰期、单调');
{
  check('halfLife 分档：low < normal < high', memoryHalfLifeMs('low') < memoryHalfLifeMs('normal') && memoryHalfLifeMs('normal') < memoryHalfLifeMs('high'),
    JSON.stringify({ low: memoryHalfLifeMs('low') / HOUR, normal: memoryHalfLifeMs('normal') / HOUR, high: memoryHalfLifeMs('high') / HOUR }));
  check('正好一个半衰期 → 衰减到 0.5', Math.abs(decayFactor(memoryHalfLifeMs('normal'), memoryHalfLifeMs('normal')) - 0.5) < 1e-9);
  check('两个半衰期 → 0.25', Math.abs(decayFactor(2 * memoryHalfLifeMs('normal'), memoryHalfLifeMs('normal')) - 0.25) < 1e-9);
  check('年龄越大分数越低（单调）', (() => {
    const mk = (ago) => memoryDecayScore({ text: 'x', importance: 'normal', lastMentionAt: at(ago) }, NOW).score;
    const seq = [0, HOUR, 6 * HOUR, DAY, 3 * DAY, 10 * DAY].map(mk);
    return seq.every((v, i) => i === 0 || v < seq[i - 1]);
  })());
  check('没有时间戳的条目不衰减（当作"刚刚"，宁可高估新鲜度也别误删）',
    memoryDecayScore({ text: 'x', importance: 'normal' }, NOW).decay === 1);
  check('重要性仍然有意义：同样 2 天前，high > normal > low', (() => {
    const s = (imp) => memoryDecayScore({ text: 'x', importance: imp, lastMentionAt: at(2 * DAY) }, NOW).score;
    return s('high') > s('normal') && s('normal') > s('low');
  })());
}

console.log('\n[2] 排序：时间真的参与排序了（旧实现只看 importance）');
{
  const score = (e) => memoryDecayScore(e, NOW).score;
  const freshNormal = score({ text: '刚聊的', importance: 'normal', lastMentionAt: at(5 * 60 * 1000) });
  const oldNormal = score({ text: '两天前的琐事', importance: 'normal', lastMentionAt: at(2 * DAY) });
  const oldHigh = score({ text: '两天前的约定', importance: 'high', lastMentionAt: at(2 * DAY) });
  const veryOldHigh = score({ text: '一个月前的约定', importance: 'high', lastMentionAt: at(30 * DAY) });
  check(`刚刚的 normal（${freshNormal.toFixed(2)}）> 两天前的 normal（${oldNormal.toFixed(2)}）—— 时间起作用了`, freshNormal > oldNormal);
  check(`两天前的 high（${oldHigh.toFixed(2)}）> 两天前的 normal（${oldNormal.toFixed(2)}）—— 重要性仍然算数`, oldHigh > oldNormal);
  check(`一个月前的 high（${veryOldHigh.toFixed(2)}）< 刚刚的 normal（${freshNormal.toFixed(2)}）—— 时间最终压过重要性`, veryOldHigh < freshNormal);
  check('"新鲜度"是连续曲线，不是台阶（相邻 1 小时之间也有差别）', (() => {
    const a = score({ text: 'x', importance: 'normal', lastMentionAt: at(2 * HOUR) });
    const b = score({ text: 'x', importance: 'normal', lastMentionAt: at(3 * HOUR) });
    return a > b;
  })());
}

console.log('\n[3] 过期的"待追问"必须作废（这次事故的直接触发点）');
{
  const stale = { text: '中午这集无职看好跟他说一声', importance: 'high', lastMentionAt: at(2 * DAY), pendingQuestion: '这集无职看下来的感受' };
  const fresh = { text: '刚答应的', importance: 'normal', lastMentionAt: at(30 * 60 * 1000), pendingQuestion: '要不要现在问他' };
  const s = memoryDecayScore(stale, NOW);
  const f = memoryDecayScore(fresh, NOW);
  check(`两天前的待追问：加成衰减到几乎为 0（${s.pendingScore.toFixed(3)}）`, s.pendingScore < 0.05, JSON.stringify(s));
  check(`半小时前的待追问：加成还在（${f.pendingScore.toFixed(2)}）`, f.pendingScore > 1.5, JSON.stringify(f));
  check('★ 带待追问的条目仍然算得出分数（写过一个 NaN 的乘数，把这类记忆全静默丢了）',
    Number.isFinite(s.score) && Number.isFinite(f.score) && isMemoryInjectable(stale, NOW) === true,
    JSON.stringify({ s: s.score, f: f.score }));
  check('两天前的 normal 会被标"可能已过时"',
    memoryDecayScore({ text: 'x', importance: 'normal', lastMentionAt: at(2 * DAY) }, NOW).stale === true);
  check('两天前的 high（约定）不算过时（它的窗口更长）',
    memoryDecayScore({ text: 'x', importance: 'high', lastMentionAt: at(2 * DAY) }, NOW).stale === false);
  check('八天前的 high 才算过时',
    memoryDecayScore({ text: 'x', importance: 'high', lastMentionAt: at(8 * DAY) }, NOW).stale === true);
}

console.log('\n[4] 年龄标签说人话（旧实现是「3120分钟前」）');
{
  const cases = [
    [30 * 1000, '刚刚'],
    [12 * 60 * 1000, '12分钟前'],
    [5 * HOUR, '5小时前'],
    [26 * HOUR, '昨天'],
    [2 * DAY, '2天前'],
    [9 * DAY, '9天前'],
  ];
  for (const [ago, want] of cases) {
    const got = humanAgo(at(ago), NOW);
    check(`${want}`, got === want, `得到 ${got}`);
  }
  check('超过两周 → 显示具体日期（不再是无穷大的分钟数）', /^\d+\/\d+ \d{2}:\d{2}$/.test(humanAgo(at(20 * DAY), NOW)), humanAgo(at(20 * DAY), NOW));
  check('2 天前的记忆标签不是「3120分钟前」这种读不出信息的形式', humanAgo(at(2 * DAY), NOW) === '2天前');
  check('时间戳缺失 → 空串（不编）', humanAgo(0, NOW) === '' && humanAgo(null, NOW) === '');
}

console.log('\n[5] 桥接真渲染：那条 9/29 的"无职"记忆现在长什么样');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { socialV2: { memory: { maxInjectChars: 900 } } } });
  try {
    const st = { activeTopics: [
      // ⚠️ 用**真实时钟**的相对偏移（别用写死的 NOW）：渲染内部取 Date.now()，
      //    写死的话跑得越晚偏差越大（实测过了午夜后"10 分钟前"变成了"N 小时前"，把断言跑挂）
      { text: '中午看一集《无职转生》，看完跟他说感想（他之前让我中午看，我还没看）', importance: 'normal', at: NOWREL - 2 * DAY, lastMentionAt: NOWREL - 2 * DAY, source: 'owner' },
      { text: '★答应他：中午这集《无职转生》看好之后跟他说一声，看完要主动提一句感想', importance: 'high', at: NOWREL - 2 * DAY + 3 * HOUR, lastMentionAt: NOWREL - 2 * DAY + 3 * HOUR, pendingQuestion: '这集无职看下来的感受', source: 'owner' },
      { text: '他刚说今晚要早点睡', importance: 'normal', at: NOWREL - 10 * 60 * 1000, lastMentionAt: NOWREL - 10 * 60 * 1000, source: 'owner' },
    ] };
    const text = h.formatMemoryV2(st);
    console.log('  —— 渲染结果 ——');
    for (const line of text.split('\n')) console.log(`  ${line}`);
    check('渲染出了记忆块', text.includes('你还记得的事'), text.slice(0, 80));
    check('每条都带"人能读的年龄"（不是裸的分钟数/时间戳）',
      (() => {
        const lines = text.split('\n').filter((l) => l.startsWith('- '));
        return lines.length >= 2 && lines.every((l) => /（(刚刚|\d+分钟前|\d+小时前|昨天|\d+天前)/.test(l));
      })(), text);
    check('★ 带"待追问"的 high 条目**没有被静默丢掉**（NaN 那个 bug 的表现）',
      /无职转生》看好之后跟他说一声/.test(text), text);
    check('**两天前的"待追问"不再注入**（否则她拿旧待办当今天的任务）', !text.includes('这集无职看下来的感受'), text);
    check('最新的那条排在**过期条目**之前（旧的往后排，新的先说）',
      text.indexOf('今晚要早点睡') < text.indexOf('（2天前，可能已过时）'), text);
    check('记忆块开头就提醒"几天前的别当成今天的"', /别当成今天的/.test(text), text.slice(0, 120));
    check('没有"3120分钟前"这种读不出来的时间', !/\d{3,}分钟前/.test(text), text);
  } finally { await h.close(); }
}

console.log('\n[6] 极端情况：曲线只管"占不占提示词位置"，不管"删不删"');
{
  check('三个月前的 high 仍然可注入', isMemoryInjectable({ text: 'x', importance: 'high', lastMentionAt: at(90 * DAY) }, NOW) === true,
    JSON.stringify(memoryDecayScore({ text: 'x', importance: 'high', lastMentionAt: at(90 * DAY) }, NOW).score));
  check('一年前的 high 淡出提示词（但条目仍留在库里，能 qq_memory_query 搜到）',
    isMemoryInjectable({ text: 'x', importance: 'high', lastMentionAt: at(365 * DAY) }, NOW) === false);
  check('三年前的 low 也淡出', isMemoryInjectable({ text: 'x', importance: 'low', lastMentionAt: at(3 * 365 * DAY) }, NOW) === false);
  check('降级阈值很保守（不会把"昨天的事"滤掉）',
    isMemoryInjectable({ text: 'x', importance: 'normal', lastMentionAt: at(DAY) }, NOW) === true);
  check('阈值是个明确的正数（0 = 永不淡出，那就不是曲线了）', MEMORY_DECAY.minInjectScore > 0);
}

console.log('\n[7] 保底：非 high 的记忆不许被一堆 high 规矩挤光（2026-10-01 加）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const now = Date.now();
  // 造 20 条 high 规矩（都很长、都很新）+ 3 条生活类 normal
  const manyHigh = Array.from({ length: 20 }, (_, i) => ({
    text: `规矩第${i + 1}条：管理员要我注意说话方式，别太硬、别玩梗过度、说正事时语气放平，这条挺长的用来占预算`,
    importance: 'high', at: now - i * 60000, lastMentionAt: now - i * 60000,
  }));
  const life = [
    { text: '他今天口腔溃疡疼得厉害，明早提醒他买西瓜霜', importance: 'normal', at: now - 2 * 3600e3, lastMentionAt: now - 2 * 3600e3 },
    { text: '他周一的课在东区 6-303，说上到十点就不去了', importance: 'normal', at: now - 3 * 3600e3, lastMentionAt: now - 3 * 3600e3 },
    { text: '他在追《无职转生》，说好中午看一集跟他聊', importance: 'normal', at: now - 4 * 3600e3, lastMentionAt: now - 4 * 3600e3 },
  ];
  const render = async (reserve) => {
    const h = await bridgeHarness({ config: { socialV2: { memory: { maxInjectChars: 700, normalReserveChars: reserve } } } });
    try { return h.formatMemoryV2({ activeTopics: [...manyHigh, ...life] }); } finally { await h.close(); }
  };
  const withReserve = await render(170);
  const without = await render(0);
  const lifeCount = (t) => ['西瓜霜', '东区 6-303', '无职转生'].filter((k) => t.includes(k)).length;
  check(`保底开启（170 字符）→ 生活类进来 ${lifeCount(withReserve)} 条`, lifeCount(withReserve) >= 1, withReserve);
  check('保底关掉（0）→ 20 条规矩把预算占满，生活类一条都进不来', lifeCount(without) === 0, without);
  check('保底开启时，规矩仍然照常注入（不是拿规矩换生活类）', (withReserve.match(/规矩第/g) ?? []).length >= 5, `规矩 ${(withReserve.match(/规矩第/g) ?? []).length} 条`);
  check('两边的注入总长都不超预算', withReserve.length <= 700 && without.length <= 700, `${withReserve.length} / ${without.length}`);

  console.log('\n[8] 真实记忆库（当前状态）渲染一遍');
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8')).coreMemory ?? {};
  const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const h = await bridgeHarness({ config: { socialV2: { memory: cfgAll.socialV2?.memory } } });
  try {
    const text = h.formatMemoryV2({ activeTopics: real.activeTopics, pendingThoughts: real.pendingThoughts, memberImpressions: real.memberImpressions });
    console.log(text);
    check('真实记忆块里既有规矩也有生活类（不再全是规则清单）',
      /规矩|别太|不要/.test(text) && /谢谢|签到|他说|他问|群/.test(text), text);
    // 末尾那句"另有 N 条没放进"的额度是从预算里扣的 → 总长照样不许超
    check(`实际长度不超预算（${text.length} ≤ ${cfgAll.socialV2?.memory?.maxInjectChars}）`,
      text.length <= Number(cfgAll.socialV2?.memory?.maxInjectChars));
  } finally { await h.close(); }
}

console.log('\n[9] 印象段真的进得去 + 截断看得出来（2026-10-13，管理员转来她那句「那栏还是空的，印象也还是十六份半句的老样子」）');
{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const now = Date.now();
  // 用一堆"占预算的 high 规矩"把话题段喂饱 —— 这正是线上把她印象栏挤空的场景
  const manyHigh = Array.from({ length: 20 }, (_, i) => ({
    text: `规矩第${i + 1}条：管理员要我注意说话方式，别太硬、别玩梗过度、说正事时语气放平，这条挺长的专门用来占预算`,
    importance: 'high', at: now - i * 60000, lastMentionAt: now - i * 60000,
  }));
  const imps = {
    '熊猫人永不为奴': { traits: ['爱@我发蓝发鲸鱼小人表情包逗我，还会P图（给小人头上扣锅）然后截图发，凌晨一点半一个人在群里测我查守望战绩，拿 TeKrop-2217 试我数据真不真，中文ID「随缘居士-5729」、补：中文名国服ID要用国服库才查得到，他说这都是测我会不会编'], interactionCount: 5, lastSeenAt: now },
    'fig（NBU最后的单纯）': { traits: ['群里做实验那次他也在，问过我打不打瓦，说话带点阴阳，后来在群里连着三天让我发带性别指向的话我没照原话发'], interactionCount: 3, lastSeenAt: now },
  };
  const h = await bridgeHarness({ config: { socialV2: { memory: { maxInjectChars: 700 } } } });
  try {
    const text = h.formatMemoryV2({ activeTopics: manyHigh, memberImpressions: imps });
    console.log(text);
    // ① 印象栏必须有内容（原来只有空标题 —— 她说的"那栏还是空的"）
    const after = text.split('【对群友的印象】')[1] ?? '';
    check('【对群友的印象】后面真的有内容（不再是空标题）', /\n- \S/.test(after), JSON.stringify(after.slice(0, 120)));
    // ② 截断必须带省略号（她说的"十六份半句"= 被腰斩又看不出来）
    const truncated = text.split('\n').filter((l) => /…/.test(l));
    check('被截断的条目带 `…`（看得出来是截的，不是记漏了）', truncated.length >= 1, JSON.stringify(truncated.slice(0, 2)));
    // ③ 总量仍然受预算约束（"末尾提示行"的额度是**从预算里扣的**，不是越界加的）
    check('注入总长仍不超预算', text.length <= 700, `${text.length} 字符`);
    // ④ 放不下的要如实说一声
    check('末尾说明了"另有 N 条记忆这轮没放进"', /另有 \d+ 条记忆这轮没放进/.test(text), text.slice(-120));
    // ⑤ 保底可关（配置项还在，别把开关写死）
    const h2 = await bridgeHarness({ config: { socialV2: { memory: { maxInjectChars: 700, impressionReserveChars: 0 } } } });
    try {
      const t2 = h2.formatMemoryV2({ activeTopics: manyHigh, memberImpressions: imps });
      const after2 = t2.split('【对群友的印象】')[1] ?? '';
      check('保底设 0 → 回到老行为（印象又进不来，开关有效）', !/\n- \S/.test(after2), JSON.stringify(after2.slice(0, 80)));
    } finally { await h2.close(); }
  } finally { await h.close(); }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
