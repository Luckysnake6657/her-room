// 查证 AI 反馈的"qq_wait_for_messages 间歇 fetch failed"是否真实：
// 看最近的工具调用记录里该工具的成败分布与时间点。
import fs from 'node:fs';

const lines = fs.readFileSync('D:/qq-bridge/state/tool-calls.jsonl', 'utf8').trimEnd().split(/\r?\n/);
const recs = [];
for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* skip */ } }

const wait = recs.filter((r) => String(r.tool ?? '').includes('wait_for_messages'));
console.log(`qq_wait_for_messages 记录数: ${wait.length}`);
const results = wait.filter((r) => r.type === 'result');
const ok = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
console.log(`  成功 ${ok} / 失败 ${fail}`);
console.log('\n最近 12 条:');
for (const r of wait.slice(-12)) {
  console.log(`  ${r.time.slice(11, 19)} ${r.type.padEnd(6)} ${r.ok === undefined ? '' : r.ok ? '✅' : '❌'}  ${r.key}`);
}

console.log('\n所有失败的时间点:');
for (const r of results.filter((x) => x.ok === false)) {
  console.log(`  ${r.time.slice(11, 19)}  ${r.key}  error=${JSON.stringify(r.error ?? null).slice(0, 80)}`);
}

console.log('\n=== AI 反馈记录 ===');
try {
  const fb = JSON.parse(fs.readFileSync('D:/qq-bridge/state/feedback.json', 'utf8'));
  console.log(JSON.stringify(fb, null, 2).slice(0, 1200));
} catch (e) {
  console.log('(读取失败) ' + e.message);
}
