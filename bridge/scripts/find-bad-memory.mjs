// 找出状态里存了"孤立代理项"的记忆条目（emoji 被截断留下的半个字符）。
import fs from 'node:fs';
import path from 'node:path';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const st = JSON.parse(fs.readFileSync(path.join('state', 'social-v2.json'), 'utf8'));

let n = 0;
for (const [key, v] of Object.entries(st.conversations || {})) {
  const cm = v.coreMemory || {};
  const lists = [['topics', cm.topics], ['thoughts', cm.thoughts], ['impressions', cm.impressions], ['archived', cm.archived]];
  console.log(`\n=== ${key} ===`);
  for (const [name, list] of lists) {
    if (!Array.isArray(list)) { console.log(`  ${name}: (无)`); continue; }
    console.log(`  ${name}: ${list.length} 条`);
    for (const item of list) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      if (LONE.test(text)) {
        n++;
        console.log(`    ★ 坏: ${text.slice(0, 160)}`);
      }
    }
  }
}
console.log(`\n共 ${n} 条含孤立代理项`);
