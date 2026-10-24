// 核对 config.json 的关键字段（避免 shell 引号转义问题）。
import fs from 'node:fs';

const c = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, ''));
// consoleToken 允许不写：桥接会自己生成一份并持久化到 state/console-token（重启不变）。
// 只看 config 会把这种情况报成"❌ 未设置"，误导排查（所以这里回退读那个文件）。
const autoTokenFile = 'D:/qq-bridge/state/console-token';
const autoToken = fs.existsSync(autoTokenFile) ? fs.readFileSync(autoTokenFile, 'utf8').trim() : '';
const mask = (t) => (t ? `${t.slice(0, 8)}…(${t.length}位)` : '❌ 未设置');

console.log('  JSON 解析: ✅ 合法');
console.log(`  consoleToken : ${c.consoleToken ? mask(c.consoleToken) : (autoToken ? `${mask(autoToken)} ← 自动生成（state/console-token）` : '❌ 未设置')}`);
console.log(`  allow.groups : ${JSON.stringify(c.allow?.groups)}`);
console.log(`  allow.private: ${JSON.stringify(c.allow?.private)}`);
console.log(`  ownerQQ      : ${c.ownerQQ}`);
console.log(`  socialV2.agentPreset        : ${c.socialV2?.agentPreset}`);
console.log(`  send.recommendedHint 已改为单气泡: ${c.socialV2?.send?.recommendedHint?.includes('默认只发一个气泡') ? '✅' : '❌'}`);
console.log(`  send.maxMessageChars        : ${c.socialV2?.send?.maxMessageChars}`);
console.log(`  wake.maxWakePerHour         : ${c.socialV2?.wake?.maxWakePerHour}`);
console.log(`  wake.recommendedProbability : ${c.socialV2?.wake?.recommendedProbability}`);
