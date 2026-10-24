// 把现有群的唤醒概率改成新默认值（全局默认只对新会话生效，已存在的会话要单独设）。
import fs from 'node:fs';

const key = process.argv[2] ?? 'group:1124778377';
const probability = Number(process.argv[3] ?? 0.02);
const consoleToken = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();

const before = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'))
  .conversations?.[key]?.wakeConfig;
console.log(`[${key}] 修改前 probability =`, before?.triggers?.probability, '| mode =', before?.mode, '| anyMessage =', before?.triggers?.anyMessage);

const res = await fetch('http://127.0.0.1:3100/api/socialV2/wake-config', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
  body: JSON.stringify({ key, config: { triggers: { probability } } }),
  signal: AbortSignal.timeout(10000),
});
console.log('POST wake-config ->', res.status);
const body = await res.text();
console.log(body.slice(0, 400));

// 从文件复核（接口会落盘）
const after = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'))
  .conversations?.[key]?.wakeConfig;
console.log('\n=== 修改后 ===');
console.log('probability :', after?.triggers?.probability);
console.log('mode        :', after?.mode, '| infinite:', after?.infinite);
console.log('must-awake  :', 'atMention=' + after?.triggers?.atMention,
  'nameMention=' + after?.triggers?.nameMention,
  'question=' + after?.triggers?.question,
  'poke=' + after?.triggers?.poke);
console.log('anyMessage  :', after?.triggers?.anyMessage);
console.log('keywords    :', JSON.stringify(after?.triggers?.keywords));
console.log('confirmedBy :', after?.confirmedBy);
