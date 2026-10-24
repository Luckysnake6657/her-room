import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
console.log('顶层键:', Object.keys(st).join(', '));
const first = Object.entries(st.conversations || {})[0];
if (first) {
  console.log('\n会话:', first[0]);
  for (const [k, v] of Object.entries(first[1])) {
    const t = Array.isArray(v) ? `数组(${v.length})` : typeof v;
    console.log(`  ${k}: ${t}${typeof v === 'string' ? ' = ' + v.slice(0, 60) : ''}`);
  }
}
// 在整份 JSON 文本里直接搜孤立代理项的转义形式
const raw = fs.readFileSync('state/social-v2.json', 'utf8');
const hits = raw.match(/\\ud[89ab][0-9a-f]{2}/gi) || [];
console.log(`\n原始文本里的代理项转义数量: ${hits.length}`, hits.slice(0, 8).join(' '));
const lone = /\ud[89ab][0-9a-f]{2}(?!\ud[c-f])/i.test(raw.replace(/\\u(d[89ab][0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))));
console.log('原始文本含孤立代理项:', lone);
