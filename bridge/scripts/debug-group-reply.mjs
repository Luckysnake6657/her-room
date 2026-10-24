// 复盘群里这次对话：投递给 agent 的到底包含什么，以及它做了什么。
import fs from 'node:fs';

const lines = fs.readFileSync('D:/qq-bridge/state/bridge.log', 'utf8').trimEnd().split(/\r?\n/);
console.log('=== 桥接日志：15:53 前后 ===');
for (const l of lines.slice(-45)) {
  if (/15:5[0-9]|16:0[0-9]/.test(l)) console.log('  ' + l);
}

console.log('\n=== 该群的会话状态：最近消息 ===');
const s = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
for (const [key, c] of Object.entries(s.conversations ?? {})) {
  if (!key.startsWith('group:')) continue;
  console.log(`\n[${key}]`);
  for (const m of (c.recentMessages ?? []).slice(-12)) {
    const t = m.time ? new Date(m.time).toLocaleTimeString('zh-CN') : '?';
    console.log(`  ${t} ${m.isSelf ? '(机器人)' : '(' + (m.sender ?? '?') + ')'} text=${JSON.stringify(m.text)} media=${(m.media ?? []).length} hasMedia=${m.hasMedia}`);
    for (const md of m.media ?? []) console.log(`        媒体: kind=${md.kind} summary=${JSON.stringify(md.summary ?? '')} subType=${JSON.stringify(md.subType ?? '')}`);
  }
  console.log(`  lastWakeReason=${c.lastWakeReason} | wakeTimes=${(c.wakeTimes ?? []).length}`);
}

console.log('\n=== 工具调用 ===');
const tc = fs.readFileSync('D:/qq-bridge/state/tool-calls.jsonl', 'utf8').trimEnd().split(/\r?\n/).slice(-14);
for (const line of tc) {
  try {
    const j = JSON.parse(line);
    const tool = String(j.tool ?? '').replace('mcp__snowluma__', '');
    let args = '';
    if (j.args) {
      try {
        const a = typeof j.args === 'string' ? JSON.parse(j.args) : j.args;
        args = JSON.stringify(a.messages ?? a.message ?? a).slice(0, 100);
      } catch { args = String(j.args).slice(0, 100); }
    }
    console.log(`  ${j.time.slice(11, 19)} ${j.type.padEnd(6)} ${tool.padEnd(20)} ${j.type === 'result' ? (j.ok ? 'OK' : 'FAIL') : ''} ${args}`);
  } catch { /* skip */ }
}
