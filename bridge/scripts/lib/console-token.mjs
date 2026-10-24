// 共享工具：读出桥接**实际在用**的控制台令牌。
//
// 为什么需要单独一个模块：令牌有两个可能的位置，规则容易记错。
//   • 手动设置的令牌写在 config.json 的 consoleToken；
//   • 点"重新生成"生成的随机令牌写在 state/console-token，并把 config 里的值**清空**。
// 桥接的实际规则（src/bridge.js）：config 里的值合法（16~128 位、只含 [A-Za-z0-9_-]）就用它，
// 否则回退到 state/console-token。
//
// 实测踩过：测试脚本只读 config.json，一旦重新生成过令牌就全部 401，
// 看起来像"功能坏了"，其实是脚本读错了地方。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ROOT_DIR = ROOT;

/** 和 bridge.js 的合法性判断保持一致。 */
function isUsable(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

export function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const t = String(cfg.consoleToken ?? '').trim();
    if (isUsable(t)) return t;
  } catch { /* config 读不出来就继续走回退 */ }
  try {
    const t = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
    if (isUsable(t)) return t;
  } catch { /* 没有自动生成的令牌文件 */ }
  return '';
}

/** 令牌来自哪个文件（用于自检报告，方便判断是不是被重新生成过）。 */
export function consoleTokenSource() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (isUsable(String(cfg.consoleToken ?? '').trim())) return 'config.json';
  } catch {}
  try {
    if (isUsable(fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim())) return 'state/console-token（自动生成）';
  } catch {}
  return '（未找到）';
}

export const BRIDGE_BASE = 'http://127.0.0.1:3100';
