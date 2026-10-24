// Summarize recent qq-bridge activity: which sends succeeded after the token fix.
import fs from 'node:fs';

const lines = fs.readFileSync('D:/qq-bridge/state/tool-calls.jsonl', 'utf8').trimEnd().split(/\r?\n/);
const recent = lines.filter((l) => l.includes('2026-09-24T19:2') || l.includes('2026-09-24T19:3'));

console.log('=== tool calls since 19:20 (UTC) ===');
for (const line of recent) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  const tool = String(j.tool ?? '').replace('mcp__snowluma__', '').replace('mcp__snowluma-host__', 'host:');
  let payload = '';
  if (j.args) {
    try {
      const a = typeof j.args === 'string' ? JSON.parse(j.args) : j.args;
      if (a.messages) payload = JSON.stringify(a.messages).slice(0, 90);
      else if (a.message) payload = JSON.stringify(a.message).slice(0, 90);
      else if (a.timeoutMs) payload = `timeoutMs=${a.timeoutMs}`;
    } catch { /* args not JSON */ }
  }
  const verdict = j.type === 'result' ? (j.ok ? 'OK  ' : 'FAIL') : '    ';
  console.log(`${j.time.slice(11, 19)}  ${j.type.padEnd(6)} ${tool.padEnd(24)} ${verdict} ${payload}`);
}

console.log('\n=== qq-activity.log (last 10) ===');
const act = fs.readFileSync('D:/qq-bridge/state/qq-activity.log', 'utf8').trimEnd().split(/\r?\n/);
console.log(act.slice(-10).join('\n'));

console.log('\n=== bridge.log send outcomes ===');
const blog = fs.readFileSync('D:/qq-bridge/state/bridge.log', 'utf8').trimEnd().split(/\r?\n/);
for (const l of blog) {
  if (/QQ 发送失败|成功 \d|已投递|暂时|繁忙/.test(l)) console.log(l);
}
