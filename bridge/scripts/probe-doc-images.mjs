// 看真实文档里内嵌了多少图、多大、什么格式 —— 决定"送几张给她看"的策略。
// 用法：node scripts/probe-doc-images.mjs <文件…>
import fs from 'node:fs';
import path from 'node:path';
import { readZipDirectory, readZipEntry } from '../src/office-extract-worker.mjs';

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
for (const f of process.argv.slice(2)) {
  if (!fs.existsSync(f)) { console.log(`❌ 不存在：${f}`); continue; }
  const buf = fs.readFileSync(f);
  console.log('='.repeat(76));
  console.log(`${path.basename(f)}  ${(buf.length / 1024).toFixed(0)} KB`);
  let dir;
  try { dir = readZipDirectory(buf); } catch (e) { console.log('  不是 ZIP：', e.message); continue; }
  const media = dir.filter((e) => /(^|\/)(ppt|word|xl)\/media\//i.test(e.name) && IMG_RE.test(e.name));
  const total = media.reduce((n, e) => n + e.uncompressedSize, 0);
  console.log(`  内嵌图片 ${media.length} 张，合计 ${(total / 1024 / 1024).toFixed(2)} MB（解压后）`);
  // 幻灯片顺序 → 每页引用了哪些图（靠 rels）
  const rels = dir.filter((e) => /_rels\/slide\d+\.xml\.rels$/i.test(e.name));
  console.log(`  幻灯片 rels 文件 ${rels.length} 个`);
  const bySize = media.map((e) => ({ n: e.name.split('/').pop(), kb: e.uncompressedSize / 1024 }))
    .sort((a, b) => b.kb - a.kb);
  console.log('  最大的 8 张：', bySize.slice(0, 8).map((x) => `${x.n}(${x.kb.toFixed(0)}KB)`).join(' '));
  console.log('  最小的 5 张：', bySize.slice(-5).map((x) => `${x.n}(${x.kb.toFixed(1)}KB)`).join(' '));
  if (rels.length) {
    const first = readZipEntry(buf, rels[0]);
    if (first) {
      const refs = [...first.toString('utf8').matchAll(/Target="([^"]*media\/[^"]+)"/g)].map((m) => m[1]);
      console.log(`  ${rels[0].name} 引用的图：`, refs.join(' ') || '（无）');
    }
  }
}
