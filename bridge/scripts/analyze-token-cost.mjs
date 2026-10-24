// 从真实会话日志统计"一次唤醒"的 token 成本，用于估算不同群规模下的消耗。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const root = 'C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--';

function readSession(dir) {
  // 会话格式升级后同一目录里会同时躺着 v3 和 v4（v3 已冻结），必须挑活的那个
  const file = sessionFileIn(dir);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  }
  let text = '';
  for (let i = 0; i < offs.length; i++) {
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* skip */ }
  }
  const recs = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { recs.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return recs;
}

const dirs = fs.readdirSync(root)
  .filter((d) => d.startsWith('session-'))
  .map((d) => ({ d, mtime: fs.statSync(`${root}/${d}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const { d } of dirs) {
  const recs = readSession(`${root}/${d}`);
  if (!recs?.length) continue;
  const head = recs.find((r) => r.type === 'session');
  const preset = head?.agentPreset ?? '?';
  const msgs = recs.filter((r) => r.type === 'assistant/message');
  if (!msgs.length) continue;

  let inSum = 0, outSum = 0, reasonSum = 0, cacheSum = 0;
  const perStep = [];
  for (const m of msgs) {
    const u = m.data?.usage ?? {};
    inSum += u.inputTokens ?? 0;
    outSum += u.outputTokens ?? 0;
    reasonSum += u.reasoningTokens ?? 0;
    cacheSum += u.cacheReadTokens ?? 0;
    perStep.push({ in: u.inputTokens ?? 0, out: u.outputTokens ?? 0, reason: u.reasoningTokens ?? 0 });
  }
  const turns = recs.filter((r) => r.type === 'turn/start').length || 1;
  const toolCalls = recs.filter((r) => r.type === 'tool/call').length;

  console.log(`\n=== ${d} (preset=${preset}) ===`);
  console.log(`  模型步数 ${msgs.length}，turn ${turns}，工具调用 ${toolCalls}`);
  console.log(`  输入合计 ${inSum}，其中缓存读取 ${cacheSum}，输出 ${outSum}（含推理 ${reasonSum}）`);
  console.log(`  平均每 turn：输入 ${Math.round(inSum / turns)} / 输出 ${Math.round(outSum / turns)} / 推理 ${Math.round(reasonSum / turns)}`);
  console.log(`  平均每步：输入 ${Math.round(inSum / msgs.length)} / 输出 ${Math.round(outSum / msgs.length)}`);
  console.log('  各步明细(in/out/reason): ' + perStep.map((s) => `${s.in}/${s.out}/${s.reason}`).join('  '));
}
