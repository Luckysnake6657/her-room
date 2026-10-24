// 在隔离子进程里加载 bridge.js，直接调用它的记忆过滤函数，验证隐私边界。
// 用法: node probe-core-memory.mjs <mode>   mode = group | private
//
// 之所以用子进程：bridge.js 有单实例锁和端口绑定等启动副作用，
// 在独立进程里加载、用完即退，最干净。
import fs from 'node:fs';

const mode = process.argv[2] ?? 'group';
const token = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
process.env.QQ_BRIDGE_PROBE = token;

const mod = await import('file:///D:/qq-bridge/src/bridge.js');
const hooks = globalThis.__QQ_BRIDGE_TEST__;

if (!hooks) {
  console.error('PROBE_FAIL: bridge.js 未暴露测试钩子（需要 QQ_BRIDGE_PROBE 环境变量 + 探针代码块）');
  process.exit(2);
}

const key = mode === 'private' ? 'private:984776985' : 'group:1124778377';
const st = hooks.getSocialV2State(key);
console.log(`### ${key} ###`);
console.log('--- 记忆注入内容 ---');
console.log(hooks.formatMemoryV2ForChat(key, st) || '(空)');
console.log('--- end ---');
process.exit(0);
