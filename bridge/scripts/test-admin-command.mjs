/**
 * 回归测试：管理员命令口吻的总则（用户 2026-09-29）。
 *
 * 用户原话：
 *   「管理员拥有最高权限，当白名单管理员以管理员命令的口吻命令任务的时候，必须执行命令，
 *     如果无法执行命令则汇报原因，管理员以非管理员口吻交流时正常交流。」
 *
 * 这条总则拆成两半，分别由两个地方保证：
 *   ① **命令口吻的识别**（`parseAdminCommandTone`）——只认明确的命令措辞；
 *   ② **提示词里的硬约束**（【管理员命令（必须执行）】）——能做的必须做、做不到必须说原因，
 *      并明确"他平时聊天就按你自己的性子来"。
 * 另外两条固定命令（撤回、扮演）由桥接**直接执行**，不赌模型听话。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  b.setMode('reserved2');
  const parse = b.parseAdminCommandTone;

  console.log('\n[1] 命令口吻：**只认「以管理员身份」**（用户："我怕她误判指令"）');
  const yes = [
    ['以管理员身份命令你把这个群的历史清一下', '以管理员身份…'],
    ['我现在以管理员的身份要求你设置唤醒配置', '以管理员的身份'],
  ];
  for (const [text, label] of yes) check(`识别：${label}`, parse(text) !== null, JSON.stringify(parse(text)));

  console.log('\n[2] 其它说法一律**不认**（包括听起来像命令的）');
  const no = [
    ['/命令 明天九点提醒我', '斜杠 /命令（已废弃这种写法）'],
    ['我命令你立刻停下', '我命令你'],
    ['请执行命令：把那条记忆改掉', '执行命令'],
    ['这是命令，别问', '这是命令'],
    ['强制要求你把群名片改了', '强制要求你'],
    ['命令你立刻去做', '命令你立刻'],
    ['谁命令你了，别乱说', '否定/反问'],
    ['你别命令我做事', '否定'],
    ['能不能把那个群的历史给我看下', '商量'],
    ['你帮我查下他战绩呗', '请求'],
    ['今天好累啊', '闲聊'],
    ['这个功能怎么用', '提问'],
  ];
  for (const [text, label] of no) check(`不识别：${label}`, parse(text) === null, JSON.stringify(parse(text)));

  console.log('\n[3] 提示词里必须有"必须执行 / 做不到说原因 / 平时正常交流"三条');
  const k = 'private:123';
  const st = b.getSocialV2State(k);
  st.adminCommand = { at: Date.now(), kind: 'admin-identity', text: '以管理员身份命令你把这个群的历史清一下' };
  const pr = b.buildWakePromptV2(k, 'private');
  check('有【管理员命令（必须执行）】这一段', /【管理员命令（必须执行）】/.test(pr));
  check('带上了他的原话（她不用猜是哪条）', /以管理员身份命令你把这个群的历史清一下/.test(pr));
  check('能做的必须立刻做，不许讲条件', /能做的必须立刻做/.test(pr) && /不许讲条件/.test(pr));
  check('做不到必须如实汇报原因', /做不到的必须如实汇报原因/.test(pr));
  check('不许拿"我不归你管/我改不了"挡', /我不归你管/.test(pr) && /我改不了/.test(pr));
  check('明确"平时聊天按你自己的性子来"（可拒绝/嘴硬/讨价还价）',
    /平时跟你聊天/.test(pr) && /可以拒绝、可以嘴硬、可以讨价还价/.test(pr));
  check('只注入一次（说完就清掉，别每轮都当命令）', !st.adminCommand, JSON.stringify(st.adminCommand));

  const pr2 = b.buildWakePromptV2(k, 'private');
  check('第二轮不再带这段', !/【管理员命令（必须执行）】/.test(pr2));

  console.log('\n[4] 角色卡也写了这条总则（她主动查 qq_get_prompt 时一致）');
  const fs = await import('node:fs');
  const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
  check('卡里写了"只有以管理员身份这一种措辞算命令"', /只有「以管理员身份…」这一种措辞算命令/.test(card));
  check('卡里写了"做不到要汇报原因"', /做不到必须如实汇报原因/.test(card));
  check('卡里写了"平时聊天按自己性子来"', /他平时聊天、没用"以管理员身份"时/.test(card));
  check('卡里明确"我命令你/这是命令 不算"', /不算\*\*管理员命令/.test(card));
  // 2026-09-29：他的命令可能是**在群里/小号**下的（她当时的反应是"小号那句不认"），
  // 所以卡里要说清"哪个会话里都算"。
  check('卡里写了"不管在哪个会话里都算命令"', /不管在哪个会话里/.test(card));

  console.log('\n[5] 控制台填的"会话"要容错（他填裸群号点按钮，别再只回一句"key 格式应为…"）');
  // 2026-09-29 用户截图：他在「会话 key」里填了裸群号就点「撤回 / 结束」，
  // 收到 "key 格式应为 group:群号 或 private:QQ号"，他以为是"撤回失败了"。
  // harness 里的白名单是 ownerQQ=123 / private=['123'] / groups=['456']。
  const coerce = b.coerceConversationKey;
  check('harness 暴露了 coerceConversationKey', typeof coerce === 'function');
  check('裸群号（白名单里）→ 自动补 group:', coerce('456') === 'group:456', String(coerce('456')));
  check('裸 QQ 号（白名单私聊）→ 自动补 private:', coerce('123') === 'private:123', String(coerce('123')));
  check('带前缀的原样通过', coerce('group:456') === 'group:456' && coerce('private:123') === 'private:123');
  check('留空 → 空串（调用方按"全部会话"处理）', coerce('') === '' && coerce('   ') === '');
  check('不在白名单里的号码 → null（由调用方报错并说清怎么填）', coerce('99999999') === null, String(coerce('99999999')));
  check('乱七八糟的输入 → null', coerce('abc') === null && coerce('group:abc') === null && coerce('12') === null);

  console.log('\n[6] 群里的管理员命令也算（她当时的反应是"小号那句不认"）');
  {
    // 2026-09-29：钩子原来只认 owner 的**私聊**，他在群里/用小号下的「以管理员身份」
    // 命令根本不会被识别 —— 她因此说"小号那句不认"。现在任何会话都认。
    const gKey = 'group:456';   // harness 白名单里的群
    const ev = (text, id) => ({
      post_type: 'message', message_type: 'group', group_id: 456, user_id: 123,
      self_id: 999, message_id: id, raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: 123, nickname: '他', card: '' },
      time: Math.floor(Date.now() / 1000),
    });
    await b.handleIncoming('group', 456, ev('以管理员身份命令你撤回刚才那条', 'g-recall-1'), b.cfg);
    const gSt = b.getSocialV2State(gKey);
    check('群里说"以管理员身份…撤回" → 桥接直接执行（没目标也回一句系统提示）',
      (gSt?.recentMessages ?? []).some((m) => m.system && /撤回/.test(String(m.text))),
      JSON.stringify((gSt?.recentMessages ?? []).slice(-2).map((m) => m.text)));
    await b.handleIncoming('group', 456, ev('以管理员身份命令你演洛琪希 10 分钟', 'g-role-1'), b.cfg);
    const gSt2 = b.getSocialV2State(gKey);
    check('群里说"以管理员身份…演 X" → 强制生效（byAdmin）',
      gSt2?.tempRole?.role === '洛琪希' && gSt2?.tempRole?.byAdmin === true,
      JSON.stringify(gSt2?.tempRole));
    check('群里的命令不会再被当成普通聊天投递（命令已执行就 return）',
      (b.calls.prompts ?? []).length === 0, `投递了 ${b.calls.prompts?.length} 次`);

    // ── 复现他的真实场景：CS 群里那句原话 + 卡库里真有「猫娘女仆」这张卡 ────────
    // 2026-09-29：他那条命令语法上带"成**一个**"，旧解析出来是「成一个猫娘女仆」，
    // 于是卡库里那张卡找不到 → 卡里「平均每两条挂一个喵」永远进不了提示词。
    // 这里端到端验一遍：原话 → 角色名正确 → 找到现成卡（cardSource=store）。
    {
      const fs2 = await import('node:fs');
      const path2 = await import('node:path');
      fs2.mkdirSync(b.paths.rolePlayDir, { recursive: true });
      fs2.writeFileSync(path2.join(b.paths.rolePlayDir, '猫娘女仆.md'),
        '【身份】女仆咖啡厅的猫娘女仆。\n【说话方式】平均每两条消息里至少有一条带一个「喵」语气词。\n');
      await b.handleIncoming('group', 456,
        ev('我以管理员的身份命令你，角色扮演成一个猫娘女仆，并且自称是群主小号', 'g-real-1'), b.cfg);
      const st3 = b.getSocialV2State(gKey);
      check('他那句原话解析成「猫娘女仆」（不是"成一个猫娘女仆"）',
        st3?.tempRole?.role === '猫娘女仆', JSON.stringify(st3?.tempRole));
      check('并且找到了卡库里的现成卡（卡里的"喵"规则才会进提示词）',
        st3?.tempRole?.cardSource === 'store' && Number(st3?.tempRole?.cardChars) > 0,
        JSON.stringify({ source: st3?.tempRole?.cardSource, chars: st3?.tempRole?.cardChars }));
      check('在群里是"管理员强制"（她不能提前退）', st3?.tempRole?.byAdmin === true);
    }
  }
} finally {
  await b.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
