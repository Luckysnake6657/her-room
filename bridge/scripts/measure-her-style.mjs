/**
 * 量她自己的说话方式（给"语气不对"这类投诉当尺子用）。
 *
 * 为什么单独有个脚本：管理员 2026-09-29 连着两次说语气不对，第二次点明是
 * 「说话语气变成一整句了，过度玩梗会令人厌烦的」。这种投诉如果只是"感觉"，
 * 改完也不知道有没有变好。这里把她**自己发过的消息**拿出来数三个指标：
 *   ① 逗号粘句率：含"汉字，汉字"（把两件事粘成一句）的比例 —— 他说的"一整句"；
 *   ② 长度分布：闲聊里中位数、>14 字的占比；
 *   ③ 调侃/嘱咐两类词的出现率（玩梗过度 / 妈妈味）。
 *
 * ⚠️ 基线是从 state/social-v2.json 留存的 recentMessages 里数的（每会话最多 100 条），
 * 所以是个**滚动样本**，不是全量。想要全量得靠 group-corpus（但那里只有别人说的话）。
 *
 * 用法：node scripts/measure-her-style.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_JSON = process.argv.includes('--json');
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

const st = read(path.join(ROOT, 'state', 'social-v2.json'));
const mine = [];
for (const [k, c] of Object.entries(st?.conversations ?? {})) {
  for (const m of (c.recentMessages ?? [])) if (m.isSelf) mine.push({ t: Number(m.time) || 0, k, txt: String(m.text ?? '') });
}
mine.sort((a, b) => a.t - b.t);

const chars = (s) => [...s].length;
const pct = (n) => Number(((n / Math.max(1, mine.length)) * 100).toFixed(1));
const commaJoined = mine.filter((x) => /[\u4e00-\u9fff][，,][\u4e00-\u9fff]/.test(x.txt));
const lens = mine.map((x) => chars(x.txt)).sort((a, b) => a - b);
const joke = mine.filter((x) => /哈哈|笑死|绷|损|嘴硬|你猜|哼|啧|行吧|哟|得了吧|离谱|憨|傻/.test(x.txt));
const nag = mine.filter((x) => /记得|别忘了|别又|早点|多吃|多喝|吃药|买药|带上|小心|照顾好|别熬夜|注意身体/.test(x.txt));
const info = mine.filter((x) => /：|——|第一|第二|因为|所以|也就是说/.test(x.txt));   // 信息类（逗号在这里是允许的）
// "旁观点评"（用户 2026-09-30："上下文理解能力还是有问题"那批）：
// 没 @ 人、不是问句、开头是"这/那/群里/快/真…"这种旁白口吻 → 像弹幕而不像参与。
const commentary = mine.filter((x) => !/@/.test(x.txt) && !/[?？]/.test(x.txt)
  && /^(这|那|群里|这里|快|真|确实|有点|感觉|看|难怪|原来|所以)/.test(x.txt.replace(/^\[[^\]]*\]/, '')));
// 分段对照：**今天** vs 更早 —— 改完要能看出有没有变好（滚动窗口本身会"洗掉"旧消息）
const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
const today = mine.filter((x) => x.t >= midnight.getTime());
const earlier = mine.filter((x) => x.t < midnight.getTime());
const rate = (list, re) => (list.length ? Number(((list.filter((x) => re.test(x.txt)).length / list.length) * 100).toFixed(1)) : null);
const burstOf = (list) => {
  let run = 1, best = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].t - list[i - 1].t <= 90000) run += 1; else { best = Math.max(best, run); run = 1; }
  }
  return list.length ? Math.max(best, run) : 0;
};
// 最长连发（相邻两条间隔 ≤ 90 秒算同一次连发）
let maxBurst = 0;
{
  let run = 1;
  for (let i = 1; i < mine.length; i++) {
    if (mine[i].t - mine[i - 1].t <= 90000) run += 1;
    else { maxBurst = Math.max(maxBurst, run); run = 1; }
  }
  maxBurst = Math.max(maxBurst, run);
}

const report = {
  样本: mine.length,
  时间跨度: mine.length ? `${new Date(mine[0].t).toLocaleString('zh-CN')} → ${new Date(mine[mine.length - 1].t).toLocaleString('zh-CN')}` : '-',
  逗号粘句率: pct(commaJoined.length),
  逗号粘句条数: commaJoined.length,
  长度中位: lens[Math.floor(lens.length / 2)] ?? 0,
  '超过14字占比': pct(mine.filter((x) => chars(x.txt) > 14).length),
  '不超过10字占比': pct(mine.filter((x) => chars(x.txt) <= 10).length),
  调侃类占比: pct(joke.length),
  嘱咐类占比: pct(nag.length),
  信息类占比: pct(info.length),
  旁观点评占比: pct(commentary.length),
  旁观点评条数: commentary.length,
  最长连发条数: maxBurst,
  最近逗号粘句: commaJoined.slice(-6).map((x) => `${new Date(x.t).toLocaleTimeString('zh-CN')} ${x.txt.replace(/\n/g, ' ').slice(0, 50)}`),
};

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`样本 ${report.样本} 条（${report.时间跨度}）`);
  console.log(`① 逗号粘句率（"汉字，汉字"）：**${report.逗号粘句率}%**（${report.逗号粘句条数} 条）  ← 他说的"一整句"`);
  console.log(`② 长度：中位 ${report.长度中位} 字 ｜ >14 字 ${report['超过14字占比']}% ｜ ≤10 字 ${report['不超过10字占比']}%`);
  console.log(`③ 调侃类 ${report.调侃类占比}% ｜ 嘱咐类 ${report.嘱咐类占比}% ｜ 信息类 ${report.信息类占比}%`);
  console.log(`④ 旁观点评 ${report.旁观点评占比}%（${report.旁观点评条数} 条，无@、非问句、旁白开头）｜ 最长连发 ${report.最长连发条数} 条`);
  {
    const comma = /[\u4e00-\u9fff][，,][\u4e00-\u9fff]/;
    const line = (label, list) => `${label}（${list.length} 条）：粘句 ${rate(list, comma) ?? '-'}% ｜ 旁观点评 ${rate(list, /^(这|那|群里|这里|快|真|确实|有点|感觉|看|难怪|原来|所以)/) ?? '-'}% ｜ 最长连发 ${burstOf(list)}`;
    console.log('\n【分段对照】');
    console.log('  ' + line('今天', today));
    console.log('  ' + line('今天以前', earlier));
  }
  console.log(`   基线（2026-09-29 改之前）：逗号粘句 45.6%，中位 12 字，>14 字 36.8%`);
  console.log('最近几条"逗号粘句"：');
  for (const x of report.最近逗号粘句) console.log('  ' + x);
}
