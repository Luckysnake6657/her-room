// Explain exactly when the bridge will and will not reply, using the live config
// plus the wake config the agent last confirmed.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
const social = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
const mode = JSON.parse(fs.readFileSync('D:/qq-bridge/state/mode.json', 'utf8')).mode;
const conv = social.conversations['private:984776985'] ?? {};
const wc = conv.wakeConfig ?? {};

console.log('当前模式 :', mode);
console.log('');
console.log('=== 第 1 层：白名单（不通过直接丢弃，AI 根本看不到）===');
console.log('  allow.private :', JSON.stringify(cfg.allow.private));
console.log('  allow.groups  :', JSON.stringify(cfg.allow.groups));
console.log('  allowAllWhenEmpty :', cfg.allowAllWhenEmpty, '=> 空白名单不放行（fail-closed）');
console.log('  deny          :', JSON.stringify(cfg.deny));

console.log('');
console.log('=== 第 2 层：唤醒触发条件（reserved2）===');
console.log('  （下面是你私聊会话里 agent 最后确认的配置）');
console.log('  anyMessage（每条都醒）:', wc.triggers?.anyMessage);
console.log('  atMention（被@/引用）:', wc.triggers?.atMention);
console.log('  nameMention（叫名字）:', wc.triggers?.nameMention);
console.log('  question（直接提问）:', wc.triggers?.question);
console.log('  poke（拍一拍）:', wc.triggers?.poke);
console.log('  普通消息随机唤醒概率 :', wc.triggers?.probability);
console.log('  关键词唤醒:', JSON.stringify(wc.triggers?.keywords));
console.log('  speakerIds（蹲特定人）:', JSON.stringify(wc.triggers?.speakerIds));
console.log('  mode / infinite :', wc.mode, '/', wc.infinite, '（diving=潜水，等条件命中才醒）');

console.log('');
console.log('=== 第 3 层：唤醒频率硬上限 ===');
console.log('  maxWakePerMinute :', cfg.socialV2?.wake?.maxWakePerMinute);
console.log('  maxWakePerHour   :', cfg.socialV2?.wake?.maxWakePerHour);

console.log('');
console.log('=== 第 4 层：AI 自己决定发不发 ===');
console.log('  被唤醒 ≠ 一定发言；它可以只看、只标记已读（qq_mark_read）继续潜水。');

console.log('');
console.log('=== 第 5 层：发送频率上限 ===');
console.log('  maxSendPerMinute :', cfg.socialV2?.send?.maxSendPerMinute);
console.log('  maxSendPerHour   :', cfg.socialV2?.send?.maxSendPerHour);
console.log('  单条上限字数     :', cfg.socialV2?.send?.maxMessageChars);
