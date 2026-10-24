/**
 * 她的日记（2026-10-14，管理员提到的"进阶 1"）。
 *
 * 设计意图（照角色日记的通行做法，见 QUICKSTART 的决策记录）：
 *   · **一天一个文件**（`state/her-diary/YYYY-MM-DD.md`），本地纯文本，管理员随时能翻；
 *   · **只追加**：已有内容**绝不覆盖、绝不删除**。这是一条硬规矩 ——
 *     日记的价值就在"当时真的这么想"，能改就等于没有；
 *   · **她能读回自己**（按日期 / 关键词 / 最近几天），这样写日记才有意义；
 *   · **写的是她自己想记的**：不是工作汇报，也不是对话摘要。
 *
 * 纯逻辑放这里（方便离线测），读写落在桥接里（要碰文件系统）。
 */

/** 日记根目录（相对仓库根）。 */
export const DIARY_DIR = 'state/her-diary';

/** 单条上限：中文 800 字够了；太长说明她在写小作文，该拆成几天。 */
export const DIARY_MAX_CHARS = 800;

/** 每天最多写几条（防止一轮里刷十遍"今天很开心"）。 */
export const DIARY_MAX_PER_DAY = 8;

/** 给她的规矩。 */
// 2026-10-20 压过半：删掉工具用法（`qq_write_diary`/`qq_read_diary` 说明里有），只留分寸。
export const DIARY_RULE = '【日记】你有自己的日记本（`qq_write_diary` 写、`qq_read_diary` 翻；**只追加，改不了删不掉**）。\n'
  + '- **想写就写**：想说但没说出口的、突然想通的、值得记的小事 —— 不是工作汇报，也别把对话抄一遍。\n'
  + '- 一天几条都行，别反复写同一件事。想翻以前的就翻，别假装记得。\n\n';

/** 本地日期（YYYY-MM-DD）。用本地时区，因为"今天"对她来说是聊天那天的日期。 */
export function diaryDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 文件名（同日期）。 */
export function diaryFileName(date) {
  return `${date}.md`;
}

/** 校验日期字符串（防止拿它当路径用）。 */
export function isValidDiaryDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim());
}

/**
 * 清洗要写的内容：去首尾空白、折叠三个以上连续空行、掐掉过长。
 * 不做任何"改写"——她写什么就记什么。
 */
export function cleanDiaryText(text) {
  const t = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

/**
 * 能不能写。返回 `{ ok, reason, text }`。
 * 空的不写；太长的拒（让她自己拆）；当天条数太多的拒。
 */
export function shouldWriteDiary(text, { maxChars = DIARY_MAX_CHARS, todayCount = 0, maxPerDay = DIARY_MAX_PER_DAY } = {}) {
  const clean = cleanDiaryText(text);
  if (!clean) return { ok: false, reason: 'empty', text: '' };
  if (clean.length > maxChars) {
    return { ok: false, reason: 'too-long', text: clean, hint: `这条 ${clean.length} 字，超过 ${maxChars} 了 —— 拆成几条、分几次写更像日记` };
  }
  if (todayCount >= maxPerDay) {
    return { ok: false, reason: 'too-many', text: clean, hint: `今天已经写了 ${todayCount} 条了，明天再写吧` };
  }
  return { ok: true, reason: '', text: clean };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 日期字符串 → 周几（`2026-10-23` → `周五`）。坏日期返回空串。 */
export function weekdayOf(dateStr) {
  const d = new Date(`${String(dateStr ?? '')}T00:00:00`);
  return Number.isFinite(d.getTime()) ? WEEKDAYS[d.getDay()] : '';
}

/**
 * 拼一条日记（追加用）。返回 `"\n## HH:MM <天气>\n\n<正文>\n"`。
 * 用二级标题当时间戳 —— 纯文本看着清楚，也不影响 md 渲染。
 * 2026-10-23：管理员要"日记该有日期和天气" —— 时间后面带上当时的天气（不给就纯时间）。
 */
export function formatDiaryEntry(text, now = new Date(), weather = '') {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const body = cleanDiaryText(text);
  const w = String(weather ?? '').trim();
  return `\n## ${hh}:${mm}${w ? ` ${w}` : ''}\n\n${body}\n`;
}

/** 新文件的抬头：`# 2026-10-23 周五`。 */
export function diaryHeader(date) {
  const wd = weekdayOf(date);
  return `# ${date}${wd ? ` ${wd}` : ''}\n`;
}

/**
 * 在已有内容后面追加（**只追加**）。纯函数，方便测：绝不改动 existing 里已有的字符。
 */
export function appendDiary(existing, text, now = new Date(), weather = '') {
  const base = String(existing ?? '');
  const entry = formatDiaryEntry(text, now, weather);
  if (!base.trim()) return diaryHeader(diaryDate(now)) + entry;
  return base.replace(/\s*$/, '\n') + entry;
}

/**
 * 从日记文本里抽取条目（给 qq_read_diary 用）。
 * 返回 `[{ time, text }]`，按出现顺序。
 */
export function parseDiaryEntries(content) {
  const lines = String(content ?? '').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    // 2026-10-23：时间后面可能带天气（`## 19:30 毛毛雨`），所以尾声要允许一个短标签。
    const m = /^## (\d{1,2}:\d{2})(?:\s+([^#]{1,20}))?\s*$/.exec(line.trim());
    if (m) {
      if (cur) out.push(cur);
      cur = { time: m[1], weather: m[2] ? m[2].trim() : '', text: '' };
      continue;
    }
    if (/^#\s/.test(line.trim())) continue;        // 抬头不算内容
    if (cur) cur.text += (cur.text ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out.map((e) => ({ time: e.time, ...(e.weather ? { weather: e.weather } : {}), text: e.text.trim() })).filter((e) => e.text);
}

/** 按关键词过滤条目（大小写不敏感）。 */
export function filterDiaryEntries(entries, keyword) {
  const k = String(keyword ?? '').trim().toLowerCase();
  if (!k) return entries;
  return entries.filter((e) => e.text.toLowerCase().includes(k));
}
