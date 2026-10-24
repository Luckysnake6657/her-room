/**
 * 她"开口说话"的纯逻辑（2026-10-14，管理员要的"她也能发语音"）。
 *
 * 谁在干活：`scripts/speak-server.py` —— **常驻**的 F5-TTS 零样本克隆 + 降调后处理。
 *   为什么必须常驻：每次现起 python 光加载模型就要 ~19 秒（加推理约 30 秒），聊天根本没法用；
 *   常驻服务把模型只加载一次，之后每句约 6 秒（2026-10-14 实测：4.43s 音频 / 合成 6402ms）。
 *   音色 = 若叶睦：素材取明日方舟那批**干声**，再按 F0 起伏挑出她情绪最明显的句子当参考
 *   （用动画参考时音高差 12.6Hz，换干声后只差 1.4Hz）；降调 12% 修正 F5 天然的偏高音高。
 *   三选一的实测结论写在 QUICKSTART：RVC 不成立（咬字被训练语言带偏）、CosyVoice 装不了
 *   （锁 grpcio==1.57 对 Python 3.12 无预编译包）、GPT-SoVITS 微调音高更准但咬字糊（可懂度 6/23）。
 * 这里放能离线测的部分：文本能不能念、怎么清洗、缓存键、以及给她的规矩。
 *
 * 管理员明确说过的一条：**"她发语音不应该给限制"** —— 所以规矩里**不写**"他说语音你才能回语音"
 * 那种条件，她**想发就发**；只保留"说话的样子"那一层（别刷屏、别无脑重复），
 * 那属于口吻/分寸，不是能力限制。
 */

/** 给她的规矩：语音是她的一种表达方式，自由用，但要有分寸。 */
export const SPEECH_RULE = '【你也能"说话"（发语音）】用 `qq_send_voice` 把你的一句话变成语音发出去 ——'
  + '合成在本机做（音色是你自己的、固定的那个），**想用就用，不用等他先发语音**。\n'
  + '- **什么时候发**：想他了、笑出声、困得不想打字、想认真说一句、说晚安的时候 —— '
  + '这种时候一条语音比打字近得多。他发了语音/在语音里说话，你也可以回一条。\n'
  + '- **一条就把一件事说完**（220 字以内都行）：别"语音半句 + 文字半句"，那样他听着像话没讲完就断了。\n'
  + '- **一轮最多一条、别连刷**：他得一条条点开听。真的超过 220 字再打字。\n'
  + '- 只念**你要说的话**：别念工具说明、报错、代码、链接。\n'
  + '- 发之前不用报备"我给你发条语音"——直接发，像真人一样。\n\n';

/** 要念的文字先清洗：去掉不该念出来的东西（CQ 码、URL、代码块、表情记号）。 */
export function cleanSpeechText(text) {
  return String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[(图片|表情|表情包|视频|语音|文件|转发消息|引用)[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 能不能发。返回 `{ ok, reason, text }`：`text` 是清洗后准备念的内容。
 * 空的、太长的一律拒 —— 语音超过 220 字就该打字（他得一条条点开听）；
 * 这里**不偷偷截断**：截断会让发出去的话和她说的话不一致，宁可让她改打字。
 */
export function shouldSpeak(text, { enabled = true, maxChars = 220 } = {}) {
  if (enabled !== true) return { ok: false, reason: 'disabled', text: '' };
  const clean = cleanSpeechText(text);
  if (!clean) return { ok: false, reason: 'empty', text: '' };
  if (clean.length > maxChars) return { ok: false, reason: 'too-long', text: clean };
  return { ok: true, reason: '', text: clean };
}

/**
 * 缓存键：同一句话不重复合成（合成一次要几秒，别浪费）。
 * 用 FNV-1a 双路压成短键（不引 node:crypto，省得 vm 沙箱/harness 还要多注入一个模块）。
 */
function shortHash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

export function speechCacheKey(text) {
  const clean = cleanSpeechText(text);
  return clean ? `t:${shortHash(clean)}` : '';
}

/** 解析 `speak.py` / 常驻服务的一行 JSON（宽容：坏数据一律当失败）。 */
export function parseSpeakJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  const line = lines[lines.length - 1];
  if (!line) return { ok: false, error: 'no-json' };
  try {
    const o = JSON.parse(line.replace(/^\uFEFF/, ''));
    if (o.ok !== true) return { ok: false, error: String(o.error ?? 'unknown') };
    // 声称成功却没给音频路径 = 下游没法发，必须当失败（2026-10-14：实测端点会这样返回）
    const wav = String(o.wav ?? '');
    if (!wav) return { ok: false, error: 'no-wav' };
    return {
      ok: true,
      wav,
      seconds: Number.isFinite(Number(o.seconds)) ? Number(o.seconds) : null,
      ms: Number.isFinite(Number(o.ms)) ? Number(o.ms) : null,
    };
  } catch {
    return { ok: false, error: 'bad-json' };
  }
}
