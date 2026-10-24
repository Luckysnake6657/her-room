/**
 * 她"开口说话"（发语音）的纯逻辑测试（2026-10-14）。
 *
 * 这一层只测**不需要模型**的部分：文本清洗、要不要发、缓存键、结果解析，以及那条规则的措辞。
 * 真正合成走 scripts/speak-server.py（F5 常驻服务），那部分的验证靠实测（见 QUICKSTART 决策记录）：
 *   参考素材（干声 + 情绪句）→ F5 零样本克隆 → 降调 12% → 网关 record 段（网关自己 encodeSilk）。
 */
import assert from 'node:assert/strict';
import { SPEECH_RULE, cleanSpeechText, shouldSpeak, speechCacheKey, parseSpeakJson } from '../src/speech.js';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (error) {
    fail++;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

// ── cleanSpeechText：能念的文本要干净（换行/多余空白/引号都要处理）──────────
t('cleanSpeechText 去掉首尾空白', () => {
  assert.equal(cleanSpeechText('  你好  '), '你好');
});
t('cleanSpeechText 把换行折成停顿（不留裸换行）', () => {
  const out = cleanSpeechText('第一句\n第二句');
  assert.ok(!out.includes('\n'), `不该留换行：${JSON.stringify(out)}`);
  assert.ok(out.includes('第一句') && out.includes('第二句'));
});
t('cleanSpeechText 折叠连续空白', () => {
  assert.equal(cleanSpeechText('你   好'), '你 好');
});
t('cleanSpeechText 非字符串入参不炸', () => {
  assert.equal(cleanSpeechText(null), '');
  assert.equal(cleanSpeechText(undefined), '');
  assert.equal(cleanSpeechText(123), '123');
});

// ── shouldSpeak：什么时候该发语音（空/太长/关掉）──────────────────────────
t('shouldSpeak 空文本不放行', () => {
  assert.equal(shouldSpeak('').ok, false);
  assert.equal(shouldSpeak('   ').ok, false);
});
t('shouldSpeak 一句话放行', () => {
  const r = shouldSpeak('我在呢。');
  assert.equal(r.ok, true);
  assert.equal(r.text, '我在呢。');
});
t('shouldSpeak 超长不放行（长内容该打字）', () => {
  const r = shouldSpeak('啊'.repeat(300), { maxChars: 220 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-long');
});
t('shouldSpeak 正好在上限放行', () => {
  assert.equal(shouldSpeak('啊'.repeat(220), { maxChars: 220 }).ok, true);
});
t('shouldSpeak 被禁掉时不放行', () => {
  const r = shouldSpeak('你好', { enabled: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
});
t('shouldSpeak 清理后再判长度（空白不算字数）', () => {
  const r = shouldSpeak('  ' + '啊'.repeat(5) + '  ', { maxChars: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.text, '啊啊啊啊啊');
});

// ── speechCacheKey：同一句话要稳定命中（也用来防重复发）────────────────────
t('speechCacheKey 同文本同键', () => {
  assert.equal(speechCacheKey('你好'), speechCacheKey('你好'));
});
t('speechCacheKey 空白差异不影响', () => {
  assert.equal(speechCacheKey('你 好'), speechCacheKey('你  好'));
});
t('speechCacheKey 不同文本不同键', () => {
  assert.notEqual(speechCacheKey('你好'), speechCacheKey('再见'));
});
t('speechCacheKey 是短键（别把整句塞进键里）', () => {
  assert.ok(speechCacheKey('啊'.repeat(200)).length <= 32);
});

// ── parseSpeakJson：解析合成服务/端点返回 ─────────────────────────────────
t('parseSpeakJson 解析成功结果', () => {
  const r = parseSpeakJson(JSON.stringify({ ok: true, wav: 'x.wav', seconds: 3.2, ms: 6000 }));
  assert.equal(r.ok, true);
  assert.equal(r.wav, 'x.wav');
  assert.equal(r.seconds, 3.2);
});
t('parseSpeakJson 解析失败结果（带原因）', () => {
  const r = parseSpeakJson(JSON.stringify({ ok: false, error: '模型未就绪' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, '模型未就绪');
});
t('parseSpeakJson 空串不炸', () => {
  assert.equal(parseSpeakJson('').ok, false);
  assert.equal(parseSpeakJson('   ').ok, false);
});
t('parseSpeakJson 非 JSON 不炸', () => {
  assert.equal(parseSpeakJson('<html>502</html>').ok, false);
});
t('parseSpeakJson 声称 ok 但没给 wav 时算失败', () => {
  assert.equal(parseSpeakJson(JSON.stringify({ ok: true })).ok, false);
});
t('parseSpeakJson 秒数为字符串时转成数字', () => {
  const r = parseSpeakJson(JSON.stringify({ ok: true, wav: 'x.wav', seconds: '2.5' }));
  assert.equal(r.seconds, 2.5);
});

// ── SPEECH_RULE：措辞必须体现管理员的明确要求 ──────────────────────────────
t('规则里写明"想用就用、不用等他先发语音"（管理员 2026-10-14 明确要求）', () => {
  assert.ok(SPEECH_RULE.includes('想用就用'), '规则必须写清"想用就用"');
  assert.ok(SPEECH_RULE.includes('不用等他先发语音'), '规则必须写明不设前置条件');
});
t('规则里不含"必须先发语音/必须回复语音"这类前置条件', () => {
  assert.ok(!/必须(先)?发语音|必须(用)?语音回复/.test(SPEECH_RULE), '管理员明确要求不给发语音设条件');
});
t('规则里保留了分寸（别连刷、别念链接/报错）', () => {
  assert.ok(SPEECH_RULE.includes('连') && SPEECH_RULE.includes('刷'), '要提醒别连刷语音条');
  assert.ok(SPEECH_RULE.includes('链接'), '要提醒别把链接念出来');
});
t('规则指明用哪个工具', () => {
  assert.ok(SPEECH_RULE.includes('qq_send_voice'), '要告诉她是哪个工具');
});

console.log(`\n  speech 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
