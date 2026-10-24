/**
 * 回归测试：群语料库 + 群风格卡 + 例句（管理员 2026-09-29「这些数据可以拿来给 onebot 学习吗」）。
 *
 * 锁死四件事：
 *   ① 语料库只收**群聊里别人**说的话（她自己的话/私聊不进），能落盘、能读回；
 *   ② 风格卡是**统计**出来的（不含任何人的原话），样本不够就不生成；
 *   ③ 只有**群聊**会注入风格卡，私聊一个字都不加（他要的是"私聊正常聊"）；
 *   ④ 例句来自 state/style-examples.json，条数受 config 限制，且注入时带字数上限。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const b = await bridgeHarness({ config: { socialV2: { enabled: true, groupStyle: { minSamples: 5, exampleCount: 3 } } } });
try {
  b.setMode('reserved2');

  console.log('\n[1] 语料库：只收"别人"说的话（群聊必收，私聊默认也收）');
  const before = b.readGroupCorpus().length;
  b.feedGroupCorpus('group:456', '群友A', '这波不亏');
  b.feedGroupCorpus('group:456', '群友B', '你懂我意思吧');
  b.feedGroupCorpus('private:123', '管理员', '私聊的话也进语料（通用层要覆盖私聊）');
  b.feedGroupCorpus('group:456', '今晚吃兔兔', '她自己说的话不该进语料');
  b.feedGroupCorpus('group:456', '群友A', '   ');
  const rows = b.readGroupCorpus();
  check('群聊消息写进去了', rows.length === before + 3, JSON.stringify(rows.slice(-3)));
  check('私聊默认也收（通用底层模版要覆盖私聊）',
    rows.some((r) => String(r.g).startsWith('private:')), JSON.stringify(rows.map((r) => r.g)));
  check('她自己的话不写（学成自恋就废了）', !rows.some((r) => r.s === '今晚吃兔兔'));
  check('空消息不写', !rows.some((r) => !String(r.x ?? '').trim()));
  check('行结构是 {t,g,s,x}', rows.every((r) => Number(r.t) > 0 && r.g && r.s && r.x));
  const onDisk = fs.readFileSync(path.join(b.paths.stateDir, 'group-corpus.jsonl'), 'utf8').trim().split('\n');
  check('真的落盘了（JSONL，一行一条）', onDisk.length === rows.length, `文件 ${onDisk.length} 行 / 内存 ${rows.length} 条`);

  console.log('\n[1b] 语料去重：跨分钟的复读要留着，同来源重复才去掉');
  {
    const f = path.join(b.paths.stateDir, 'group-corpus.jsonl');
    const now = Date.now();
    const lines = [];
    // 同一个人同一句话、跨 10 分钟各 3 次 → 真·复读，应全部保留
    for (let i = 0; i < 10; i++) for (let k = 0; k < 3; k++) lines.push(JSON.stringify({ t: now - i * 600000 + k * 1000, g: 'group:456', s: '群友A', x: '这波不亏' }));
    // 同一分钟内三个来源各来一遍 → 只留 1 条
    for (let k = 0; k < 3; k++) lines.push(JSON.stringify({ t: now - 3600000 + k * 500, g: 'group:456', s: '群友B', x: '你懂我意思吧' }));
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const g456 = b.collectGroupCorpusRows().filter((r) => r.group === 'group:456');
    check('跨分钟的复读保留（复读本身是风格特征），同分钟去重', g456.length === 11, `去重后 ${g456.length} 条（期望 11）`);
  }

  console.log('\n[2] 风格卡：统计出来的，不含原话');
  // 造一批"群里那样说话"的消息：短、没标点、疑问用语气词
  const seed = [
    ['群友A', '这波不亏'], ['群友B', '你懂我意思吧'], ['群友A', '真的假的'],
    ['群友C', '有点东西啊'], ['群友B', '笑死 这也行'], ['群友A', '不是 你听我说'],
    ['群友C', '行吧 那就这样'], ['群友B', '我都懒得说'], ['群友C', '谁在打排位'],
    ['群友A', '[表情包]'], ['群友B', '[图片]'], ['群友C', '明天再说吧'],
    ['群友A', '先撤了'], ['群友B', '你那把怎么打的'], ['群友C', '我没看懂'],
    ['群友A', '别催我'], ['群友B', '这也能输'], ['群友C', '先睡了'],
    ['群友A', '他说啥了'], ['群友B', '我上号了'], ['群友C', '等我五分钟'],
    ['群友A', '笑死'], ['群友B', '服了'], ['群友C', '这波有点东西'],
  ];
  for (const [s, t] of seed) b.feedGroupCorpus('group:456', s, t);
  const prof = b.describeGroupStyle(b.collectGroupCorpusRows(), 'group:456');
  check('生成了风格卡（样本够）', !!prof && prof.stats.n >= 20, JSON.stringify(prof?.stats));
  check('统计里有中位长度/零标点比例/表情包占比', prof?.stats && typeof prof.stats.med === 'number'
    && typeof prof.stats.noPunct === 'number' && typeof prof.stats.media === 'number', JSON.stringify(prof?.stats));
  check('文本里写了"短句"和"不打标点"', /短句/.test(prof?.text ?? '') && /不打标点/.test(prof?.text ?? ''));
  check('**不含任何群友的原话**（只讲特征）',
    !/这波不亏|你懂我意思吧|有点东西啊/.test(prof?.text ?? ''), (prof?.text ?? '').slice(0, 120));
  check('样本不够就不生成（避免拿三条消息瞎总结）',
    b.describeGroupStyle([{ sender: 'x', text: '喂', group: 'group:999', at: Date.now() }], 'group:999') === null
    || (b.describeGroupStyle([{ sender: 'x', text: '喂', group: 'group:999', at: Date.now() }], 'group:999')?.stats.n ?? 0) < 5);

  console.log('\n[3] 注入范围：通用层进所有会话，本群层只进群聊');
  {
    const exFile = path.join(b.paths.stateDir, 'style-examples.json');
    fs.writeFileSync(exFile, JSON.stringify({ examples: ['这波不亏', '你懂我意思吧', '明天再说吧'] }));
    // 私聊也要有语料，通用层才认得出"所有聊天"
    for (let i = 0; i < 30; i++) b.feedGroupCorpus('private:123', '管理员', i % 2 ? '你在干嘛' : '这个怎么弄');
    const groupLine = b.buildChatStyleLine('group:456');
    const privLine = b.buildChatStyleLine('private:123');
    check('群聊：通用层 + 本群层都在',
      /【打字习惯（通用底层/.test(groupLine) && /【本群说话的样子/.test(groupLine), groupLine.slice(0, 90));
    check('私聊：有通用层（"所有聊天都适用"）', /【打字习惯（通用底层，所有聊天都适用）】/.test(privLine), privLine.slice(0, 90));
    check('私聊：**没有**"本群说话的样子"（不串味）', !/【本群说话的样子/.test(privLine));
    check('例句带在通用层里，并说明"别照抄原话"', /别照抄原话/.test(privLine) && /这波不亏/.test(privLine));
    check('例句条数受 config 限制（exampleCount=3）',
      ((privLine.split('别照抄原话')[1] ?? '').match(/「/g) ?? []).length === 3,
      (privLine.split('别照抄原话')[1] ?? '').slice(0, 80));
    const gPrompt = b.buildWakePromptV2('group:456', 'atMention');
    const pPrompt = b.buildWakePromptV2('private:123', 'atMention');
    check('群聊唤醒提示词里带通用层', /【打字习惯（通用底层/.test(gPrompt));
    check('私聊唤醒提示词里也带通用层（这是他要的"底层聊天逻辑"）', /【打字习惯（通用底层/.test(pPrompt));
    check('私聊唤醒提示词里没有本群层', !/【本群说话的样子/.test(pPrompt));
  }

  console.log('\n[3b] "不断更新"：语料涨到阈值就自动重建（不用等 24h TTL）');
  {
    const before = b.generalStyleProfile(true);
    const corpusFile = path.join(b.paths.stateDir, 'group-corpus.jsonl');
    const size0 = fs.statSync(corpusFile).size;
    // 灌到超过阈值（growthBytes = max(4096, refreshAfterNewMessages × 90)，所以至少得涨 4KB）
    b.feedGroupCorpus('group:456', '群友A', 'x'.repeat(200));
    for (let i = 0; i < 80; i++) b.feedGroupCorpus('group:456', '群友B', `新消息${i}`.padEnd(90, '啊'));
    const grew = fs.statSync(corpusFile).size - size0;
    // ⚠️ 这里必须断言"真的重建了"（样本数严格变大），
    //    只断言 after >= before 的话，**拿到旧缓存也会过**（第一次写这个测试就踩了，
    //    结果掩盖了"私聊路径永远不刷新"的 bug）。
    const after = b.generalStyleProfile();     // 不 force：应该因为"涨了"而重建
    check('语料增长触发自动重建（不需要手动点）',
      !!before && !!after && Number(after.stats.n) > Number(before.stats.n) && grew > 4096,
      `增长 ${grew} 字节；样本 ${before?.stats.n} → ${after?.stats.n}`);
    check('私聊路径也会刷新（不能只有群聊调那个带增长检查的函数）',
      Number(after?.stats.n) > Number(before?.stats.n),
      `after=${after?.stats.n} before=${before?.stats.n}`);
  }

  console.log('\n[5] 长消息不能被截成"头 200 + 尾 200"（2026-09-29 用户实测："你这条中间断了一截"）');
  {
    const long = `开头${'中'.repeat(700)}结尾`;   // 706 字
    await b.handleIncoming('private', 123, {
      post_type: 'message', message_type: 'private', user_id: 123, self_id: 999,
      message_id: 'long-1', raw_message: long,
      message: [{ type: 'text', data: { text: long } }],
      sender: { user_id: 123, nickname: '管理员', card: '' },
      time: Math.floor(Date.now() / 1000),
    }, b.cfg);
    const st = b.getSocialV2State('private:123');
    const msg = (st?.recentMessages ?? []).filter((m) => !m.isSelf).slice(-1)[0];
    check('长消息完整保留（不再丢中间）', [...String(msg?.text ?? '')].length >= 700,
      `存了 ${[...String(msg?.text ?? '')].length} 字`);
    check('头尾都在（中间不是空的）', /^开头/.test(String(msg?.text)) && /结尾$/.test(String(msg?.text)),
      `${String(msg?.text).slice(0, 6)} … ${String(msg?.text).slice(-6)}`);
    check('tail 仍留 200 字（"没说完"判断要用）', String(msg?.tail ?? '').length <= 200 && String(msg?.tail ?? '').endsWith('结尾'));
  }

  console.log('\n[6] 通用层/本群层不许说两遍（2026-10-01：语料 74% 来自一个群，两块逐行一样）');
  {
    const now = Date.now();
    const corpusFile = path.join(b.paths.stateDir, 'group-corpus.jsonl');
    const body = (i) => (i % 3 ? '这波不亏' : '你懂我意思吧');
    // ── 第一轮：三个会话同一个风格 → 本群层应该只说一句"基本一样"
    //    缩写：nbu 只在 group:A（单群专属，通用层不该收、A 的卡里该留着）
    //          cs 两个群都在用（才算通用）
    const lines = [];
    const push = (g, s, x, i) => lines.push(JSON.stringify({ t: now - i * 60000, g, s, x }));
    for (let i = 0; i < 80; i++) {
      push('group:A', '群友A', body(i), i);
      push('private:123', '管理员', body(i), i);
      push('group:B', '群友B', body(i), i);
    }
    for (let i = 0; i < 6; i++) push('group:A', '群友A', 'nbu 上号吧', 100 + i);
    for (let i = 0; i < 6; i++) { push('group:A', '群友A', 'cs 打不打吧', 200 + i); push('group:B', '群友B', 'cs 打不打吧', 200 + i); }
    fs.writeFileSync(corpusFile, lines.join('\n') + '\n');
    b.groupStyleProfiles(true);   // 强制重建（读上面这份语料）

    const generalLine = b.buildChatStyleLine('private:123');
    check('通用层不含"只在一个群出现"的缩写（nbu）', !/nbu/.test(generalLine), generalLine.slice(-90));
    check('通用层保留"两个群都在用"的缩写（cs）', /\bcs\b/.test(generalLine), generalLine.slice(-90));

    const aLine = b.buildChatStyleLine('group:A');
    const aPart = aLine.split('【本群说话的样子')[1] ?? '';
    check('单群专属缩写仍然留在那个群的卡里（nbu）', /nbu/.test(aLine), aPart.slice(0, 140));
    check('同风格群不再复述那 6 行，本群层只剩真正的差别（就 1 行）',
      (aPart.match(/\n- /g) ?? []).length === 1, `本群层 ${(aPart.match(/\n- /g) ?? []).length} 行`);

    const bLine = b.buildChatStyleLine('group:B');
    check('完全同风格 → 本群层只说一句"基本一样"（不再复述）',
      /【本群说话的样子】这个群和上面的通用习惯\*\*基本一样\*\*/.test(bLine), bLine.slice(-140));
    const allRows = b.collectGroupCorpusRows();
    const bare = b.describeGroupStyle(allRows, 'group:B', { reference: b.describeGroupStyle(allRows, '__all__').stats });
    check('describeGroupStyle 参照通用层后能报"全一致"', bare?.sameAsGeneral === true && bare.text === '', JSON.stringify(bare));

    // ── 第二轮：把 group:B 改成明显另一种风格 → 它必须正常列差别（而且只列不一样的）
    const lines2 = [...lines];
    for (let i = 0; i < 80; i++) {
      lines2.push(JSON.stringify({ t: now - i * 60000, g: 'group:B', s: '群友B', x: `我觉得这个事情吧，还是应该认真考虑一下的，毕竟${i}号了。哈哈！真的吗？` }));
    }
    fs.writeFileSync(corpusFile, lines2.join('\n') + '\n');
    b.groupStyleProfiles(true);
    const bLine2 = b.buildChatStyleLine('group:B');
    const bPart2 = bLine2.split('【本群说话的样子')[1] ?? '';
    check('风格明显不同 → 正常列差别，不再说"基本一样"',
      /【本群说话的样子/.test(bLine2) && !/基本一样/.test(bLine2), bPart2.slice(0, 120));
    check('打了"只列和上面不一样的地方"的标记，且行数少于通用层',
      /只列和上面不一样的地方/.test(bPart2)
      && (bPart2.match(/\n- /g) ?? []).length < (b.buildChatStyleLine('private:123').match(/\n- /g) ?? []).length,
      `本群 ${(bPart2.match(/\n- /g) ?? []).length} 行 / 通用 ${(b.buildChatStyleLine('private:123').match(/\n- /g) ?? []).length} 行`);
  }

  console.log('\n[7] 语气浓度：撤掉了（前提不成立）');
  {
    // 2026-10-02：本来想教她"这个群多冲"，量了真实语料发现两个群只有 1.6~1.8% 带脏字/骂人，
    //   根本不冲（"一堆人嫌他恶心"来自 476145502 那个群，而她不在那）。所以不留这个永远不触发的死代码，
    //   只守一条：**别又好心地加回来**（除非真的进了吵闹的群）。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    check('没有"语气浓度/很冲"这段死代码', !/这个群说话\*\*很冲\*\*/.test(src));
  }

  console.log('\n[4] 开关与上限');
  {
    const c = JSON.parse(fs.readFileSync(path.join(b.paths.root, 'config.json'), 'utf8'));
    c.socialV2.groupStyle.enabled = false;
    fs.writeFileSync(path.join(b.paths.root, 'config.json'), JSON.stringify(c));
  }
  check('（源码级）风格卡可关闭：enabled=false 时 groupStyleConfig 会返回 enabled:false',
    /enabled: c\.enabled !== false/.test(fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('两层各有字数上限（通用层 generalMaxChars + 本群层 maxChars，不会撑爆提示词）',
    /clip\(out, c\.generalMaxChars\)/.test(src) && /clip\(out, c\.generalMaxChars \+ c\.maxChars\)/.test(src));
  check('风格卡有 TTL（默认 24h，不用每轮重算）', /ttlHours/.test(src) && /groupStyleCache/.test(src));
  check('语料库有双上限（条数 + 字节）且超了留最近一半',
    /maxLines/.test(src) && /maxBytes/.test(src) && /trimGroupCorpus/.test(src));
} finally {
  await b.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
