// Verify the persona pipeline directly: replay the bridge's own read+filter
// steps against the live state file and card, and show exactly what the agent
// receives as its persona hint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = 'D:/qq-bridge/state/current-role.json';
const rolesDir = 'D:/qq-bridge/roles';

// --- mirrors readRoleState() ---
const rs = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
console.log('state/current-role.json :', JSON.stringify(rs));

const cardPath = `${rolesDir}/${rs.role}.md`;
console.log('resolved card           :', cardPath);
console.log('card exists             :', fs.existsSync(cardPath));

let hint = fs.readFileSync(cardPath, 'utf8');
console.log('card chars              :', hint.length);
if (hint.length > 6000) {
  hint = hint.slice(0, 6000);
  console.log('  (截断到 6000)');
}

// --- mirrors currentRoleHintV2() for reserved2 ---
const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
const lines = hint.split('\n');
const kept = [];
let inExample = false;
for (const line of lines) {
  if (/^##\s*.*回复示例/.test(line)) { inExample = true; kept.push(line); continue; }
  if (inExample && /^##\s/.test(line)) inExample = false;
  if (inExample) kept.push(line);
  else if (!GEN1_ROLE_LINE_RE.test(line)) kept.push(line);
}
const finalHint = kept.join('\n');

console.log('\n=== 最终注入内容 ===');
console.log('字符数      :', finalHint.length);
console.log('行数        :', finalHint.split('\n').length);
console.log('首行        :', finalHint.split('\n')[0]);
console.log('末行        :', finalHint.trimEnd().split('\n').pop());
console.log('\n前 400 字符预览:');
console.log(finalHint.slice(0, 400));

// Prove there is no second source of persona text shadowing this card.
// 读的是仓库里的**手写源**，不是 ~/.dsh 下装好的副本：DSH 0.2.0 起
// ~/.dsh/.agent-presets/qq-chat-v2/ 已经没有任何代码读取（preset 只能是 bundle 声明，
// 由 setup-dsh.mjs 从这份手写源生成），去读它等于检查一份可能早已冻结的化石 ——
// 旧写法还写死了 C:/Users/zjin6/...，换机器/换家目录整个探针就失效。
// "装上去的那份和手写源一致"由 scripts/verify-dsh-adaptation.mjs 负责断言，这里不重复。
console.log('\n=== 是否还有其它可能覆盖人格的源 ===');
const preset = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
console.log('preset 含“活人版”  :', preset.includes('活人版'));
console.log('preset 含“小鲸鱼”  :', preset.includes('小鲸鱼'));
console.log('preset persona.prefix 开头:');
const m = preset.match(/prefix:\s*>-\n([\s\S]{0,200})/);
if (m) console.log(m[1].split('\n').map((l) => '   ' + l.trim()).slice(0, 6).join('\n'));
