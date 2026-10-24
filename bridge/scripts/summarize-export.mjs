// 统计导出的思维链文件，给出内容概览（供人工快速定位）。
import fs from 'node:fs';

const p = process.argv[2] ?? 'D:/deepseekharness/群聊思维链-这是好ow啊.md';
const md = fs.readFileSync(p, 'utf8');
const lines = md.split('\n');

const turns = lines.filter((l) => l.startsWith('### 🤖 模型回合'));
const sends = lines.filter((l) => /🔧 \*\*qq_send_message\*\*|🔧 \*\*qq_send_sticker\*\*|🔧 \*\*qq_reply\*\*/.test(l));
const waits = lines.filter((l) => /🔧 \*\*qq_wait_for_messages\*\*/.test(l));
const marks = lines.filter((l) => /🔧 \*\*qq_mark_read\*\*/.test(l));
const lookups = lines.filter((l) => /🔧 \*\*(qq_get_recent_messages|qq_get_unread_messages|qq_get_message_images|qq_slang_query|qq_memory_query|qq_list_stickers)\*\*/.test(l));
const search = lines.filter((l) => /web_search|web_fetch/.test(l));
const tools = lines.filter((l) => /^- 🔧 \*\*/.test(l));

console.log('文件:', p);
console.log('大小:', Math.round(fs.statSync(p).size / 1024), 'KB，行数:', lines.length);
console.log('');
console.log('模型回合:', turns.length);
console.log('工具调用合计:', tools.length);
console.log('  · 发送消息/表情/引用:', sends.length);
console.log('  · 查看消息/图片/黑话/记忆:', lookups.length);
console.log('  · 联网搜索/抓取:', search.length);
console.log('  · 等待（判断对方说完没）:', waits.length);
console.log('  · 标记已读（选择潜水）:', marks.length);
console.log('');

// 思维链总字数
let reasoningChars = 0;
let inReason = false;
for (const l of lines) {
  if (l === '**【思维链】**') { inReason = true; continue; }
  if (inReason) {
    if (l.startsWith('> ')) reasoningChars += l.length - 2;
    else if (l.trim() === '') continue;
    else inReason = false;
  }
}
console.log('思维链正文合计约:', reasoningChars.toLocaleString('zh-CN'), '字符');
console.log('');
console.log('=== 回合一览（时间 / 推理token / 首个动作）===');
for (const [i, l] of turns.entries()) {
  const time = l.match(/·\s+(\d{4}\/\d+\/\d+ \d+:\d+:\d+)/)?.[1] ?? '?';
  const toks = l.match(/推理 (\d+)/)?.[1] ?? '?';
  console.log(`  #${String(i + 1).padStart(2)} ${time}  推理${toks}`);
}
