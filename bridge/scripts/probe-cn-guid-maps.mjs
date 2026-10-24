// 查看 query_tool.json 里 heroList / mapList 的结构，用于把 GUID 翻成名字。
import fs from 'node:fs';

const p = 'D:/Overstats/overstats/res/query_tool.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

for (const key of ['heroList', 'mapList']) {
  const list = j[key];
  console.log(`=== ${key} (${Array.isArray(list) ? list.length : typeof list}) ===`);
  if (Array.isArray(list) && list.length) {
    console.log('  第一条全部字段:');
    console.log('  ' + JSON.stringify(list[0], null, 1).split('\n').join('\n  '));
    console.log('  前 6 条的 name/guid:');
    list.slice(0, 6).forEach((h) => {
      console.log('    ' + JSON.stringify({ name: h.name, guid: h.heroGuid || h.mapGuid || h.guid || h.id }));
    });
  }
  console.log('');
}

// 验证：用对局里的两个 GUID 反查
const samples = {
  mapGuid: '576460752303425122',
  heroGuid: '207165582859043469',
};
console.log('=== 反查验证 ===');
for (const [kind, guid] of Object.entries(samples)) {
  const list = kind === 'mapList' ? j.mapList : j.heroList;
  const key = kind === 'mapList' ? 'mapGuid' : 'heroGuid';
  const hit = (list || []).find((x) => String(x[key] || x.guid || x.id || '') === guid);
  console.log(`  ${kind} ${guid} -> ${hit ? hit.name : '(未命中，检查字段名)'}`);
}
