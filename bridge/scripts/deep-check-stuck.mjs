// 深查：会话文件持续被写但 turn 未闭合 —— 到底是卡在哪个工具的哪一步。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

// 会话格式升级后同一目录里 v3/v4 并存（v3 已冻结），别写死 v3
const file = sessionFileIn('C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/session-96b51f4a-a75a-4bdb-9f35-50953ad8d609');
const root = 'C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--';

// 先找出群会话的真实 ID（日志里出现过 session-96b51f4a）
console.log('=== 目录里最新的会话 ===');
for (const d of fs.readdirSync(root).map((n) => ({ n, m: fs.statSync(`${root}/${n}`).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 3)) {
  const f = sessionFileIn(`${root}/${d.n}`);
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  console.log(`  ${d.n}  ${new Date(d.m).toLocaleString('zh-CN')}  ${Math.round(size / 1024)}KB`);
}

if (!fs.existsSync(file)) { console.log('\n目标文件不存在'); process.exit(0); }

const buf = fs.readFileSync(file);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
}
console.log(`\n文件 ${Math.round(buf.length / 1024)}KB，${offs.length} 帧`);

const recs = [];
const framesText = [];
for (let i = 0; i < offs.length; i++) {
  const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
  let t = '';
  try { t = zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { continue; }
  framesText.push(t);
  for (const l of t.split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
}

// 去重（同一记录可能被重写多帧）
const seen = new Set();
const uniq = [];
for (const r of recs) {
  const k = `${r.type}|${r.seq ?? ''}|${r.time ?? ''}`;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(r);
}
console.log(`原始记录 ${recs.length} 条 -> 去重后 ${uniq.length} 条`);

const when = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '?');
console.log('\n=== 去重后最后 16 条 ===');
for (const r of uniq.slice(-16)) {
  let extra = '';
  if (r.type === 'tool/call') extra = String(r.data?.name ?? '').replace('mcp__snowluma__', '') + ' ' + JSON.stringify(r.data?.arguments ?? '').slice(0, 120);
  else if (r.type === 'tool/result') extra = r.data?.ok === false ? 'FAIL' : 'OK';
  else if (r.type === 'step/start') extra = 'step ' + (r.data?.step ?? '');
  else if (r.type === 'turn/start') extra = 'turn ' + (r.data?.turn ?? '');
  else if (r.type === 'assistant/message') { const u = r.data?.usage ?? {}; extra = `in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0}`; }
  console.log(`  ${when(r.time)} ${String(r.type).padEnd(20)} ${extra}`);
}

const cnt = (t) => uniq.filter((r) => r.type === t).length;
console.log('\n=== 闭合情况（去重后）===');
console.log(`  turn: ${cnt('turn/start')} / ${cnt('turn/end')}`);
console.log(`  step: ${cnt('step/start')} / ${cnt('step/end')}`);
console.log(`  tool/call: ${cnt('tool/call')} / tool/result: ${cnt('tool/result')}`);

// 最后一个未闭合 step 的工具调用
const lastCall = [...uniq].reverse().find((r) => r.type === 'tool/call');
const lastResult = [...uniq].reverse().find((r) => r.type === 'tool/result');
console.log('\n=== 最后一个工具调用 vs 最后一个结果 ===');
console.log('  最后 tool/call  :', when(lastCall?.time), String(lastCall?.data?.name ?? '').replace('mcp__snowluma__', ''));
console.log('  最后 tool/result:', when(lastResult?.time));
if (lastCall && lastResult && Number(lastCall.time) > Number(lastResult.time)) {
  console.log('  => ⚠️ 有一个工具调用没有返回结果，turn 卡在它上面');
  console.log('     参数:', JSON.stringify(lastCall.data?.arguments ?? '').slice(0, 300));
}
