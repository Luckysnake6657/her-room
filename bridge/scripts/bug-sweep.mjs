/**
 * 「还有没有 bug」体检：把四处证据一起打出来。
 *   ① 她自己报的问题（qq_report_feedback，state/feedback.json）
 *   ② 今天所有**工具调用失败**按工具 + 原因归类（原因字段 2026-10-01 才修好，所以只信新的）
 *   ③ bridge.log 里的 ⚠️/错误/失败 行（重启之后的部分）
 *   ④ 每个会话的运行健康：卡住的等待、未读、唤醒配置是否"永远叫不醒"、发送额度
 */
import fs from 'node:fs';

const line = (s) => console.log(s);
const T = (t) => new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

line('=== ① 她自己报的问题（feedback.json，最新 10 条）===');
try {
  const fb = JSON.parse(fs.readFileSync('state/feedback.json', 'utf8'));
  const list = Array.isArray(fb) ? fb : (fb.entries ?? []);
  if (!list.length) line('  （空——她没报过问题）');
  for (const f of list.slice(-10)) {
    line(`  [${f.level ?? 'info'}] ${T(f.at ?? f.time)} ${String(f.message ?? f.text ?? '').slice(0, 160)}`);
  }
  line(`  合计 ${list.length} 条`);
} catch (e) { line('  读不到: ' + e.message); }

line('\n=== ② 今天工具调用失败的原因归类（只统计"原因非空"的，旧记录原因是 null）===');
try {
  const rows = fs.readFileSync('state/tool-calls.jsonl', 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const fails = rows.filter((e) => e.type === 'result' && e.ok === false);
  const withReason = fails.filter((f) => f.error);
  const tally = new Map();
  for (const f of withReason) {
    const tool = String(f.tool ?? '').replace(/^mcp__[a-z-]+__/, '');
    const key = `${tool} :: ${String(f.error).slice(0, 60)}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  line(`  失败总数 ${fails.length}（其中有原因的 ${withReason.length}）`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`   x${n}  ${k}`);
} catch (e) { line('  读不到: ' + e.message); }

line('\n=== ③ bridge.log 里的异常行（重启之后）===');
try {
  const lines = fs.readFileSync('state/bridge.log', 'utf8').split('\n').filter(Boolean);
  // 找最后一次"桥接已启动"，只看之后的
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) { if (/妗ユ帴宸插惎鍔▄|桥接已启动/.test(lines[i])) { start = i; break; } }
  const tail = lines.slice(start);
  const bad = tail.filter((l) => /⚠️|错误|失败|Error|error|拒绝|异常|超时|重试/.test(l) && !/忽略未授权会话/.test(l));
  line(`  重启后 ${tail.length} 行，其中异常 ${bad.length} 行：`);
  for (const l of bad.slice(-15)) line('   ' + l.replace(/[^\x20-\x7E\u4e00-\u9fa5，。：；（）「」【】…·—]/g, '.').slice(0, 170));
} catch (e) { line('  读不到: ' + e.message); }

line('\n=== ④ 会话运行健康 ===');
try {
  const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
  const now = Date.now();
  for (const [key, c] of Object.entries(st.conversations ?? {})) {
    const wc = c.wakeConfig ?? {};
    const tr = wc.triggers ?? {};
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke
      || (Array.isArray(tr.keywords) && tr.keywords.length) || Number(tr.probability) > 0
      || (!wc.infinite && wc.sleepUntil && Date.parse(wc.sleepUntil) > now);
    const stuckWait = c.waitingUntil && Number(c.waitingUntil) > now + 6 * 60 * 1000;
    line(`  ${key}`);
    line(`    未读 ${(c.unread ?? []).length}｜唤醒 ${wc.mode}/${wc.infinite ? '无限' : (wc.sleepUntil ?? '未设')}｜可被叫醒=${wakeable}｜卡住的长等待=${stuckWait ? '是' : '否'}`);
    line(`    最近发言 ${c.lastAiReplyAt ? Math.round((now - c.lastAiReplyAt) / 60000) + ' 分钟前' : '无'}｜发送额度记录 ${(c.sendTimes ?? []).length} 条｜待追问 ${(c.pendingThoughts ?? []).length}`);
    if (!wakeable) line('    ⚠️ 这个会话配置成"永远叫不醒"（ensureWakeableV2 应该已经兜底，除非刚被改）');
  }
} catch (e) { line('  读不到: ' + e.message); }
