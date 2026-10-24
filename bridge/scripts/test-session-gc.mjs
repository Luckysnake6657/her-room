/**
 * 回归测试：**退役会话的垃圾回收**（2026-10-12）。
 *
 * 现场：会话轮换（换 preset / 换模型 / 权限变化）时桥接会先 `stopSessionWork(旧会话)`。
 * 实测 DSH 侧回 `invalid session/control baseline`，而旧代码**只在日志里写一行**
 * "请在 DSH 检查旧任务" —— 等于把问题丢给人。代价是旧会话可能还在跑：它调工具会被
 * `assertSession` 拦下（发不出去），但**模型推理照样烧 token**。
 *
 * 现在的约定（这个用例钉的就是它）：
 *   • 停不掉的会话记进 `state/session-gc.json`（同一条不重复，tries 累加）；
 *   • 启动时 + 每 2 分钟的看门狗里各重试一次，成功就清掉；
 *   • 试超过 5 次的**不再重试**（DSH 那边已经没它了，再试是白试），但记录留着。
 */
import fs from 'node:fs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123 } });
try {
  h.setMode('reserved2');
  const reset = () => { fs.rmSync(h.SESSION_GC_FILE, { force: true }); };
  const cancelled = () => (h.calls.cancelled ?? []).map((x) => (typeof x === 'string' ? x : x?.sessionId)).filter(Boolean);

  console.log('\n[1] 停不掉的会话要被记下来（同一条不重复，tries 累加）');
  {
    reset();
    h.noteSessionGc('sess-fail-1', 'private:123', 'invalid session/control baseline');
    let list = h.readSessionGc();
    check('记入清单 1 条', list.length === 1 && list[0].sessionId === 'sess-fail-1', JSON.stringify(list));
    check('带上了 key 与原因', list[0].key === 'private:123' && /control baseline/.test(list[0].reason));
    h.noteSessionGc('sess-fail-1', 'private:123', 'invalid session/control baseline');
    list = h.readSessionGc();
    check('同一条不重复，tries 累加到 2', list.length === 1 && Number(list[0].tries) === 2, JSON.stringify(list));
  }

  console.log('\n[2] 重试成功 → 停掉并清出清单');
  {
    const before = cancelled().length;
    const cleared = await h.sweepSessionGc('test');
    check('清掉 1 个', cleared === 1, `cleared=${cleared}`);
    check('真的调了 stopSessionWork', cancelled().length - before === 1 && cancelled().includes('sess-fail-1'), JSON.stringify(cancelled().slice(-3)));
    check('清单空了', h.readSessionGc().length === 0, JSON.stringify(h.readSessionGc()));
  }

  console.log('\n[3] 试太多次的条目不重试（但保留记录，别死循环烧 DSH）');
  {
    reset();
    h.noteSessionGc('sess-old', 'private:123', 'x');
    const list = h.readSessionGc();
    list[0].tries = 9;
    fs.writeFileSync(h.SESSION_GC_FILE, JSON.stringify(list), 'utf8');
    const before = cancelled().length;
    const cleared = await h.sweepSessionGc('test');
    check('不重试 → 一个都没清', cleared === 0, `cleared=${cleared}`);
    check('也没真去调 stopSessionWork', cancelled().length === before, `多了 ${cancelled().length - before} 次`);
    check('记录还在（留着人看）', h.readSessionGc().some((x) => x.sessionId === 'sess-old'));
  }

  console.log('\n[4] 清单有上限（滚动淘汰，不能无限长）');
  {
    reset();
    for (let i = 0; i < 60; i += 1) h.noteSessionGc(`sess-${i}`, 'private:123', 'x');
    check('最多留 50 条', h.readSessionGc().length === 50, `实际 ${h.readSessionGc().length}`);
  }

  console.log('\n[5] 源码级：四处"停旧会话失败"都必须接上回收，且看门狗里要重试');
  {
    const src = fs.readFileSync('src/bridge.js', 'utf8');
    const calls = (src.match(/noteSessionGc\((?!sessionId, key, reason)/g) ?? []).length;
    check('四处 catch 都接上了 noteSessionGc', calls === 4, `找到 ${calls} 处调用`);
    // ⚠️ 必须匹配**代码**而不是注释：说明性注释里还留着"请在 DSH 检查旧任务"这句话
    //    （第一版断言就被自己的注释骗红了，技能里专门记过这个坑）
    check('不再只是"请在 DSH 检查旧任务"（那是要人肉兜底）',
      !/log\(`⚠️ 停止旧会话失败 [^`]*请在 DSH 检查旧任务/.test(src));
    check('看门狗里会重试（sweepSessionGc 有调度）', /sweepSessionGc\('watchdog'\)/.test(src) && /sweepSessionGc\('startup'\)/.test(src));
    check('清理失败也不许影响主流程（有 try 包住）', /function noteSessionGc[\s\S]{0,900}?catch \{/.test(src));
  }
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
