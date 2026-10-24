/**
 * 回归测试：「他现在在听/看什么」的纯逻辑（2026-10-14，管理员点名要的"进阶 2"）。
 *
 * 现场：他在用 Edge 看 B 站，系统媒体会话（SMTC）当场读到了曲名/状态/进度 ——
 * 所以这条功能**不碰网易云的私有文件**，也**不给她加任何工具**（桥接读、结果拼进上下文）。
 * 这里钉住最容易退化的三件事：解析宽容、便条别啰嗦（同一首不重复）、没在放时别乱说。
 */
import { parseNowPlayingJson, formatNowPlayingLine, nowPlayingKey, cleanMediaTitle } from '../src/now-playing.js';
import { NOW_PLAYING_RULE } from '../src/prompt-rules.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

console.log('\n[1] 解析脚本输出（宽容：读歌失败绝不能影响她回话）');
{
  const good = parseNowPlayingJson('{"playing":true,"paused":false,"status":"Playing","app":"网易云音乐","title":"遐想","artist":"某歌手","album":"某专辑","positionS":47,"durationS":240}');
  check('正常 JSON → 字段齐', good.playing === true && good.title === '遐想' && good.artist === '某歌手' && good.positionS === 47, JSON.stringify(good));
  check('空输入 → 当没在放', parseNowPlayingJson('').playing === false);
  check('坏 JSON → 当没在放（不抛错）', parseNowPlayingJson('{ 这不是 json').playing === false);
  check('有 JSON 但没标题 → 当没在放', parseNowPlayingJson('{"playing":true,"title":""}').playing === false);
  check('混进 BOM/警告行也能挑出 JSON',
    parseNowPlayingJson('\uFEFF警告：xxx\n{"playing":true,"title":"狂赌之渊","app":"Edge 浏览器"}').title === '狂赌之渊');
  check('实测过的那条 Edge 数据能解出来',
    parseNowPlayingJson('{"artist":"","album":"","sessionCount":1,"durationS":254,"positionS":42,"title":"狂赌之渊在它面前像个新兵蛋子_哔哩哔哩_bilibili","app":"Edge 浏览器","playing":false,"status":"Paused","paused":true}').app === 'Edge 浏览器');
}

console.log('\n[2] 便条要短、要准，而且**同一首别反复念叨**（防"电台 DJ"）');
{
  const song = { playing: true, paused: false, app: '网易云音乐', title: '遐想', artist: '某歌手', positionS: 47, durationS: 240 };
  const line = formatNowPlayingLine(song, { now: 1000, at: 900 });
  check('正在放 → 拼出便条', /他现在在听\/看/.test(line) && /遐想/.test(line) && /网易云音乐/.test(line), line);
  check('带上进度（47s/240s → 0:47/4:00）', /0:47\/4:00/.test(line), line);
  check('同一首、同一状态 → 不再重复（last.key 相同）', formatNowPlayingLine(song, { last: { key: nowPlayingKey(song) }, now: 1000, at: 900 }) === '');
  check('换了歌 → 要告诉她', formatNowPlayingLine({ ...song, title: '另一首' }, { last: { key: nowPlayingKey(song) }, now: 1000, at: 900 }) !== '');
  check('播放→暂停也算变化', formatNowPlayingLine({ ...song, playing: false, paused: true }, { last: { key: nowPlayingKey(song) }, now: 1000, at: 900 }) !== '');
  const paused = formatNowPlayingLine({ ...song, playing: false, paused: true }, { now: 1000, at: 900 });
  check('暂停时说的是「刚停在」', /刚停在/.test(paused), paused);
  check('数据太旧（>3 分钟没刷新）→ 不说', formatNowPlayingLine(song, { now: 1000 + 200000, at: 900 }) === '');
  check('没在放也没暂停（读失败）→ 不说', formatNowPlayingLine({ playing: false, paused: false, title: 'x' }, { now: 1000, at: 900 }) === '');
  check('没有标题 → 不说', formatNowPlayingLine({ playing: true, title: '' }, { now: 1000, at: 900 }) === '');
  check('没有歌手的视频标题也不出" — "空壳', !/ — \（/.test(line), line);
}

console.log('\n[3] 规矩里必须写明"别每轮汇报"（否则她会变成报幕机）');
{
  check('规则提到别每轮汇报', /别每轮都汇报|不要每轮都汇报/.test(NOW_PLAYING_RULE));
  check('规则提到别反复念叨同一首', /反复念叨/.test(NOW_PLAYING_RULE));
  check('规则说明"没有便条就是没在放，别猜"', /别猜|别编/.test(NOW_PLAYING_RULE));
  check('规则点明了数据来源（系统媒体会话）', /媒体会话/.test(NOW_PLAYING_RULE));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
console.log('\n[4] 读到的不一定是歌，还有视频/音频 —— 要说对（管理员 2026-10-14 指出的）');
{
  // 他在 Edge 看 B 站，实测原始标题带着平台尾巴
  const edge = parseNowPlayingJson('{"playing":true,"paused":false,"app":"Edge 浏览器","mediaType":"video","title":"狂赌之渊在它面前像个新兵蛋子_哔哩哔哩_bilibili","positionS":42,"durationS":254}');
  const vLine = formatNowPlayingLine(edge, { now: 1000, at: 900 });
  check('视频 → 说「正在看」而不是「正在听」', /正在看/.test(vLine), vLine);
  check('标题清掉了 _哔哩哔哩_bilibili 尾巴', /《狂赌之渊在它面前像个新兵蛋子》/.test(vLine) && !/哔哩哔哩|bilibili/.test(vLine), vLine);
  check('视频不硬塞歌手', !/—\s*。/.test(vLine), vLine);
  const music = parseNowPlayingJson('{"playing":true,"app":"网易云音乐","mediaType":"music","title":"遐想","artist":"某歌手"}');
  const mLine = formatNowPlayingLine(music, { now: 1000, at: 900 });
  check('音乐 → 说「正在听」并带上歌手', /正在听/.test(mLine) && /某歌手/.test(mLine), mLine);
  const unknown = parseNowPlayingJson('{"playing":true,"app":"某播放器","title":"某个东西"}');
  check('类型不明 → 保守地说「正在放」', /正在放/.test(formatNowPlayingLine(unknown, { now: 1000, at: 900 })), formatNowPlayingLine(unknown, { now: 1000, at: 900 }));
  check('清洗：- YouTube 尾巴', cleanMediaTitle('某个视频 - YouTube') === '某个视频', cleanMediaTitle('某个视频 - YouTube'));
  check('清洗：_哔哩哔哩_bilibili 双层尾巴', cleanMediaTitle('标题_哔哩哔哩_bilibili') === '标题', cleanMediaTitle('标题_哔哩哔哩_bilibili'));
  check('清洗：正常标题不动', cleanMediaTitle('遐想') === '遐想');
  check('清洗：空输入不炸', cleanMediaTitle('') === '');
  check('清洗之后仍是空标题 → 便条不发（别给她一条空书名号）', formatNowPlayingLine({ playing: true, title: '   ', mediaType: 'music' }, { now: 1000, at: 900 }) === '');
}
process.exit(failed === 0 ? 0 : 1);
