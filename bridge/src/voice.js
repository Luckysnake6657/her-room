/**
 * 语音转文字的纯逻辑（2026-10-14，管理员点名要的"进阶 3"）。
 *
 * 谁在干活：`scripts/transcribe.py`（ffmpeg 解 AMR → faster-whisper small 转写，**全程本地**）。
 * 这里放能离线测的部分：解析它的 JSON、决定"要不要转/怎么拼给她、失败怎么降级"。
 *
 * 隐私约定（管理员特别在意，也写进了 config 的注释）：
 *   • 音频**下载 → 转码 → 转写 → 立刻删**，本地只留文字；
 *   • 不外传（whisper 和 ffmpeg 都在本机跑，一条都不出网）；
 *   • 同一个 file_id 只转一次（缓存转写结果，不重复下载）。
 */

/** 提示词规矩：语音转出来的文字怎么用（别把机器转写的错字当圣旨）。 */
export const VOICE_TRANSCRIBE_RULE = '【他说的话（语音转文字）】他发的语音会被本机转成文字，标成 `[语音] 内容…`。'
  + '注意三点：① 这是**机器转写**，同音字/人名/英文可能出错 —— 意思明显时照常接，'
  + '关键信息（数字、时间、地点、人名）拿不准就顺口确认一句，别硬猜；'
  + '② 转写失败时你只会看到光秃秃的 `[语音]`，那种时候就说"语音我这边没转出来，你打字或者再说一遍"；'
  + '③ 别把"我能听懂你语音"当成新本领到处显摆，照常聊就行。\n\n';

/** 解析 `transcribe.py` 的一行 JSON。宽容：坏数据一律当失败，绝不让它影响消息处理。 */
export function parseTranscriptJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  const line = lines[lines.length - 1];
  if (!line) return { ok: false, error: 'no-json' };
  try {
    const o = JSON.parse(line.replace(/^\uFEFF/, ''));
    if (o.ok !== true) return { ok: false, error: String(o.error ?? 'unknown') };
    const body = String(o.text ?? '').trim();
    if (!body) return { ok: false, error: 'empty-text' };
    return {
      ok: true,
      text: body,
      lang: String(o.lang ?? ''),
      langProb: Number(o.langProb ?? 0),
      seconds: Number.isFinite(Number(o.seconds)) ? Number(o.seconds) : null,
      ms: Number.isFinite(Number(o.ms)) ? Number(o.ms) : null,
    };
  } catch {
    return { ok: false, error: 'bad-json' };
  }
}

/**
 * 把转写结果拼成给她的那段文字。
 * 转写失败 → 只留 `[语音]`（她会照规矩说"没转出来"）；成功 → `[语音] 内容`。
 */
export function formatVoiceSegment(result, { maxChars = 500 } = {}) {
  if (!result || result.ok !== true || !result.text) return '[语音]';
  const body = String(result.text).replace(/\s+/g, ' ').trim();
  if (!body) return '[语音]';
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `[语音] ${clipped}`;
}

/** 该不该转：开关 + 时长/大小上限（太长的不转，省得她等半天）。 */
export function shouldTranscribe({ enabled = true, seconds = null, bytes = null, maxSeconds = 90, maxBytes = 3 * 1024 * 1024 } = {}) {
  if (enabled !== true) return { ok: false, reason: 'disabled' };
  if (Number.isFinite(bytes) && bytes > maxBytes) return { ok: false, reason: 'too-large' };
  if (Number.isFinite(seconds) && seconds > maxSeconds) return { ok: false, reason: 'too-long' };
  return { ok: true, reason: '' };
}

/** 缓存键：同一个语音只转一次（file_id 优先，取不到就用 URL 的后半段）。 */
export function voiceCacheKey(seg = {}) {
  const id = String(seg.file_id ?? seg.file ?? '').trim();
  if (id) return `id:${id}`;
  const url = String(seg.url ?? '').trim();
  if (!url) return '';
  return `url:${url.slice(-64)}`;
}
