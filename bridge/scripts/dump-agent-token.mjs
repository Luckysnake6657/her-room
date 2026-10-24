// Refresh the QQ conversation agent token into a file, then verify it against
// the bridge's v2 status endpoint. Needed because each bridge restart mints new
// per-conversation tokens.
import fs from 'node:fs';

const s = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const key = 'private:984776985';
const st = s.conversations?.[key];
if (!st?.agentToken) {
  console.error('no agent token for', key);
  process.exit(1);
}
fs.writeFileSync('D:/deepseekharness/agenttoken.txt', st.agentToken, 'utf8');
console.log('token length:', st.agentToken.length, '(written to workspace temp file)');

const res = await fetch(`http://127.0.0.1:3100/api/socialV2/state?key=${encodeURIComponent(key)}`, {
  headers: { 'x-agent-token': st.agentToken },
  signal: AbortSignal.timeout(8000),
});
console.log('state endpoint:', res.status);
if (res.ok) {
  const j = await res.json();
  console.log('agentToken accepted ✅');
  console.log('mode:', j.state?.wakeConfig?.mode, '| lastIncomingAt:', j.state?.lastIncomingAt);
}
