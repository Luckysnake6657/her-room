// Restore D:\qq-bridge\config.json from the shipped template, then apply the
// one non-default value we need (the OneBot access token).
//
// Written after a PowerShell Get-Content/ConvertTo-Json round-trip truncated the
// original config.json to 0 bytes. Node is used here because it reads and writes
// UTF-8 correctly.
import fs from 'node:fs';

const templatePath = 'D:/qq-bridge/config.example.json';
const bridgePath = 'D:/qq-bridge/config.json';
const onebotPath = 'D:/SnowLuma/config/onebot_3167579121.json';

const onebot = JSON.parse(fs.readFileSync(onebotPath, 'utf8'));
const wsToken = onebot.networks.wsServers[0].accessToken;
const httpToken = onebot.networks.httpServers[0].accessToken;
if (wsToken !== httpToken) {
  console.error('SnowLuma adapters still disagree on the token; fix that first.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

// Apply our intentional deviation from the template.
cfg.snowluma.accessToken = wsToken;

// Keep a backup copy of the template-derived baseline for future recovery.
fs.copyFileSync(templatePath, `${bridgePath}.template.bak`);

fs.writeFileSync(bridgePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

const check = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
console.log('restored config.json');
console.log('  bytes                    :', fs.statSync(bridgePath).size);
console.log('  parses as JSON           : true');
console.log('  snowluma.accessToken set :', check.snowluma.accessToken === wsToken);
console.log('  wsUrl                    :', check.snowluma.wsUrl);
console.log('  httpUrl                  :', check.snowluma.httpUrl);
console.log('  consolePort              :', check.consolePort);
console.log('  workspaceTitle           :', check.workspaceTitle);
console.log('  allowAllWhenEmpty        :', check.allowAllWhenEmpty);
console.log('  allow.private / groups   :', JSON.stringify(check.allow.private), '/', JSON.stringify(check.allow.groups));
console.log('  socialV2.enabled         :', check.socialV2.enabled);
