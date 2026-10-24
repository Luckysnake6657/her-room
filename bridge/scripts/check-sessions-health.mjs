// 检查两个 QQ 会话的 DSH 侧状态：turn/step 是否闭合、最后活动时间。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const root = 'C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--';
const sessions = JSON.parse(fs.readFileSync('D:/qq-bridge/state/sessions.json', 'utf8'));

function analyze(sessionId) {
  // v3 已冻结：写死它会让 turn/step 永远停在升级前，看着像"卡住了"
  const file = sessionFileIn(`${root}/${sessionId}`);
  if (!fs.existsSync(file)) return { sessionId, error: '文件不存在' };
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
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
  const count = (t) => recs.filter((r) => r.type === t).length;
  const last = recs[recs.length - 1];
  const lastTool = [...recs].reverse().find((r) => r.type === 'tool/call');
  const lastAsst = [...recs].reverse().find((r) => r.type === 'assistant/message');
  const when = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '?');
  return {
    sessionId,
    bytes: buf.length,
    mtime: fs.statSync(file).mtime,
    turns: [count('turn/start'), count('turn/end')],
    steps: [count('step/start'), count('step/end')],
    lastType: last?.type,
    lastTime: last?.time,
    lastTool: lastTool ? String(lastTool.data?.name ?? '').replace('mcp__snowluma__', '') : null,
    lastToolTime: lastTool?.time,
    lastAsstTime: lastAsst?.time,
  };
}

for (const [key, sid] of Object.entries(sessions.sessions)) {
  const a = analyze(sid);
  console.log(`\n=== ${key} ===`);
  if (a.error) { console.log('  ' + a.error); continue; }
  const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '?');
  console.log('  会话文件最后写入 :', a.mtime.toLocaleString('zh-CN'), `(${Math.round((Date.now() - a.mtime) / 1000)} 秒前)`);
  console.log('  turn   start/end :', a.turns.join(' / '), a.turns[0] === a.turns[1] ? '✅ 闭合' : '⚠️ 有未闭合');
  console.log('  step   start/end :', a.steps.join(' / '), a.steps[0] === a.steps[1] ? '✅ 闭合' : '⚠️ 有未闭合');
  console.log('  最后一条记录     :', a.lastType, '@', fmt(a.lastTime));
  console.log('  最后工具调用     :', a.lastTool, '@', fmt(a.lastToolTime));
  console.log('  最后模型消息     :', fmt(a.lastAsstTime));
}
