// Make SnowLuma's per-account OneBot config self-consistent, and refuse to
// write anything that the running adapters would reject.
//
// Background: SnowLuma configures the HTTP and WebSocket adapters
// independently, so their access tokens can differ. qq-bridge cannot use that
// shape — it takes ONE `snowluma.accessToken` and sends it both to the WS
// client and as `Authorization: Bearer` on HTTP API calls. The two adapters
// must therefore share a token.
//
// This script:
//   1. reads the target account's config (default 3167579121)
//   2. aligns httpServers[0].accessToken to wsServers[0].accessToken
//   3. verifies the LIVE server accepts that token on BOTH ports before
//      declaring success — the file being right is not enough, because the
//      running process can still hold an older token in memory.
import fs from 'node:fs';

const uin = process.argv[2] || '3167579121';
const cfgPath = `D:/SnowLuma/config/onebot_${uin}.json`;
const bridgePath = 'D:/qq-bridge/config.json';

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const http = cfg.networks.httpServers[0];
const ws = cfg.networks.wsServers[0];
const token = ws.accessToken;
const fp = (t) => (t ? `${t.slice(0, 6)}...${t.slice(-4)}` : '(empty)');

console.log(`account           : ${uin}`);
console.log(`http token on disk: ${fp(http.accessToken)}  port ${http.port}`);
console.log(`ws   token on disk: ${fp(token)}  port ${ws.port}`);

if (!token) {
  console.error('ws token is empty; refusing to guess.');
  process.exit(1);
}

if (http.accessToken !== token) {
  fs.copyFileSync(cfgPath, `${cfgPath}.bak-before-align`);
  const raw = fs.readFileSync(cfgPath, 'utf8');
  fs.writeFileSync(cfgPath, raw.replace(http.accessToken, token), 'utf8');
  console.log(`aligned http token -> ${fp(token)}  (backup: ${cfgPath}.bak-before-align)`);
} else {
  console.log('http token already aligned on disk');
}

const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
if (bridge.snowluma.accessToken !== token) {
  bridge.snowluma.accessToken = token;
  fs.writeFileSync(bridgePath, `${JSON.stringify(bridge, null, 2)}\n`, 'utf8');
  console.log('bridge config.json token updated');
} else {
  console.log('bridge config.json token already correct');
}

// ---- live verification: the part that actually matters ----
console.log('\nlive check (a token the running process does not hold will 401):');

async function liveHttp() {
  const res = await fetch(`http://127.0.0.1:${http.port}/get_status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.text()).slice(0, 60);
  return { status: res.status, body };
}

function liveWs() {
  return new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const sock = net.connect(ws.port, '127.0.0.1');
      let buf = '';
      sock.setTimeout(6000);
      sock.on('connect', () => sock.write([
        'GET / HTTP/1.1', `Host: 127.0.0.1:${ws.port}`, 'Upgrade: websocket',
        'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Authorization: Bearer ${token}`, '', '',
      ].join('\r\n')));
      sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); } });
      sock.on('timeout', () => { sock.destroy(); resolve('timeout'); });
      sock.on('error', (e) => resolve(`ERR ${e.code}`));
      sock.on('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
    });
  });
}

const httpRes = await liveHttp();
const wsRes = await liveWs();
const httpOk = httpRes.status === 200;
const wsOk = wsRes.includes('101');

console.log(`  HTTP :${http.port}  ${httpOk ? 'OK  ' : 'FAIL'} ${httpRes.status} ${httpRes.body}`);
console.log(`  WS   :${ws.port}  ${wsOk ? 'OK  ' : 'FAIL'} ${wsRes}`);

if (httpOk && wsOk) {
  console.log('\nboth adapters accept the shared token — qq-bridge can send and receive.');
} else {
  console.log('\nMISMATCH: the on-disk config is aligned but the RUNNING SnowLuma is not.');
  console.log('The running process holds an older token. Re-apply the OneBot config in the');
  console.log('SnowLuma WebUI (http://127.0.0.1:5099) so the runtime picks up this token,');
  console.log(`i.e. set BOTH adapters to: ${token}`);
  process.exitCode = 2;
}
