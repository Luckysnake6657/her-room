/**
 * 天气纯逻辑测试（2026-10-23，管理员："城市改成宁波，希望她有时间观念和天气观念"）。
 *
 * 守的是几条"编了就会露馅"的边界：
 *   • 未知天气码不许编（返回中性）；坏数据一律 null（宁可不说天气）
 *   • 只有"分组变化"才算明显变化（连续小雨不算）
 *   • 情绪刺激只动愉快度 v、有上限，晴天正、雨雪负
 *   • 日记里的天气词是短标签（不带温度/风）
 */
import assert from 'node:assert/strict';
import {
  describeCode, parseOpenMeteo, formatWeatherLine, isNotableChange,
  weatherStimulus, diaryWeatherLabel,
} from '../src/weather.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

t('晴朗码 → 晴 / sun / 正 mood', () => {
  const d = describeCode(0);
  assert.equal(d.label, '晴');
  assert.equal(d.group, 'sun');
  assert.ok(d.mood > 0);
});
t('雨码 → rain / 负 mood', () => {
  const d = describeCode(63);
  assert.equal(d.group, 'rain');
  assert.ok(d.mood < 0);
});
t('未知天气码不编：返回中性', () => {
  const d = describeCode(999);
  assert.equal(d.group, 'unknown');
  assert.equal(d.mood, 0);
  assert.equal(d.label, '天气不明');
});

t('parseOpenMeteo 解析正常数据', () => {
  const d = parseOpenMeteo({ current: { temperature_2m: 20.84, weather_code: 53, wind_speed_10m: 19.5 } });
  assert.equal(d.temp, 20.8);
  assert.equal(d.label, '毛毛雨');
  assert.equal(d.wind, 20);
  assert.ok(d.at > 0);
});
t('parseOpenMeteo 坏数据返回 null（不许编）', () => {
  assert.equal(parseOpenMeteo(null), null);
  assert.equal(parseOpenMeteo({ current: { weather_code: 0 } }), null);
  assert.equal(parseOpenMeteo({ current: { temperature_2m: 20, weather_code: 'x' } }), null);
});

t('formatWeatherLine 正常带城市/温度/风', () => {
  const d = parseOpenMeteo({ current: { temperature_2m: 21, weather_code: 3, wind_speed_10m: 8 } });
  const line = formatWeatherLine(d, { city: '宁波', now: d.at });
  assert.ok(line.includes('【今天天气】宁波'));
  assert.ok(line.includes('阴'));
  assert.ok(line.includes('21℃'));
  assert.ok(line.includes('风 8km/h'));
  assert.ok(line.includes('不用每轮汇报'), '要写明分寸，否则每轮念天气');
});
t('formatWeatherLine 数据太旧就不出现', () => {
  const d = parseOpenMeteo({ current: { temperature_2m: 21, weather_code: 3 } });
  assert.equal(formatWeatherLine(d, { city: '宁波', now: d.at + 5 * 60 * 60 * 1000 }), '');
});
t('formatWeatherLine 未知天气不出现', () => {
  const d = { label: '天气不明', temp: 20, at: Date.now() };
  assert.equal(formatWeatherLine(d, { city: '宁波' }), '');
});

t('isNotableChange：晴→雨算、雨→雨不算、没上次不算', () => {
  const sun = describeCode(0);
  const rain = describeCode(63);
  const rain2 = describeCode(61);
  assert.equal(isNotableChange(sun, rain), true);
  assert.equal(isNotableChange(rain, rain2), false);
  assert.equal(isNotableChange(null, rain), false);
  assert.equal(isNotableChange(sun, sun), false);
});

t('weatherStimulus：晴正、雨负、只动 v', () => {
  const sun = weatherStimulus(describeCode(0), 0.12);
  const rain = weatherStimulus(describeCode(63), 0.12);
  assert.ok(sun.v > 0);
  assert.ok(rain.v < 0);
  assert.equal(sun.a, 0);
  assert.equal(sun.d, 0);
});
t('weatherStimulus：权重有上限，别让天气盖过对话', () => {
  const s = weatherStimulus(describeCode(63), 5);
  assert.ok(Math.abs(s.v) <= 0.5);
});

t('diaryWeatherLabel 是短标签（不带温度）', () => {
  assert.equal(diaryWeatherLabel(parseOpenMeteo({ current: { temperature_2m: 21, weather_code: 3 } })), '阴');
  assert.equal(diaryWeatherLabel(null), '');
});

console.log(`\n  weather 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
