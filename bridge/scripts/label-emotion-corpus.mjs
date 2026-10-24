/**
 * 用 LLM 当老师，给语料打 **PAD 情感标签**（离线一次，产出 state/emotion-labels.jsonl）。
 *
 * 为什么这么做：项目硬约束是"不引 Python/torch、不引常驻侧车、行为要可回归"，
 * 但用户要的是**真·神经网络**而不是拍脑袋的词典。可行的路子就是"蒸馏"：
 *   ① 离线：让 DSH 里的模型（deepseek）逐批给真实群聊/私聊句子打 PAD 标签（老师）；
 *   ② 训练：`scripts/train-emotion-net.mjs` 在 Node 里用梯度下降把标签学进一个小 MLP（学生）；
 *   ③ 在线：`src/emotion-net.js` 纯 JS 前向推理（确定性、微秒级、0 API 成本）。
 *
 * 老师只跑一次（语料涨了再补跑，幂等：按文本 hash 跳过已标注的）。
 *
 * 用法：
 *   node scripts/label-emotion-corpus.mjs --limit 400        # 先跑一小批看看质量
 *   node scripts/label-emotion-corpus.mjs                    # 全量（会花 API 钱，见结尾估算）
 *   node scripts/label-emotion-corpus.mjs --batches 5 --dry  # 只看会发什么提示词
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'state', 'group-corpus.jsonl');
// --context：带上文重新标一份，写**另一个**文件（不动已有的单句标签，方便两套同口径对比）
const CTX = process.argv.includes('--context');
const LABELS = path.join(ROOT, 'state', CTX ? 'emotion-labels-ctx.jsonl' : 'emotion-labels.jsonl');
const SESSION_FILE = path.join(ROOT, 'state', CTX ? 'emotion-label-session-ctx.json' : 'emotion-label-session.json');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const LIMIT = Number(argOf('--limit', 0)) || 0;          // 0 = 不限制
const BATCH = Math.max(4, Number(argOf('--batch', 6)) || 6);
const DRY = argv.includes('--dry');
const BATCHES = Number(argOf('--batches', 0)) || 0;      // 只跑前 N 批（调试用）
// 上下文模式：上文与本句的最大间隔（秒）；超过就不算"接话"，这条不进
const GAP_SEC = Math.max(10, Number(argOf('--gapSec', 180)) || 180);

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isMedia = (t) => /^\[(图片|表情|表情包|视频|语音|文件|转发消息)/.test(t);

// ── 1. 读语料，挑出值得标注的句子 ──────────────────────────────────────────
// 上下文模式：顺带记住"同群里紧邻的上一条**有字**消息"，作为本句的上文
// （语料是 append-only，文件顺序就是时间顺序；媒体占位不算"上文"，遇到就再往前找一条）
const HIST = 4;                       // 每群留最近 4 条有字消息，够跨过图片/表情了
const histByGroup = new Map();
let ctxSkipped = { noPrev: 0, tooOld: 0 };
const rows = [];
const seen = new Set();
for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const text = clean(r.x);
  const group = String(r.g ?? '');
  const at = Number(r.t) || 0;
  const hist = histByGroup.get(group) ?? [];
  const len = [...text].length;
  const usableAsText = !!text && !isMedia(text);
  // ① 先取上文（此刻 hist 里还**没有**本句 —— 顺序反了就会把本句当成自己的上文）
  let prevText = '';
  let prevSender = '';
  let why = 'noPrev';
  if (CTX) {
    for (let i = hist.length - 1; i >= 0; i--) {
      const p = hist[i];
      if (at && p.at && at - p.at > GAP_SEC * 1000) { why = 'tooOld'; break; }   // 更早的只会更远
      if ([...p.text].length > 80) continue;                                    // 太长的上文没参考价值，再往前找
      prevText = p.text;
      prevSender = p.sender;
      why = '';
      break;
    }
  }
  // ② 再把本句记进历史（供后面的消息用）；媒体占位不进历史，免得把上文链断成"[图片]"
  if (usableAsText) {
    hist.push({ at, text, sender: String(r.s ?? '') });
    while (hist.length > HIST) hist.shift();
    histByGroup.set(group, hist);
  }
  if (!usableAsText) continue;                  // 纯媒体占位没内容可判
  if (len < 2 || len > 80) continue;            // 太长的是粘贴内容，不是"说话"
  if (CTX) {
    if (why) { ctxSkipped[why]++; continue; }   // 没有可用上文 → 这条不进（保证标签确实带上下文）
  }
  // 上下文模式下按"上文+本句"去重：同一句话接在不同上文后面是两条不同的样本
  const h = hash(CTX ? `${prevText}\u0001${text}` : text);
  if (seen.has(h)) continue;
  seen.add(h);
  rows.push({ h, text, prev: prevText, prevSender, group, sender: String(r.s ?? '') });
}
if (CTX) {
  console.log(`[ctx] 带上下文的样本 ${rows.length} 条（丢掉：没有上文 ${ctxSkipped.noPrev}｜上文隔超过 ${GAP_SEC}s ${ctxSkipped.tooOld}）`);
}


// 已标注过的跳过（幂等）
const done = new Set();
if (fs.existsSync(LABELS)) {
  for (const line of fs.readFileSync(LABELS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).h); } catch { /* 坏行忽略 */ }
  }
}
let todo = rows.filter((r) => !done.has(r.h));
if (LIMIT) todo = todo.slice(0, LIMIT);

console.log(`语料 ${rows.length} 条（去重后）｜已标注 ${done.size} 条｜本次待标注 ${todo.length} 条｜每批 ${BATCH} 条`);
if (!todo.length) { console.log('没有要标注的了。'); process.exit(0); }

// ── 2. 提示词 ─────────────────────────────────────────────────────────────
function buildPrompt(batch) {
  if (CTX) {
    const list = batch.map((r, i) => `${i + 1}.\n上文：${r.prev}\n本句：${r.text}`).join('\n');
    return `你是情感标注员。下面是中文**群聊/私聊**里一段对话的片段，每组两行：「上文」是群里刚发生的一句，「本句」是要打分的那句。

请给**每一句「本句」**打一个 PAD 三维情感分，打分对象是**说这句话的人**此刻的情绪（不是话题本身正不正面）。
**必须结合上文**：同一句"6""啊？""草""真的假的"接在不同上文后面，情绪可以完全不同（例如上文在夸她 → 本句是得意；上文在骂人 → 本句是看戏或附和）。但也不要脑补上文之外的东西。

- v（效价）：-1 极负面（被冒犯、难受、厌恶）… 0 中性 … +1 极正面（开心、被夸、亲昵）
- a（唤醒）：-1 很低落/懒得说话 … 0 平常 … +1 很激动/兴奋/着急
- d（支配感）：-1 被动、被拿捏、没底气 … 0 平常 … +1 在掌控、有底气、主动

判断规则（很重要，别判错）：
1. 群友之间**互相玩笑/互损**（"傻"、"滚"、"菜"这类当玩笑用的）→ v 只轻微负（-0.2 左右）甚至中性，不要判成极度负面；
2. 纯陈述事实、报时间地点、问路 → 接近 [0,0,0]；
3. 脏话骂人且明显带火气 → v 明显负、a 正；
4. 卖萌/亲昵/感谢/夸奖 → v 正；
5. 长句认真讲事情 → a 偏低（平静），别给高唤醒；
6. 只有本句在对着上文"接话"（附和、起哄、反呛、安慰）时，才让上文影响分数；本句明显在起新话题就按本句自己判。

只输出 JSON 数组，长度必须等于 ${batch.length}，每项：{"i":序号,"v":数值,"a":数值,"d":数值}
数值保留两位小数，范围 [-1,1]。不要解释、不要 markdown 代码块。

对话片段：
${list}

JSON：`;
  }
  const list = batch.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  return `你是情感标注员。下面是一组中文**群聊/私聊**里的单句发言（每行一句，可能很短、没标点）。

请给**每一句**打一个 PAD 三维情感分（这是**说话人自己**在说这句话时/听到上文的情绪，不是话题本身正不正面）：
- v（效价）：-1 极负面（被冒犯、难受、厌恶）… 0 中性 … +1 极正面（开心、被夸、亲昵）
- a（唤醒）：-1 很低落/懒得说话 … 0 平常 … +1 很激动/兴奋/着急
- d（支配感）：-1 被动、被拿捏、没底气 … 0 平常 … +1 在掌控、有底气、主动

判断规则（很重要，别判错）：
1. 群友之间**互相玩笑/互损**（"傻"、"滚"、"菜"这类当玩笑用的）→ v 只轻微负（-0.2 左右）甚至中性，不要判成极度负面；
2. 纯陈述事实、报时间地点、问路 → 接近 [0,0,0]；
3. 脏话骂人且明显带火气 → v 明显负、a 正；
4. 卖萌/亲昵/感谢/夸奖 → v 正；
5. 长句认真讲事情 → a 偏低（平静），别给高唤醒。

只输出 JSON 数组，长度必须等于 ${batch.length}，每项：{"i":序号,"v":数值,"a":数值,"d":数值}
数值保留两位小数，范围 [-1,1]。不要解释、不要 markdown 代码块。

句子：
${list}

JSON：`;
}

// ── 3. 连接 DSH ───────────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const auth = {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader,
  prefix: cfg.dsh?.authPrefix,
};
const api = new NodeApiClient(cfg.dsh?.baseUrl || 'http://127.0.0.1:3080', undefined, auth);

const waiters = new Map();
let muxStarted = false;
const DEBUG = argv.includes('--debug');
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
function startMux() {
  if (muxStarted) return;
  muxStarted = true;
  (async () => {
    for (;;) {
      try {
        for await (const envelope of api.events.mux({})) {
          const frame = envelope?.payload;
          if (frame?.type !== 'session/event') continue;
          const w = waiters.get(frame.sessionId);
          if (!w) continue;
          const ev = frame.event ?? {};
          if (DEBUG) console.log(`   [frame ${stamp()}] ${ev.type}${ev.type === 'tool/call' ? ' ' + ev.data?.name : ''}`);
          // ⚠️ 不能依赖 turn/start：**第一轮的 turn/start 往往在 mux 开始 follow 之前就发过了**
          //    （实测：collector 里没有那一轮 → turn/end 被忽略 → 白等到超时）。
          //    这里自己累计 assistant 文本，见到 turn/end 就收工。
          if (ev.type === 'turn/start') { w.text = ''; continue; }
          if (ev.type === 'assistant/message') {
            for (const b of ev.data?.message?.content ?? []) {
              if (b?.type === 'text' && typeof b.text === 'string') w.text = (w.text ?? '') + b.text;
            }
            continue;
          }
          if (ev.type === 'turn/end') {
            const text = w.text ?? '';
            w.text = '';
            if (DEBUG) console.log(`   [frame ${stamp()}] turn 结束（${ev.data?.reason?.kind}，文本 ${String(text).length} 字）`);
            if (ev.data?.reason?.kind === 'completed') w.resolve(text);
            else w.reject(new Error(`turn 未正常完成：${ev.data?.reason?.kind}`));
          }
        }
      } catch (error) {
        console.error('[label] 事件流断开，2 秒后重连：', error?.message ?? error);
        await sleep(2000);
      }
    }
  })();
}

function waitTurn(sessionId, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(sessionId);
      reject(new Error(`等待标注 turn 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    waiters.set(sessionId, {
      resolve: (t) => { clearTimeout(timer); resolve(t); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

async function ensureSession() {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (saved?.sessionId) {
      // 复用已有标注会话：**必须 follow**，否则事件流里没有这个会话，waitTurn 会永远等不到（实测踩过）
      api.events.follow(saved.sessionId);
      console.log('[label] 复用标注会话', saved.sessionId);
      return saved.sessionId;
    }
  } catch { /* 没有存档 */ }
  const dir = path.join(ROOT, 'state', 'emotion-label');
  fs.mkdirSync(dir, { recursive: true });
  // ⚠️ 不要在这里调 agentPresets.list：实测那个调用会挂住（最小探针里没调它，一路顺畅）
  const preset = 'standard';
  // 跟黑话学习会话一样：先建 workspace，再在里面建会话
  let params = { cwd: dir, agentPreset: preset };
  try {
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
    if (ws?.workspace?.workspaceId) {
      params = { workspaceId: ws.workspace.workspaceId, agentPreset: preset };
      try { await api.workspace.rename({ workspaceId: ws.workspace.workspaceId, title: '情感标注' }); } catch { /* 改名失败无所谓 */ }
    }
  } catch { /* 用 cwd 形状兜底 */ }
  console.log('[label] 正在创建标注会话…');
  const created = unwrap(await api.sessions.create(params), 'session.create');
  const sessionId = created.sessionId;
  api.events.follow(sessionId);        // ★ 关键：不 follow 就收不到事件
  try {
    if (cfg.dsh?.provider && cfg.dsh?.model) {
      const r = unwrap(await api.sessions.selectModel({
        sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model,
        reasoningEffort: 'low',      // 标注不需要深思考，省时间省钱
      }), 'session.selectModel');
      console.log('[label] 已设模型', cfg.dsh.provider + '/' + cfg.dsh.model, '| effort low');
    }
  } catch (error) {
    console.warn('[label] ⚠️ 设模型/思考档失败（会用默认，可能很慢）：', error?.message ?? error);
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, at: new Date().toISOString(), preset }, null, 1));
  console.log('[label] 新建标注会话', sessionId, '| preset', preset);
  return sessionId;
}

function parseLabels(text, n) {
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const i = Number(x?.i);
    if (!Number.isInteger(i) || i < 1 || i > n) continue;
    const num = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
    out.push({ i, v: num(x.v), a: num(x.a), d: num(x.d) });
  }
  return out;
}

// ── 4. 跑批次 ─────────────────────────────────────────────────────────────
// --recheck N：抽 N 条**已经标过**的，重新标一遍，看老师自己跟自己一致不一致。
// 这是判断"这任务到底能不能学"的关键实验：老师自相矛盾 → 任何学生都学不到东西。
const RECHECK = Number(argOf('--recheck', 0)) || 0;
if (RECHECK) {
  const labeled = [];
  for (const line of fs.readFileSync(LABELS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { labeled.push(JSON.parse(line)); } catch { /* 坏行 */ }
  }
  const pick = [];
  const stepN = Math.max(1, Math.floor(labeled.length / RECHECK));
  for (let i = 0; i < labeled.length && pick.length < RECHECK; i += stepN) pick.push(labeled[i]);
  const sessionId = await ensureSession();
  startMux();
  const pairs = [];
  for (let i = 0; i < pick.length; i += BATCH) {
    const batch = pick.slice(i, i + BATCH);
    const waiting = waitTurn(sessionId, 180000);
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: buildPrompt(batch) }] });
    let raw = '';
    try { raw = await waiting; } catch (e) { console.error('  重新标注等待失败：', e.message); continue; }
    const labels = parseLabels(raw, batch.length);
    for (const L of labels) {
      const src = batch[L.i - 1];
      if (src) pairs.push({ text: src.text, v1: src.v, v2: L.v, a1: src.a, a2: L.a, d1: src.d, d2: L.d });
    }
    console.log(`  重新标注 ${Math.min(i + BATCH, pick.length)}/${pick.length}`);
  }
  const pearson = (A, B) => {
    const n = A.length;
    const ma = A.reduce((s, x) => s + x, 0) / n;
    const mb = B.reduce((s, x) => s + x, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  const mad = (A, B) => A.reduce((s, x, i) => s + Math.abs(x - B[i]), 0) / A.length;
  console.log(`\n=== 老师自洽性（同一批句子标两遍，n=${pairs.length}）===`);
  console.log(`v：相关 ${pearson(pairs.map((p) => p.v1), pairs.map((p) => p.v2)).toFixed(2)}｜平均绝对差 ${mad(pairs.map((p) => p.v1), pairs.map((p) => p.v2)).toFixed(2)}`);
  console.log(`a：相关 ${pearson(pairs.map((p) => p.a1), pairs.map((p) => p.a2)).toFixed(2)}｜平均绝对差 ${mad(pairs.map((p) => p.a1), pairs.map((p) => p.a2)).toFixed(2)}`);
  console.log(`d：相关 ${pearson(pairs.map((p) => p.d1), pairs.map((p) => p.d2)).toFixed(2)}｜平均绝对差 ${mad(pairs.map((p) => p.d1), pairs.map((p) => p.d2)).toFixed(2)}`);
  console.log('判读：自洽性 <0.5 说明标签本身噪声很大 → 学生再练也学不到（得先改标注方式：加对话上下文/改成三分类）。');
  console.log('\n几组例子（第一遍 vs 第二遍）：');
  for (const p of pairs.slice(0, 8)) console.log(`  ${p.text.slice(0, 24).padEnd(26)} v ${p.v1.toFixed(2)}/${p.v2.toFixed(2)}  a ${p.a1.toFixed(2)}/${p.a2.toFixed(2)}  d ${p.d1.toFixed(2)}/${p.d2.toFixed(2)}`);
  process.exit(0);
}

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

if (DRY) {
  console.log('\n=== 第一条提示词预览 ===\n' + buildPrompt(batches[0]).slice(0, 1200));
  console.log(`\n（dry-run：共 ${batches.length} 批；全量预估输入 ≈ ${Math.round(batches.length * 700 / 1000)}k 字符 ≈ ${Math.round(batches.length * 700 * 0.6 / 1000)}k token 量级）`);
  process.exit(0);
}

const sessionId = await ensureSession();
startMux();

let labeled = 0;
let failed = 0;
const limitBatches = BATCHES || batches.length;
for (let b = 0; b < Math.min(limitBatches, batches.length); b++) {
  const batch = batches[b];
  const prompt = buildPrompt(batch);
  try {
    // ★ 先把等待登记好，再发提示：否则"提示被接受"到"登记等待"之间到达的帧会被丢掉（实测踩过）
    const waiting = waitTurn(sessionId, Number(argOf('--turn-timeout', 300000)) || 300000);
    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
    if (accepted?.result?.ok === false) throw new Error(accepted.result.error?.message ?? 'prompt 被拒');
    let raw = '';
    try {
      raw = await waiting;
    } catch (e) {
      console.error(`[label] 第 ${b + 1} 批等待失败（${e.message}），跳过该批`);
      failed += batch.length;
      continue;
    }
    const labels = parseLabels(raw, batch.length);
    if (labels.length < Math.ceil(batch.length * 0.6)) {
      console.error(`[label] 第 ${b + 1} 批只解析出 ${labels.length}/${batch.length} 条，跳过（原文前 120 字：${raw.slice(0, 120)}）`);
      failed += batch.length;
      continue;
    }
    const lines = [];
    for (const L of labels) {
      const r = batch[L.i - 1];
      if (!r) continue;
      lines.push(JSON.stringify({
        h: r.h, text: r.text,
        ...(CTX ? { prev: r.prev, prevSender: r.prevSender } : {}),
        group: r.group, sender: r.sender, v: L.v, a: L.a, d: L.d, at: Date.now(),
      }));
    }
    fs.appendFileSync(LABELS, lines.join('\n') + '\n', 'utf8');
    labeled += lines.length;
    console.log(`[label] 第 ${b + 1}/${Math.min(limitBatches, batches.length)} 批 ✓ ${lines.length} 条（累计 ${labeled}）`);
  } catch (error) {
    failed += batch.length;
    console.error(`[label] 第 ${b + 1} 批出错：${error?.message ?? error}`);
  }
  await sleep(300);
}

console.log(`\n标注完成：新增 ${labeled} 条，失败/跳过 ${failed} 条 → ${LABELS}`);
console.log('下一步：node scripts/train-emotion-net.mjs');
// ⚠️ 必须显式退出：mux 事件流是常开的 async iterator，不 exit 的话 Node 永远不退
//    （实测踩过：10 批全标完了，但进程挂着不返回，看起来像"卡死"）
process.exit(failed > 0 && labeled === 0 ? 1 : 0);


