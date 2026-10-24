// Narrow down why SnowLuma's HTTP API (port 3000) rejects the token that its
// WebSocket server (port 3001) accepts.
//
// get_status is read-only, so this sends no messages.
import fs from 'node:fs';

const a = JSON.parse(fs.readFileSync('D:/SnowLuma/config/onebot_3167579121.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('D:/SnowLuma/config/onebot_984776985.json', 'utf8'));
const bridge = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));

const tA = a.networks.httpServers[0].accessToken;   // 3167579121 http token
const tAWs = a.networks.wsServers[0].accessToken;   // 3167579121 ws token
const tB = b.networks.httpServers[0].accessToken;   // 984776985 http token
const fp = (t) => (t ? `${t.slice(0, 6)}...${t.slice(-4)}` : '(none)');

const variants = [
  ['Bearer header (as bridge does)', () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tA}` } })],
  ['lowercase bearer header', () => ({ headers: { 'content-type': 'application/json', authorization: `bearer ${tA}` } })],
  ['raw token in Authorization', () => ({ headers: { 'content-type': 'application/json', authorization: tA } })],
  ['X-Self-Token header', () => ({ headers: { 'content-type': 'application/json', 'x-self-token': tA } })],
  ['access_token query param', () => ({ headers: { 'content-type': 'application/json' } }), `?access_token=${encodeURIComponent(tA)}`],
  ['other account http token', () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tB}` } })],
  ['ws token of same account', () => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${tAWs}` } })],
  ['no auth', () => ({ headers: { 'content-type': 'application/json' } })],
];

console.log(`http token A (3167579121) = ${fp(tA)}`);
console.log(`ws   token A (3167579121) = ${fp(tAWs)}`);
console.log(`http token B (984776985)  = ${fp(tB)}`);
console.log('');

for (const [label, mk, suffix = ''] of variants) {
  const { headers } = mk();
  try {
    const res = await fetch(`http://127.0.0.1:3000/get_status${suffix}`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(8000),
    });
    const body = (await res.text()).slice(0, 110);
    console.log(`${res.status === 200 ? 'OK   ' : 'FAIL '} ${label.padEnd(32)} ${res.status}  ${body}`);
  } catch (e) {
    console.log(`ERR   ${label.padEnd(32)} ${e.code || e.message}`);
  }
}
