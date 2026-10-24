/**
 * 回归测试：情感模块（纯 JS 神经网络推理 + 时间动力学）。
 *
 * 锁死九件事（都是"错了会让她的行为变得不可解释"的地方）：
 *   ① 特征函数确定性：同输入同输出，且**训练/推理共用同一份**（否则权重全废）；
 *   ② 没有权重 → 整个模块保持中性、**绝不注入**、也绝不返回随机值；
 *   ③ 只有训练时相关系数过线的维度才允许注入（没学会的维度不许编）；
 *   ④ 衰减是指数的：1 个半衰期减半、3 小时基本回到中性；
 *   ⑤ 中性不注入；注入的是"语气倾向 + 表达姿态"（姿态是硬的，从 PAD 直接映射，不给她否决权）；
 *   ⑥ 从磁盘读回的状态要消毒（NaN / 越界 / 脏键不会污染提示词）；
 *   ⑦ 权重损坏/旧格式/维度不符 → 不崩、也不编；
 *   ⑧ **词表读回来必须是同一份**（训练写的 vocab/idf 与推理重建的索引逐位一致 —— 对不上则权重全废）；
 *   ⑨ 生产权重文件（如果训过）能加载、门限自洽、输出不是退化状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as net from '../src/emotion-net.js';
import {
  HAND_DIM, CTX_DIM, VOCAB_DEFAULTS, buildVocab, makeVocabIndex, extractSparse, denseFeatures, contextFeatures,
} from '../src/emotion-features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-emotion-test-'));
const wPath = path.join(tmp, 'weights.json');

const VOCAB = ['兔', '兔兔', '屌', '屎', '哈', '谢谢'];
const mkW = (v = VOCAB.length) => [0, 1, 2].map(() => new Array(v + HAND_DIM).fill(0));

/** 造一份"可用"的小权重：W 全 0、B=0.9 → 输出恒为 0.9（确定性、非中性），只用来验注入/衰减逻辑 */
const mkWeights = ({ usable = [true, true, true], corr = [0.7, 0.6, 0.5], B = [0.9, 0.9, 0.9] } = {}) => ({
  version: 2, kind: 'sparse-linear-tfidf',
  vocab: VOCAB.slice(), idf: VOCAB.map(() => 1),
  vocabSize: VOCAB.length, handDim: HAND_DIM, outDim: 3,
  W: mkW(), B: B.slice(),
  metrics: { corr, usable, oofMse: 0.04, baseMse: 0.08 },
});

console.log('\n[1] 特征：确定性 + 训练/推理共用同一份实现');
{
  // 稀疏特征（推理走这条）与手写特征都必须无随机
  const list = buildVocab(['兔兔太屌了', '一坨狗屎', '哈哈哈哈', '谢谢你'], { minCount: 1, maxSize: 20 });
  const voc = makeVocabIndex(list, ['兔兔太屌了', '一坨狗屎', '哈哈哈哈', '谢谢你']);
  const a = extractSparse('兔兔太屌了', voc);
  const b = extractSparse('兔兔太屌了', voc);
  check('稀疏特征同输入同输出（无随机）',
    a.idx.length > 0 && a.idx.length === b.idx.length && Array.from(a.idx).every((v, i) => v === b.idx[i]) && Array.from(a.val).every((v, i) => v === b.val[i]));
  check('稀疏特征是 L2 归一化的（不会随句子长度无界变大）',
    Math.abs(Math.sqrt(Array.from(a.val).reduce((s, x) => s + x * x, 0)) - 1) < 1e-9);
  const d1 = denseFeatures('兔兔太屌了'), d2 = denseFeatures('兔兔太屌了');
  check(`手写特征长度 = ${HAND_DIM} 且确定`, d1.length === HAND_DIM && d1.every((v, i) => v === d2[i]));
  check('空文本不炸', extractSparse('', voc).idx.length === 0 && denseFeatures('').length === HAND_DIM);
  const trainer = fs.readFileSync(path.join(ROOT, 'scripts', 'train-emotion-net.mjs'), 'utf8');
  const infer = fs.readFileSync(path.join(ROOT, 'src', 'emotion-net.js'), 'utf8');
  check('训练器 import 的是 src/emotion-features.js（不是自己抄一份）',
    /from '\.\.\/src\/emotion-features\.js'/.test(trainer));
  check('推理模块也用同一份特征（extractSparse + denseFeatures）',
    /extractSparse/.test(infer) && /denseFeatures/.test(infer) && /from '\.\/emotion-features\.js'/.test(infer));
  check('训练器里没有第二份特征实现', !/export function featurize|function featurize\(/.test(trainer));
}

console.log('\n[1b] 调侃降权（2026-10-23："我说笨蛋只是调侃一下"）');
{
  check('「笨蛋程莫雯」→ 刺激只算 0.3', net.teaseScale('笨蛋程莫雯') === 0.3);
  check('「你才笨蛋」→ 0.3', net.teaseScale('你才笨蛋') === 0.3);
  check('普通句子 → 1（不误伤）', net.teaseScale('今天好热') === 1);
  check('空串 → 1', net.teaseScale('') === 1);
}

console.log('\n[2] 没有权重 → 保持中性，绝不注入、绝不随机');
{
  net.configure({ weightsPath: path.join(tmp, 'not-exist.json') });
  const s1 = net.scoreText('兔兔太屌了');
  const s2 = net.scoreText('烦死了');
  check('scoreText 全 0', s1.v === 0 && s1.a === 0 && s1.d === 0, JSON.stringify(s1));
  check('好话坏话都不编（同为 0）', JSON.stringify(s1) === JSON.stringify(s2));
  const e = net.updateEmotion(null, s1);
  check('buildEmotionLine 返回空串（不注入）', net.buildEmotionLine(e) === '');
  check('weightsInfo 说明是"没有可用权重"', net.weightsInfo().loaded === false);
  check('weightsInfo 带上失败原因（好排查）', /missing-file/.test(String(net.weightsInfo().error)), String(net.weightsInfo().error));
}

console.log('\n[3] 只有过线维度才注入');
{
  fs.writeFileSync(wPath, JSON.stringify(mkWeights({ usable: [true, false, false] })));
  net.configure({ weightsPath: wPath, neutralThreshold: 0.18, maxChars: 120 });
  const e = net.updateEmotion(null, { v: 0.9, a: 0.9, d: 0.9 }, null);
  const line = net.buildEmotionLine(e);
  check('usable=[true,false,false] 时只出现效价那类词', /心情不错|有点烦/.test(line), line);
  check('没学会的维度不出现（不说"话多""有底气"）', !/话会比平时|有底气|懒得打字|主导话题/.test(line), line);
  check('注入带语气倾向 + 硬性表达姿态', /倾向/.test(line) && /表达姿态/.test(line) && /照它来/.test(line));
    check('不再给她否决权（没有"可以忽略"）', !/可以忽略/.test(line), line);
  check('长度不超上限', line.length <= 120, String(line));
  // 没过线的维度连刺激都不该产生（不是"算出来但不说"）
  const s = net.scoreText('屌');
  check('scoreText 里没过线的维度直接返回 0', s.a === 0 && s.d === 0, JSON.stringify(s));
  fs.writeFileSync(wPath, JSON.stringify(mkWeights({ usable: [false, false, false] })));
  net.configure({ weightsPath: wPath });
  check('三个维度都不可用 → 一个空串都不注入', net.buildEmotionLine(net.updateEmotion(null, { v: 1, a: 1, d: 1 })) === '');
}

console.log('\n[4] 衰减是指数的（半衰期语义）');
{
  fs.writeFileSync(wPath, JSON.stringify(mkWeights()));
  net.configure({ weightsPath: wPath, halfLifeMs: 60 * 60 * 1000, neutralThreshold: 0.18 });
  const t0 = Date.now();
  const e0 = net.updateEmotion(null, { v: 1, a: 0, d: 0 }, null, t0);
  const half = net.applyDecay(e0, t0 + 60 * 60 * 1000);
  check('1 个半衰期后约剩一半', Math.abs(half.pad[0] - e0.pad[0] / 2) < 0.02, `${e0.pad[0]} → ${half.pad[0]}`);
  const three = net.applyDecay(e0, t0 + 3 * 3600 * 1000);
  check('3 小时后剩约 12.5%（3 个半衰期）', Math.abs(three.pad[0] - e0.pad[0] / 8) < 0.01, `${e0.pad[0]} → ${three.pad[0]}`);
  check('衰减后 3 小时不再注入', net.buildEmotionLine(e0, t0 + 3 * 3600 * 1000) === '');
  check('衰减推进 updatedAt（反复调用不会重复衰减）',
    net.applyDecay(net.applyDecay(e0, t0 + 1000), t0 + 1000).pad[0] === net.applyDecay(e0, t0 + 1000).pad[0]);
  check('时间倒流（时钟回拨）不会把情绪放大', net.applyDecay(e0, t0 - 60000).pad[0] <= e0.pad[0]);
}

console.log('\n[5] 状态消毒 & 边界');
{
  const dirty = net.sanitizeEmotion({ pad: [NaN, 5, 'x'], updatedAt: -1, evil: 1, __proto__: { polluted: 1 } });
  check('NaN → 0、越界 → 夹到 [-1,1]', dirty.pad[0] === 0 && dirty.pad[1] === 1 && dirty.pad[2] === 0, JSON.stringify(dirty.pad));
  check('脏键不会带进来', !('evil' in dirty) && dirty.evil === undefined);
  check('坏时间戳 → 用当前时间', Number.isFinite(dirty.updatedAt) && dirty.updatedAt > 0);
  const clamped = net.updateEmotion({ pad: [0.9, 0.9, 0.9], updatedAt: Date.now() }, { v: 1, a: 1, d: 1 });
  check('连续同向刺激被夹在 [-1,1]', clamped.pad.every((v) => v <= 1 && v >= -1), JSON.stringify(clamped.pad));
  check('原对象没被就地改（不可变更新）', (() => { const o = { pad: [0, 0, 0], updatedAt: Date.now() }; net.updateEmotion(o, { v: 1 }); return o.pad[0] === 0; })());
}

console.log('\n[6] 权重损坏 / 旧格式 / 维度不符 → 不崩、也不编');
{
  const cases = [
    ['坏 JSON', '{ 这不是 JSON', 'parse-fail'],
    ['旧版 char-gram 格式（必须拒绝，否则静默乱算）', JSON.stringify({ version: 1, inDim: 2060, hidden: 24, W1: [1], b1: [1], W2: [1], b2: [1] }), 'wrong-kind'],
    ['kind 对但词表为空', JSON.stringify({ ...mkWeights(), vocab: [] }), 'bad-vocab'],
    ['W 行数与词表对不上', JSON.stringify({ ...mkWeights(), W: mkW(VOCAB.length + 1) }), 'bad-W'],
    ['W 里有 null', JSON.stringify({ ...mkWeights(), W: [mkW().map(() => null), mkW(), mkW()] }), 'bad-W'],
    ['B 里有字符串', JSON.stringify({ ...mkWeights(), B: ['0.9', 0.9, 0.9] }), 'bad-B'],
    ['idf 长度不对', JSON.stringify({ ...mkWeights(), idf: [1, 2] }), 'bad-idf'],
    ['vocabSize 与 vocab 对不上', JSON.stringify({ ...mkWeights(), vocabSize: 99 }), 'dim-mismatch'],
  ];
  for (const [label, body, wantErr] of cases) {
    fs.writeFileSync(wPath, body);
    net.configure({ weightsPath: wPath });
    const info = net.weightsInfo();
    check(`${label} → 拒绝加载`, info.loaded === false, JSON.stringify(info));
    check(`${label} → 原因记为 ${wantErr}`, String(info.error).startsWith(wantErr), String(info.error));
    check(`${label} → scoreText 中性`, net.scoreText('随便')?.v === 0);
  }
  // 路径是目录
  net.configure({ weightsPath: tmp });
  check('路径是目录 → 拒绝加载且不抛异常', net.weightsInfo().loaded === false);
  check('坏的 configure 之后仍能恢复', (() => {
    fs.writeFileSync(wPath, JSON.stringify(mkWeights()));
    net.configure({ weightsPath: wPath });
    return net.weightsInfo().loaded === true && net.scoreText('屌').v > 0;
  })());
}

console.log('\n[7] 词表读回来必须是同一份（对不上则权重全废）');
{
  // 用真实特征管线（不是手搓词表）训练路径造一份权重：词表 + idf 走 buildVocab/makeVocabIndex，
  // 再把权重丢给推理模块加载 —— 如果加载端重建的索引与训练端不一致，算出来的分就对不上。
  const corpus = ['兔兔太屌了', '一坨狗屎啊', '哈哈哈哈笑死', '谢谢你兔兔', '傻杯', '生日快乐'];
  const list = buildVocab([...corpus, ...corpus], { minCount: 1, maxSize: 200 });
  const voc = makeVocabIndex(list, corpus);
  const V = list.length;
  const W = mkW(V);
  // 给几个 token 指定权重、给 2 号手写特征（问号）也指定权重，验证两条通道都用上了
  const tokenAt = (t) => voc.map.get(t);
  check('测试词表里确实有这两个 token（否则下面的比对是空转）',
    tokenAt('屌') !== undefined && tokenAt('屎') !== undefined, JSON.stringify({ 屌: tokenAt('屌'), 屎: tokenAt('屎'), V }));
  W[0][tokenAt('屌')] = 0.5;
  W[0][tokenAt('屎')] = -0.5;
  W[1][V + 2] = 0.25;
  fs.writeFileSync(wPath, JSON.stringify({
    version: 2, kind: 'sparse-linear-tfidf',
    vocab: list.map((x) => x.token), idf: Array.from(voc.idf),
    vocabSize: V, handDim: HAND_DIM, outDim: 3, W, B: [0, 0, 0],
    metrics: { corr: [0.5, 0.5, 0.5], usable: [true, true, false] },
  }));
  net.configure({ weightsPath: wPath });
  check('这份权重能加载', net.weightsInfo().loaded === true, JSON.stringify(net.weightsInfo()));
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  for (const text of ['兔兔太屌了', '一坨狗屎啊', '哈哈哈哈笑死', '屌?', '']) {
    const { idx, val } = extractSparse(text, voc);
    let expV = 0;
    for (let j = 0; j < idx.length; j++) { if (idx[j] === tokenAt('屌')) expV += 0.5 * val[j]; if (idx[j] === tokenAt('屎')) expV -= 0.5 * val[j]; }
    const expA = 0.25 * denseFeatures(text)[2];
    const got = net.scoreText(text);
    check(`「${text || '(空)'}」推理结果与训练端逐位一致`,
      Math.abs(got.v - clamp1(expV)) < 1e-12 && Math.abs(got.a - clamp1(expA)) < 1e-12,
      `got v${got.v} a${got.a} ｜ exp v${clamp1(expV)} a${clamp1(expA)}`);
  }
  check('没过线的维度恒为 0', net.scoreText('屌?').d === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });

// ── 桥接级：它到底能不能"在这套框架里跑"，以及坏掉时会不会带崩主流程 ──────────
console.log('\n[8] 桥接端到端（harness 里跑真实 handleIncoming / buildWakePromptV2）');{
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const wFile = path.join(tmp, 'usable-weights.json');
  fs.mkdirSync(tmp, { recursive: true });
  // 造一份"三个维度都可用"的确定性权重：W 全 0、B=1 → 输出恒为 1（非中性）
  fs.writeFileSync(wFile, JSON.stringify({ ...mkWeights({ B: [1, 1, 1], corr: [0.9, 0.9, 0.9] }) }));

  const ev = (text, id) => ({
    post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
    message_id: id, raw_message: text,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: 123, nickname: '管理员', card: '' },
    time: Math.floor(Date.now() / 1000),
  });

  // ① 默认关闭（enabled 缺省 = false）→ 一点都不做
  {
    const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, ev('兔兔太屌了', 'e-off-1'), b.cfg);
      const st = b.getSocialV2State('private:123');
      check('默认关闭时：状态里不会出现 emotion', !st?.emotion, JSON.stringify(st?.emotion));
      check('默认关闭时：提示词里没有语气行', !/【语气倾向】/.test(b.buildWakePromptV2('private:123', 'private')));
    } finally { await b.close(); }
  }

  // ② 打开 + 可用权重 → 情绪被更新、语气行进提示词
  {
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wFile, gain: 1 } } },
    });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, ev('兔兔太屌了', 'e-on-1'), b.cfg);
      const st = b.getSocialV2State('private:123');
      check('打开后：emotion 落进会话状态', Array.isArray(st?.emotion?.pad), JSON.stringify(st?.emotion));
      check('pad 被推向正值（模型输出 1 × gain 1）',
        Number(st?.emotion?.pad?.[0]) > 0.5, JSON.stringify(st?.emotion?.pad));
      const prompt = b.buildWakePromptV2('private:123', 'private');
      check('语气行真的进了提示词', /【语气倾向】/.test(prompt), prompt.slice(-140));
      check('语气行带着硬性表达姿态进了提示词', /表达姿态/.test(prompt) && /照它来/.test(prompt));
      const onDisk = JSON.parse(fs.readFileSync(path.join(b.paths.stateDir, 'social-v2.json'), 'utf8'));
      check('emotion 落盘（重启不丢）', !!onDisk.conversations?.['private:123']?.emotion, 'state 文件里没有 emotion');
    } finally { await b.close(); }
  }

  // ②b 短句降权（2026-10-23）：模型对 1~3 字最不准（只有一两个 token）。
  //   实测「没招」v=-0.42 而它在训练集里就被标成 -0.4 —— 不是学歪，是"群友抱怨"的语境
  //   被套到了"他对她说"。所以 2~3 字刺激 ×0.5、1 字（"？""嗯"）直接不给刺激。
  {
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wFile, gain: 1 } } },
    });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, ev('没招', 'e-short-1'), b.cfg);
      let st = b.getSocialV2State('private:123');
      const afterShort = Number(st?.emotion?.pad?.[0]);
      check('2~3 字短句刺激减半（模型输出 1 × 0.5）', Math.abs(afterShort - 0.5) < 1e-6, `pad[0]=${afterShort}`);
      await b.handleIncoming('private', 123, ev('？', 'e-short-2'), b.cfg);
      st = b.getSocialV2State('private:123');
      const afterOne = Number(st?.emotion?.pad?.[0]);
      check('1 个字不给刺激（"？"不改变情绪）', Math.abs(afterOne - afterShort) < 1e-6, `pad[0]=${afterOne}`);
    } finally { await b.close(); }
  }

  // ②c 负刺激压缩（2026-10-23）：模型对负面更敏感，单句 < -0.3 打 7 折，别让一句话定生死。
  {
    const wNeg = path.join(tmp, 'neg-weights.json');
    fs.writeFileSync(wNeg, JSON.stringify(mkWeights({ B: [-1, -1, -1], corr: [0.9, 0.9, 0.9] })));
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wNeg, gain: 1 } } },
    });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, ev('今天真的很烦人', 'e-neg-1'), b.cfg);
      const st = b.getSocialV2State('private:123');
      const pad = Number(st?.emotion?.pad?.[0]);
      check('强负刺激压缩到 7 折（模型 -1 → 约 -0.7）', Math.abs(pad - (-0.7)) < 1e-6, `pad[0]=${pad}`);
      // 情绪溯源（2026-10-23）：情绪明显时，语气行带出"是哪句话"让她知道为什么。
      const prompt = b.buildWakePromptV2('private:123', 'private');
      check('情绪明显时带溯源（跟这件事有关 + 原话）',
        /跟这件事有关/.test(prompt) && /今天真的很烦人/.test(prompt), prompt.slice(-180));
    } finally { await b.close(); }
  }

  // ②e 弱刺激降权（2026-10-24 管理员："有些话语情绪刺激会很小……只要影响很低就行"）：
  //    中性话的 +0.1 残差降成三成 —— 几乎不动，但真情绪（夸/骂）照常。
  {
    const wWeak = path.join(tmp, 'weak-weights.json');
    fs.writeFileSync(wWeak, JSON.stringify(mkWeights({ B: [0.1, 0.1, 0.1], corr: [0.9, 0.9, 0.9] })));
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wWeak, gain: 1 } } },
    });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, ev('明天见吧', 'e-weak-1'), b.cfg);
      const st = b.getSocialV2State('private:123');
      const pad = Number(st?.emotion?.pad?.[0]);
      check('弱刺激降权（中性话几乎不动，|pad| < 0.05）', Math.abs(pad) < 0.05, `pad[0]=${pad}`);
    } finally { await b.close(); }
  }

  // ③ 故障注入：权重是坏文件 / 路径是目录 / 是旧格式 → 只记 warn，主流程照常，且不注入
  for (const [label, badPath] of [['坏 JSON', path.join(tmp, 'bad.json')], ['路径是目录', tmp]]) {
    if (label === '坏 JSON') fs.writeFileSync(badPath, '{oops');
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: badPath } } },
    });
    try {
      b.setMode('reserved2');
      let threw = null;
      try {
        await b.handleIncoming('private', 123, ev('测试', `e-bad-${label}`), b.cfg);
      } catch (error) { threw = error; }
      check(`权重${label}：handleIncoming 不抛异常（只跳过情感）`, !threw, String(threw));
      const prompt = b.buildWakePromptV2('private:123', 'private');
      check(`权重${label}：不注入任何语气行`, !/【语气倾向】/.test(prompt));
    } finally { await b.close(); }
  }

  // ④ 熔断器：连续报错就自动停用（用户："我真怕到时候又有一堆bug"）
  // 注意：坏权重路径这种故障**模块自己就兜住了**（loadWeights 里 catch → 返回中性），
  // 根本不给上层报错的机会 —— 这是好事。所以这里直接测熔断器本体：
  // 真的抛到上层时（未来代码改坏/环境异常），连续 5 次就必须自我停用。
  {
    const b = await bridgeHarness({
      config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wFile, gain: 1 } } },
    });
    try {
      b.setMode('reserved2');
      check('初始未熔断', b.emotionRuntimeState().disabled === false, JSON.stringify(b.emotionRuntimeState()));
      let threw = null;
      try {
        for (let i = 0; i < 4; i++) b.emotionFault(new Error(`测试故障 ${i}`));
      } catch (error) { threw = error; }
      check('报错 4 次还没熔断（不因偶发就停）', b.emotionRuntimeState().disabled === false, JSON.stringify(b.emotionRuntimeState()));
      b.emotionFault(new Error('第 5 次'));
      const st2 = b.emotionRuntimeState();
      check('连续第 5 次报错 → 自动熔断', st2.disabled === true, JSON.stringify(st2));
      check('熔断过程本身不抛异常', !threw, String(threw));
      check('熔断后不再注入语气行', b.buildEmotionLineFor('private:123') === '');
      await b.handleIncoming('private', 123, ev('熔断后照常', 'e-brk-1'), b.cfg);
      const st = b.getSocialV2State('private:123');
      check('熔断后消息照常入库、状态照常更新（她别的功能不受影响）',
        (st?.recentMessages ?? []).length >= 1 && !st?.emotion, JSON.stringify({ msgs: (st?.recentMessages ?? []).length, emotion: st?.emotion ?? null }));
    } finally { await b.close(); }
  }
}

// ── 生产权重（如果训过）：加载、门限自洽、输出不退化 ────────────────────────
console.log('\n[9] 生产权重文件 state/emotion-weights.json');
{
  const prod = path.join(ROOT, 'state', 'emotion-weights.json');
  if (!fs.existsSync(prod)) {
    console.log('  ⏭ 还没有训练好的权重（先跑 node scripts/train-emotion-net.mjs），本节跳过');
  } else {
    net.configure({ weightsPath: prod });
    const info = net.weightsInfo();
    check('能加载', info.loaded === true, JSON.stringify(info));
    check('是 v2 稀疏格式', info.kind === 'sparse-linear-tfidf' && info.vocabSize > 0, JSON.stringify(info));
    check('词表规模在预期范围（500~6000）', info.vocabSize >= 500 && info.vocabSize <= 6000, String(info.vocabSize));
    const gate = net.currentOptions().minCorr;
    // 安全性质（不能放宽，只能收紧）：**任何要注入的维度，相关必须过线**。
    // 手工把过线的维度改成 false（比如 d 压线时先关掉它）是允许的；反过来把没过线的维度打开则必须报错。
    check(`要注入的维度相关都过了 ${gate} 的线（允许手工收紧、不允许放宽）`,
      info.usable.every((u, k) => !u || Math.abs(info.corr[k]) >= gate),
      JSON.stringify({ corr: info.corr, usable: info.usable, gate }));
    check('至少有一个维度可用（否则模块等于没开，白占接线）',
      info.usable.some(Boolean), JSON.stringify(info.usable));
    check('记录了交叉验证指标（不是训练集数字）', Number(info.metrics?.oofMse) > 0 && Array.isArray(info.metrics?.spearman));
    const texts = ['一坨狗屎', '谢谢你兔兔', '哈哈哈哈笑死', '傻杯', '生日快乐'];
    const outs = texts.map((t) => net.scoreText(t));
    check('输出都在 [-1,1]', outs.every((o) => [o.v, o.a, o.d].every((x) => x >= -1 && x <= 1)));
    check('不是退化状态（不同文本输出不全一样）',
      new Set(outs.map((o) => `${o.v.toFixed(3)}/${o.a.toFixed(3)}/${o.d.toFixed(3)}`)).size >= 3);
    const semOk = net.scoreText('一坨狗屎').v < net.scoreText('谢谢你兔兔').v;
    check('语感抽查：屎 < 谢谢（若这条挂了说明权重坏了，不要接进提示词）', semOk,
      `屎 ${net.scoreText('一坨狗屎').v.toFixed(3)} vs 谢谢 ${net.scoreText('谢谢你兔兔').v.toFixed(3)}`);
    const line = net.buildEmotionLine({ pad: [0.5, 0.3, -0.4], updatedAt: Date.now() });
    console.log(`  注入行示例：${line}`);
    check('注入行不超过 maxChars', line.length <= net.currentOptions().maxChars);

    // 真实权重能不能**真的**在桥接路径上产生注入 —— 光有"接线"不算，必须真的会响。
    // 这一节同时也是"正负方向有没有搞反"的守门人（反了的话她会在一片骂声里说"心情不错"）。
    console.log('  — 真实权重端到端（harness 里喂真消息，看 pad 与注入行）—');
    const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
    const NEG = ['一坨狗屎', '傻杯', '我草泥马啊我的队友都是屎吗', '真的要燃尽了', '我好绝望啊', '这游戏真垃圾'];
    const POS = ['谢谢你兔兔', '兔兔太屌了', '生日快乐', '好耶', '哈哈哈哈哈笑死', '你太可爱了'];
    const evp = (text, id) => ({
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
      message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }],
      sender: { user_id: 123, nickname: '管理员', card: '' }, time: Math.floor(Date.now() / 1000),
    });
    for (const [label, seq, want] of [['负面', NEG, -1], ['正面', POS, 1]]) {
      const b = await bridgeHarness({ config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: prod } } } });
      try {
        b.setMode('reserved2');
        let i = 0;
        for (const t of seq) await b.handleIncoming('private', 123, evp(t, `prod-${label}-${i++}`), b.cfg);
        const st = b.getSocialV2State('private:123');
        const v = Number(st?.emotion?.pad?.[0]);
        const prompt = b.buildWakePromptV2('private:123', 'private');
        const line = (prompt.match(/【语气倾向】[^\n]*/) ?? [''])[0];
        check(`连喂 ${seq.length} 条${label}消息后效价往${label === '负面' ? '负' : '正'}走（v=${v.toFixed(3)}）`, Math.sign(v) === want,
          `pad=${JSON.stringify(st?.emotion?.pad)}`);
        check(`${label}消息确实注入了对味的语气行`, label === '负面' ? /有点烦/.test(line) && !/心情不错/.test(line) : /心情不错/.test(line) && !/有点烦/.test(line),
          line || '（没有注入行 → 模块等于没接，或权重太弱）');
      } finally { await b.close(); }
    }
  }
}

// ── 静息基线（2026-09-30：模型输出有正的常数偏移，不减掉就会把情绪顶到上限）────────
console.log('\n[11] 静息基线');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-emotion-base-'));
  const corpus = ['兔兔太屌了', '一坨狗屎啊', '哈哈哈哈笑死', '谢谢你兔兔', '傻杯', '生日快乐'];
  const list = buildVocab([...corpus, ...corpus], { minCount: 1, maxSize: 200 });
  const voc = makeVocabIndex(list, corpus);
  const V = list.length;
  const w = [0, 1, 2].map(() => new Array(V + HAND_DIM).fill(0));
  w[0][voc.map.get('屌')] = 0.5;
  w[1][V + 1] = 0.3;                     // 手写特征第 1 维（有感叹号）
  const f = path.join(dir, 'w.json');
  fs.writeFileSync(f, JSON.stringify({
    version: 2, kind: 'sparse-linear-tfidf', vocab: list.map((x) => x.token), idf: Array.from(voc.idf),
    vocabSize: V, handDim: HAND_DIM, outDim: 3, W: w, B: [0, 0, 0], metrics: { corr: [0.5, 0.5, 0.5], usable: [true, true, true] },
  }));
  // ① 基线就是"逐维减掉一个常数"
  net.configure({ weightsPath: f, baseline: null });
  const raw = net.scoreText('兔兔太屌了!');
  net.configure({ weightsPath: f, baseline: { v: 0.1, a: 0.2, d: 0.3 } });
  const biased = net.scoreText('兔兔太屌了!');
  check('有基线 = 无基线 − 基线（逐维）',
    Math.abs(biased.v - (raw.v - 0.1)) < 1e-12 && Math.abs(biased.a - (raw.a - 0.2)) < 1e-12,
    JSON.stringify({ raw, biased }));
  // ② 脏配置不许改变行为、也不许崩
  for (const [label, bad] of [['null', null], ['空对象', {}], ['字符串', 'abc'], ['零数组', [0, 0, 0]]]) {
    net.configure({ weightsPath: f, baseline: bad });
    const got = net.scoreText('兔兔太屌了!');
    check(`baseline=${label} → 当作 0（不炸、不改行为）`, Math.abs(got.v - raw.v) < 1e-12, JSON.stringify(got));
  }
  net.configure({ weightsPath: f, baseline: { v: 5, a: NaN, d: 'x' } });
  check('越界被夹到 ±1、非数字归零',
    (() => { const s = net.scoreText('兔兔太屌了!'); return Math.abs(s.v - (raw.v - 1)) < 1e-12 && Math.abs(s.a - raw.a) < 1e-12; })(),
    JSON.stringify({ raw, got: net.scoreText('兔兔太屌了!') }));
  fs.rmSync(dir, { recursive: true, force: true });

  // ③ 生产权重 + 生产基线：真实语料上的**平均刺激应当 ≈ 0** —— 这正是"不再往上限漂"的判据
  const prod = path.join(ROOT, 'state', 'emotion-weights.json');
  const corpusFile = path.join(ROOT, 'state', 'group-corpus.jsonl');
  if (!fs.existsSync(prod) || !fs.existsSync(corpusFile)) {
    console.log('  ⏭ 没有生产权重/语料，这一小节跳过');
  } else {
    const cfgAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const base = cfgAll.socialV2?.emotion?.baseline ?? null;
    const texts = [];
    for (const line of fs.readFileSync(corpusFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = String(JSON.parse(line).x ?? '').trim(); if (t && texts.length < 400) texts.push(t); } catch { /* 坏行 */ }
    }
    const meanOf = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
    const sample = (b) => {
      net.configure({ weightsPath: prod, baseline: b });
      const vs = [], as = [];
      for (const t of texts) { const s = net.scoreText(t); vs.push(s.v); as.push(s.a); }
      return { v: meanOf(vs), a: meanOf(as) };
    };
    check('config 里配了基线', !!base && Number.isFinite(Number(base.v)) && Number.isFinite(Number(base.a)), JSON.stringify(base));
    const noBase = sample(null);
    const withBase = sample(base);
    check('不减基线时确实有正的常数偏移（a 尤其明显）', noBase.v > 0.01 && noBase.a > 0.15, JSON.stringify(noBase));
    check(`减掉基线后平均刺激≈0（v ${withBase.v.toFixed(3)}、a ${withBase.a.toFixed(3)}）`,
      Math.abs(withBase.v) < 0.06 && Math.abs(withBase.a) < 0.06, JSON.stringify(withBase));
  }

  // ④ 桥接真的把基线传下去了吗（漏传 = 白配）+ 会话末尾如实记了"这轮注入了哪句"
  {
    const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
    const wFile = path.join(dir, 'const.json');
    fs.mkdirSync(dir, { recursive: true });
    // 造一份"输出恒为 1"的权重：B=1、W 全 0 → 刺激 = 1 − baseline
    fs.writeFileSync(wFile, JSON.stringify({
      version: 2, kind: 'sparse-linear-tfidf', vocab: VOCAB.slice(), idf: VOCAB.map(() => 1),
      vocabSize: VOCAB.length, handDim: HAND_DIM, outDim: 3,
      W: mkW(), B: [1, 1, 1], metrics: { corr: [0.9, 0.9, 0.9], usable: [true, false, false] },
    }));
    const evb = (text, id) => ({
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
      message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }],
      sender: { user_id: 123, nickname: '管理员', card: '' }, time: Math.floor(Date.now() / 1000),
    });
    const padAfter = async (baseline) => {
      const b = await bridgeHarness({ config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: wFile, gain: 1, logChanges: true, ...(baseline ? { baseline } : {}) } } } });
      try {
        b.setMode('reserved2');
        await b.handleIncoming('private', 123, evb('随便一句', `base-${baseline ? 'on' : 'off'}`), b.cfg);
        const st = b.getSocialV2State('private:123');
        // 注入那行日志是在**拼唤醒提示词**时记的，所以得先真的拼一次
        b.buildWakePromptV2('private:123', 'timeout');
        let logText = '';
        try { logText = fs.readFileSync(path.join(b.paths.stateDir, 'bridge.log'), 'utf8'); } catch { /* 没日志文件 */ }
        return { pad: Number(st?.emotion?.pad?.[0]), logText };
      } finally { await b.close(); }
    };
    const off = await padAfter(null);
    const on = await padAfter({ v: 0.6, a: 0.6, d: 0 });
    check(`桥接把 baseline 传下去并生效（pad ${off.pad.toFixed(2)} → ${on.pad.toFixed(2)}）`,
      Math.abs(off.pad - 1) < 0.01 && Math.abs(on.pad - 0.4) < 0.01, JSON.stringify({ off: off.pad, on: on.pad }));
    check('会话末尾如实记了"这轮注入了哪句"（原来这个观测缺口只能靠反推）',
      /\[emotion\][^\n]*语气行/.test(off.logText) && /语气行/.test(on.logText),
      (off.logText.match(/\[emotion\][^\n]*/g) ?? []).slice(-2).join(' ｜ '));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 上下文模式（第二轮）：特征排布、加载校验、以及"桥接喂的上文"到底对不对 ──────
console.log('\n[10] 带上下文（上文 + 本句）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-emotion-ctx-'));
  const corpus = ['兔兔太屌了', '一坨狗屎啊', '哈哈哈哈笑死', '谢谢你兔兔', '傻杯', '生日快乐'];
  const list = buildVocab([...corpus, ...corpus], { minCount: 1, maxSize: 200 });
  const voc = makeVocabIndex(list, corpus);
  const V = list.length;
  const HANDT = HAND_DIM + CTX_DIM;
  const clamp1 = (x) => Math.max(-1, Math.min(1, x));
  const tok = (t) => voc.map.get(t);

  // ① 排布：本句里的「屌」+0.5、上文里的「屎」-0.5、上文在骂人时 a +0.25
  const w = [0, 1, 2].map(() => new Array(2 * V + HANDT).fill(0));
  w[0][tok('屌')] = 0.5;
  w[0][V + tok('屎')] = -0.5;
  w[1][2 * V + HAND_DIM] = 0.25;             // contextFeatures[0] = 上文在骂人
  const wFile = path.join(dir, 'ctx.json');
  fs.writeFileSync(wFile, JSON.stringify({
    version: 2, kind: 'sparse-linear-tfidf',
    vocab: list.map((x) => x.token), idf: Array.from(voc.idf),
    vocabSize: V, handDim: HANDT, context: true, ctxDim: CTX_DIM, outDim: 3,
    W: w, B: [0, 0, 0],
    metrics: { corr: [0.5, 0.5, 0.5], usable: [true, true, true] },
  }));
  net.configure({ weightsPath: wFile });
  check('带上下文的权重能加载', net.weightsInfo().loaded === true, JSON.stringify(net.weightsInfo()));
  check('weightsInfo 标了 context', net.weightsInfo().context === true);
  const expect = (text, prev) => {
    const cur = extractSparse(text, voc);
    const pv = extractSparse(prev, voc);
    let ev = 0;
    for (let j = 0; j < cur.idx.length; j++) if (cur.idx[j] === tok('屌')) ev += 0.5 * cur.val[j];
    for (let j = 0; j < pv.idx.length; j++) if (pv.idx[j] === tok('屎')) ev -= 0.5 * pv.val[j];
    return { v: clamp1(ev), a: clamp1(0.25 * contextFeatures(prev)[0]) };
  };
  for (const [text, prev] of [['屌', '屎'], ['屌', ''], ['屌', '谢谢你兔兔'], ['兔兔太屌了', '一坨狗屎啊']]) {
    const got = net.scoreText(text, prev);
    const exp = expect(text, prev);
    check(`「${text}」+上文「${prev || '(无)'}」与训练端逐位一致`,
      Math.abs(got.v - exp.v) < 1e-12 && Math.abs(got.a - exp.a) < 1e-12,
      `got v${got.v} a${got.a} ｜ exp v${exp.v} a${exp.a}`);
  }
  // 上文真的改变了结果（否则"上下文"就是摆设）
  check('换了上文，输出会变（上下文确实参与计算）',
    net.scoreText('屌', '屎').v !== net.scoreText('屌', '谢谢你兔兔').v,
    `${net.scoreText('屌', '屎').v} vs ${net.scoreText('屌', '谢谢你兔兔').v}`);
  // ② 格式守卫：ctxDim / handDim 对不上必须拒载
  for (const [label, patch, wantErr] of [
    ['context 为 true 但 ctxDim 不是 3', { ctxDim: 5 }, 'dim-mismatch'],
    ['context 为 true 但 handDim 还是 12', { handDim: HAND_DIM }, 'dim-mismatch'],
    ['W 行长度只算了单块', { W: [0, 1, 2].map(() => new Array(V + HANDT).fill(0)) }, 'bad-W'],
  ]) {
    const p2 = path.join(dir, `bad-${wantErr}-${Math.abs(label.length)}.json`);
    fs.writeFileSync(p2, JSON.stringify({
      version: 2, kind: 'sparse-linear-tfidf', vocab: list.map((x) => x.token), idf: Array.from(voc.idf),
      vocabSize: V, handDim: HANDT, context: true, ctxDim: CTX_DIM, outDim: 3, W: w, B: [0, 0, 0],
      metrics: { corr: [0.5, 0.5, 0.5], usable: [true, true, true] }, ...patch,
    }));
    net.configure({ weightsPath: p2 });
    check(`${label} → 拒绝加载（${wantErr}）`, net.weightsInfo().loaded === false && String(net.weightsInfo().error).startsWith(wantErr),
      JSON.stringify(net.weightsInfo()));
  }

  // ③ 桥接到底喂了什么上文 —— 造一份"v = 上文里有屎 ? 1 : 0"的权重，只靠上文驱动
  const w2 = [0, 1, 2].map(() => new Array(2 * V + HANDT).fill(0));
  w2[0][V + tok('屎')] = 1;
  const prevOnly = path.join(dir, 'prev-only.json');
  fs.writeFileSync(prevOnly, JSON.stringify({
    version: 2, kind: 'sparse-linear-tfidf', vocab: list.map((x) => x.token), idf: Array.from(voc.idf),
    vocabSize: V, handDim: HANDT, context: true, ctxDim: CTX_DIM, outDim: 3, W: w2, B: [0, 0, 0],
    metrics: { corr: [0.5, 0.5, 0.5], usable: [true, false, false] },
  }));
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const evc = (text, id) => ({
    post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
    message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }],
    sender: { user_id: 123, nickname: '管理员', card: '' }, time: Math.floor(Date.now() / 1000),
  });
  // ⚠️ 这三条原来靠"往 st.recentMessages 里塞一条"来模拟 —— 2026-10-02 重构后
  //    **上文不再从 recentMessages 取**（那玩意儿在"静默模式"下根本不更新，实测静默期间
  //    整段群聊既没进语料也没进情感），改成 feedLearning 自己维护的上文环。
  //    所以这里改成"走真实入口造场景"，不再直接改内部状态（改内部状态测的是实现，不是行为）。
  const evSelf = (text, id) => ({
    post_type: 'message', message_type: 'private', user_id: 999, self_id: 999,
    message_id: id, raw_message: text, message: [{ type: 'text', data: { text } }],
    sender: { user_id: 999, nickname: '今晚吃兔兔', card: '' }, time: Math.floor(Date.now() / 1000),
  });
  const run = async (between) => {
    const b = await bridgeHarness({ config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: prevOnly, gain: 1 } } } });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, evc('一坨狗屎', 'c1'), b.cfg);
      if (between) await between(b);
      // 关键探针：**第二条消息处理之前**这个会话的上文是什么（之后它自己就变成上文了）
      const prevBefore = b.learningPrevTextFor('private:123');
      await b.handleIncoming('private', 123, evc('哈哈', 'c2'), b.cfg);
      return { v: Number(b.getSocialV2State('private:123')?.emotion?.pad?.[0]), prevBefore };
    } finally { await b.close(); }
  };
  const vPlain = await run(null);
  // 注意：稀疏特征是 L2 归一化的，所以"上文里有屎"给出的刺激是 ~0.47 而不是 1.0 —— 别按 1.0 去卡
  check(`上一句是别人说的「一坨狗屎」→ 本句的刺激被上文推起来（pad.v=${vPlain.v.toFixed(2)}）`,
    vPlain.v > 0.3 && vPlain.prevBefore === '一坨狗屎', `pad.v=${vPlain.v.toFixed(2)} prev=${JSON.stringify(vPlain.prevBefore)}`);
  const vSelf = await run(async (b) => { await b.handleIncoming('private', 999, evSelf('我自己说的话', 'c-self'), b.cfg); });
  check('中间夹了她自己发的话 → 不进上文环，仍用别人那条当上文',
    vSelf.v === vPlain.v && vSelf.prevBefore === '一坨狗屎', `pad.v=${vSelf.v.toFixed(2)} prev=${JSON.stringify(vSelf.prevBefore)}`);
  const vMedia = await run(async (b) => {
    await b.handleIncoming('private', 123, {
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 'c-media',
      raw_message: '[图片]', message: [{ type: 'image', data: { file: 'x.jpg', url: 'https://public.invalid/x.jpg' } }],
      sender: { user_id: 123, nickname: '管理员', card: '' }, time: Math.floor(Date.now() / 1000),
    }, b.cfg);
  });
  // 图片那条自己也会被计分（它也有上文），所以这里不能比 pad，只能比"它有没有顶掉上文"
  check('中间夹了图片占位 → 不进上文环，仍用有字那条当上文',
    vMedia.prevBefore === '一坨狗屎', `prev=${JSON.stringify(vMedia.prevBefore)}`);
  // 超窗口这条直接查"取上文"这个规则本身：把 now 往后推 200s，等价于上文已经隔了 200s
  const oldPrev = await (async () => {
    const b = await bridgeHarness({ config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: prevOnly, gain: 1 } } } });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, evc('一坨狗屎', 'c1'), b.cfg);
      return b.learningPrevTextFor('private:123', Date.now() + 200000);
    } finally { await b.close(); }
  })();
  check('上文隔了 200s（超过 180s 窗口）→ 不给上文', oldPrev === '', `prev(200s后)=${JSON.stringify(oldPrev)}`);
  const vFirst = await (async () => {
    const b = await bridgeHarness({ config: { socialV2: { enabled: true, emotion: { enabled: true, weightsPath: prevOnly, gain: 1 } } } });
    try {
      b.setMode('reserved2');
      await b.handleIncoming('private', 123, evc('哈哈', 'c0'), b.cfg);
      return Number(b.getSocialV2State('private:123')?.emotion?.pad?.[0] ?? 0);
    } finally { await b.close(); }
  })();
  check('群里第一句（没有上文）→ 不给上文（pad.v=0）', vFirst === 0, `pad.v=${vFirst}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
