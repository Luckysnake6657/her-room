// Activate a persona card through the bridge's local console API.
//
// Polls until the console answers (the bridge may still be booting), then sets
// the current role and prints the injected hint length so we can prove the card
// is actually reaching the agent.
import fs from 'node:fs';

const role = process.argv[2] || '小鲸鱼2';
const token = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
const base = 'http://127.0.0.1:3100';
const headers = { 'content-type': 'application/json', 'x-console-token': token };

async function waitReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/roles`, { headers, signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
      if (r.status === 401) throw new Error('console token rejected (401)');
    } catch (e) {
      if (e.message?.includes('401')) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

if (!(await waitReady())) {
  console.error('console did not come up within 90s');
  process.exit(1);
}

const list = await (await fetch(`${base}/api/roles`, { headers })).json();
console.log('available roles:', JSON.stringify(list.roles));
console.log('current role   :', JSON.stringify(list.current));

const res = await fetch(`${base}/api/role`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ role }),
});
console.log(`POST /api/role {role:${role}} -> ${res.status} ${(await res.text()).slice(0, 200)}`);

const after = await (await fetch(`${base}/api/roles`, { headers })).json();
console.log('current role now:', JSON.stringify(after.current));

const stateFile = 'D:/qq-bridge/state/current-role.json';
if (fs.existsSync(stateFile)) {
  console.log('state/current-role.json:', fs.readFileSync(stateFile, 'utf8').replace(/\s+/g, ' '));
}
