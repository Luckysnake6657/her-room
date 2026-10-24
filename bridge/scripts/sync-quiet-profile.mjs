// 把 config.example.json 同步成"安静档"（和 config.json 一致），供新装用户使用。
// 直接在文本上做精确替换，避免 JSON 往返把注释/排版/键顺序搞乱。
// 幂等：值已经是目标值就跳过，重复跑不会报"找不到"。
import fs from 'node:fs';

const f = 'config.example.json';
let src = fs.readFileSync(f, 'utf8');
const before = src;

// [键, 旧值, 新值]
const edits = [
  ['autoReplyCheckMs', '30000', '120000'],
  ['sleepMinMs', '60000', '300000'],
  ['recommendedProbability', '0.05', '0.02'],
  ['maxWakePerHour', '12', '4'],
  ['burstMaxMessages', '8', '3'],
  ['maxSendPerMinute', '8', '8'],
  // 2026-09-28：原来 25 → 实测一次 turn 发 2~3 条、连续几轮就撞满，
  // 她在对话中途发不出话（截图里两条红色"发送频率超限"）。
  // 上限的作用是挡"失控刷屏"，不是挡正常回话：8/分钟已经足够狠了，小时档给到 150。
  ['maxSendPerHour', '60', '150'],
  ['checkIntervalMinMs', '1800000', '7200000'],
  ['checkIntervalMaxMs', '5400000', '14400000'],
  ['idleThresholdMs', '900000', '3600000'],
];

/** 匹配 `"key": 值` 后面跟着逗号或换行。 */
function keyRe(key, value) {
  const escaped = String(value).replace('.', '\\.');
  return new RegExp(`("${key}"\\s*:\\s*)${escaped}(\\s*[,\r\n])`);
}

let changed = 0;
let already = 0;
for (const [key, from, to] of edits) {
  if (keyRe(key, to).test(src)) { already++; continue; }   // 已经是目标值 → 幂等
  if (!keyRe(key, from).test(src)) {
    console.log(`⚠️ 找不到 "${key}" 的 ${from}（值已被改过？请人工确认）`);
    continue;
  }
  src = src.replace(keyRe(key, from), `$1${to}$2`);
  changed++;
}

// proactive.probability 单独处理（"probability" 出现多次，锁定在 proactive 段内）
if (keyRe('probability', 0.05).test(src)) already++;
else src = src.replace(/("proactive"\s*:\s*\{[\s\S]*?"probability"\s*:\s*)0\.3(\s*\n)/, '$10.05$2');

if (src === before) {
  console.log(`没有变化（${already} 项已是目标值）`);
  process.exit(0);
}
fs.writeFileSync(f, src, 'utf8');
console.log(`✅ config.example.json 已同步：改了 ${changed} 项，${already} 项本来就是目标值`);

// 校验仍是合法 JSON
JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
console.log('✅ 仍是合法 JSON');
