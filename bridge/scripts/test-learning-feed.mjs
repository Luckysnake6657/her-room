/**
 * 回归测试：**学习类消费端（语料库 / 情感 / 黑话）不该被"静默"断粮**（2026-10-02）。
 *
 * 现场：管理员开着「静默模式」时，group:795894138 在 20:02–20:42 这 40 分钟里
 *   网关日志有 99 条群友发言，语料库只落进 37 条 —— 而且一条都没进情感模块。
 *   根因：语料/情感/黑话原来散在 `handleIncoming` 的 reserved2 分支里，
 *   而"静默模式"那行 `return` 排在它**前面**（老代码里静默 = 整条消息丢掉）。
 *
 * 但"不说话"和"不学习"是两件事：她沉默的时候恰恰最该攒素材。
 * 现在收成一个入口 `feedLearning`，位置在那些 early-return 之前。
 *
 * 这条锁死：
 *   [1] 静默模式下群友的话照样进语料，但**不进她的收件箱**（沉默行为不变）；
 *   [2] 静默期间情感模块照样计分（用合成权重，确定性）；
 *   [3] 全局静默（silentAll）只管"发不出去/叫不醒"，学习照常；
 *   [4] 命令不是"说话"（`/` 开头、角色切换话术都不进语料）；
 *   [5] 她自己说的话不进语料；
 *   [6] 上文口径与标注脚本一致（180s 窗口 / 跳过图片占位），且取上文在本句入环之前。
 *
 * 用法: node scripts/test-learning-feed.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { HAND_DIM } from '../src/emotion-features.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// 合成权重：W 全 0、B=1、三维都可用 → 输出恒为 1（非中性、确定性），只用来验"有没有计分"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-learning-feed-'));
const wFile = path.join(tmp, 'weights.json');
{
  const VOCAB = ['兔', '兔兔', '屌', '屎', '哈', '谢谢'];
  fs.writeFileSync(wFile, JSON.stringify({
    version: 2, kind: 'sparse-linear-tfidf',
    vocab: VOCAB, idf: VOCAB.map(() => 1),
    vocabSize: VOCAB.length, handDim: HAND_DIM, outDim: 3,
    W: [0, 1, 2].map(() => new Array(VOCAB.length + HAND_DIM).fill(0)),
    B: [1, 1, 1],
    metrics: { corr: [0.9, 0.9, 0.9], usable: [true, true, true], oofMse: 0.04, baseMse: 0.08 },
  }));
}

const GKEY = 'group:456';
const ev = (text, id, userId = 777, nickname = '群友A', gid = 456) => ({
  post_type: 'message', message_type: 'group', group_id: gid, user_id: userId,
  self_id: 999, message_id: id, raw_message: text,
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: userId, nickname, card: '' },
  time: Math.floor(Date.now() / 1000),
});
const evMedia = (id, gid = 456) => ({
  post_type: 'message', message_type: 'group', group_id: gid, user_id: 777,
  self_id: 999, message_id: id, raw_message: '[图片]',
  message: [{ type: 'image', data: { file: 'x.jpg', url: 'https://public.invalid/x.jpg' } }],
  sender: { user_id: 777, nickname: '群友A', card: '' },
  time: Math.floor(Date.now() / 1000),
});

const b = await bridgeHarness({
  config: {
    socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wFile, gain: 1 } },
    ownerQQ: 123,
    allow: { private: ['123'], groups: ['456', '789'] },
  },
});
try {
  b.setMode('reserved2');
  const corpusTexts = () => b.readGroupCorpus().map((r) => String(r.x ?? ''));

  console.log('\n[1] 全局静默期间：不说话，但照样学习（而且消息仍进收件箱）');
  b.setSilentAll(true, 'test');
  check('（前置）全局静默开着', b.silentAllBlocks(GKEY) === true, String(b.silentAllBlocks(GKEY)));
  await b.handleIncoming('group', 456, ev('今天这波打的什么玩意', 'ls-1'), b.cfg);
  await b.handleIncoming('group', 456, ev('对面那个狙太准了吧', 'ls-2'), b.cfg);
  const inCorpus = corpusTexts();
  check('静默期间群友的话**进了语料库**（之前这段整段丢）',
    inCorpus.includes('今天这波打的什么玩意') && inCorpus.includes('对面那个狙太准了吧'),
    JSON.stringify(inCorpus.slice(-4)));
  // 2026-10-02 两个静默开关合并后的语义：她**收得到**（解禁后接得上话茬），
  // 只是不许发（端点 403）、也不会被叫醒（scheduleWakeV2 跳过）。
  check('静默期间消息**仍然进她的收件箱**（合并老开关后的新语义：收得到、不许回）',
    (b.getSocialV2State(GKEY)?.recentMessages ?? []).some((m) => /今天这波打的什么玩意/.test(String(m.text ?? ''))),
    JSON.stringify((b.getSocialV2State(GKEY)?.recentMessages ?? []).slice(-2).map((m) => m.text)));

  console.log('\n[2] 静默期间情感模块照样计分');
  {
    const padBefore = Array.isArray(b.getSocialV2State(GKEY)?.emotion?.pad) ? [...b.getSocialV2State(GKEY).emotion.pad] : null;
    await b.handleIncoming('group', 456, ev('气死我了这都能输', 'ls-emo'), b.cfg);
    const padAfter = b.getSocialV2State(GKEY)?.emotion?.pad;
    check('静默期间情绪被推动（pad 有变化）',
      Array.isArray(padAfter) && padAfter.some((v, i) => Math.abs(v - (padBefore?.[i] ?? 0)) > 1e-6),
      `before=${JSON.stringify(padBefore)} after=${JSON.stringify(padAfter)}`);
  }

  console.log('\n[3] 老的「静默模式」已惰性化：开着它既不影响学习，也不再把消息整条丢掉');
  {
    // 2026-10-02 合并开关：roleState.mode 不再是判据（见 test-silent-all.mjs [6]）。
    // 这里守住"学习链不依赖它"——将来谁把它接回判据，这条会红。
    b.setSilentAll(false, 'test');
    b.writeRoleState(null, 'silent');
    await b.handleIncoming('group', 456, ev('老开关开着时说的这句', 'sa-1'), b.cfg);
    check('老开关开着：照样进语料库', corpusTexts().includes('老开关开着时说的这句'), JSON.stringify(corpusTexts().slice(-3)));
    check('老开关开着：照样进收件箱（不再整条丢）',
      (b.getSocialV2State(GKEY)?.recentMessages ?? []).some((m) => /老开关开着时说的这句/.test(String(m.text ?? ''))));
    b.writeRoleState(null, 'active');
  }

  console.log('\n[4] 命令不是"说话"：斜杠命令 / 角色切换话术都不进语料');
  b.writeRoleState(null, 'active');
  await b.handleIncoming('group', 456, ev('/model', 'cmd-1'), b.cfg);
  await b.handleIncoming('group', 456, ev('现在切换角色 换成洛琪希', 'cmd-2'), b.cfg);
  await b.handleIncoming('group', 456, ev('这把稳了真的', 'cmd-ok'), b.cfg);
  const c2 = corpusTexts();
  check('`/model` 没进语料', !c2.includes('/model'), JSON.stringify(c2.slice(-3)));
  check('非管理员的"切换角色"话术没进语料', !c2.some((t) => /切换角色/.test(t)), JSON.stringify(c2.slice(-3)));
  check('正常聊天照常进（对照组，防"一刀切全挡了"）', c2.includes('这把稳了真的'), JSON.stringify(c2.slice(-3)));

  console.log('\n[5] 她自己说的话不进语料（否则越学越自恋）');
  await b.handleIncoming('group', 456, ev('我刚说了一句', 'self-1', 777, '今晚吃兔兔'), b.cfg);
  check('发送者是她自己 → 不进语料', !corpusTexts().includes('我刚说了一句'), JSON.stringify(corpusTexts().slice(-3)));

  console.log('\n[6] 上文口径（与标注脚本一致）与"取上文早于入环"');
  {
    const gk = 'group:789';
    await b.handleIncoming('group', 789, ev('第一句有内容', 'p-1', 777, '群友A', 789), b.cfg);
    check('第一句成为上文', b.learningPrevTextFor(gk) === '第一句有内容', b.learningPrevTextFor(gk));
    await b.handleIncoming('group', 789, evMedia('p-media', 789), b.cfg);
    check('图片占位**不进**上文环', b.learningPrevTextFor(gk) === '第一句有内容', b.learningPrevTextFor(gk));
    await b.handleIncoming('group', 789, ev('第二句有内容', 'p-2', 777, '群友A', 789), b.cfg);
    check('随后第二句成为新上文', b.learningPrevTextFor(gk) === '第二句有内容', b.learningPrevTextFor(gk));
    check('超过 180s 就不给上文（不是在接话）', b.learningPrevTextFor(gk, Date.now() + 5 * 60 * 1000) === '',
      b.learningPrevTextFor(gk, Date.now() + 5 * 60 * 1000));
    // 长消息（>80 字）也不进上文环（标注脚本同款规则）
    const long = '啊'.repeat(120);
    await b.handleIncoming('group', 789, ev(long, 'p-long', 777, '群友A', 789), b.cfg);
    check('超长消息不进上文环（上文仍是第二句）', b.learningPrevTextFor(gk) === '第二句有内容', b.learningPrevTextFor(gk));
  }
} finally {
  await b.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
