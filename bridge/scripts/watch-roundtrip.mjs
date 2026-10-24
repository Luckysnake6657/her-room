// Tail the bridge log for a window, then summarize what happened after a given
// marker line — used to watch a live QQ round-trip end to end.
import fs from 'node:fs';

const marker = process.argv[2] ?? '19:37';
const waitMs = Number(process.argv[3] ?? 90000);
const logPath = 'D:/qq-bridge/state/bridge.log';
const activityPath = 'D:/qq-bridge/state/qq-activity.log';
const toolPath = 'D:/qq-bridge/state/tool-calls.jsonl';

const start = Date.now();
let lastSize = 0;
process.stdout.write(`watching for activity after ${marker} (up to ${Math.round(waitMs / 1000)}s)\n`);

const timer = setInterval(() => {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/);
    const fresh = lines.filter((l) => l.slice(0, 5) >= marker);
    if (fresh.length !== lastSize) {
      lastSize = fresh.length;
      console.log('--- 新日志 ---');
      for (const l of fresh.slice(-12)) console.log(l);
    }
  } catch { /* ignore */ }
  if (Date.now() - start > waitMs) {
    clearInterval(timer);
    finish();
  }
}, 4000);

function finish() {
  console.log('\n================ 汇总 ================');

  console.log('\n[桥接日志] 关键事件:');
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/);
  for (const l of lines.filter((l) => l.slice(0, 5) >= marker)) {
    if (/新会话|已投递|繁忙|发送失败|\[send\]|工具统一发送|唤醒 |DSH|已连接|断开/.test(l)) console.log('  ' + l);
  }

  console.log('\n[QQ 活动] 最近 8 条:');
  for (const l of fs.readFileSync(activityPath, 'utf8').trimEnd().split(/\r?\n/).slice(-8)) console.log('  ' + l);

  console.log('\n[工具调用] 最近 10 条:');
  const toolLines = fs.readFileSync(toolPath, 'utf8').trimEnd().split(/\r?\n/).slice(-10);
  for (const line of toolLines) {
    try {
      const j = JSON.parse(line);
      const tool = String(j.tool ?? '').replace('mcp__snowluma__', '').replace('mcp__snowluma-host__', 'host:');
      let payload = '';
      if (j.args) {
        try {
          const a = typeof j.args === 'string' ? JSON.parse(j.args) : j.args;
          if (a.messages) payload = JSON.stringify(a.messages).slice(0, 70);
          else if (a.message) payload = JSON.stringify(a.message).slice(0, 70);
        } catch { /* not json */ }
      }
      console.log(`  ${j.time.slice(11, 19)} ${j.type.padEnd(6)} ${tool.padEnd(20)} ${j.type === 'result' ? (j.ok ? 'OK' : 'FAIL') : ''} ${payload}`);
    } catch { /* skip */ }
  }

  console.log('\n[sessions.json]');
  console.log('  ' + fs.readFileSync('D:/qq-bridge/state/sessions.json', 'utf8').replace(/\s+/g, ' '));
  process.exit(0);
}
