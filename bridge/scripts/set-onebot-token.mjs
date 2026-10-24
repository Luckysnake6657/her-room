// Point the bridge at the SnowLuma WebSocket access token.
// Node handles UTF-8 correctly, unlike PowerShell's Get-Content/ConvertTo-Json
// round-trip which mangled the Chinese strings in this config.
import fs from 'node:fs';

const onebotPath = 'D:/SnowLuma/config/onebot_3167579121.json';
const bridgePath = 'D:/qq-bridge/config.json';

const onebot = JSON.parse(fs.readFileSync(onebotPath, 'utf8'));
const wsToken = onebot.networks.wsServers[0].accessToken;
const httpToken = onebot.networks.httpServers[0].accessToken;

console.log('SnowLuma http/ws tokens equal :', httpToken === wsToken);
console.log('token fingerprint             :', wsToken.slice(0, 6) + '...' + wsToken.slice(-4), `(len=${wsToken.length})`);

const before = fs.readFileSync(bridgePath, 'utf8');
const cfg = JSON.parse(before);

const prior = cfg.snowluma.accessToken;
cfg.snowluma.accessToken = wsToken;

// Sanity-check that nothing else drifted before writing.
const checks = {
  'wsUrl kept': cfg.snowluma.wsUrl === 'ws://127.0.0.1:3001',
  'httpUrl kept': cfg.snowluma.httpUrl === 'http://127.0.0.1:3000',
  'agentPreset kept': cfg.agentPreset === 'qq-chat',
  'workspaceTitle intact': cfg.workspaceTitle === 'QQ 聊天',
  'chinese keywords intact': cfg.social.mustReplyKeywords.includes('小鲸鱼'),
  'allowAllWhenEmpty kept false': cfg.allowAllWhenEmpty === false,
};
for (const [k, ok] of Object.entries(checks)) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k}`);

if (Object.values(checks).some((v) => !v)) {
  console.error('refusing to write: config drift detected');
  process.exit(1);
}

fs.writeFileSync(bridgePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`accessToken updated: ${prior ? '(was set)' : '(was empty)'} -> set`);

const verify = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
console.log('re-read ok, token matches SnowLuma :', verify.snowluma.accessToken === wsToken);
console.log('ownerQQ =', verify.ownerQQ, '| allow.private =', JSON.stringify(verify.allow.private), '| allow.groups =', JSON.stringify(verify.allow.groups));
