/**
 * 回归测试：文本文件编码探测。
 *
 * 真实事故（用户截图）：管理员发了 7.77MB 的日志 `1-26.txt`，她回
 *   「能看到了，但全是乱码」
 *   「这txt应该是GBK编码的，我这边按UTF-8读，除了那个链接一个字都对不上；
 *     你另存成UTF-8再切小份发，八兆的我只读到开头和结尾」
 * **她诊断对了**：中文 Windows 导出的日志大量是 GBK，而桥接原来一律
 * `buffer.toString('utf8')` —— 中文全变 U+FFFD。
 *
 * 顺带修的第二点：长文本原来只内联**开头** 6000 字符，而日志的异常堆栈在**结尾**。
 * 现在头 60% + 尾 40%，中间标注省略了多少字符。
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

// ── 用**已知的 GBK 字节**造样本（Node 没有内置 GBK 编码器，只能查表写死）──
// 先自检这些字节：如果我对不上，后面的断言就没有意义。
const GBK_BYTES = {
  中文: [0xd6, 0xd0, 0xce, 0xc4],
  错误: [0xb4, 0xed, 0xce, 0xf3],
  连接超时: [0xc1, 0xac, 0xbd, 0xd3, 0xb3, 0xac, 0xca, 0xb1],
  重试: [0xd6, 0xd8, 0xca, 0xd4],
};
console.log('\n[0] 先自检 GBK 样本字节（字节不对的话后面全是假结论）');
for (const [word, bytes] of Object.entries(GBK_BYTES)) {
  const decoded = new TextDecoder('gb18030').decode(Buffer.from(bytes));
  check(`GBK 字节 → ${word}`, decoded === word, `实际解出 ${JSON.stringify(decoded)}`);
}

const gbkLine = Buffer.concat([
  Buffer.from('2026-09-28 19:00:00 [ERROR] ', 'latin1'),
  Buffer.from(GBK_BYTES.错误), Buffer.from([0xa3, 0xba]),   // 全角冒号
  Buffer.from(GBK_BYTES.连接超时), Buffer.from([0x0a]),
]);

let nextBuffer = Buffer.alloc(0);
const bridge = await bridgeHarness({
  globals: { safeFetchAnyBuffer: async (url) => ({ statusCode: 200, url, buffer: nextBuffer }) },
});

try {
  const { fetchAndCacheQqFile, segmentsToText } = bridge;
  const get = (fileId, name) => fetchAndCacheQqFile({ fileId, name, url: 'https://x.invalid/f' }, undefined, { key: 'private:123' });

  console.log('\n[1] GBK 日志必须解对（这就是用户那个 1-26.txt）');
  nextBuffer = Buffer.concat(Array.from({ length: 3000 }, () => gbkLine));
  const gbk = await get('e1', '1-26.txt');
  check('识别为 gb18030/GBK', /gb18030|gbk/i.test(String(gbk.encoding)), String(gbk.encoding));
  check('中文解对了（不是乱码）', String(gbk.text).includes('错误'), JSON.stringify(String(gbk.text).slice(0, 80)));
  check('没有替换字符 U+FFFD', !String(gbk.text).includes('\uFFFD'));
  check('ASCII 部分也没坏', String(gbk.text).includes('2026-09-28 19:00:00'));

  console.log('\n[2] UTF-8 / BOM / UTF-16 都要认');
  nextBuffer = Buffer.from('2026-09-28 [INFO] 中文日志正常\n'.repeat(500), 'utf8');
  const utf8 = await get('e2', 'a.log');
  check('UTF-8 识别为 utf-8', String(utf8.encoding) === 'utf-8', String(utf8.encoding));
  check('UTF-8 内容正确', String(utf8.text).includes('中文日志正常'));

  nextBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM的中文\n'.repeat(100), 'utf8')]);
  const bom = await get('e3', 'b.log');
  check('UTF-8 BOM：识别为 utf-8', String(bom.encoding) === 'utf-8', String(bom.encoding));
  check('UTF-8 BOM：BOM 已去掉（正文不以 \\uFEFF 开头）', !String(bom.text).startsWith('\uFEFF'), JSON.stringify(String(bom.text).slice(0, 12)));
  check('UTF-8 BOM：内容正确', String(bom.text).includes('带BOM的中文'));

  // Windows 记事本"另存为 Unicode" = UTF-16LE + BOM（FF FE）
  nextBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('记事本存的中文\n'.repeat(100), 'utf16le')]);
  const u16 = await get('e4', 'c.log');
  check('UTF-16LE BOM：识别为 utf-16le', String(u16.encoding) === 'utf-16le', String(u16.encoding));
  check('UTF-16LE BOM：内容正确', String(u16.text).includes('记事本存的中文'), JSON.stringify(String(u16.text).slice(0, 40)));

  console.log('\n[3] 长文件：头 + 尾（日志的关键信息在结尾）');
  // 造一个"开头有标记、中间很长、结尾有异常堆栈"的日志
  const head = 'BEGIN-MARK 服务启动\n';
  const middle = '普通日志行，无关紧要的内容。\n'.repeat(2000);
  const tail = 'FATAL-EXCEPTION 数据库连接失败\n';
  nextBuffer = Buffer.from(head + middle + tail, 'utf8');
  const long = await get('e5', 'big.log');
  check('开头在', String(long.text).includes('BEGIN-MARK'), String(long.text).slice(0, 60));
  check('**结尾也在**（这是本次修的重点）', String(long.text).includes('FATAL-EXCEPTION'),
    JSON.stringify(String(long.text).slice(-120)));
  check('中间标注了省略了多少字符', /中间省略 \d+ 字符/.test(String(long.text)));
  check('总长度仍受 6000 字符预算约束', String(long.text).length < 6500, `len=${String(long.text).length}`);
  check('标记为已截断', long.truncated === true);

  console.log('\n[4] 扩展名不在白名单的 GBK 文本也要能认出来（looksLikeTextBuffer 的旧毛病）');
  nextBuffer = Buffer.concat(Array.from({ length: 400 }, () => gbkLine));
  const noExt = await get('e6', '日志导出');   // 没有扩展名
  check('无扩展名的 GBK 文本被认出是文本', !!noExt.text && String(noExt.text).includes('错误'),
    JSON.stringify({ enc: noExt.encoding, head: String(noExt.text ?? '').slice(0, 40) }));

  console.log('\n[5] 二进制不能被当文本（别把图片解成"人话"）');
  nextBuffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 0x00)]);
  const bin = await get('e7', '图片数据');
  check('含 NUL 的二进制不当文本', !bin.text, JSON.stringify(String(bin.text ?? '').slice(0, 40)));
  nextBuffer = Buffer.alloc(4096, 0xff);
  const bin2 = await get('e8', '乱码数据');
  check('全 0xFF 的垃圾不当文本', !bin2.text, JSON.stringify({ enc: bin2.encoding, head: String(bin2.text ?? '').slice(0, 40) }));

  console.log('\n[6] 编码信息要告诉她（免得她以为文件坏了）');
  nextBuffer = Buffer.concat(Array.from({ length: 200 }, () => gbkLine));
  const g2 = await get('e9', '1-26.txt');
  const segText = await segmentsToText([{ type: 'file', data: { file_id: 'e9', name: '1-26.txt', file_size: 1000 } }], {});
  check('消息里标注了非 UTF-8 编码', /gb18030|GBK/i.test(segText), segText.slice(0, 200));
  check('并且说明已经转码', /转码|编码/.test(segText), segText.slice(0, 200));
  check('正文确实是解对的中文', segText.includes('错误'), segText.slice(0, 300));
} finally {
  await bridge.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
