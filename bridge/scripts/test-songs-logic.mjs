/**
 * 歌单 / 翻唱的纯逻辑测试（2026-10-14）。
 *
 * 关键是**点歌要认得出来**：他说"唱那首周杰伦的"，也得命中《夜曲》——
 * 所以别名匹配是这层最重要的东西。
 */
import assert from 'node:assert/strict';
import {
  SING_RULE, SONG_NAME_MAX, cleanSongName, shouldAddSong, findSong, addAlias,
  makeSongEntry, parseSongs, formatSongLine, coverFileNames,
} from '../src/songs.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

t('歌名去掉扩展名', () => {
  assert.equal(cleanSongName('夜曲.mp3'), '夜曲');
  assert.equal(cleanSongName('My Song.M4A'), 'My Song');
});
t('歌名去掉路径非法字符（要能当文件名）', () => {
  const n = cleanSongName('a/b:c*d?e"f<g>h|i');
  assert.ok(!/[\\/:*?"<>|]/.test(n), `还有非法字符：${n}`);
});
t('歌名限长', () => {
  assert.ok(cleanSongName('啊'.repeat(200)).length <= SONG_NAME_MAX);
});
t('空名字不给收', () => {
  assert.equal(shouldAddSong('').ok, false);
  assert.equal(shouldAddSong('   ').reason, 'no-name');
});
t('歌单满了不给收', () => {
  const r = shouldAddSong('新歌', { count: 100, max: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'full');
});
// ★ 点歌要认得出来
t('★ 精确匹配歌名', () => {
  const s = findSong([{ name: '夜曲' }, { name: '晴天' }], '夜曲');
  assert.equal(s.name, '夜曲');
});
t('★ 别名匹配（他说"周杰伦那首"）', () => {
  const songs = [{ name: '夜曲', aliases: ['周杰伦那首', '小夜曲'] }];
  assert.equal(findSong(songs, '周杰伦那首').name, '夜曲');
  assert.equal(findSong(songs, '小夜曲').name, '夜曲');
});
t('★ 匹配大小写/空格不敏感', () => {
  const songs = [{ name: 'My Song' }];
  assert.equal(findSong(songs, 'my song').name, 'My Song');
  assert.equal(findSong(songs, '  MY SONG  ').name, 'My Song');
});
t('★ 包含匹配（说一半也能认）', () => {
  assert.equal(findSong([{ name: '告白气球' }], '告白').name, '告白气球');
});
t('找不到就返回 null（她要能如实说"这首我没有"）', () => {
  assert.equal(findSong([{ name: '夜曲' }], '不存在的歌'), null);
  assert.equal(findSong([], '夜曲'), null);
  assert.equal(findSong([{ name: '夜曲' }], ''), null);
});
t('加别名去重', () => {
  let s = { name: '夜曲', aliases: [] };
  s = addAlias(s, '周杰伦那首');
  s = addAlias(s, '周杰伦那首');
  assert.equal(s.aliases.length, 1);
});
t('别名数量上限', () => {
  let s = { name: 'x', aliases: [] };
  for (let i = 0; i < 20; i++) s = addAlias(s, `别名${i}`);
  assert.ok(s.aliases.length <= 8);
});
t('歌单解析容错', () => {
  assert.deepEqual(parseSongs('坏数据'), []);
  assert.deepEqual(parseSongs('[{"name":"a"}]'), [], '缺 file 的丢掉');
  assert.equal(parseSongs('[{"name":"a","file":"a.mp3"}]').length, 1);
});
t('条目带加入时间与来源', () => {
  const e = makeSongEntry({ name: '夜曲', file: '夜曲.mp3', from: 'private:1 #9' });
  assert.ok(e.addedAt && e.from === 'private:1 #9');
});
t('展示行含名字和别名', () => {
  const line = formatSongLine({ name: '夜曲', aliases: ['周杰伦那首'] }, 1);
  assert.ok(line.includes('夜曲') && line.includes('周杰伦那首') && line.startsWith('1.'));
});
t('产物文件名跟着歌名走（中文也安全）', () => {
  const f = coverFileNames('夜曲');
  assert.ok(f.mp3.endsWith('.mp3') && !/[\\/:*?"<>|]/.test(f.mp3));
});
t('规则里写明"不能凭歌名去网上找歌"', () => {
  assert.ok(SING_RULE.includes('qq_sing'));
  assert.ok(/不能凭歌名去网上找歌|没那个能力/.test(SING_RULE), '必须写清这条界限');
  assert.ok(SING_RULE.includes('歌单里没有'));
});

console.log(`\n  songs 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);