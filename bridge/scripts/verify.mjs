/**
 * 一条命令给出"这个改动到底行不行"的单一结论：**批测 + self-check**。
 *
 * 为什么要有它（2026-10-10，"数字员工"落地的一部分）：
 *   self-check 里跑的是**子集**（审计/跨会话/代发/工具面…），批测才是全套 55 个用例；
 *   两个都跑才算"我证明过我做对了"。以前要手动跑两条命令、自己看两段输出拼结论 ——
 *   步骤越多越容易偷懒跳过，而"跳过验收"正是 agent 从"工具人"掉成"闯祸机器"的地方。
 *
 * 设计原则（省 token、也省你的注意力）：
 *   • 只把**结论**和失败细节打出来（子命令的输出折叠掉），不刷屏；
 *   • 退出码合并：任一步失败就非 0，可以直接当 CI/守卫用；
 *   • `--fast` 只跑 self-check（跳过批测），改文案时够用。
 *
 * 用法：
 *   node scripts/verify.mjs          # 全套（批测 + self-check）—— 提交/重启前跑这个
 *   node scripts/verify.mjs --fast   # 只跑 self-check（静态 + 运行时，秒级）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');

function run(label, args) {
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  // 只留"有信息量"的行：批测汇总行、self-check 的 ❌/⚠ 和合计行
  const keep = out.split('\n').filter((l) => /=====|合计|❌|⚠|汇总|失败/.test(l)).slice(-14);
  return { label, code: r.status ?? 1, secs, keep };
}

const steps = [];
// 2026-10-23：**验证过程中源文件被改**会让结果不可信（批测可能读到半改的代码）。
// 实测三次"单跑批测全绿、verify 却 FAIL"，全是我边改边跑造成的误报。
// 所以跑之前拍一张 mtime 快照，跑完发现变了就明说"这次结果不可信"。
const TRACKED = ['src/bridge.js', 'src/prompt-rules.js', 'src/diary.js', 'src/weather.js',
  'src/emotion-net.js', 'src/speech.js', 'src/sticker-lib.js', 'scripts/self-check.mjs'];
const snapshot = () => TRACKED.map((f) => { try { return fs.statSync(path.join(ROOT, f)).mtimeMs; } catch { return 0; } }).join(',');
const snapBefore = snapshot();

if (!FAST) steps.push(run('批测', ['scripts/run-test-batch.mjs']));
steps.push(run('自检', ['scripts/self-check.mjs', ...(FAST ? ['--fast'] : [])]));

const snapAfter = snapshot();

let ok = true;
for (const s of steps) {
  const pass = s.code === 0;
  if (!pass) ok = false;
  console.log(`\n──── ${s.label}：${pass ? '✅ 通过' : '❌ 失败'}（${s.secs}s）────`);
  for (const line of s.keep) console.log(`  ${line.trim()}`);
}

console.log(`\n================ ${ok ? '✅ VERIFY PASS' : '❌ VERIFY FAIL'} ================`);
if (snapBefore !== snapAfter) {
  console.log('⚠️ 验证过程中源文件被修改过 —— 这次结果不可信（可能读到半改的代码），请重跑。');
}
if (!ok) {
  console.log('要往下查：失败项在上一段里；批测可以单独重跑（node scripts/run-test-batch.mjs <用例名>）。');
}
process.exit(ok ? 0 : 1);
