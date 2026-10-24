// 验证：所有收藏表情都能提取出 SnowLuma 要的 32 位 hex emoji_id
import fs from 'node:fs';

const raw = fs.readFileSync('D:/qq-bridge/state/stickers.json', 'utf8').replace(/^\uFEFF/, '');
const entries = JSON.parse(raw);

// 复刻 bridge 里的提取逻辑
const extract = (entry) => /^[0-9A-Fa-f]{32}$/.test(String(entry.md5 || '').trim())
  ? String(entry.md5).trim().toUpperCase()
  : (String(entry.id || '').match(/([0-9A-Fa-f]{32})/) || [])[1]?.toUpperCase() || '';

let okByMd5 = 0, okByFallback = 0, fail = 0;
const sample = [];
for (const e of entries) {
  const byMd5 = /^[0-9A-Fa-f]{32}$/.test(String(e.md5 || '').trim());
  const id = extract(e);
  if (byMd5) okByMd5++;
  else if (id) okByFallback++;
  else { fail++; if (sample.length < 3) sample.push(e); }
}
console.log(`总数 ${entries.length}`);
console.log(`  ✅ 用 md5 直接取到:      ${okByMd5}`);
console.log(`  ✅ 从 id 兜底取到:       ${okByFallback}`);
console.log(`  ❌ 取不到（会退回发图片）: ${fail}`);
if (sample.length) console.log('  取不到的样本: ' + JSON.stringify(sample.map((e) => ({ id: e.id, md5: e.md5 }))));

// SnowLuma 校验规则对照
console.log('\n=== SnowLuma 校验规则 ===');
const re = /^[0-9a-fA-F]{32}$/;
let pass = 0;
for (const e of entries) if (re.test(extract(e))) pass++;
console.log(`  通过 SnowLuma emojiId 校验的: ${pass}/${entries.length}`);

console.log('\n=== 发送时会构造的 image 段样本（前 3 条）===');
for (const e of entries.slice(0, 3)) {
  const emojiId = extract(e);
  console.log('  ' + JSON.stringify({
    type: 'image',
    data: { file: 'base64://<图片字节>', emoji_id: emojiId, emoji_package_id: 0, summary: e.desc || '' }
  }));
}
