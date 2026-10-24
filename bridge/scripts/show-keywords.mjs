// Show the keyword lists and meme references that need to change for the new account.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));

console.log('=== config.json：唤醒关键词 (socialV2.wake.recommendedKeywords) ===');
for (const k of cfg.socialV2.wake.recommendedKeywords) console.log('  ' + k);

console.log('\n=== config.json：一代仿真必回关键词 (social.mustReplyKeywords) ===');
for (const k of cfg.social.mustReplyKeywords) console.log('  ' + k);

console.log('\n=== 现有会话的实际唤醒关键词 ===');
const social = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
for (const [key, conv] of Object.entries(social.conversations ?? {})) {
  console.log(`  ${key}: ${JSON.stringify(conv.wakeConfig?.triggers?.keywords ?? [])}`);
  console.log(`         confirmedBy=${conv.wakeConfig?.confirmedBy}  mode=${conv.wakeConfig?.mode}`);
}

console.log('\n=== 角色卡里提到"大肥鱼/兔兔"的行 ===');
const card = fs.readFileSync('D:/qq-bridge/roles/小鲸鱼2.md', 'utf8').split('\n');
card.forEach((l, i) => {
  if (/大肥鱼|兔兔|鲸鱼娘|形象|昵称/.test(l)) console.log(`  ${String(i + 1).padStart(3)}: ${l.trim().slice(0, 110)}`);
});

console.log('\n=== 所有角色卡文件 ===');
console.log('  ' + fs.readdirSync('D:/qq-bridge/roles').join(', '));
