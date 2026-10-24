// Finish the account migration: remove the remaining DeepSeek/D指导-era wake
// keywords (the account is 程莫雯 now, not a DeepSeek persona), then activate
// the 程莫雯 card and reset the private conversation so stale per-conversation
// state (old keywords, old persona context) is rebuilt from these defaults.
import fs from 'node:fs';

const cfgPath = 'D:/qq-bridge/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// 全部清空：这个账号不再以 DeepSeek 身份出现，这些词醒它没有意义。
// 留空表示"不靠关键词唤醒"，仍可被 @ / 叫名字 / 提问 / 拍一拍 / 5% 随机唤醒。
const beforeWake = [...cfg.socialV2.wake.recommendedKeywords];
cfg.socialV2.wake.recommendedKeywords = [];
const beforeMust = [...cfg.social.mustReplyKeywords];
cfg.social.mustReplyKeywords = ['在吗'];

fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log('=== config.json 关键词（最终）===');
console.log('wake 清理前:', JSON.stringify(beforeWake));
console.log('wake 清理后: []  （不再靠关键词唤醒；@/名字/提问/拍一拍/5% 随机仍然有效）');
console.log('must 清理前:', JSON.stringify(beforeMust));
console.log('must 清理后:', JSON.stringify(cfg.social.mustReplyKeywords));

const token = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
const base = 'http://127.0.0.1:3100';
const headers = { 'content-type': 'application/json', 'x-console-token': token };

console.log('\n=== 切换角色为「程莫雯」===');
const roles = await (await fetch(`${base}/api/roles`, { headers })).json();
console.log('可用角色:', JSON.stringify(roles.roles), '当前:', roles.current);
const setRes = await fetch(`${base}/api/role`, { method: 'POST', headers, body: JSON.stringify({ role: '程莫雯' }) });
console.log(`POST /api/role -> ${setRes.status} ${(await setRes.text()).slice(0, 120)}`);

console.log('\n=== 重置私聊会话（清掉旧的每会话状态）===');
const resetRes = await fetch(`${base}/api/session/reset`, {
  method: 'POST', headers,
  body: JSON.stringify({ key: 'private:984776985' }),
  signal: AbortSignal.timeout(20000),
});
console.log(`POST /api/session/reset -> ${resetRes.status} ${(await resetRes.text()).replace(/\s+/g, ' ').slice(0, 200)}`);

console.log('\n=== 最终状态 ===');
console.log('current-role.json :', fs.readFileSync('D:/qq-bridge/state/current-role.json', 'utf8').replace(/\s+/g, ' '));
console.log('sessions.json     :', fs.readFileSync('D:/qq-bridge/state/sessions.json', 'utf8').replace(/\s+/g, ' '));
