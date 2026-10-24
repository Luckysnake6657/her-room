/**
 * 「他现在在听/看什么」的纯逻辑（2026-10-14，管理员点名要的"进阶 2"）。
 *
 * 数据来自系统媒体会话（SMTC）：`scripts/now-playing.ps1` 读出来输出一行 JSON。
 * 走这条路的原因（也是设计上的重点）：
 *   • 通用：网易云、QQ音乐、Edge/Chrome、PotPlayer…全都注册媒体会话 ——
 *     实测当场读到 Edge 里播的 B 站视频。比"只翻网易云的私有文件"覆盖面大得多。
 *   • **不扩她的能力面**：读的是桥接这一侧，结果拼进她的上下文；她不需要任何新工具。
 *   • 只读、不要登录态、不碰对方进程内存、不写任何东西。
 *
 * 这里只放**能离线测**的部分：解析脚本输出、决定"这轮要不要告诉她"、拼成一行提示词。
 */

/**
 * 解析 `now-playing.ps1` 的输出（一行 JSON）。
 * 宽容处理：空/坏数据一律当成"没在放"，绝不因为读歌失败影响她回话。
 */
export function parseNowPlayingJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { playing: false, reason: 'empty' };
  // 脚本可能混进别的行（BOM、警告），取最后一行像 JSON 的
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  const line = lines[lines.length - 1];
  if (!line) return { playing: false, reason: 'no-json' };
  try {
    const o = JSON.parse(line.replace(/^\uFEFF/, ''));
    const title = String(o.title ?? '').trim();
    if (!title) return { playing: false, reason: 'no-title' };
    return {
      playing: o.playing === true,
      paused: o.paused === true,
      status: String(o.status ?? ''),
      app: String(o.app ?? '').trim(),
      title,
      artist: String(o.artist ?? '').trim(),
      album: String(o.album ?? '').trim(),
      // music / video / unknown：SMTC 的 PlaybackType 有的应用不填，脚本那边用 app+标题兜过底
      mediaType: ['music', 'video'].includes(String(o.mediaType)) ? String(o.mediaType) : 'unknown',
      positionS: Number.isFinite(Number(o.positionS)) ? Number(o.positionS) : null,
      durationS: Number.isFinite(Number(o.durationS)) ? Number(o.durationS) : null,
    };
  } catch {
    return { playing: false, reason: 'bad-json' };
  }
}

/**
 * 清洗 SMTC 给的网页/媒体标题尾巴：`xxx_哔哩哔哩_bilibili` → `xxx`、`xxx - YouTube` → `xxx`。
 * （实测他在 Edge 看 B 站时，标题就是「狂赌之渊在它面前像个新兵蛋子_哔哩哔哩_bilibili」）
 */
export function cleanMediaTitle(title) {
  return String(title ?? '')
    .replace(/\s*[_\-–|]\s*(哔哩哔哩|bilibili|youtube|腾讯视频|爱奇艺|优酷|抖音|西瓜视频|网易云音乐|QQ音乐|Spotify).*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
/** 拼成一行便条；不值得说就返回空串。`last` 是上次已经告诉过她的（用来避免同一首反复念叨）。 */
export function formatNowPlayingLine(data, { last = null, staleMs = 180000, now = Date.now(), at = 0 } = {}) {
  if (!data || !data.title) return '';
  if (!data.playing && !data.paused) return '';
  if (at && now - at > staleMs) return '';            // 数据太旧（脚本没刷上）就别拿出来说
  const key = `${data.app}|${data.title}|${data.playing ? 'p' : 's'}`;
  if (last && last.key === key) return '';            // 同一首、同一状态 → 这轮不重复告诉她
  // 标题清洗：SMTC 给的是网页标题，常带 `_哔哩哔哩_bilibili` / `- YouTube` 这种平台尾巴
  const clean = cleanMediaTitle(data.title);
  if (!clean) return '';      // 清洗完没内容了就别发（否则会给她一条空的《》）
  const app = data.app ? `（${data.app}）` : '';
  // 按媒体类型说对话：看到视频别说成"你在听这首歌"（管理员 2026-10-14 指出来的）
  const verb = data.mediaType === 'video' ? '正在看' : (data.mediaType === 'music' ? '正在听' : '正在放');
  const state = data.playing ? verb : '刚停在';
  const who = data.mediaType === 'music' && data.artist ? `《${clean}》— ${data.artist}` : `《${clean}》`;
  let progress = '';
  if (Number.isFinite(data.positionS) && Number.isFinite(data.durationS) && data.durationS > 0) {
    const mm = Math.floor(data.positionS / 60);
    const ss = String(Math.round(data.positionS % 60)).padStart(2, '0');
    const tm = Math.floor(data.durationS / 60);
    const ts = String(Math.round(data.durationS % 60)).padStart(2, '0');
    progress = `，进度 ${mm}:${ss}/${tm}:${ts}`;
  }
  return `【他现在在听/看】${app}${state}${who}${progress}。`
    + '（便条而已：只在自然的时候顺口带一句，别每轮都汇报，也别反复念叨同一首。）\n';
}

/** 便条的"指纹"，用来判断要不要更新"上次告诉过她的"。 */
export function nowPlayingKey(data) {
  if (!data || !data.title) return '';
  return `${data.app ?? ''}|${data.title}|${data.playing ? 'p' : 's'}`;
}
