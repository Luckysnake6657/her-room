/**
 * 打开情感模块（管理员一次性动作）。
 *
 * 前置条件：`state/emotion-weights.json` 是 v2 稀疏格式，且目标维度的**交叉验证**相关过了 0.4 的线。
 * 2026-09-30 第二轮实测：v 0.473±0.010 / a 0.478±0.005 / d 0.402±0.010（5 折 × 8 种子 out-of-fold）。
 *
 * 用法：node scripts/enable-emotion.mjs            # 打开（logChanges 也打开，方便看真实流量下的变化）
 *       node scripts/enable-emotion.mjs --off      # 关回去
 *       node scripts/enable-emotion.mjs --no-log   # 打开但不写 [emotion] 日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const argv = process.argv.slice(2);
const on = !argv.includes('--off');
const log = !argv.includes('--no-log');

const raw = fs.readFileSync(CFG, 'utf8');
const cfg = JSON.parse(raw);
cfg.socialV2 ??= {};
const cur = cfg.socialV2.emotion ?? {};
cfg.socialV2.emotion = {
  enabled: on,
  halfLifeMs: cur.halfLifeMs ?? 3600000,
  gain: cur.gain ?? 0.35,
  neutralThreshold: cur.neutralThreshold ?? 0.18,
  // ★ 2026-10-22 修复：这里原来**没带 baseline**，脚本一跑就把静息基线丢了 ——
  //   而 baseline 是"减掉模型常数偏移"的关键（丢了它情绪会一路推到上限）。
  //   实测代价：跑完 test-emotion 直接挂两条（"config 里配了基线" / "减掉基线后平均刺激≈0"）。
  ...(cur.baseline ? { baseline: cur.baseline } : {}),
  ...(cur._baselineNote ? { _baselineNote: cur._baselineNote } : {}),
  maxChars: cur.maxChars ?? 120,
  weightsPath: cur.weightsPath ?? '',
  logChanges: on ? log : false,
  _note: cur._note ?? '情感模块：离线 LLM 标注 → Node 训练「本群词表 + tf-idf → 单线性层」→ 在线纯 JS 推理（46.8µs/条、0 token）。相关系数没过 0.4 的维度不注入；没有权重/格式不符则保持中性、绝不随机；连续报错 5 次自动熔断。',
};

// 改前先备份（只留最近一份 .bak，避免堆一堆）
try { fs.writeFileSync(CFG + '.bak', raw, 'utf8'); } catch { /* 备份失败不拦着 */ }
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`情感模块 → ${on ? '已打开' : '已关闭'}（logChanges=${on ? log : false}）`);
console.log(`配置写入 ${CFG}（旧版留在 config.json.bak）`);
console.log('⚠️ 改完必须重启桥接才生效：node scripts/launch-all.mjs --restart --no-open --no-check');
console.log('   起来后看（注意是 x-console-token，不是 x-agent-token）：');
console.log('   curl -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/socialV2/emotion');
