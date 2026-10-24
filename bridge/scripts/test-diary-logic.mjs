/**
 * 她日记本的纯逻辑测试（2026-10-14，管理员提到的"进阶 1"）。
 *
 * 最要紧的一条：**appendDiary 只能追加，不许改动已有内容** —— 那是日记的立身之本。
 */
import assert from 'node:assert/strict';
import {
  DIARY_RULE, DIARY_MAX_CHARS, diaryDate, diaryFileName, isValidDiaryDate,
  cleanDiaryText, shouldWriteDiary, formatDiaryEntry, diaryHeader, appendDiary,
  parseDiaryEntries, filterDiaryEntries,
} from '../src/diary.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const at = (s) => new Date(`2026-10-14T${s}:00`);

t('日期格式是 YYYY-MM-DD', () => {
  assert.match(diaryDate(at('09:30')), /^\d{4}-\d{2}-\d{2}$/);
});
t('日期能当文件名（不含路径分隔符）', () => {
  const f = diaryFileName(diaryDate(at('09:30')));
  assert.ok(!f.includes('/') && !f.includes('\\'), '文件名里不能有路径分隔符');
  assert.match(f, /\.md$/);
});
t('isValidDiaryDate 挡住路径注入', () => {
  assert.equal(isValidDiaryDate('2026-10-14'), true);
  assert.equal(isValidDiaryDate('../../etc/passwd'), false);
  assert.equal(isValidDiaryDate('2026-10-14/../x'), false);
  assert.equal(isValidDiaryDate(''), false);
});
t('cleanDiaryText 去首尾空白、折叠空行', () => {
  assert.equal(cleanDiaryText('  你好  '), '你好');
  assert.equal(cleanDiaryText('a\n\n\n\nb'), 'a\n\nb');
});
t('空的不给写', () => {
  assert.equal(shouldWriteDiary('   ').ok, false);
  assert.equal(shouldWriteDiary('').reason, 'empty');
});
t('正常一条给写', () => {
  const r = shouldWriteDiary('今天还行。');
  assert.equal(r.ok, true);
  assert.equal(r.text, '今天还行。');
});
t('太长的拒（让她自己拆）', () => {
  const r = shouldWriteDiary('啊'.repeat(DIARY_MAX_CHARS + 1));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-long');
  assert.ok(r.hint.includes('拆'), '要提示她拆开写');
});
t('当天写太多条也拒', () => {
  const r = shouldWriteDiary('再来一条', { todayCount: 8, maxPerDay: 8 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-many');
});
t('条目带 HH:MM 时间戳', () => {
  const e = formatDiaryEntry('内容', at('07:05'));
  assert.ok(e.includes('## 07:05'), e);
  assert.ok(e.includes('内容'));
});
t('新文件有日期抬头', () => {
  assert.match(diaryHeader('2026-10-14'), /^# 2026-10-14/);
});
// ★ 核心不变量
t('★ 追加不改动已有内容（逐字符比对）', () => {
  const first = appendDiary('', '第一条', at('08:00'));
  const second = appendDiary(first, '第二条', at('09:00'));
  assert.ok(second.startsWith(first.replace(/\s*$/, '\n')), '已有的字一个都不许变');
  assert.ok(second.includes('第一条') && second.includes('第二条'));
});
t('★ 追加不会丢字（长度只增不减）', () => {
  let s = appendDiary('', 'a'.repeat(10), at('01:00'));
  const before = s.length;
  s = appendDiary(s, 'b'.repeat(10), at('02:00'));
  assert.ok(s.length > before);
  assert.ok(s.includes('a'.repeat(10)) && s.includes('b'.repeat(10)));
});
t('★ 同一天多次写＝多条，不覆盖', () => {
  let s = appendDiary('', '一', at('01:00'));
  s = appendDiary(s, '二', at('02:00'));
  s = appendDiary(s, '三', at('03:00'));
  assert.equal(parseDiaryEntries(s).length, 3);
});
t('parseDiaryEntries 按时间抽出来', () => {
  const s = appendDiary(appendDiary('', '早上的事', at('08:30')), '晚上的事', at('21:15'));
  const e = parseDiaryEntries(s);
  assert.equal(e.length, 2);
  assert.equal(e[0].time, '08:30');
  assert.equal(e[0].text, '早上的事');
  assert.equal(e[1].time, '21:15');
});
t('parseDiaryEntries 不把日期抬头当内容', () => {
  const e = parseDiaryEntries(diaryHeader('2026-10-14') + appendDiary('', '正文', at('10:00')));
  assert.equal(e.length, 1);
  assert.equal(e[0].text, '正文');
});
t('关键词过滤（大小写不敏感）', () => {
  const s = appendDiary(appendDiary('', '今天很暖和', at('10:00')), '他提了 VRChat', at('11:00'));
  const e = parseDiaryEntries(s);
  assert.equal(filterDiaryEntries(e, '暖和').length, 1);
  assert.equal(filterDiaryEntries(e, 'vrchat').length, 1);
  assert.equal(filterDiaryEntries(e, '不存在').length, 0);
  assert.equal(filterDiaryEntries(e, '').length, 2, '空关键词=不过滤');
});
t('规则里写明只追加、改不了删不掉', () => {
  assert.ok(DIARY_RULE.includes('qq_write_diary') && DIARY_RULE.includes('qq_read_diary'));
  assert.ok(/改不了|删不掉/.test(DIARY_RULE), '要让她知道写进去就改不了');
  assert.ok(DIARY_RULE.includes('不是工作汇报'), '要说明写的是自己想记的');
});

console.log(`\n  diary 逻辑：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);