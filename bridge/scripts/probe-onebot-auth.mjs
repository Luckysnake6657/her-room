// Which OneBot access token does the running SnowLuma actually accept?
//
// Sends no real message: get_status is a read-only OneBot action.
// Verifies both adapters (HTTP API 3000 and WS 3001) with both candidate
// tokens, so we can tell whether the token we wrote to disk is the one the
// running process actually holds in memory.
import fs from 'node:fs';
import net from 'node:net';

const cfgPath = 'D:/SnowLuma/config/onebot_3167579121.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const httpCfg = cfg.networks.httpServers[0];
const wsCfg = cfg.networks.wsServers[0];

const bridge = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));

const candidates = {
  'config-file HTTP token': httpCfg.accessToken,
  'config-file WS token': wsCfg.accessToken,
  'bridge config token': bridge.snowluma.accessToken,
  'no token': null,
};

const fp = (t) => (t ? `${t.slice(0, 6)}...${t.slice(-4)}` : '(none)');

async function tryHttp(label, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${bridge.snowluma.httpUrl}/get_status`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    const text = (await res.text()).slice(0, 90);
    console.log(`  HTTP  [${label.padEnd(22)} ${fp(token).padEnd(16)}] ${res.status} ${text}`);
  } catch (e) {
    console.log(`  HTTP  [${label.padEnd(22)} ${fp(token).padEnd(16)}] ERR ${e.code || e.message}`);
  }
}

function tryWs(label, token) {
  return new Promise((resolve) => {
    const headers = [
      'GET / HTTP/1.1',
      'Host: 127.0.0.1:3001',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    const sock = net.connect(3001, '127.0.0.1');
    let buf = '';
    sock.setTimeout(6000);
    sock.on('connect', () => sock.write(headers.join('\r\n') + '\r\n\r\n'));
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const status = buf.split('\r\n')[0];
        const ok = status.includes('101');
        console.log(`  WS    [${label.padEnd(22)} ${fp(token).padEnd(16)}] ${ok ? 'ACCEPTED' : 'REJECTED'} (${status})`);
        sock.destroy();
        resolve();
      }
    });
    sock.on('timeout', () => { console.log(`  WS    [${label}] timeout`); sock.destroy(); resolve(); });
    sock.on('error', (e) => { console.log(`  WS    [${label}] ERR ${e.code}`); resolve(); });
    sock.on('close', () => resolve());
  });
}

console.log('=== HTTP API (port 3000, used by send_private_msg) ===');
for (const [label, token] of Object.entries(candidates)) await tryHttp(label, token);
console.log('=== WebSocket (port 3001) ===');
for (const [label, token] of Object.entries(candidates)) await tryWs(label, token);
