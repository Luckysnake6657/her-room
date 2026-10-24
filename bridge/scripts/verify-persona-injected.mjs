// Verify the persona card reached the QQ session by searching the DSH session
// log for card-only strings. Handles multi-frame zstd (zstd -d style streams),
// which zstdDecompressSync only partially decodes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2]
  ?? 'C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/session-3ae28176-d4b5-473b-b9d8-2c96a86e2ce3';

if (!fs.existsSync(dir)) {
  console.error('session dir not found:', dir);
  process.exit(1);
}
console.log('session dir:', dir);
console.log('files:', fs.readdirSync(dir).join(', '));

const markers = [
  '小鲸鱼（活人版）',
  '先反应，后内容',
  'AI 味黑名单',
  '蓝发鲸鱼尾巴',
  '你都想问别人了',
  '朋友关系',
];

async function decompressAll(file) {
  const full = path.join(dir, file);
  const buf = fs.readFileSync(full);
  if (!(buf.length > 4 && buf.readUInt32LE(0) === 0xfd2fb528)) {
    return buf.toString('utf8');
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    const s = zlib.createZstdDecompress();
    s.on('data', (c) => chunks.push(c));
    s.on('end', resolve);
    s.on('error', reject);
    s.end(buf);
  });
  return Buffer.concat(chunks).toString('utf8');
}

for (const f of fs.readdirSync(dir)) {
  if (!/\.(zstd|jsonl)$/.test(f)) continue;
  let text;
  try {
    text = await decompressAll(f);
  } catch (e) {
    console.log(`${f}: 解压失败 ${e.message}`);
    continue;
  }
  console.log(`\n=== ${f} -> ${text.length} 字符 ===`);
  let hit = 0;
  for (const m of markers) {
    const n = text.split(m).length - 1;
    if (n > 0) hit++;
    console.log(`  ${n > 0 ? '✅' : '❌'} ${m}  x${n}`);
  }
  console.log(hit > 0
    ? `  => 角色卡确实注入（命中 ${hit}/${markers.length}）`
    : '  => 未找到角色卡标记');

  if (hit > 0) {
    const i = text.indexOf('先反应，后内容');
    if (i > 0) console.log('\n  片段: ...' + text.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' ') + '...');
  }
}
