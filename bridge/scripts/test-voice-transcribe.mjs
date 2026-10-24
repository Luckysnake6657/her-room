/**
 * 回归测试：语音转文字的纯逻辑（2026-10-14，管理员点名要的"进阶 3"）。
 *
 * 现场与结论（都实测过）：
 *   • QQ 语音是 **AMR**（record 段的 file 是 xxx.amr）→ 不需要 silk 解码器（pilk 编译失败那条路绕过）；
 *   • scripts/transcribe.py：imageio-ffmpeg 自带的 ffmpeg 转 16k wav → faster-whisper small 转写；
 *     实测 8.1 秒语音、总耗时 4.8 秒、语言 zh 置信度 1.00（把"端到端"听成"端道端"，同音错字）。
 *   • 全程本地、音频用完即删 —— 这几条也要在测试里钉住。
 */
import { parseTranscriptJson, formatVoiceSegment, shouldTranscribe, voiceCacheKey, VOICE_TRANSCRIBE_RULE } from '../src/voice.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

console.log('\n[1] 解析 transcribe.py 的输出（坏数据一律当失败，绝不影响消息处理）');
{
  const good = parseTranscriptJson('{"ok": true, "text": "这是语音转文字的端道端测试", "lang": "zh", "langProb": 1.0, "seconds": 8.1, "ms": 4569}');
  check('成功 → 拿到文字与元数据', good.ok === true && good.text.includes('端道端') && good.seconds === 8.1 && good.ms === 4569, JSON.stringify(good));
  check('失败 JSON → ok:false 并带原因', parseTranscriptJson('{"ok": false, "error": "ffmpeg 转码失败"}').ok === false);
  check('空输入 → 当失败', parseTranscriptJson('').ok === false);
  check('坏 JSON → 当失败（不抛错）', parseTranscriptJson('{ 不是 json').ok === false);
  check('ok:true 但文字是空的 → 当失败', parseTranscriptJson('{"ok": true, "text": "   "}').ok === false);
  check('混进日志行也能挑出 JSON', parseTranscriptJson('warning: xxx\n{"ok": true, "text": "喂"}').text === '喂');
}

console.log('\n[2] 拼给她看的文本 + 失败降级（她照规矩会说"没转出来"）');
{
  check('成功 → `[语音] 内容`', formatVoiceSegment({ ok: true, text: '今天天气不错' }) === '[语音] 今天天气不错');
  check('失败 → 光秃秃的 `[语音]`', formatVoiceSegment({ ok: false, error: 'x' }) === '[语音]');
  check('null → 光秃秃的 `[语音]`', formatVoiceSegment(null) === '[语音]');
  check('超长转写会截断（别把上下文撑爆）', formatVoiceSegment({ ok: true, text: '字'.repeat(900) }).length < 520);
  check('换行/多余空白会被压成一行', formatVoiceSegment({ ok: true, text: '你好\n\n  世界' }) === '[语音] 你好 世界');
}

console.log('\n[3] 该不该转（开关 + 体积上限）');
{
  check('默认开 → 转', shouldTranscribe({ enabled: true }).ok === true);
  check('关掉 → 不转', shouldTranscribe({ enabled: false }).reason === 'disabled');
  check('太大的不转（保护下载和内存）', shouldTranscribe({ enabled: true, bytes: 9 * 1024 * 1024 }).reason === 'too-large');
  check('正常大小能转', shouldTranscribe({ enabled: true, bytes: 300 * 1024 }).ok === true);
  check('太长的音频不转', shouldTranscribe({ enabled: true, seconds: 300 }).reason === 'too-long');
}

console.log('\n[4] 缓存键：同一段语音只转一次（不重复下载）');
{
  check('优先用 file_id', voiceCacheKey({ file_id: 'abc', url: 'https://x/y.amr' }) === 'id:abc');
  check('没有 file_id 就用文件名', voiceCacheKey({ file: 'z.amr', url: 'https://x/y.amr' }) === 'id:z.amr');
  check('都没有就用 URL 尾部', voiceCacheKey({ url: 'https://x/aaaa' }).startsWith('url:'));
  check('什么都没有 → 空键（不缓存）', voiceCacheKey({}) === '');
}

console.log('\n[5] 规矩里必须写清"这是机器转写、可能出错"（别把错字当圣旨）');
{
  check('提到是机器转写', /机器转写/.test(VOICE_TRANSCRIBE_RULE));
  check('提醒同音字/关键信息要确认', /同音字|确认/.test(VOICE_TRANSCRIBE_RULE));
  check('说明转写失败时怎么办', /没转出来|转写失败/.test(VOICE_TRANSCRIBE_RULE));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
