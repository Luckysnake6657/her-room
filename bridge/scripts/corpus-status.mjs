/**
 * 「她那个群聊聊天和通用模版是每天都在学吗」——一条命令看清语料库/风格卡的状态与代价。
 *
 * 打印三件事：
 *   ① 语料库：多少条、按天/按会话分布（她是不是一直在收）
 *   ② 风格卡：上次什么时候重建的、离下次重建还差多少（TTL 24h 或新增 ~200 条）
 *   ③ 代价：每轮真的注入多少字符（私聊/群聊）、强制重建要多久（它同步跑在唤醒路径上）
 *
 * 用法：node scripts/corpus-status.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const gs = cfg.socialV2?.groupStyle ?? {};
const TTL_H = Number(gs.ttlHours ?? 24);
const REFRESH = Number(gs.refreshAfterNewMessages ?? 200);
const GROWTH_BYTES = Math.max(4096, REFRESH * 90);
const CORPUS = 'state/group-corpus.jsonl';

console.log('=== ① 语料库（每条别人的消息都会追加，群聊+私聊）===');
let rows = [];
try {
  const text = fs.readFileSync(CORPUS, 'utf8');
  rows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const size = fs.statSync(CORPUS).size;
  console.log(`${CORPUS}: ${(size / 1024).toFixed(0)} KB / ${rows.length} 条 / 上限 ${cfg.socialV2?.corpus?.maxLines ?? '—'} 条`);
  const byGroup = {};
  for (const r of rows) byGroup[r.g] = (byGroup[r.g] ?? 0) + 1;
  console.log('按会话:', Object.entries(byGroup).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' | '));
  const day = {};
  for (const r of rows) { const d = new Date(r.t).toLocaleDateString('zh-CN'); day[d] = (day[d] ?? 0) + 1; }
  console.log('按天:', Object.entries(day).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])).map(([d, n]) => `${d.slice(5)} ${n}`).join(' | '));
} catch (e) { console.log('（读不到语料库）', e.message); }

console.log('\n=== ② 风格卡（生成物，不是每条消息都重算）===');
try {
  const g = JSON.parse(fs.readFileSync('state/group-style.json', 'utf8'));
  const ageH = (Date.now() - Number(g.generatedAt)) / 3600000;
  const grew = fs.statSync(CORPUS).size - Number(g.corpusBytes || 0);
  console.log(`上次重建: ${new Date(g.generatedAt).toLocaleString('zh-CN')}（${ageH.toFixed(1)} 小时前 / TTL ${TTL_H}h）`);
  console.log(`样本 ${g.sampleTotal} 条 | 通用层 ${g.general ? `有（${g.general.stats.n} 条）` : '无'} | 各群卡 ${Object.entries(g.profiles ?? {}).map(([k, p]) => `${k}=${p.stats.n}`).join(' ') || '无'}`);
  console.log(`距"语料涨够"重建: 又涨了 ${(grew / 1024).toFixed(1)} KB / 阈值 ${(GROWTH_BYTES / 1024).toFixed(0)} KB（≈${REFRESH} 条）`);
  console.log(`重建触发：TTL 到点 **或** 涨够阈值（先到哪个算哪个）；内存里 10 分钟内不重复算`);
} catch { console.log('（还没有风格卡：样本不足 minSamples 或没生成过）'); }

console.log('\n=== ③ 代价（每轮都注入这些字符）===');
const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  const sd = h.paths.stateDir;
  for (const f of ['group-corpus.jsonl', 'group-style.json', 'style-examples.json']) {
    try { fs.copyFileSync(path.join('state', f), path.join(sd, f)); } catch { /* 没有就算了 */ }
  }
  for (const f of fs.readdirSync('state')) {
    if (/^archived-group-\d+\.json$/.test(f)) fs.copyFileSync(path.join('state', f), path.join(sd, f));
  }
  const t0 = Date.now();
  h.groupStyleProfiles(true);
  const rebuildMs = Date.now() - t0;
  console.log(`强制重建耗时 ${rebuildMs} ms（同步跑在唤醒提示词里；只在触发那一刻发生）`);
  for (const [key, label] of [['private:984776985', '私聊'], ['group:1054156254', '群聊']]) {
    const b = h.buildChatStyleLine(key);
    console.log(`\n--- ${label}: ${b.length} 字符 ≈ ${Math.round(b.length * 0.62)} token/轮${label === '群聊' ? `（通用层上限 ${gs.generalMaxChars ?? 420} + 本群上限 ${gs.maxChars ?? 500}）` : ''} ---`);
    console.log(b || '（空）');
  }
} finally { await h.close(); }
