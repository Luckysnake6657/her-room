// 统计每个会话**实际**的唤醒与发言频率，找出频率到底被什么推高。
// 数据来自 state/social-v2.json 的 wakeTimes / sendTimes（桥接自己记的时间戳）。
import fs from 'node:fs';

const st = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const now = Date.now();
const HOUR = 3600 * 1000;

function rate(times, windowMs) {
  const list = (Array.isArray(times) ? times : []).filter((t) => Number(t) > now - windowMs);
  return list.length;
}

console.log('=== 每个会话：最近 1 小时 / 6 小时 / 24 小时 的唤醒与发言 ===\n');
console.log('会话'.padEnd(24), '唤醒(1h/6h/24h)'.padStart(20), '发言(1h/6h/24h)'.padStart(20), '  模式/概率');
for (const [key, c] of Object.entries(st.conversations || {})) {
  const w = [rate(c.wakeTimes, HOUR), rate(c.wakeTimes, 6 * HOUR), rate(c.wakeTimes, 24 * HOUR)];
  const s = [rate(c.sendTimes, HOUR), rate(c.sendTimes, 6 * HOUR), rate(c.sendTimes, 24 * HOUR)];
  const wc = c.wakeConfig || {};
  console.log(
    key.padEnd(24),
    `${w[0]} / ${w[1]} / ${w[2]}`.padStart(20),
    `${s[0]} / ${s[1]} / ${s[2]}`.padStart(20),
    `  ${wc.mode || '-'} p=${wc.probability ?? '-'} infinite=${wc.infinite ?? '-'}`,
  );
}

console.log('\n=== 唤醒原因分布（按 lastWakeReason 计数不准，改看 wakeTimes 总量）===');
const lead = st.conversations?.['private:984776985'];
if (lead) {
  const today = (lead.wakeTimes || []).filter((t) => t > now - 12 * HOUR);
  console.log(`private 最近 12 小时唤醒 ${today.length} 次`);
  // 相邻唤醒间隔分布
  const sorted = [...today].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => (t - sorted[i]) / 60000).filter((g) => g < 240);
  if (gaps.length) {
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`  相邻唤醒间隔：平均 ${avg.toFixed(1)} 分钟，最短 ${Math.min(...gaps).toFixed(1)} 分钟`);
    const buckets = { '<2min': 0, '2-5min': 0, '5-15min': 0, '15-60min': 0 };
    for (const g of gaps) {
      if (g < 2) buckets['<2min']++;
      else if (g < 5) buckets['2-5min']++;
      else if (g < 15) buckets['5-15min']++;
      else buckets['15-60min']++;
    }
    console.log('  间隔分布：', JSON.stringify(buckets));
  }
}
