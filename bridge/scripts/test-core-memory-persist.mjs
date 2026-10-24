// 端到端验证跨会话记忆的持久化：写入 → 重启 → 读回。
// 用法: node scripts/test-core-memory-persist.mjs
import fs from 'node:fs';

const consoleToken = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
const base = 'http://127.0.0.1:3100';
const key = 'private:984776985';
const marker = `持久化测试-${Date.now()}`;

const state0 = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
console.log('写入前 coreMemory:',
  `话题 ${state0.coreMemory?.activeTopics?.length ?? '无'} / 印象 ${Object.keys(state0.coreMemory?.memberImpressions ?? {}).length}`);
console.log('写入前会话内 activeTopics:', (state0.conversations?.[key]?.activeTopics ?? []).length);

const res = await fetch(`${base}/api/socialV2/memory-append`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
  body: JSON.stringify({ key, category: 'pendingThought', content: marker, extra: { motivation: 'curiosity' } }),
  signal: AbortSignal.timeout(10000),
});
console.log('\nPOST memory-append ->', res.status);
console.log((await res.text()).slice(0, 250));

const state1 = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const inCore = (state1.coreMemory?.pendingThoughts ?? []).some((t) => t.text === marker);
const inConv = (state1.conversations?.[key]?.pendingThoughts ?? []).some((t) => t.text === marker);
console.log('\n落盘后：');
console.log('  全局 coreMemory 含该条 :', inCore ? '✅' : '❌');
console.log('  会话内 含该条         :', inConv ? '✅' : '❌');
const entry = (state1.coreMemory?.pendingThoughts ?? []).find((t) => t.text === marker);
if (entry) console.log('  该条 source           :', entry.source);
console.log('\n标记（重启后用它复查）:', marker);

fs.writeFileSync('D:/deepseekharness/persist-marker.txt', marker, 'utf8');

// ⚠️ 这是**唯一一个往真实桥接/真实记忆里写的用例**（端到端，别的方式验不了"重启后还在"）。
// 所以必须自己收拾干净：否则每跑一次批测就往她的【你想说但还没说的】里塞一条
// "持久化测试-<epoch>"（实测攒了 6 条，还被她当自己的念头读到）。
for (const category of ['pendingThought', 'activeTopic']) {
  const r = await fetch(`${base}/api/socialV2/memory-remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
    body: JSON.stringify({ key, category, content: marker }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  console.log(`清理 ${category} ->`, r?.status ?? '失败');
}
const state2 = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const left = [
  ...(state2.coreMemory?.pendingThoughts ?? []),
  ...(state2.conversations?.[key]?.pendingThoughts ?? []),
].filter((t) => t.text === marker).length;
console.log('清理后残留:', left === 0 ? '✅ 0 条（两边都干净）' : `❌ ${left} 条还在`);
