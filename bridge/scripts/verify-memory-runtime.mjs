// 通过桥接运行时的记忆接口，分别查看私聊/群会话"实际能看到什么"。
// 这是端到端验证：证明核心记忆已加载、且隐私过滤在真实运行路径生效。
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const base = 'http://127.0.0.1:3100';

const tokenOf = (key) => state.conversations?.[key]?.agentToken;

for (const key of ['private:984776985', 'group:1124778377']) {
  const token = tokenOf(key);
  if (!token) { console.log(`\n[${key}] 无 agentToken（会话还没建立？）`); continue; }
  const url = `${base}/api/socialV2/memory?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { headers: { 'x-agent-token': token }, signal: AbortSignal.timeout(8000) });
    console.log(`\n========== [${key}]  GET memory -> ${res.status} ==========`);
    if (!res.ok) { console.log((await res.text()).slice(0, 200)); continue; }
    const j = await res.json();
    console.log('注入给该会话的记忆（formatted）:');
    console.log(j.formatted || '(空)');
    if (j.raw) console.log('raw:', JSON.stringify(j.raw).slice(0, 300));
  } catch (e) {
    console.log(`\n[${key}] 请求失败: ${e.cause?.code ?? e.message}`);
  }
}

console.log('\n========== 文件里的 coreMemory ==========');
console.log(JSON.stringify(state.coreMemory, null, 2).slice(0, 1200));
