// What chunk types does the session stream actually record? Looking for model
// reasoning text vs. just token counts.
import fs from 'node:fs';

const lines = fs.readFileSync('D:/deepseekharness/session-dump.jsonl', 'utf8').split('\n').filter((l) => l.trim());
const recs = [];
for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* skip */ } }

const chunkTypes = new Map();
const blockTypes = new Map();
const deltas = new Map();
for (const r of recs) {
  if (r.type !== 'assistant/message') continue;
  for (const s of r.data?.stream ?? []) {
    const t = s?.chunk?.type ?? s?.type ?? '(none)';
    chunkTypes.set(t, (chunkTypes.get(t) ?? 0) + 1);
    if (s?.chunk?.blockType) blockTypes.set(s.chunk.blockType, (blockTypes.get(s.chunk.blockType) ?? 0) + 1);
    if (s?.chunk?.delta?.type) deltas.set(s.chunk.delta.type, (deltas.get(s.chunk.delta.type) ?? 0) + 1);
  }
}
console.log('stream chunk types :', [...chunkTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', '));
console.log('block types        :', [...blockTypes.entries()].map(([k, v]) => `${k}×${v}`).join(', '));
console.log('delta types        :', [...deltas.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '(无)');

console.log('\n=== assistant 消息的 content 块类型与文本 ===');
for (const r of recs) {
  if (r.type !== 'assistant/message') continue;
  const when = r.time ? new Date(r.time).toLocaleTimeString('zh-CN') : '?';
  const content = r.data?.message?.content ?? [];
  const desc = content.map((c) => {
    if (c.type === 'text') return `text(${(c.text ?? '').length}字): ${JSON.stringify((c.text ?? '').slice(0, 120))}`;
    if (c.type === 'tool-call' || c.type === 'tool_use') return `tool-call(${c.name ?? c.toolName ?? '?'})`;
    if (c.type === 'reasoning' || c.type === 'thinking') return `REASONING(${(c.text ?? c.reasoning ?? '').length}字)`;
    return c.type;
  });
  console.log(`\n[${when}] usage: reasoning=${r.data?.usage?.reasoningTokens ?? 0} output=${r.data?.usage?.outputTokens ?? 0} in=${r.data?.usage?.inputTokens ?? 0}`);
  for (const d of desc) console.log('   ' + d);
}

console.log('\n=== 有没有任何记录带 reasoning 正文 ===');
const probe = recs.find((r) => /reasoning/i.test(JSON.stringify(r)) && !/reasoningTokens/.test(JSON.stringify(r)));
console.log(probe ? '找到: ' + probe.type : '未找到：会话日志只记录 reasoningTokens 计数，未持久化思维链正文');
