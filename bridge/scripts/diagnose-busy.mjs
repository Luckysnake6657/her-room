// 判断"会话繁忙"是真卡死还是 agent 正在正常工作。
import fs from 'node:fs';

const logPath = 'D:/qq-bridge/state/bridge.log';
const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/);

console.log('=== 桥接日志：最近 40 行 ===');
for (const l of lines.slice(-40)) console.log('  ' + l);

console.log('\n=== 事件流重连次数统计 ===');
const reconn = lines.filter((l) => /连接 DSH 事件流/.test(l));
const broken = lines.filter((l) => /事件流中断/.test(l));
console.log(`  连接 DSH 事件流: ${reconn.length} 次；事件流中断: ${broken.length} 次`);
console.log('  最近 6 次中断原因:');
for (const l of broken.slice(-6)) console.log('    ' + l);

const st = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8')).conversations?.['private:984776985'] ?? {};
const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '-');
const now = Date.now();
console.log('\n=== 私聊会话状态 ===');
console.log('  lastIncomingAt :', fmt(st.lastIncomingAt), `（${Math.round((now - (st.lastIncomingAt || 0)) / 1000)} 秒前）`);
console.log('  lastAiReplyAt  :', fmt(st.lastAiReplyAt), `（${Math.round((now - (st.lastAiReplyAt || 0)) / 1000)} 秒前）`);
console.log('  lastActionAt   :', fmt(st.lastActionAt), `（${Math.round((now - (st.lastActionAt || 0)) / 1000)} 秒前）`);
console.log('  lastWakeReason :', st.lastWakeReason);
console.log('  wakeTimes 最近 5 次:', (st.wakeTimes ?? []).slice(-5).map((t) => new Date(t).toLocaleTimeString('zh-CN')).join(', '));
console.log('  unread 条数    :', (st.unread ?? []).length);

console.log('\n=== 最近工具调用 ===');
const tc = fs.readFileSync('D:/qq-bridge/state/tool-calls.jsonl', 'utf8').trimEnd().split(/\r?\n/).slice(-14);
for (const line of tc) {
  try {
    const j = JSON.parse(line);
    const tool = String(j.tool ?? '').replace('mcp__snowluma__', '');
    let args = '';
    if (j.args) {
      try {
        const a = typeof j.args === 'string' ? JSON.parse(j.args) : j.args;
        args = JSON.stringify(a.messages ?? a.message ?? a.timeoutMs ?? '').slice(0, 70);
      } catch { /* ignore */ }
    }
    console.log(`  ${j.time.slice(11, 19)} ${j.type.padEnd(6)} ${tool.padEnd(22)} ${j.type === 'result' ? (j.ok ? 'OK' : 'FAIL') : ''} ${args}`);
  } catch { /* skip */ }
}
