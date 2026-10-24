// 把控制台令牌写死进 config.json，这样桥接每次重启都复用同一个令牌，
// 浏览器不用反复重新输入。
//
// 用 Node 读写：PowerShell 的 Get-Content/ConvertTo-Json 会毁 UTF-8（并且曾经把
// config.json 截成 0 字节），所以配置改动一律走这个脚本方式。
import fs from 'node:fs';

const CONFIG = 'D:/qq-bridge/config.json';
const TOKEN_FILE = 'D:/qq-bridge/state/console-token';

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
  console.error(`令牌内容不合法（长度 ${token.length}），已中止`);
  process.exit(1);
}

const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '');
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  console.error('config.json 解析失败，未修改：' + e.message);
  process.exit(1);
}

fs.copyFileSync(CONFIG, `${CONFIG}.bak-consoletoken`);

const before = cfg.consoleToken ?? null;
cfg.consoleToken = token;

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

// 回读校验
const check = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
console.log('  config.json 已更新');
console.log(`  consoleToken: ${before ? before.slice(0, 8) + '…' : '(原来未设置)'} → ${token.slice(0, 8)}…`);
console.log(`  长度校验: ${check.consoleToken === token ? '✅ 一致' : '❌ 不一致'}`);
console.log(`  备份: ${CONFIG}.bak-consoletoken`);
console.log(`  其他字段保留: mode=${check.mode}, allowGroups=${JSON.stringify(check.allow?.groups)}, ownerQQ=${check.ownerQQ}`);
