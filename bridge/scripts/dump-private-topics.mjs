import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const c = st.conversations['private:984776985'];
const show = (label, v) => {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(v, null, 1).replace(/\\ud[89ab][0-9a-f]{2}/gi, (m) => `【${m}】`));
};
show('activeTopics', c.activeTopics);
show('memberImpressions', c.memberImpressions);
console.log('\n--- 全文件是否有 emoji 紧邻截断点 ---');
for (const t of c.activeTopics) {
  console.log(`${t.at || ''} | src=${t.source || '-'} | ${JSON.stringify(t.text || t.content || t)}`);
}
