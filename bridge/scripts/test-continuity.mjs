/**
 * 回归测试：按**她自己的诉求**做的三件事（申请 #26，管理员 2026-10-13：「我这次遵循她的选择」）。
 *
 * 她的原话（前两条来自 #26 的 detail，第三条来自同一份清单）：
 *   1) 连续性（她排第一）：「每次唤醒对我都像『重新加载』：上下文重建、只带一份最近对话…
 *      醒来先要重新认场，热话题基本赶不上、也常接错。」
 *   5) 别断在半路：「我说过『过会儿再试』『有结果叫你』的事，希望能被系统记住并在合适的时候
 *      自己捡起来…现在虽然有 pendingThought，但经常是我自己忘了回头看。」
 *   3) 读懂图：「…读不出它是哪个梗、大家在什么语境下用它——所以接不住。」**但她同时明确划界：
 *      「任何扩大我能力面的权限」都不要** → 所以这条只能给"用现有工具攒"的方法，不许加工具。
 *
 * 这个用例把这三件事钉住：
 *   [1] 轮换后的 seed 条数/每条字数**可配**（原来写死 14 条 / 110 字符）
 *   [2] 刚过期的 pendingThought 会被端到她眼前（"你还没做完的事"），太久远的不提（噪音）
 *   [3] 表情包/梗只用**现有工具**（QQ 侧无新增工具），且规则真的进了每轮注入
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

const KEY = 'private:984776985';
const h = await bridgeHarness({ config: { socialV2: { enabled: true }, ownerQQ: 123 } });
try {
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const now = Date.now();

  console.log('\n[1] 轮换后的 seed：条数与每条字数**可配**（她 #26 第 1 条「连续性」）');
  {
    st.recentMessages = Array.from({ length: 40 }, (_, i) => ({
      isSelf: i % 2 === 0, sender: i % 2 === 0 ? '我' : '他',
      text: `第${i + 1}条消息，内容写得长一点用来验证每条截断的字数限制到底生效没有，后面都是填充文字`,
      time: now - (40 - i) * 60000,
    }));
    h.cfg.socialV2.session = { seedMsgs: 5, seedChars: 30 };
    const small = h.buildContextSeedLine(st);
    h.cfg.socialV2.session = { seedMsgs: 30, seedChars: 160 };
    const big = h.buildContextSeedLine(st);
    const countLines = (t) => (t.match(/^ {2}\S/gm) ?? []).length;
    check('seedMsgs=5 → 只带 5 条', countLines(small) === 5, `实际 ${countLines(small)} 条`);
    check('seedMsgs=30 → 带 30 条（默认值提高后确实更连贯）', countLines(big) === 30, `实际 ${countLines(big)} 条`);
    check('seedChars 生效（30 字符的版本明显更短）', small.length < big.length * 0.5, `${small.length} vs ${big.length}`);
    check('每行仍带"距今多久"（时间锚点不能被配置化弄丢）', /（\d+(分钟|小时|天)前|刚刚）/.test(big), big.slice(0, 200));
    h.cfg.socialV2.session = {};   // 复位，后面的用例不受影响
  }

  console.log('\n[2] 「你还没做完的事」：刚过期的 pendingThought 要端到眼前（她 #26 第 5 条）');
  {
    st.pendingThoughts = [{ text: '想问问他今天嗓子好点没', expiresAt: now - 3600 * 1000 }];
    const p1 = h.buildWakePromptV2(KEY, 'private');
    check('提示词里出现【你还没做完的事】', p1.includes('【你还没做完的事】'));
    check('带上了那条想法正文', p1.includes('想问问他今天嗓子好点没'), p1.slice(p1.indexOf('你还没做完'), p1.indexOf('你还没做完') + 160));
    check('说明了"这是你自己记的、不是新消息"', /你自己.*之前记下/.test(p1));
    check('给了明确动作（补上或明确放弃，别装看不见）', /明确放弃/.test(p1));
    // 太久远的（5 天前过期）不该提 —— 提了是噪音，还会让她拿旧事当今天的任务
    st.pendingThoughts = [{ text: '五天前想问的那句', expiresAt: now - 5 * 24 * 3600 * 1000 }];
    check('过期超过 48 小时的不提（避免噪音/旧事当新事）', !h.buildWakePromptV2(KEY, 'private').includes('【你还没做完的事】'));
    // 没过期的归记忆块，不重复列
    st.pendingThoughts = [{ text: '还没到期的想法', expiresAt: now + 3600 * 1000 }];
    check('未过期的想法不重复列在这里', !h.buildWakePromptV2(KEY, 'private').includes('【你还没做完的事】'));
    st.pendingThoughts = [];
  }

  console.log('\n[3] 表情包/梗：**不新增能力面**，只给"用现有工具攒"的方法（她 #26 第 3 条 + 她自己的边界）');
  {
    const p = h.buildWakePromptV2(KEY, 'private');
    check('每轮注入里出现了【表情包与梗】', p.includes('【表情包与梗】'));
    for (const tool of ['qq_get_message_images', 'qq_collect_sticker', 'qq_sticker_note', 'qq_slang_submit', 'qq_slang_query']) {
      check(`方法里点名了现有工具 ${tool}`, p.includes(tool));
    }
    check('明确写了"不用申请任何新能力"（尊重她"不要扩权"的边界）', /不用申请任何新能力/.test(p));
    // 硬边界：不许因为这条规则去动白名单/MCP 工具面
    const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
    const tools = (mcp.match(/^ {2}'qq_[a-z_]+',/gm) ?? []).map((s) => s.trim().replace(/[',]/g, ''));
    // ⚠️ 这份清单是**2026-10-13 冻结的工具面快照**（不是"允许清单"）：它的唯一作用是
    //    让"以后悄悄多出一个工具"必然把这条用例弄红 → 强制有人显式来这里看一眼。
    //    加工具的人要连这份快照一起改（那一步就是一次评审）。
    const allowed = new Set(['qq_request_action', 'qq_send_file', 'qq_send_message', 'qq_get_prompt', 'qq_get_unread_messages',
      'qq_get_recent_messages', 'qq_social_state', 'qq_send_group_message', 'qq_send_private_message', 'qq_reply', 'qq_send_burst',
      'qq_wait_for_messages', 'qq_report_feedback', 'qq_get_my_recent_messages', 'qq_get_message_detail', 'qq_get_active_members',
      'qq_set_wake_config', 'qq_mark_read', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
      'qq_slang_query', 'qq_slang_submit', 'qq_request_cross_send', 'qq_get_message_images', 'qq_get_forward_msg', 'qq_send_poke',
      'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_collect_sticker', 'qq_get_self_image',
'qq_set_sticker_remark', 'qq_status', 'qq_list_groups', 'qq_get_group_members', 'qq_get_group_history',
      // 2026-10-13：管理员装了 MATLAB 并**明确要她"能自己跑代码 + 出图"**（这是他自己越过她"不要扩权"那条
      // 偏好的决定）。所以这个工具是**显式加进来**的 —— 快照更新就是那次评审的留痕，别当成悄悄扩权。
      'qq_run_matlab',
      // 2026-10-14：管理员明确要她能"开口说话"（发语音），音色用若叶睦的本地克隆。
      // 和其他新增能力一样：显式登记 = 一次评审留痕，不是悄悄扩权。
      'qq_send_voice',
      // 2026-10-14：管理员提到的"进阶 1"——她自己的日记本（只追加、改不了删不掉）。
      'qq_diary',
      // 2026-10-14：进阶篇 ③ 她的相册（她挑的图，存图必须写理由）。
      'qq_gallery',
      // 2026-10-14：她的歌单 + 翻唱（他发一次歌，以后点歌她就能唱）。
      'qq_sing',
      // 2026-10-18：进阶 4「给她一台手机」。管理员**自己装了 MuMu 模拟器并明确说
      //   "这台就是给她用的"**（不是主力机），要她能截屏 + 点按 + 打字 + 连招。
      //   显式登记 = 一次评审留痕，不是悄悄扩权。安全约束见 QUICKSTART「手机通道」：
      //   参数只收数字/枚举（防 adb shell 注入）、只操作配置里那一台设备、截屏不自动进上下文。
      'qq_phone',
      // 2026-10-16：进阶 3「按需看文件」（文本按行 / 文档按页）。
      'qq_read_file',
      // 2026-10-20：她说"我只看得见你在听什么，自己放不了" —— 管理员要她能控网易云的播放。
      //   显式登记 = 一次评审留痕。**只 5 个动作**（play/pause/toggle/next/prev），
      //   音量/进度/退出刻意不给（突然拉满音量会伤人耳朵）。
      'qq_media']);
    const unknown = [...new Set(tools.filter((t) => !allowed.has(t)))];
    check('没有偷偷新增 QQ 工具（能力面没被扩大）', unknown.length === 0, JSON.stringify(unknown));
    const rules = fs.readFileSync(path.join(ROOT, 'src', 'prompt-rules.js'), 'utf8');
    check('规则登记进了 RULE_INVENTORY（"她到底被交代了哪些规矩"一眼能看完）', /key: 'meme-library'/.test(rules));
  }
} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
