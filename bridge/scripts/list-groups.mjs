// Ask OneBot directly for the bot's group list, using the bridge's config
// credentials. Confirms a group number exists before whitelisting it.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
const { httpUrl, accessToken } = cfg.snowluma;

const res = await fetch(`${httpUrl}/get_group_list`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  },
  body: '{}',
  signal: AbortSignal.timeout(15000),
});
console.log('get_group_list ->', res.status);
const j = await res.json();
console.log('retcode:', j.retcode, '| status:', j.status);

const groups = Array.isArray(j.data) ? j.data : [];
console.log(`\n机器人在 ${groups.length} 个群里：`);
for (const g of groups) {
  console.log(`  ${g.group_id}  ${g.group_name ?? ''}`);
}

const target = String(process.argv[2] ?? '');
if (target) {
  const hit = groups.find((g) => String(g.group_id) === target);
  console.log(`\n目标群 ${target}: ${hit ? '✅ 存在 -> ' + (hit.group_name ?? '') : '❌ 不在列表里（机器人可能没加这个群）'}`);
}
