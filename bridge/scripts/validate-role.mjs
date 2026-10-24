// Validate the current persona card against the bridge's real injection rules.
// Mirrors currentRoleHint() + currentRoleHintV2() from src/bridge.js.
// Reads which card is active from state/current-role.json instead of hardcoding
// a filename, so this keeps working after the role is switched.
import fs from 'node:fs';

const stateFile = 'D:/qq-bridge/state/current-role.json';
let cardPath;
try {
  const role = JSON.parse(fs.readFileSync(stateFile, 'utf8')).role;
  cardPath = `D:/qq-bridge/roles/${role}.md`;
  console.log(`当前角色: ${role}  ->  ${cardPath}`);
} catch {
  cardPath = process.argv[2];
  if (!cardPath) {
    console.error('无法读取 state/current-role.json，且未提供卡片路径');
    process.exit(1);
  }
}
const raw = fs.readFileSync(cardPath, 'utf8');

// 注入上限必须和 bridge 侧的 roleInjectLimit() 一致：
// 默认 ROLE_INJECT_LIMIT（现为 8000），可被 config.json 的 socialV2.roleCard.maxChars 覆盖，
// 显式写 0 = 不截断。（旧版这里写死 6000，bridge 改成 8000 后就会报假警。）
let LIMIT = 8000;
try {
  const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, ''));
  const v = cfg.socialV2?.roleCard?.maxChars;
  if (v === 0) LIMIT = Infinity;
  else if (Number.isFinite(Number(v)) && Number(v) >= 1000) LIMIT = Math.round(Number(v));
} catch {}

console.log('=== 体积检查（currentRoleHint 在此长度硬截断）===');
console.log(`字符数 : ${raw.length}`);
console.log(`注入上限: ${LIMIT === Infinity ? '不截断（配置写了 0）' : LIMIT}`);
console.log(`状态   : ${raw.length > LIMIT ? '❌ 会被截断，丢掉 ' + (raw.length - LIMIT) + ' 字符' : '✅ 不会截断'}`);

console.log('\n=== 二代过滤检查（GEN1_ROLE_LINE_RE 命中即整行丢弃）===');
const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
const lines = raw.split('\n');
const dropped = lines.filter((l) => GEN1_ROLE_LINE_RE.test(l));
if (dropped.length === 0) console.log('✅ 没有被丢弃的行');
else dropped.forEach((l) => console.log('❌ 会被丢弃: ' + l.slice(0, 100)));

console.log('\n=== 示例节处理检查 ===');
console.log('含「回复示例」小节: ' + (/^##\s*.*回复示例/m.test(raw) ? '✅ 有（空格会转成逗号；本卡已用逗号，不受影响）' : '无'));

console.log('\n=== 最坏情况：截断 + 过滤后还剩多少 ===');
let hint = raw.length > LIMIT ? raw.slice(0, LIMIT) : raw;
const kept = [];
let inExampleSection = false;
for (const line of hint.split('\n')) {
  if (/^##\s*.*回复示例/.test(line)) { inExampleSection = true; kept.push(line); continue; }
  if (inExampleSection && /^##\s/.test(line)) inExampleSection = false;
  if (inExampleSection) kept.push(line);
  else if (!GEN1_ROLE_LINE_RE.test(line)) kept.push(line);
}
const finalText = kept.join('\n');
console.log(`注入字符数: ${finalText.length}`);
console.log(`结尾一行  : ${finalText.trimEnd().split('\n').pop().slice(0, 80)}`);

console.log('\n=== 角色名合法性（sanitizeRoleName 保留 \\w 与中文与横线）===');
const name = JSON.parse(fs.readFileSync(stateFile, 'utf8')).role;
const sanitized = String(name).replace(/[^\w\u4e00-\u9fff-]/g, '');
console.log(`"${name}" -> "${sanitized}"  ${sanitized === name ? '✅ 合法' : '❌ 会被改名'}`);
console.log('角色文件存在: ' + fs.existsSync(`D:/qq-bridge/roles/${name}.md`));
