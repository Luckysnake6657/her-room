/**
 * 回归测试：说话分寸 + 气泡排版。
 *
 * 用户（管理员）看过她一条实际发言后提的两点：
 *   「对了，提示词能不能改一下，说话这么毒舌可不好，
 *     而且她发言怎么喜欢在气泡前面先加个问号，正常也是先发问号再发下一句」
 * 那条发言是：`？ 体检还插队，是赶着去证明自己身体好吗`
 *   • 毒舌到拿别人的**身体**做人身攻击；
 *   • 「？」粘在句首，而不是像真人那样**单独发一条**再发下一句。
 *
 * 这条锁死：每轮真正投递的唤醒提示词里必须有【说话分寸】，
 * 而且包含"不拿身体/家人开涮"和"「？」单独发一条"这两条具体要求。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const bridge = await bridgeHarness({ config: { socialV2: { enabled: true } } });

try {
  bridge.setMode('reserved2');
  const { buildWakePromptV2 } = bridge;
  const prompt = buildWakePromptV2('private:123', 'private');

  console.log('\n[1] 分寸行必须每轮都在（角色卡只有她主动查时才看到，不够）');
  check('提示词里有【说话分寸】', prompt.includes('【说话分寸】'));
  check('明确禁止人身攻击', /人身攻击/.test(prompt));
  check('点名不许拿"身体/健康"开涮', /身体/.test(prompt) && /健康/.test(prompt));
  check('点名不许拿"家人/外貌"开涮', /家人/.test(prompt) && /外貌/.test(prompt));
  check('举例了那句扎人的反问（便于她对照）', /是赶着去证明/.test(prompt), prompt.slice(0, 200));
  check('被骂时：不甩脏字、不升级、不追着打',
    /不甩脏字/.test(prompt) && /不升级/.test(prompt) && /不追着打/.test(prompt));
  check('仍然允许嘴硬/损（不能把性格改没了）', /可以嘴硬/.test(prompt) && /可以损/.test(prompt));

  console.log('\n[1b] "别粘成一整句 + 别过度玩梗"（2026-09-29 他连续两次指出）');
  // 第一次截图她说「语气不对吧」；我误以为要"先接梗"，他纠正：
  //   「也不是接梗，就是说话语气变成一整句了，过度玩梗会令人厌烦的」
  // 实测基线：她 45.6% 的自发言是"汉字，汉字"（逗号把两件事粘一句）。
  // ⚠️ 2026-10-17 压提示词：那个小节标题删了（和【说话的样子】重复），规则实质还在。
check('有"逗号能不用就不用"这条（原来那一节的实质）', /逗号能不用就不用/.test(prompt));
  check('点了他第二次的原话，便于她对照', /说话语气变成一整句了/.test(prompt));
  check('给了她自己的真实反例（班次+吐槽粘一句）', /10月1号早上6点51那班/.test(prompt));
  check('要求两件事分两条发（不再用逗号粘成一句）', /有两件事就分两条发/.test(prompt));
  check('信息类例外还在（讲清一件事/查战绩这类可以合成一段）', /例外·信息类/.test(prompt));
  check('**别过度玩梗**（这是他的第二句抱怨）', /别过度玩梗/.test(prompt) && /佐料不是主食/.test(prompt));
  check('关心别变成嘱咐+核对', /嘱咐 \+ 核对|嘱咐\+核对|嘱咐/.test(prompt));

  console.log('\n[1c] 别当解说员 / 看图别编剧情（2026-09-30 用户："上下文理解能力还是有问题"）');
  // 现场：群里聊"黑色大象大战白色老虎"，她连发「这话题是一路往动物世界升级」「群里快成纪录片现场了」；
  // 紧接着一张婚礼合影，她说「这位军官在路口站了一整晚」——那句是她自己编的场面。
  check('有"别当解说员"这条', /别当解说员/.test(prompt));
  check('点明"同一件事最多评论一次"', /同一件事最多评论一次/.test(prompt));
  check('举了她自己的真实反例（弹幕式连发）',
    /这话题是一路往动物世界升级/.test(prompt) && /快成纪录片现场/.test(prompt));
  check('要求看图只说图里确实有的', /看图\/表情包只说图里确实有的|只说图里确实有的/.test(prompt));
  check('举了"军官在路口站了一整晚"这个编造反例', /军官在路口站了一整晚/.test(prompt));
  check('看不清就直说，别硬猜', /没看到内容|没刷出来/.test(prompt));
  check('没有把"先接梗"写成规则（那是被否掉的方向）',
    !/先接梗/.test(prompt) && !/第一句先接梗/.test(prompt), '提示词里不该再出现"先接梗"');

  console.log('\n[2] 气泡排版：反应词单独发');
  check('提示词里写了「？」要单独发一条', /单独发一条/.test(prompt));
  check('明确禁止拼在句子前面', /不要拼在句子前面|不要发/.test(prompt));
  check('举了反例（不让它再粘）', /体检还插队/.test(prompt));
  check('一条消息只说一件事', /一条消息就说完一件事|只说一件事/.test(prompt));

  console.log('\n[3] 不能矫枉过正');
  check('没让她变客服腔（不含"抱歉/理解您的感受"这类）',
    !/理解您的感受|很抱歉给您/.test(prompt));
  check('没禁止她怼回去（只是要求别过火）',
    /冷淡怼一句|可以怼/.test(prompt), prompt.match(/.{0,20}怼.{0,20}/)?.[0]);

  console.log('\n[4] 那条旧规矩不该再出现在记忆里（会被每轮注入，跟新要求打架）');
  const st = bridge.getSocialV2State('private:984776985');
  const all = [
    ...(st.activeTopics ?? []).map((t) => t?.text ?? ''),
    ...((bridge.socialV2?.coreMemory?.activeTopics) ?? []).map((t) => t?.text ?? ''),
  ].join('\n');
  check('没有"一个「？」接一句傻逼"这种旧规矩', !/接一句傻逼/.test(all), all.slice(0, 120));

  // ── 2026-09-28 第二轮反馈 ────────────────────────────────────────────────
  // 用户原话：「在聊正事的时候突然插一句，而且现在聊天老是前言不搭后语，逻辑性太差，
  //   还有说话语气太怪了，正常聊天喜欢发一整句，而不是像其他人一样不怎么加逗号」
  console.log('\n[5] 说话的样子：一条一个短句、逗号能不用就不用（管理员 2026-09-29 选的 A 档）');
  check('要求"一条消息 = 一个短句"', /一条消息 = 一个短句/.test(prompt));
  check('要求"逗号能不用就不用"', /逗号能不用就不用/.test(prompt));
  check('禁止用逗号把两个分句粘成一条长句', /别用逗号把两个分句粘成一条长句/.test(prompt));
  check('禁止把一句话拆成一串碎片', /拆成一串碎片/.test(prompt));
  check('两件事分两条、最多三条', /分两条发（最多三条）/.test(prompt));
  check('信息类仍是"一整段、用逗号连接"', /例外·信息类/.test(prompt) && /合成一整段、用逗号连接/.test(prompt));
  check('禁止夹日文假名/外文语气词', /日文假名/.test(prompt) && /の/.test(prompt));
  check('禁止用口癖/学猫叫代替回答', /代替回答/.test(prompt) && /猫叫/.test(prompt));
  check('配置里的发送提示也同步成 A 档',
    /一条消息 = 一个短句/.test(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'))
      && /逗号能不用就不用/.test(fs.readFileSync('D:/qq-bridge/config.json', 'utf8')));

  console.log('\n[6] 搭得上话（别在正事中间插一句、别前言不搭后语）');
  check('要求先看清最近几条', /先看清最近几条|谁在跟谁说话/.test(prompt));
  check('要求直接回答最后一条', /直接回答最后一条/.test(prompt));
  check('禁止答非所问', /答非所问/.test(prompt));
  check('禁止自己另开话题', /别自己开一个新话题|另开一个话题/.test(prompt));
  check('别人聊正事时：相关才接、否则别出声', /别人在聊正事/.test(prompt) && /不要突然插一句|就安静|就不出声/.test(prompt));
  check('拿不准就问，别硬接', /别硬接/.test(prompt));

  // ── 2026-09-29：上下文太复杂 / 被 @ 却看不懂时，允许她直接问 ──────────────
  console.log('\n[11] 看不懂就直接问（"上下文太复杂、at 她时理解不了的话题，让她可以直接问"）');
  check('有这条规则', /看不懂就直接问/.test(prompt));
  check('点名了"被 @ 却看不懂"这种情形', /@ 你/.test(prompt) && /看不懂他在问什么/.test(prompt));
  check('给了具体说法（你这条我没看懂/你们在说哪个/说清楚点）',
    /你这条我没看懂/.test(prompt) && /你们在说哪个/.test(prompt) && /说清楚点/.test(prompt));
  check('明确"问一句比硬猜强、也不丢人"', /问一句比硬猜强/.test(prompt) && /不丢人/.test(prompt));
  check('禁止装懂 / 禁止"这个我知道"糊过去', /别装作懂了/.test(prompt) && /这个我知道/.test(prompt));
  check('建议带线索，少让人解释', /是刚才那场比赛的事吗/.test(prompt));
  check('有上限：同一件事最多问一次（防拿"你没说清楚"当挡箭牌）', /同一件事最多问一次/.test(prompt));
  check('角色卡也同步了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /看不懂就直接问/.test(card) && /问一句比硬猜强/.test(card) && /同一件事最多问一次/.test(card);
  })());

  // ── 2026-09-28 第三轮：管理员挑的"活人感"要求（逐条筛过，见 QUICKSTART）────────
  console.log('\n[7] 活人感（口语化 / 不念稿 / 不 emoji / 少@ / 有主见）');
  check('要求口语化、可以改口', /口语化/.test(prompt) && /改口/.test(prompt));
  check('明确"别念稿"', /别写成念稿|不念稿/.test(prompt));
  check('不用 emoji / 颜文字', /不用 emoji/.test(prompt));
  check('不列点、不"首先/其次/总之"', /不列点/.test(prompt) && /首先\/其次\/总之/.test(prompt));
  check('不重复上一句说过的话', /不重复/.test(prompt) && /别再复述/.test(prompt));
  check('少 @ 别人', /少 @ 别人/.test(prompt));
  // 「轻松点、别端着」「有自己主见…不为讨好改口」这两条在 2026-09-29 被用户点名回退了
  // （他说"语气怪改错了"），所以这里改成**反向**断言：不许再自动加回来。
  check('没有"轻松点/别端着"这条语气指令', !/别端着/.test(prompt));
  check('没有"有主见/不为讨好改口"这类人格加戏', !/有自己主见/.test(prompt));
  // ⚠️ 反面：管理员给的原始清单里有一条"单次回复必须≤20字符"——那和"发一整句"直接冲突，**故意没收录**
  check('没有收录"≤20字符"这类碎片化上限', !/≤\s*20\s*字符|必须≤20/.test(prompt));
  // ⚠️ 反面：也不该出现"被识破就完蛋/绝不承认自己是AI"这类说法（与"别为了让角色成立去骗人"冲突）
  check('没有收录"被识破就完蛋/就地正法"式威胁措辞', !/就地正法|被识破/.test(prompt));
  check('角色卡里也同步了（她主动查 qq_get_prompt 时看到的一致）', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /一条消息 = 一个短句/.test(card) && /别人在聊正事/.test(card) && /回之前先看最近几条/.test(card)
      && /口语化、说人话/.test(card) && /少 @ 别人/.test(card);
  })());
  // ── 2026-09-29：把"语气"那一轮改错的部分回退掉 ────────────────────────────
  // 用户：「语气怪改错了，回退一下」——我那轮从别人清单里抄进来的
  // "允许词不达意/口是心非/开小差"+"可以有'那个''就是'这种口头语"+"轻松点别端着"
  // 会让她更啰嗦更没逻辑，正好和"前言不搭后语、逻辑性太差"打架，所以撤了。
  console.log('\n[8] 已回退：不准再许可"说不清楚"（那是把逻辑性往下拽）');
  check('没有"词不达意/口是心非/开小差都正常"这类许可', !/词不达意/.test(prompt) && !/口是心非/.test(prompt) && !/跑一下神|开小差/.test(prompt));
  check('没有给"那个/就是/你别说"这种填充口头语开绿灯', !/你别说/.test(prompt));
  check('没有"轻松点、别端着"这条（用户说语气改错了）', !/别端着/.test(prompt));
  check('保留：说人话/别念稿/可以说错就改口', /口语化/.test(prompt) && /别写成念稿/.test(prompt) && /改口/.test(prompt));
  check('保留：无 emoji/不列点/不重复/少@',
    /不用 emoji/.test(prompt) && /不列点/.test(prompt) && /不重复/.test(prompt) && /少 @ 别人/.test(prompt));
  check('角色卡也同步回退了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return !/词不达意/.test(card) && !/别端着/.test(card) && /一条消息 = 一个短句/.test(card);
  })());

  // ── 2026-09-29：私聊立的规矩怎么才能管到群聊（用户："她是不是没法把私聊要求应用到群聊"）──
  console.log('\n[9] 跨会话的规矩要记下来（只答应不记 = 换个会话就不知道）');
  check('提示词里要求她"当场记进记忆"', /跨会话的规矩要记下来/.test(prompt) && /qq_memory_append/.test(prompt));
  check('说清了原因：每个会话上下文独立', /各自独立的上下文/.test(prompt));
  check('举了真实翻车例子（私聊让语气好一点、群里照样冲）', /语气好一点/.test(prompt) && /照样冲/.test(prompt));
  check('角色卡也同步了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /有人跟你立规矩时要记下来/.test(card) && /importance="high"/.test(card);
  })());

  // ── 2026-09-29 第二轮：别太嘴硬、语气别太硬 ─────────────────────────────
  console.log('\n[10] 嘴硬只用在贫上（"也别太嘴硬，有些原则上的事情不能嘴硬啊，她说话语气太硬了"）');
  check('有独立的"嘴硬只用在贫上"规则', /【嘴硬只用在贫上/.test(prompt));
  check('正事/认真问/求助/事实原则时不嘴硬', /说正事、被认真问、对方在求助或讲自己的事、涉及事实和原则时，不嘴硬/.test(prompt));
  check('拒绝别人不许用冷句，并给了替代说法', /拒绝别人不许用冷句/.test(prompt) && /不是不帮你/.test(prompt));
  check('少用反问和怼人句式', /少用反问和怼人的句式/.test(prompt));
  check('把"嘴硬"定义清楚（不是说话像欠你钱）', /不是\*\*说话像欠你钱\*\*/.test(prompt));
  check('角色卡也同步了（嘴硬只用在贫上）', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /嘴硬只用在贫上/.test(card) && /不是说话像欠你钱/.test(card);
  })());

  // ── 2026-10-01：管理员「说话逻辑是不是还有问题……还有感觉她不会安慰别人」────────
  // 现场（私聊 10-01 17:10）：他说「嗓子好难受…」，她回「阿莫西林是抗生素，感冒这一挂基本是病毒，
  // 吃了白吃」——纯科普、零共情。翻日志确认：当时注入的记忆块里**确实有**
  // 「别动不动给人说教/上价值」那条（而且本来就是 high）——她还是犯，
  // 因为那是一条**没有触发条件的禁令**：她没把"回答药理问题"归类成"说教"。
  // 所以这条规则改成**场景化**的：别人说难受/疼/烦的时候怎么接。
  console.log('\n[12] 别人不好受时怎么接（他难受，她却上了一堂药理课）');
  check('有独立的「别人不好受时怎么接」规则', /【别人不好受时怎么接】/.test(prompt));
  check('第一句先接情绪、别急着解决问题', /先接住情绪，别急着解决问题/.test(prompt));
  check('禁止科普/给方案/讲道理（要建议等他开口）', /科普知识/.test(prompt) && /要建议等他开口要的时候再给/.test(prompt));
  check('举了她自己的真实反例（嗓子好难受 → 阿莫西林是抗生素）',
    /嗓子好难受/.test(prompt) && /阿莫西林是抗生素/.test(prompt));
  check('禁止套话 + 禁止把话头转到自己身上', /多喝热水/.test(prompt) && /别把话头转到自己身上/.test(prompt));
  check('他难受时不损、不嘴硬、不开玩笑', /不损、不嘴硬、不开玩笑/.test(prompt));
  check('角色卡也同步了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /别人不好受时怎么接/.test(card) && /阿莫西林是抗生素/.test(card) && /先接住情绪/.test(card);
  })());

  console.log('\n[13] 别只说结论（"说话逻辑是不是还有问题"）');
  // 实测形态：她的回复依赖自己脑子里那一步，说出口只剩结论 ——
  // 他："木头脑袋…" → 她："行行，那水也不提了"（凭什么不提了？）→ 他只能回"啥意思"。
  check('有「别只说结论」这条', /别只说结论/.test(prompt));
  check('点明"那/所以/反正/行行"开头必须带依据', /"那\/所以\/反正\/行行"开头的话/.test(prompt));
  check('给了真实反例（问吃药没 → 那医院先不用跑）', /那医院先不用跑/.test(prompt));
  check('对方回"啥意思"＝要换一整句说全，不是更短的句子',
    /你上一句没交代清楚/.test(prompt) && /别用更短的句子解释/.test(prompt));
  check('禁止把闲聊答成科普/上价值', /别把闲聊答成科普/.test(prompt) && /别上价值/.test(prompt));
  check('角色卡也同步了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /别只说结论/.test(card) && /别把闲聊答成科普/.test(card);
  })());

  // ── 2026-10-01：把"刚发生的那几条"摆到眼前 ────────────────────────────────
  // 原来她眼前只有 `【此刻状态】……最近一条来自 X：前 30 字`（而且这人可能是别人），
  // 要接话得**先调工具读消息**；一快起来就凭半句猜 → 答非所问。
  console.log('\n[14] 【刚发生的几条】直接摆在眼前（听不懂的结构性修复）');
  const st14 = bridge.getSocialV2State('private:123');
  const now14 = Date.now();
  st14.recentMessages = [
    { sender: '他', text: '发烧不至于', time: now14 - 4 * 60000, seq: 811 },
    { sender: '他', text: '嗓子好难受…', time: now14 - 2 * 60000, seq: 812 },
    { sender: '', text: '没烧就好办', time: now14 - 60000, isSelf: true },
  ];
  const p14 = bridge.buildWakePromptV2('private:123', 'private');
  check('列出了最近几条（谁 + 第几条 + 说了什么）',
    /【刚发生的几条】/.test(p14) && /他（第 812 条）：嗓子好难受/.test(p14));
  check('她自己的发言标成"你"（看得出谁在跟谁说话）', /你：没烧就好办/.test(p14));
  check('要求先看这几条、直接回最下面那条', /回之前先看这几条/.test(p14) && /直接回最下面那条/.test(p14));
  check('只有一个人在说时不啰嗦引用', /回最下面那条就行，不用引用/.test(p14));

  st14.recentMessages = [
    { sender: '他', text: '这局谁赢了', time: now14 - 4 * 60000, seq: 813 },
    { sender: '阿远', text: '别问我', time: now14 - 2 * 60000, seq: 814 },
    { sender: '', text: '你们俩先吵完', time: now14 - 60000, isSelf: true },
  ];
  const p15 = bridge.buildWakePromptV2('private:123', 'private');
  check('多个人在说时才给引用 id 的用法（省 token）', /replyToMessageId=<那个第几条>/.test(p15));

  st14.recentMessages = [{ sender: '他', text: '睡了没', time: now14 - 3 * 3600000, seq: 815 }];
  st14.unread = [];
  const p16 = bridge.buildWakePromptV2('private:123', 'private');
  check('安静时（只有一条三小时前的消息）不列这几条，省 token', !/【刚发生的几条】/.test(p16));

  // ── 2026-10-01：写入侧兜底 —— 说话方式的纠正不许按普通话题衰退 ──────────────
  // ⚠️ 判据必须只认明确的祈使句：放宽到"说话/语气/风格"会误伤她自己记的事实类条目
  // （角色卡、情感模块实验……实测 50 条里误命中 13 条），把它们升成 high 会挤爆注入预算。
  console.log('\n[15] 写入侧兜底：说话方式的纠正不许悄悄过期');
  const isRule = bridge.looksLikeBehaviorRule;
  check('识别真实的纠正（别太凶／说话委婉一点／别动不动说教）',
    isRule('他说我说话别太凶，语气放软，以后对群友的玩闹别用冷句')
    && isRule('★规矩：「说话委婉一点」——别太呛太毒')
    && isRule('他还说「现在的人最烦的就是讲大道理了」——别动不动给人说教/上价值，别端着当老师'),
    '这三条都是真实发生过的纠正');
  check('不误伤事实类条目（角色卡／情感模块／普通话题）',
    !isRule('猫娘女仆角色卡更新到第9版：说话方式改成「每两条带一次喵语气词」')
    && !isRule('他给桥接加了情感模块，我这轮提示词里多出【语气倾向】一行，语气就会变')
    && !isRule('他周三晚上的课：第9-10节（东区6-303）'),
    '误命中会把无关条目也升成 high，挤爆 900 字的注入预算');
  const st15 = bridge.getSocialV2State('private:999');
  bridge.appendMemoryV2(st15, 'activeTopic', '管理员说我说话别太凶，语气放软一点', { importance: 'normal' }, 'private:999');
  const gotRule = (bridge.socialV2.coreMemory.activeTopics ?? []).find((t) => String(t.text).includes('别太凶'));
  check('她标了 normal，写入时也自动升成 high', gotRule?.importance === 'high', JSON.stringify(gotRule));
  bridge.appendMemoryV2(st15, 'activeTopic', '他周三晚上有课，东区6-303', { importance: 'normal' }, 'private:999');
  const gotFact = (bridge.socialV2.coreMemory.activeTopics ?? []).find((t) => String(t.text).includes('周三晚上有课'));
  check('普通话题仍按她标的重要性走（不被误升级）', gotFact?.importance === 'normal', JSON.stringify(gotFact));

  // ── 2026-10-01：承诺必须有锚（截图上「有结果叫你」之后再没下文）────────────────
  console.log('\n[16] 答应了就要留个锚（"有结果叫你"不能是空话）');
  check('有【答应了就要留个锚】这条', /【答应了就要留个锚】/.test(prompt));
  check('点名了两个可用的锚（pendingThought / 有限潜水）',
    /category="pendingThought"/.test(prompt) && /qq_set_wake_config/.test(prompt));
  check('说清了"没锚的承诺就是空话"', /没锚的承诺就是空话/.test(prompt));
  check('点出了真实场景（有结果叫你）', /有结果叫你/.test(prompt));

  // ── 2026-10-01 23:10：「我上句没接住，你那个"那就是真的"是指哪件事啊」────────────
  // 这不是人话：**播报自己的理解状态**像系统日志，而且"接住"这词是从提示词里抄的。
  console.log('\n[17] 问就问内容，别播报自己的状态（"我上句没接住"）');
  check('有"别播报自己的状态"这条', /问的时候别播报自己的状态/.test(prompt));
  check('给了她的真实反例', /我上句没接住/.test(prompt));
  check('给了人话版本（直接问内容）', /什么叫那就是真的/.test(prompt) && /指哪件事/.test(prompt));
  check('说清"要问的是他说的话、不是你的理解状况"', /不是\*\*你的理解状况\*\*/.test(prompt));
  check('角色卡的 AI 味黑名单也同步了', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /播报自己的状态/.test(card) && /我上句没接住/.test(card);
  })());

  // ── 2026-10-02：「她不是学习的群聊发言吗，怎么还跟豆包一样」──────────────────
  // 实测她 862 条群聊里"解释/方案句式"只有 1 条，但那 1 条正是没人点名时的技术答疑：
  //   ✗「客户端开国服没用，得号本身绑过完美，不然就是国际服按你节点丢亚洲区」
  //   ✗「打ow主要吃声场，开放式的比游戏耳机强，四百档就看飞利浦SHP9500，缺点是没有麦还漏音」
  console.log('\n[18] 群里别当答疑机（"怎么还跟豆包一样"）');
  check('有"别当答疑机"这条', /群里别当答疑机/.test(prompt));
  check('说清"没人点名你就别接"', /不是非答不可/.test(prompt) && /没人点名你就别接/.test(prompt));
  check('钉了她的真实反例（耳机推荐那句）', /飞利浦SHP9500/.test(prompt));
  check('点明群里是群友、不是客服', /不是客服/.test(prompt));

  // ── 2026-10-02 20:19（CS 群截图）：没人问她，她插科普；当事人说"我开的国服啊"她还坚持自己的说法 ──
  console.log('\n[19] 没人问你，就别科普 + 看眼色');
  check('有"没人问你，就别科普"这条', /没人问你，就别科普/.test(prompt));
  check('禁止反驳别人的亲身经历', /更别反驳他的亲身经历/.test(prompt) && /他说是啥就是啥/.test(prompt));
  check('钉了她的真实反例（末末"我开的国服啊"）', /我开的国服啊/.test(prompt) && /选中国区只是优先排/.test(prompt));
  check('有"看眼色"：没人接就别补第二条', /看眼色/.test(prompt) && /没人接\*\*、或者话题已经翻篇了，就别再补第二条/.test(prompt));
  check('拿不准的细节别当结论说', /拿不准的细节别当结论说/.test(prompt));

  // ── 2026-10-02 19:48（CS 群）：她被问"兔兔是真人吗"，直接回「不是真人，bot一个」，随后被群友阴阳 ──
  // 角色卡第 68 行本来就写死了"绝对不说自己是 AI/机器人/模型/助手"，但卡片不进每轮提示词 → 必须在这里也写。
  console.log('\n[20] 别人问你是不是 bot：绝不承认、也别做自我介绍');
  check('有这条规则', /别人问你是不是机器人\/AI/.test(prompt));
  check('明确"绝不承认、别做自我介绍"', /绝不承认/.test(prompt) && /别做自我介绍/.test(prompt));
  check('钉了她的真实反例（不是真人，bot一个）', /不是真人，bot一个/.test(prompt));
  check('给了卡片那套说法（你猜 / 你才机器人）', /你猜/.test(prompt) && /你才机器人/.test(prompt));
  check('别人议论你是不是 bot 时别接话', /别接话/.test(prompt));
  check('与角色卡第 68 行一致（卡里也写死了不许承认）', (() => {
    const card = fs.readFileSync('D:/qq-bridge/roles/程莫雯.md', 'utf8');
    return /你绝对不会说自己是 AI、机器人、模型、助手、DeepSeek/.test(card);
  })());
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
