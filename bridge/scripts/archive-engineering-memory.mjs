/**
 * 清掉记忆里的"我们自己的工程日志"（2026-10-01，管理员："照你的改"）。
 *
 * 为什么单独写一个：`memory-audit.mjs` 按 **coreMemory** 的索引工作，
 * 而这几条在**会话级** `conversations['private:984776985'].activeTopics` 里 ——
 * 它一条都没扫到（实测：报了"建议归档 0 条"，但真实注入里就躺着「读卡正文已经修好了…」）。
 *
 * 语义按项目规矩：**归档，不删除** —— 移进 `coreMemory.archived`（带 archivedAt），
 * 不再进提示词，但 `qq_memory_query` 还搜得到。
 *
 * ⚠️ 必须**先停桥接**再跑：桥接把状态握在内存里，退出时会整份写回，
 *    在线改文件会被它覆盖（这是在 `state/` 上改东西最容易踩的坑）。
 *
 * 用法：
 *   node scripts/archive-engineering-memory.mjs           # 只看会动哪几条
 *   node scripts/archive-engineering-memory.mjs --apply   # 真的归档（自动备份）
 */
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const STATE = 'state/social-v2.json';
const MEMORY_ARCHIVE_LIMIT = 200;

// 要清的条目：用**文本前缀**匹配（比索引稳，索引会随条目增删漂移）
const TARGETS = [
  { key: 'private:984776985', prefix: '读卡正文已经修好了', why: '工具/调试笔记（qq_role_play get-card 的返回字段、文件路径）' },
  { key: 'private:984776985', prefix: '日志更正（2026-09-30 12:08）', why: '桥接内部机制（沉睡前观察/发送侧提醒为什么这么设计）' },
  { key: 'private:984776985', prefix: '2026-09-30 14:50 他给桥接加了新模块', why: '桥接内部模块笔记（【语气倾向】是哪个模块加的）' },
];

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
st.coreMemory ??= {};
st.coreMemory.archived ??= [];
const now = Date.now();
let moved = 0;

for (const t of TARGETS) {
  const conv = st.conversations?.[t.key];
  const list = conv?.activeTopics;
  if (!Array.isArray(list)) { console.log(`⚠️ 找不到会话 ${t.key}.activeTopics，跳过「${t.prefix}」`); continue; }
  const hits = list.filter((e) => String(e?.text ?? '').startsWith(t.prefix));
  if (!hits.length) { console.log(`－ 已经没有「${t.prefix}」（可能已清过）`); continue; }
  for (const e of hits) {
    console.log(`→ [${t.key}] [${e.importance}] ${String(e.text).length} 字「${String(e.text).slice(0, 60)}…」`);
    console.log(`   理由：${t.why}`);
    if (APPLY) {
      st.coreMemory.archived.push({ ...e, archivedAt: now, archivedReason: 'engineering-log' });
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    }
    moved++;
  }
}

if (APPLY && moved) {
  if (st.coreMemory.archived.length > MEMORY_ARCHIVE_LIMIT) {
    st.coreMemory.archived = st.coreMemory.archived.slice(-MEMORY_ARCHIVE_LIMIT);
  }
  const bak = `${STATE}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(STATE, bak);
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
  console.log(`\n✅ 已归档 ${moved} 条；备份：${bak}`);
  console.log(`   coreMemory.archived 现在 ${st.coreMemory.archived.length} 条（上限 ${MEMORY_ARCHIVE_LIMIT}）`);
  const conv = st.conversations['private:984776985'];
  console.log(`   会话级 activeTopics 剩 ${conv.activeTopics.length} 条`);
} else if (moved) {
  console.log(`\n（dry run：会归档 ${moved} 条。加 --apply 执行）`);
} else {
  console.log('\n（没有要清的条目）');
}
