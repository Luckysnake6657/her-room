/**
 * 她相册的纯逻辑测试（2026-10-14，进阶篇 ③）。
 *
 * 最要紧的一条：**存图必须写理由**。原帖那句是灵魂 ——
 * 「意义不在图，在于她挑：你给她看一百张，她自己挑了三张，那三张就是她的了。」
 * 没有理由的存图只是搬运。
 */
import assert from 'node:assert/strict';
import {
  GALLERY_RULE, GALLERY_MAX, GALLERY_NOTE_MAX, GALLERY_EXTS, galleryDate, guessExt,
  galleryFileName, cleanGalleryNote, shouldSaveToGallery, formatGalleryLine,
  makeGalleryEntry, parseGalleryIndex, nextSeq, filterGallery,
} from '../src/gallery.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

t('日期是 YYYY-MM-DD', () => {
  assert.match(galleryDate(new Date('2026-10-14T09:00:00')), /^\d{4}-\d{2}-\d{2}$/);
});
t('扩展名只认白名单里的', () => {
  assert.equal(guessExt('http://x/a.PNG?sign=1'), 'png');
  assert.equal(guessExt('http://x/a.webp'), 'webp');
  assert.equal(guessExt('http://x/a.svg'), 'jpg', 'svg 不在白名单 → 退回 jpg');
  assert.equal(guessExt(''), 'jpg');
});
t('文件名以日期开头 + 两位序号', () => {
  assert.equal(galleryFileName('2026-10-14', 3, 'png'), '2026-10-14-03.png');
  assert.equal(galleryFileName('2026-10-14', 12, 'JPG'), '2026-10-14-12.jpg');
});
t('文件名里的扩展名挡非法值', () => {
  assert.equal(galleryFileName('2026-10-14', 1, '../../evil'), '2026-10-14-01.jpg');
});
// ★ 核心规则
t('★ 没写理由不给存', () => {
  const r = shouldSaveToGallery('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-note');
  assert.ok(r.hint.includes('你挑'), '要点出"意义在她挑"');
});
t('★ 只有空白也不算理由', () => {
  assert.equal(shouldSaveToGallery('   \n  ').ok, false);
});
t('写了理由就能存', () => {
  const r = shouldSaveToGallery('他挑的这张');
  assert.equal(r.ok, true);
  assert.equal(r.note, '他挑的这张');
});
t('理由太长拒（一句话就够）', () => {
  const r = shouldSaveToGallery('啊'.repeat(GALLERY_NOTE_MAX + 1));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'note-too-long');
});
t('相册满了拒，并提示淘汰', () => {
  const r = shouldSaveToGallery('还行', { count: GALLERY_MAX, max: GALLERY_MAX });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'full');
  assert.ok(r.hint.includes('删'), '要告诉她可以淘汰旧图');
});
t('理由清洗：换行折成空格、去多余空白', () => {
  assert.equal(cleanGalleryNote('  这张\n好看  '), '这张 好看');
});
t('展示行含编号 + 理由 + 时间', () => {
  const line = formatGalleryLine({ id: '2026-10-14-01', note: '夜海', savedAt: '2026-10-14T22:23:45.000Z' }, 1);
  assert.ok(line.includes('[1]'));
  assert.ok(line.includes('2026-10-14-01'));
  assert.ok(line.includes('夜海'));
  assert.ok(line.includes('2026-10-14 22:23'));
});
t('索引条目记下来源', () => {
  const e = makeGalleryEntry({ id: 'x', file: 'x.jpg', note: '好看', from: 'private:1 #42' });
  assert.equal(e.from, 'private:1 #42');
  assert.ok(e.savedAt);
});
t('索引解析容错（坏 json 当空）', () => {
  assert.deepEqual(parseGalleryIndex('not json'), []);
  assert.deepEqual(parseGalleryIndex(''), []);
  assert.deepEqual(parseGalleryIndex('[{"id":"a"}]'), [], '缺 file 的丢掉');
  assert.equal(parseGalleryIndex('[{"id":"a","file":"a.jpg"}]').length, 1);
});
t('当天序号往后排（不覆盖已有的）', () => {
  const entries = [{ file: '2026-10-14-01.jpg' }, { file: '2026-10-14-02.jpg' }, { file: '2026-10-13-01.jpg' }];
  assert.equal(nextSeq(entries, '2026-10-14'), 3);
  assert.equal(nextSeq(entries, '2026-10-15'), 1);
});
t('关键词过滤（理由 + 来源）', () => {
  const es = [
    { note: '夜海·仙女棒', from: 'private:1 #7' },
    { note: '他挑的这张', from: 'group:9 #88' },
  ];
  assert.equal(filterGallery(es, '仙女').length, 1);
  assert.equal(filterGallery(es, 'group:9').length, 1);
  assert.equal(filterGallery(es, '').length, 2);
  assert.equal(filterGallery(es, '没有').length, 0);
});
t('规则里写明理由必填、别什么都存', () => {
  assert.ok(GALLERY_RULE.includes('qq_gallery'));
  assert.ok(GALLERY_RULE.includes('理由是必须的'), '理由必填要写进规矩');
  assert.ok(/别什么都存|别只存/.test(GALLERY_RULE));
});

console.log(`\n  gallery 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);