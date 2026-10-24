/**
 * 回归测试：文件下载上限分档 + 报错文案。
 *
 * 用户截图里发了个 **7.77MB 的 `1-26.txt`**（日志文件），结果她读不到——
 * 因为 `fetchAndCacheQqFile` 原来对所有非 Office 文件都用 4MB 上限，
 * 而 `.txt` 恰恰是最该能读的东西（正文只内联前 6000 字符，大文件根本不影响上下文）。
 *
 * 顺手修的另一处：safe-fetch 的报错写死成「**图片**超过大小限制」，
 * 实测日志里出现过 `下载失败 xxx.mp4：图片超过大小限制（4194304 字节）` ——
 * 看日志的人会以为在修图片的问题。
 *
 * 分档：
 *   Office 文档（ppt/doc/xls/odf）  32MB
 *   文本类（txt/log/md/代码…）      16MB
 *   其它（视频/压缩包/未知）          4MB
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const MB = 1024 * 1024;

// 假下载层：**复刻 safe-fetch 的上限行为**（超了才抛，不然测不出分档）
let nextBuffer = Buffer.alloc(0);
let lastCap = 0;
const bridge = await bridgeHarness({
  globals: {
    safeFetchAnyBuffer: async (url, cap) => {
      lastCap = cap;
      if (nextBuffer.length > cap) {
        throw new Error(`内容超过下载上限（${cap} 字节，实际已超过 ${nextBuffer.length} 字节）`);
      }
      return { statusCode: 200, url, buffer: nextBuffer };
    },
  },
});

try {
  const { fetchAndCacheQqFile } = bridge;
  const get = (fileId, name) => fetchAndCacheQqFile({ fileId, name, url: 'https://x.invalid/f' }, undefined, { key: 'private:123' });

  console.log('\n[1] 7.77MB 的日志 .txt 必须能读（用户截图里就是它读不到）');
  // 造一个和真实文件同量级的内容
  nextBuffer = Buffer.from('2026-09-28 19:00:00 [INFO] 一行日志内容\n'.repeat(210000), 'utf8');
  const txt = await get('t1', '1-26.txt');
  check(`文件确实超过旧的 4MB 上限（${(nextBuffer.length / MB).toFixed(2)} MB）`, nextBuffer.length > 4 * MB);
  check('文本文件走 16MB 档', lastCap === 16 * MB, `cap=${(lastCap / MB).toFixed(0)}MB`);
  check('读取成功（不再"读取失败"）', !txt.error && !!txt.text, JSON.stringify({ e: txt.error }));
  check('正文截到 6000 字符级别并标注省略',
    txt.text.length > 1000 && /中间省略 \d+ 字符/.test(txt.text) && txt.truncated === true,
    `len=${txt.text?.length}`);
  check('原始 buffer 已释放（不然缓存很快吃满）', txt.buffer === null);

  console.log('\n[2] Office 文档走 32MB 档');
  nextBuffer = Buffer.alloc(20 * MB, 0x41);
  const pdf = await get('d1', '论文.pdf');
  check('PDF 走 32MB 档', lastCap === 32 * MB, `cap=${(lastCap / MB).toFixed(0)}MB`);
  check('20MB 的 PDF 能下载（提取另说，至少不是"下载失败"）', !/超过下载上限/.test(String(pdf.error ?? '')), String(pdf.error));

  console.log('\n[3] 其它类型 12MB 档（2026-10-14 从 4MB 放宽：真正受益的是大截图/长图）');
  nextBuffer = Buffer.alloc(8 * MB, 0x00);
  const mp4 = await get('v1', '录屏.mp4');
  check('其它类型走 12MB 档', lastCap === 12 * MB, `cap=${(lastCap / MB).toFixed(0)}MB`);
  check('8MB 的视频现在能收下（不再"读取失败"）', !mp4.error, String(mp4.error));
  nextBuffer = Buffer.alloc(20 * MB, 0x00);
  const bigMp4 = await get('v2', '录像.mp4');
  check('20MB 的视频仍被拒（超过 12MB 档）', !!bigMp4.error, JSON.stringify(bigMp4).slice(0, 120));
  check('报错文案不再写"图片"（那是视频文件）', !/图片/.test(String(bigMp4.error)), String(bigMp4.error));
  check('报错里带上限与实际大小的数字', /12582912|超过下载上限/.test(String(bigMp4.error)), String(bigMp4.error));
  // ★ 放宽的真正理由：图片是她**看得懂**的东西，大截图/长图原来卡在 4MB 直接读不了
  check('视频超限的提示要说人话（她看不到视频内容，别让他以为再放宽点就能用）',
    /看不到内容/.test(String(bigMp4.error)), String(bigMp4.error));
  nextBuffer = Buffer.alloc(9 * MB, 0x89);
  const bigPng = await get('p1', '长截图.png');
  check('9MB 的大截图能收（这才是这次放宽的实际收益）', !bigPng.error, String(bigPng.error));

  console.log('\n[4] 超过各自档位上限时，报的是"下载上限"而不是"图片"');
  nextBuffer = Buffer.alloc(40 * MB, 0x41);
  const huge = await get('d2', '超大课件.pptx');
  check('40MB 的 pptx 被拒（32MB 档）', !!huge.error, String(huge.error));
  check('文案准确', /超过下载上限/.test(String(huge.error)) && !/图片/.test(String(huge.error)), String(huge.error));

  console.log('\n[5] 文本文件的 buffer 释放只针对文本；文档要留着（按需看图要用）');
  // 注意：全 0x41 的 buffer 会被 looksLikeTextBuffer 判成**文本**（释放 buffer 是对的）。
  // 要真的走文档分支，得给一个带 NUL 的 ZIP 头（这样才不会被当文本）。
  nextBuffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
  const doc = await get('d3', '坏课件.pptx');
  check('文档即使取字失败也保留 buffer（供按需看图重试）',
    Buffer.isBuffer(doc.buffer) && doc.buffer.length === 64,
    `buffer=${doc.buffer === null ? 'null' : (doc.buffer?.length ?? typeof doc.buffer)} err=${doc.officeError ?? doc.error ?? '-'}`);
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
