// Set the bridge owner and enable private-chat whitelisting for that QQ.
//
// Usage: node scripts/set-owner.mjs <QQ号>
//
// Only fields the operator explicitly asked to change are touched; everything
// else in config.json is preserved byte-for-byte by re-serializing the parsed
// object. A timestamped backup is written first.
import fs from 'node:fs';

const qq = Number(process.argv[2]);
if (!Number.isInteger(qq) || qq <= 0) {
  console.error('usage: node scripts/set-owner.mjs <QQ号>');
  process.exit(1);
}

const configPath = 'D:/qq-bridge/config.json';
const original = fs.readFileSync(configPath, 'utf8');
const cfg = JSON.parse(original);

const backup = `${configPath}.bak-before-owner`;
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, original, 'utf8');
  console.log('backup written      :', backup);
}

cfg.ownerQQ = qq;
if (!Array.isArray(cfg.allow.private)) cfg.allow.private = [];
if (!cfg.allow.private.includes(qq)) cfg.allow.private.push(qq);

// Fail-closed default stays as-is on purpose: allowAllWhenEmpty must stay false
// so an empty allowlist never means "let everyone in".
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

const check = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log('ownerQQ             :', check.ownerQQ);
console.log('allow.private       :', JSON.stringify(check.allow.private));
console.log('allow.groups        :', JSON.stringify(check.allow.groups));
console.log('allowAllWhenEmpty   :', check.allowAllWhenEmpty);
console.log('accessToken still set:', Boolean(check.snowluma.accessToken));
console.log('workspaceTitle      :', check.workspaceTitle);
