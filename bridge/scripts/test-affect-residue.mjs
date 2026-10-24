/**
 * 情绪余波（AffectResidue）的纯逻辑测试（2026-10-14）。
 *
 * 要守住的两条最要紧：
 *   ① **排除自己** —— 本会话的 PAD 已经体现在 st.emotion 里，余波再吃一遍等于算两次；
 *   ② **只当底色** —— 权重 0.3，不能压过当前会话的情绪（否则"私聊时莫名情绪化"）。
 */
import assert from 'node:assert/strict';
import {
  RESIDUE_WEIGHT, RESIDUE_HALF_LIFE_MS, RESIDUE_BLEND, RESIDUE_MIN_STRENGTH,
  residueStrength, shouldDeposit, decayResidue, blendResidue, othersResidue, mixPad,
  parseResidueStore, trimResidueStore,
} from '../src/affect-residue.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const NOW = 1792080000000;   // 固定时间戳，别让测试跟时钟赛跑

t('强度取效价和唤醒度里更明显的那个', () => {
  assert.equal(residueStrength([-0.4, 0.1, 0]), 0.4);
  assert.equal(residueStrength([0.05, -0.6, 0]), 0.6);
});
t('中性波动不值得沉淀', () => {
  assert.equal(shouldDeposit([0.01, -0.02, 0]), false);
});
t('明显的情绪值得沉淀', () => {
  assert.equal(shouldDeposit([-0.4, 0.1, 0]), true);
});
t('门槛是可调的（测试用）', () => {
  assert.equal(shouldDeposit([0.02, 0, 0], { minStrength: 0.01 }), true);
});
t('余波会随时间衰减（一个半衰期减半）', () => {
  const e = { pad: [0.8, 0.6, 0.4], updatedAt: NOW - RESIDUE_HALF_LIFE_MS };
  const d = decayResidue(e, NOW);
  assert.ok(Math.abs(d[0] - 0.4) < 1e-6, String(d[0]));
  assert.ok(Math.abs(d[1] - 0.3) < 1e-6, String(d[1]));
});
t('余波半衰期比会话内慢（6h vs 3h）', () => {
  assert.equal(RESIDUE_HALF_LIFE_MS, 6 * 3600 * 1000);
});
t('沉淀是慢融合，不是覆盖', () => {
  const prev = { pad: [-0.6, 0, 0], updatedAt: NOW };
  const next = blendResidue(prev, [0.6, 0, 0], NOW);
  // 35% 融合：−0.6*0.65 + 0.6*0.35 = −0.18
  assert.ok(next.pad[0] > -0.25 && next.pad[0] < -0.1, String(next.pad[0]));
  assert.ok(next.pad[0] < 0.6, '一次小波动不该把底色冲成正的');
});
t('★ 只取别的会话的余波（排除自己）', () => {
  const sessions = {
    'group:1': { pad: [-0.8, 0, 0], updatedAt: NOW },
    'private:2': { pad: [0.8, 0, 0], updatedAt: NOW },
  };
  const others = othersResidue(sessions, 'group:1', NOW);
  assert.ok(others[0] > 0.7, `应该只剩 private:2 的正值，实际 ${others[0]}`);
});
t('★ 只有一个会话时，它的余波不作用于自己', () => {
  const sessions = { 'group:1': { pad: [-0.9, 0, 0], updatedAt: NOW } };
  const others = othersResidue(sessions, 'group:1', NOW);
  assert.deepEqual(others, [0, 0, 0]);
});
t('多个会话取平均', () => {
  const sessions = {
    a: { pad: [-0.6, 0, 0], updatedAt: NOW },
    b: { pad: [-0.2, 0, 0], updatedAt: NOW },
  };
  const others = othersResidue(sessions, 'self', NOW);
  assert.ok(Math.abs(others[0] + 0.4) < 1e-6, String(others[0]));
});
t('★ 余波只当底色：不会被余波翻面', () => {
  const mixed = mixPad([0.8, 0, 0], [-1, 0, 0], RESIDUE_WEIGHT);
  assert.ok(mixed[0] > 0, `当前情绪的方向该保住，实际 ${mixed[0]}`);
  assert.ok(mixed[0] < 0.8, '但会被余波拉低一些');
});
t('★ 弱情绪也不会被余波翻成相反方向（会减弱到一半）', () => {
  const mixed = mixPad([0.3, 0, 0], [-1, 0, 0], RESIDUE_WEIGHT);
  assert.ok(mixed[0] > 0, `不该翻成负数，实际 ${mixed[0]}`);
  assert.ok(Math.abs(mixed[0] - 0.15) < 1e-6, `该减弱到一半，实际 ${mixed[0]}`);
});
t('符号本来相反时不该被"保护"成翻转（保持余波的方向也没问题）', () => {
  // base=0 时没有"当前情绪方向"可言，余波直接生效
  const mixed = mixPad([0, 0, 0], [-1, 0, 0], RESIDUE_WEIGHT);
  assert.ok(mixed[0] < 0, String(mixed[0]));
});
t('权重 0 = 完全忽略余波', () => {
  assert.deepEqual(mixPad([0.5, 0, 0], [-1, -1, -1], 0), [0.5, 0, 0]);
});
t('合成结果不越界', () => {
  const m = mixPad([2, -2, 0.5], [2, -2, 0.5], 1);
  m.forEach((x) => assert.ok(x >= -1 && x <= 1, String(x)));
});
t('解析落盘数据容错（坏数据当空）', () => {
  assert.deepEqual(parseResidueStore('坏'), { sessions: {} });
  assert.deepEqual(parseResidueStore('{"sessions":{"a":{"pad":[1]}}}'), { sessions: {} });
  const ok = parseResidueStore('{"sessions":{"a":{"pad":[-0.2,0.1,0],"updatedAt":123}}}');
  assert.deepEqual(ok.sessions.a.pad, [-0.2, 0.1, 0]);
});
t('会话上限按最近更新淘汰', () => {
  const store = { sessions: {} };
  for (let i = 0; i < 60; i++) store.sessions['k' + i] = { pad: [0, 0, 0], updatedAt: i };
  const trimmed = trimResidueStore(store, 40);
  assert.equal(Object.keys(trimmed.sessions).length, 40);
  assert.ok(trimmed.sessions.k59, '最新的要留着');
  assert.ok(!trimmed.sessions.k0, '最旧的该被淘汰');
});
t('常量是照实测定的（改之前先想清楚）', () => {
  assert.equal(RESIDUE_WEIGHT, 0.3);
  assert.equal(RESIDUE_BLEND, 0.35);
  assert.equal(RESIDUE_MIN_STRENGTH, 0.12);
});

console.log(`\n  affect-residue 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
