// 修 + 同步：config.example.json 里 send.recommendedHint 是**该对象最后一个属性**，
// 不能带尾逗号（我第一次同步时加了 `,`，JSON 直接非法：Expected double-quoted property name）。
// 用法：node scripts/sync-send-hint.mjs
import fs from 'node:fs';

const ROOT = 'D:/qq-bridge';
const cur = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8')).socialV2.send.recommendedHint;
const p = `${ROOT}/config.example.json`;
const lines = fs.readFileSync(p, 'utf8').split('\n');

const idx = lines.findIndex((l) => l.includes('"recommendedHint"') && /单条消息不要用空格断句|默认只发一个气泡|一整句完整的话/.test(l));
if (idx < 0) { console.error('example 里找不到 send.recommendedHint 那一行'); process.exit(1); }
const indent = lines[idx].slice(0, lines[idx].indexOf('"'));
// 看下一条非空行是不是 `}` / `},`：是的话说明这是对象最后一个属性，不能加逗号
const nextLine = lines.slice(idx + 1).find((l) => l.trim()) ?? '';
const isLastProp = /^\s*\}/.test(nextLine);
lines[idx] = `${indent}"recommendedHint": ${JSON.stringify(cur)}${isLastProp ? '' : ','}`;

fs.writeFileSync(p, lines.join('\n'), 'utf8');
JSON.parse(fs.readFileSync(p, 'utf8'));
console.log(`已同步第 ${idx + 1} 行（最后属性=${isLastProp}，不加尾逗号），JSON 合法`);
