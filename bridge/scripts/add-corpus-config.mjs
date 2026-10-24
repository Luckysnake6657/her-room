/**
 * 给 config.json / config.example.json 补 socialV2.corpus / socialV2.groupStyle（幂等）。
 * 中文+引号在 PowerShell 里极易写坏 JSON，所以一律用脚本改。
 *
 * 2026-09-29 第二轮（用户："群聊私聊的聊天方式能不能总结成一个不断更新的通用模版，
 * 在所有聊天作为底层聊天逻辑里启用"）新增：
 *   corpus.includePrivate        语料也收私聊（通用模版要覆盖私聊）
 *   groupStyle.generalEnabled    通用底层模版（所有会话都注入）
 *   groupStyle.generalMaxChars   通用层的字数上限
 *   groupStyle.refreshAfterNewMessages  语料新增多少条就自动重建（"不断更新"）
 */
import fs from 'node:fs';

const DEFAULTS = {
  corpus: {
    enabled: true,
    includePrivate: true,
    maxLines: 20000,
    maxBytes: 20971520,
  },
  groupStyle: {
    enabled: true,
    generalEnabled: true,
    generalMaxChars: 420,
    ttlHours: 24,
    refreshAfterNewMessages: 200,
    maxChars: 500,
    exampleCount: 5,
    minSamples: 60,
  },
};

const NOTES = {
  'socialV2.corpus': '长期语料库 state/group-corpus.jsonl（名字是历史遗留，现在也含私聊）：只存别人说的话，供通用模版/群风格卡/例句/黑话补课复用。超上限留最近一半。includePrivate=false 就只收群聊。',
  'socialV2.groupStyle': '聊天风格模版：generalEnabled 的通用层注入**所有**会话（群聊+私聊），是底层打字习惯；每群的"本群说话的样子"只注入群聊。refreshAfterNewMessages：语料新增这么多条就自动重建（不断更新）。例句来自 state/style-examples.json。',
};

for (const file of ['config.json', 'config.example.json']) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  cfg.socialV2 = cfg.socialV2 ?? {};
  let changed = false;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    cfg.socialV2[k] = cfg.socialV2[k] ?? {};
    for (const [kk, vv] of Object.entries(v)) {
      if (cfg.socialV2[k][kk] === undefined) { cfg.socialV2[k][kk] = vv; changed = true; }
    }
    if (cfg.socialV2[k]._note !== NOTES[`socialV2.${k}`]) { cfg.socialV2[k]._note = NOTES[`socialV2.${k}`]; changed = true; }
  }
  if (!changed) { console.log(`${file}: 已有，跳过`); continue; }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(file, 'utf8'));   // 回读校验：写坏了当场炸
  console.log(`${file}: 已更新 corpus + groupStyle`);
}
