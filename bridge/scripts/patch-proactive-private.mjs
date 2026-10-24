// Make the reserved2 "proactiveCheck" wake prompt chat-type aware:
// a private proactive ping must have a REASON to exist, otherwise stay silent —
// "群里安静了，抛个话题" is nonsense in a 1:1 chat.
import fs from 'node:fs';

const p = 'D:/qq-bridge/src/bridge.js';
let src = fs.readFileSync(p, 'utf8');
const before = src;

// The exact original one-liner (matched by its unique leading text).
const anchor = "      return `${base}【主动机会】${key}\\n原因：群里已经安静了一段时间";
const start = src.indexOf(anchor);
if (start < 0) throw new Error('proactiveCheck prompt line not found');
const lineEnd = src.indexOf('\n', start);
const originalLine = src.slice(start, lineEnd);

const PRIVATE_BRANCH = [
  "      if (key.startsWith('private:')) {",
  "        // 私聊主动：不是\"开话题\"，而是像朋友突然想起你。必须有由头，",
  "        // 否则宁可不动 —— 硬找话说比不说话更像客服。",
  "        return `${base}【主动机会】${key}\\n原因：你们私聊已经安静了一阵，这是一次你可以主动找他的机会。\\n这**不是**群聊那种\"抛个话题\"，而是像朋友突然想起对方，随手发一条。判断标准：\\n\\n**值得主动的情形**（有其一才开口）：\\n- 你刚看到/听到/想到某个东西，跟他有关，或你们之前聊过（例如刷到他在追的那部番出了新消息、他上次提过的考试/面试/那盆花）。\\n- 你想追一句上次没聊完的话（记忆里的 activeTopic / pendingThoughts）。\\n- 你情绪上确实想说点什么（刚看完一部片想吐槽、今天有点烦、突然很饿）。\\n- 现在是自然的问候时机（早上、深夜、周末），而且你们最近聊得还行。\\n\\n**不该主动的情形**（那就安静收尾）：\\n- 只是\"该说点什么了\"这种空落落的冲动 —— 没有由头就别发。\\n- 你刚发过消息、对方还没回（那是在等回复，不是在等机会）。\\n- 深夜且对方可能睡了、或对方最近明显在忙／情绪不好。\\n- 你只能说出\"在干嘛\"\"在吗\"这种没内容的话。\\n\\n**怎么发**：一条自然的短话，像随手打的，不要像\"来聊天吧\"。可以带着由头直接说（\"你上次说的那个我看完了\"），也可以只发一句状态（\"今天有点烦\"）。想分多条用 messages 数组。\\n如果一时想不到由头，先用 qq_memory_query 看看有没有能捡起来的话题；仍然没有，就安静收尾（qq_mark_read 或 qq_set_wake_config），**不要为了主动而主动**。`;",
  "      }",
].join('\n');

src = src.slice(0, start) + PRIVATE_BRANCH + '\n' + src.slice(lineEnd);

if (src === before) throw new Error('no change applied');
fs.writeFileSync(p, src, 'utf8');

console.log('patched proactive prompt');
console.log('原文行:', originalLine.trim().slice(0, 80) + '...');
console.log('字节:', before.length, '->', src.length);
console.log('含私聊分支:', src.includes("if (key.startsWith('private:')) {") ? '✅' : '❌');
