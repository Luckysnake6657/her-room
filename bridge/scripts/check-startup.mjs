// Show the tail of the bridge log for the most recent startup, so a restart can
// be verified clean: whitelist, SnowLuma, DSH, mode, role, and any errors.
import fs from 'node:fs';

const lines = fs.readFileSync('D:/qq-bridge/state/bridge.log', 'utf8').trimEnd().split(/\r?\n/);

// find the last "桥接已启动" block
let startIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('桥接已启动')) { startIdx = i; break; }
}
const block = startIdx >= 0 ? lines.slice(startIdx) : lines.slice(-25);

console.log(`=== 最近一次启动（第 ${startIdx + 1} 行起，共 ${block.length} 行）===`);
for (const l of block) console.log(l);

console.log('\n=== 本次启动的问题扫描 ===');
const bad = block.filter((l) => /错误|失败|unauthorized|401|断开|异常|⚠️|拒绝/.test(l));
if (bad.length === 0) console.log('  ✅ 无错误 / 无鉴权失败 / 无断开');
else bad.forEach((l) => console.log('  ⚠️  ' + l));

console.log('\n=== 关键状态 ===');
const has = (re) => block.some((l) => re.test(l));
const checks = [
  ['白名单已加载（无"白名单为空"警告）', !has(/白名单为空/)],
  ['SnowLuma 已连接', has(/SnowLuma 已连接/)],
  ['DSH 已就绪', has(/DSH 已就绪/)],
  ['模式已确定', has(/桥接模式已确定为/)],
  ['收藏表情已同步', has(/已同步 QQ 收藏表情/)],
  ['无发送失败', !has(/QQ 发送失败/)],
];
for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '⚠️ '} ${name}`);

console.log('\n=== 配置快照 ===');
const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
console.log('  角色         :', fs.readFileSync('D:/qq-bridge/state/current-role.json', 'utf8').replace(/\s+/g, ' '));
console.log('  ownerQQ      :', cfg.ownerQQ);
console.log('  allow.private:', JSON.stringify(cfg.allow.private), '| allow.groups:', JSON.stringify(cfg.allow.groups));
console.log('  唤醒关键词   :', JSON.stringify(cfg.socialV2.wake.recommendedKeywords), '（空=不靠关键词）');
console.log('  必回关键词   :', JSON.stringify(cfg.social.mustReplyKeywords));
console.log('  角色卡       : roles/程莫雯.md', fs.statSync('D:/qq-bridge/roles/程莫雯.md').size, 'bytes');
