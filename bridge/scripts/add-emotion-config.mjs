/** 给 config.json / config.example.json 补 socialV2.emotion（幂等）。默认**关闭**，等模型指标过线再开。 */
import fs from 'node:fs';

const DEFAULTS = {
  enabled: false,                 // ★默认关：训练指标（相关系数）过线、人工确认后才打开
  halfLifeMs: 3600000,            // 情绪半衰期 1 小时（指数衰减）
  gain: 0.35,                     // 每次刺激推动幅度
  neutralThreshold: 0.18,         // 各维度都低于它 → 不注入
  maxChars: 120,                  // 注入行长度上限（token 预算）
  weightsPath: '',                // 空 = state/emotion-weights.json
  logChanges: false,              // 每次情绪变动都打日志（调试用）
};
const NOTE = '情感模块：离线用 LLM 标注语料 → Node 里梯度下降训练小 MLP（scripts/train-emotion-net.mjs）→ 在线纯 JS 推理（src/emotion-net.js）。相关性没过线的维度不注入；没有权重就保持中性、绝不随机。';

for (const file of ['config.json', 'config.example.json']) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  cfg.socialV2 = cfg.socialV2 ?? {};
  let changed = false;
  if (!cfg.socialV2.emotion) { cfg.socialV2.emotion = { ...DEFAULTS, _note: NOTE }; changed = true; }
  else {
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (cfg.socialV2.emotion[k] === undefined) { cfg.socialV2.emotion[k] = v; changed = true; }
    }
    if (cfg.socialV2.emotion._note !== NOTE) { cfg.socialV2.emotion._note = NOTE; changed = true; }
  }
  if (!changed) { console.log(`${file}: 已有，跳过`); continue; }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`${file}: 已补 socialV2.emotion（enabled=false）`);
}
