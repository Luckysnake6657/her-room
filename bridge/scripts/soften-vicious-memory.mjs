// 改掉她记忆里那条"过时"的规矩。
//
// 背景：用户（管理员）看过她说话后提了两点——太毒舌、「？」粘在句首。
// 而她的私聊记忆里存着一条**管理员早先自己定的**规矩：
//   「以后有人无缘无故骂我，就两条路选一条——① 阴阳怪气几句，② 一个「？」接一句傻逼」
// 这条每轮都会被注入，不改的话会一直跟新的【说话分寸】对着干。
// 所以按管理员的**新**要求重写它（是"更新"不是"删除"，历史脉络留着）。
//
// 用法：node scripts/soften-vicious-memory.mjs           # 只预览
//       node scripts/soften-vicious-memory.mjs --apply   # 真的改
import { readConsoleToken, BRIDGE_BASE } from './lib/console-token.mjs';

const APPLY = process.argv.includes('--apply');
const KEY = 'private:984776985';
const MARK = '以后有人无缘无故骂我';

const token = readConsoleToken();
if (!token) { console.error('读不到控制台令牌'); process.exit(2); }

const mem = await (await fetch(`${BRIDGE_BASE}/api/socialV2/memory?key=${encodeURIComponent(KEY)}`, {
  headers: { 'x-console-token': token },
})).json();

// 端点返回 { ok, key, category, formatted, raw }，原始列表在 raw 里
const raw = mem.raw ?? {};
const topics = (raw.activeTopics ?? []).map((t) => (typeof t === 'string' ? t : t?.text ?? ''));
const hit = topics.find((t) => String(t).includes(MARK));
if (!hit) {
  console.log('没找到那条规矩（可能已经改过了）。当前 activeTopics：');
  for (const t of topics) console.log('  -', String(t).slice(0, 90));
  process.exit(0);
}
console.log('找到旧规矩：\n  ' + hit + '\n');

const NEW = '19:34 有人@我骂脏话，我回了句「被雾子气到冲我撒是吧」。管理员后来又补了要求：嘴硬可以、'
  + '怼回去也可以，但**别毒舌到人身攻击**——不拿对方的身体、健康、家人、外貌、穷富开涮，'
  + '也不用扎人的反问。被骂就冷淡怼一句、或阴阳**他那句话**，不甩脏字、不升级、不追着打。';

if (NEW.length > 200) { console.error(`新文本 ${NEW.length} 字，超过 200 上限（接口会截断）`); process.exit(2); }
console.log(`新规矩（${NEW.length} 字）：\n  ${NEW}\n`);
if (!APPLY) { console.log('（预览模式，加 --apply 才会真的写）'); process.exit(0); }

const r = await fetch(`${BRIDGE_BASE}/api/socialV2/memory-update`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ key: KEY, category: 'activeTopic', oldContent: hit, newContent: NEW }),
});
console.log('HTTP', r.status);
console.log((await r.text()).slice(0, 300));
