/**
 * 记忆体检：找出"该清的记忆"（2026-10-01）。
 *
 * ## 为什么需要
 * 管理员："她都记忆紊乱了" + "我想省点 token 但是效果还得好"。查下来发现更深的问题：
 * 她的记忆库里 **53% 标了 high、22% 是我们自己的修复日志**（"日志更正""读卡修好了""补充实测"…）。
 * 注入有字数预算，这些工程日志把预算占满 → **真正跟她有关的生活话题反而挤不进来**。
 *
 * 桥接侧已经做了两件事：① 注入按衰退曲线排序（`src/memory-decay.js`）；② 写入口加了规范
 * （`qq_memory_append` 描述里明确"别把工程/系统日志写成记忆"）。这个脚本负责**存量清理**。
 *
 * ## 判定（都只是"建议"，可以只采纳一部分）
 * - `archive`：工程/系统日志型（我们修了什么、哪个工具怎么用、接口/配置怎么改、实测复盘）→
 *   移进 `coreMemory.archived`：**不再注入提示词，但内容还在**，`qq_memory_query` 仍可搜到。
 * - `downgrade`：标了 high 但不属于"约定/承诺/他明确说的关键信息/规矩" → 降到 normal
 *   （让它按 48h 半衰期自然退场，而不是占着 high 的 21 天）。
 * - `keep`：其余（生活/关系/群里的梗/操作口径这类她真用得上的）。
 *
 * 用法：
 *   node scripts/memory-audit.mjs                 # 只看名单，不改任何东西
 *   node scripts/memory-audit.mjs --apply         # 执行全部建议（会先备份 social-v2.json）
 *   node scripts/memory-audit.mjs --apply --only 3,7,12   # 只执行这几条（编号来自上面那份名单）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state', 'social-v2.json');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  if (i < 0 || !argv[i + 1]) return null;
  return new Set(argv[i + 1].split(',').map((x) => Number(x.trim())).filter(Number.isFinite));
})();

// ── 判定规则（**宁可漏判，也不要把生活/规矩/身份事实清掉**）─────────────────
// 第一版只凭"日志/实测/复盘/纠正"这类词就判归档 —— 结果把
// 「管理员第二次纠正我的说话方式」（行为规矩）「群号对应关系」（身份事实）
// 也划进了工程日志。那是绝不能清的。所以现在要求**同时**命中"工程词"和"工具/配置名"，
// 并且**不命中**行为规矩或身份事实，才归档。
const HARD_LOG = /日志|实测|复盘|报错|已修|修好了|故障/;
const TOOLISH = /qq_[a-z_]+|config\.json|socialV2|coreMemory|baseline|接口|端点|字段|提示词|权重|MCP|DSH|schema|工具可用|token 参数|预算|描述压缩|桥接|唤醒/;
const BEHAVIOR = /说话|语气|别当|不要|不许|别太|别装|别再|规矩|口径|礼貌|照实|如实|诚实|提醒|替.*说话|站.*这边|答应|约定|承诺|人设|口吻/;
const FACT = /身份|真名|群号|对应关系|车次|乘车人|票价|几点|课|老师|辅导员|作息|身体|病|疼|家里|妈妈|地址|网址|QQ 号/;

function classify(e) {
  const text = String(e?.text ?? '');
  const hits = [];
  if (HARD_LOG.test(text)) hits.push('工程标签');
  if (TOOLISH.test(text)) hits.push('工具/桥接名');
  const behavior = BEHAVIOR.test(text);
  const fact = FACT.test(text);
  if (behavior) hits.push('含行为词');
  if (fact) hits.push('含事实词');
  // ① 明确写着"日志/实测/复盘/报错"且提到工具/桥接 → 这是工程记录，哪怕正文里引用了规则也归档
  //    （第二版放过了"日志更正""补充实测"，就是因为它们正文里抄了一句"不要用空格…"被当成了行为规矩）
  if (HARD_LOG.test(text) && TOOLISH.test(text)) {
    return { action: 'archive', why: '工程/系统日志（引用了规则也一样：规则本体在提示词里，不在她记忆里）', hits };
  }
  const imp = String(e?.importance ?? 'normal');
  // ② 没有工程标签但含行为/事实的 → 保留（这类才是她回话要用的）
  if (behavior || fact) return { action: 'keep', why: '', hits };
  // ③ 其余 high 名不副实 → 降级
  if (imp === 'high') return { action: 'downgrade', why: '标了 high 但既不是约定/承诺，也不是规矩或事实', hits };
  return { action: 'keep', why: '', hits };
}

// ── 语义重复检测（2026-10-01）──────────────────────────────────────────────
// 她有个习惯：**同一条纠正会被反复记成新条目**（实测「谢谢之后别再接」记了 4 遍、
// 「9/29 语气纠正」3 个时间切片）。注入位有限，这些重复把预算吃光。
// ⚠️ 用 Jaccard 抓不到（长句互相稀释：实测 0 组 ≥0.35），要用**包含度** = 交集 / 较短那条的长度：
// "短的那条说的东西，长的那条基本都说了" —— 这才是"同一句话说两遍"的判据。
function bigrams(s) {
  const t = String(s).replace(/[\s，。、；：「」“”（）()\[\]★·—…,.!?~0-9a-zA-Z:：-]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}
function containment(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}
function findDupes(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const c = containment(items[i].text, items[j].text);
      if (c >= 0.55) out.push({ i, j, c });
    }
  }
  return out.sort((x, y) => y.c - x.c);
}

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const cm = st.coreMemory ?? {};
const topics = Array.isArray(cm.activeTopics) ? cm.activeTopics : [];
const now = Date.now();

// 先报"语义重复"（这个不影响 classif，只是额外提示）
const dupes = findDupes(topics);
if (dupes.length) {
  console.log(`=== 疑似"同一句话说多遍"（包含度 ≥0.55）：${dupes.length} 组 ===`);
  for (const d of dupes.slice(0, 10)) {
    console.log(`  包含度 ${(d.c * 100).toFixed(0)}%｜#${d.i}[${topics[d.i].importance}] vs #${d.j}[${topics[d.j].importance}]`);
    console.log(`    短：${String(topics[d.i].text).replace(/\s+/g, ' ').slice(0, 54)}`);
    console.log(`    长：${String(topics[d.j].text).replace(/\s+/g, ' ').slice(0, 54)}`);
  }
  console.log('  （建议合并：保留信息最全的那条、把其余归档。--merge-dupes 会自动这么做）\n');
}

const rows = topics.map((e, i) => {
  const c = classify(e);
  const last = Number(e.lastMentionAt) || Number(e.at) || 0;
  const ageH = last ? (now - last) / 3600000 : 0;
  return { i, e, ...c, ageH, imp: String(e.importance ?? 'normal'), text: String(e.text ?? '') };
});

const byAction = { archive: rows.filter((r) => r.action === 'archive'), downgrade: rows.filter((r) => r.action === 'downgrade'), keep: rows.filter((r) => r.action === 'keep') };
console.log(`coreMemory.activeTopics 共 ${rows.length} 条`);
console.log(`  建议归档 ${byAction.archive.length} 条｜建议降级 ${byAction.downgrade.length} 条｜保留 ${byAction.keep.length} 条`);
console.log(`  （其中标了 high 的 ${rows.filter((r) => r.imp === 'high').length} 条）\n`);

const fmtRow = (r) => `  #${String(r.i).padStart(2)} ${r.action === 'archive' ? '归档' : r.action === 'downgrade' ? '降级' : '保留'} `
  + `[${r.imp}] ${(r.ageH >= 24 ? `${(r.ageH / 24).toFixed(0)}天` : `${r.ageH.toFixed(0)}h`).padStart(4)}前｜`
  + `${r.text.replace(/\s+/g, ' ').slice(0, 62)}`;

console.log('=== 建议归档（移进 archived：不再注入提示词，但 qq_memory_query 还能搜到）===');
for (const r of byAction.archive) console.log(fmtRow(r));
console.log('\n=== 建议降级 high → normal ===');
for (const r of byAction.downgrade) console.log(fmtRow(r));
console.log('\n=== 保留（生活/关系/规矩/操作口径）===');
for (const r of byAction.keep.slice(0, 30)) console.log(fmtRow(r));
if (byAction.keep.length > 30) console.log(`  …还有 ${byAction.keep.length - 30} 条`);

if (!APPLY) {
  console.log(`\n（这只是名单，**没有改动任何东西**。执行：node scripts/memory-audit.mjs --apply [--only 3,7,12]）`);
  process.exit(0);
}

// ── 执行 ───────────────────────────────────────────────────────────────────
// --merge-dupes：把"同一句话说多遍"合并（保留信息最全/最新的那条，其余归档；一条不删）
if (argv.includes('--merge-dupes')) {
  if (!dupes.length) { console.log('\n没有检测到语义重复，不用合并。'); process.exit(0); }
  const backup = `${STATE}.bak-memory-merge-${Date.now()}`;
  fs.copyFileSync(STATE, backup);
  if (!Array.isArray(cm.archived)) cm.archived = [];
  const kill = new Set();
  const groups = [];
  for (const d of dupes) {
    if (kill.has(d.i) || kill.has(d.j)) continue;
    // 保留"更长 + 更新"的那条（长的通常细节全，新的通常口径准）
    const keepIdx = (() => {
      const a = topics[d.i], b = topics[d.j];
      const la = String(a.text).length, lb = String(b.text).length;
      if (Math.abs(la - lb) > 20) return la > lb ? d.i : d.j;
      const ta = Number(a.lastMentionAt) || Number(a.at) || 0;
      const tb = Number(b.lastMentionAt) || Number(b.at) || 0;
      return ta >= tb ? d.i : d.j;
    })();
    const dropIdx = keepIdx === d.i ? d.j : d.i;
    kill.add(dropIdx);
    groups.push({ keep: keepIdx, drop: dropIdx, c: d.c });
  }
  let archived = 0;
  cm.activeTopics = topics.filter((e, i) => {
    if (!kill.has(i)) return true;
    const keeper = topics[groups.find((g) => g.drop === i).keep];
    cm.archived.push({ ...e, archivedAt: now, archivedReason: `与 #${topics.indexOf(keeper)} 语义重复（包含度≥0.55），已合并（memory merge-dupes）` });
    archived++;
    return false;
  });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
  console.log(`\n✅ 合并重复：归档 ${archived} 条（activeTopics ${topics.length} → ${cm.activeTopics.length}）`);
  for (const g of groups) console.log(`   保留「${String(topics[g.keep].text).slice(0, 40)}…」← 归档了 ${(g.c * 100).toFixed(0)}% 重复的那条`);
  console.log(`   备份：${path.relative(ROOT, backup)}`);
  process.exit(0);
}

const picked = rows.filter((r) => (ONLY ? ONLY.has(r.i) : true) && r.action !== 'keep');
if (!picked.length) { console.log('\n没有要改的（或 --only 没命中）。'); process.exit(0); }
const backup = `${STATE}.bak-memory-audit-${Date.now()}`;
fs.copyFileSync(STATE, backup);
const toArchive = new Set(picked.filter((r) => r.action === 'archive').map((r) => r.i));
const toDowngrade = new Set(picked.filter((r) => r.action === 'downgrade').map((r) => r.i));
if (!Array.isArray(cm.archived)) cm.archived = [];
let archived = 0, downgraded = 0;
cm.activeTopics = topics.filter((e, i) => {
  if (toArchive.has(i)) {
    cm.archived.push({ ...e, archivedAt: now, archivedReason: '工程/系统日志清理（memory-audit）' });
    archived++;
    return false;
  }
  if (toDowngrade.has(i)) { e.importance = 'normal'; downgraded++; }
  return true;
});
if (cm.archived.length > 200) cm.archived = cm.archived.slice(-200);
fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
console.log(`\n✅ 归档 ${archived} 条、降级 ${downgraded} 条（activeTopics ${topics.length} → ${cm.activeTopics.length}）`);
console.log(`   备份：${path.relative(ROOT, backup)}`);
console.log('   生效方式：桥接下次 saveSocialV2State 会带上新状态；想立刻看到效果就重启桥接。');
