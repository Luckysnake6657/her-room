// 1) validate the new 程莫雯 card against the bridge's injection rules
// 2) drop account-inappropriate keywords from config.json (大肥鱼 etc.)
import fs from 'node:fs';

const cardPath = 'D:/qq-bridge/roles/程莫雯.md';
const raw = fs.readFileSync(cardPath, 'utf8');

console.log('=== 角色卡校验 ===');
console.log('角色名规范化 :', '程莫雯'.replace(/[^\w\u4e00-\u9fff-]/g, ''));
console.log('字符数       :', raw.length, raw.length > 6000 ? '❌ 超 6000 会被截断' : '✅ 不截断');

const GEN1 = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
const dropped = raw.split('\n').filter((l) => GEN1.test(l));
console.log('被过滤的行   :', dropped.length === 0 ? '✅ 无' : '❌ ' + dropped.length + ' 行 -> ' + dropped[0].slice(0, 80));

// The whole point of this card: no old identity left.
console.log('\n=== 旧身份残留检查 ===');
for (const bad of ['小鲸鱼', 'DeepSeek', 'deepseek', 'D指导', 'D老师', '大肥鱼', '鲸鱼', '偷吃 token', '[SILENT]']) {
  const n = raw.split(bad).length - 1;
  // "不要说自己是AI" 这类否定式提及是允许的，只要不是拿它当身份
  console.log(`  ${n === 0 ? '✅' : '⚠️ '} ${bad}  x${n}`);
}

// ---- config.json keyword cleanup ----
const cfgPath = 'D:/qq-bridge/config.json';
const before = fs.readFileSync(cfgPath, 'utf8');
const cfg = JSON.parse(before);

const DROP = new Set(['大肥鱼', '小鲸鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1']);
const keepWake = cfg.socialV2.wake.recommendedKeywords.filter((k) => !DROP.has(k));
const keepMust = cfg.social.mustReplyKeywords.filter((k) => !DROP.has(k));

console.log('\n=== config.json 关键词清理 ===');
console.log('wake 删掉 :', JSON.stringify(cfg.socialV2.wake.recommendedKeywords.filter((k) => DROP.has(k))));
console.log('wake 保留 :', JSON.stringify(keepWake));
console.log('must 删掉 :', JSON.stringify(cfg.social.mustReplyKeywords.filter((k) => DROP.has(k))));
console.log('must 保留 :', JSON.stringify(keepMust));

fs.copyFileSync(cfgPath, `${cfgPath}.bak-before-keywords`);
cfg.socialV2.wake.recommendedKeywords = keepWake;
cfg.social.mustReplyKeywords = keepMust;
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

const check = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
console.log('\n写入后校验:');
console.log('  JSON 可解析     :', true, `(${fs.statSync(cfgPath).size} bytes)`);
console.log('  ownerQQ 保留    :', check.ownerQQ);
console.log('  allow.private   :', JSON.stringify(check.allow.private));
console.log('  accessToken 保留:', Boolean(check.snowluma.accessToken));
console.log('  workspaceTitle  :', check.workspaceTitle);
