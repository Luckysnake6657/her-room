// Print the model's full reasoning chain from a DSH session log.
//
// Storage detail: each stream entry is a chunk whose text lives in `chunk.texts`
// (an array of tiny fragments, with `chunk.dt` holding per-fragment timings) —
// not in a single string field.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

// 位置参数优先；没给就从默认会话目录里挑**活的那个**文件
// （升级后 v3/v4 并存，写死 v3 会一直回放升级前冻结的思维链）
const file = process.argv[2]
  ?? sessionFileIn('C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/session-84a3bb26-2819-4892-b770-15f8264290ee');

const buf = fs.readFileSync(file);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
}
let text = '';
for (let i = 0; i < offs.length; i++) {
  const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
  try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* skip */ }
}
const recs = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const when = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN') : '?');
const joinTexts = (c) => (Array.isArray(c.texts) ? c.texts.join('') : (c.text ?? ''));

console.log('============================ 思维链回放 ============================\n');

for (const r of recs) {
  if (r.type === 'user/message') {
    const c = r.data?.message?.content ?? r.data?.content;
    const str = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : '';
    const tail = str.length > 900 ? '…\n' + str.slice(-700) : str;
    console.log(`\n\n---------------- 收到桥接投递 ${when(r.time)} ----------------`);
    console.log(tail.trim());
  }

  if (r.type === 'assistant/message') {
    const usage = r.data?.usage ?? {};
    console.log(`\n\n########## 模型回合 ${when(r.time)}   reasoning=${usage.reasoningTokens ?? 0} tokens, 输出=${usage.outputTokens ?? 0} tokens ##########`);
    for (const s of r.data?.stream ?? []) {
      // 注意：stream 条目本身就是 chunk（字段直接挂在 s 上，没有 s.chunk 这一层）。
      const c = s ?? {};
      if (c.type === 'reasoning-chunks') {
        console.log('\n┌─ 思维链 ─────────────────────────────');
        console.log(joinTexts(c).trim());
        console.log('└──────────────────────────────────────');
      } else if (c.type === 'text-chunks') {
        const t = joinTexts(c).trim();
        if (t) {
          console.log('\n┌─ 对外文本（不自动发送，需工具）──────');
          console.log(t);
          console.log('└──────────────────────────────────────');
        }
      } else if (c.type === 'tool-call-chunks') {
        console.log('\n┌─ 工具调用 ───────────────────────────');
        console.log(joinTexts(c).trim() || '(参数在 tool/call 记录里)');
        console.log('└──────────────────────────────────────');
      }
    }
  }

  if (r.type === 'tool/call') {
    const name = String(r.data?.name ?? r.data?.toolName ?? '?').replace('mcp__snowluma__', '');
    let args = r.data?.arguments ?? r.data?.args ?? '';
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep */ } }
    console.log(`\n  >>> ${when(r.time)} 调用 ${name}  ${JSON.stringify(args).slice(0, 260)}`);
  }
  if (r.type === 'tool/result') {
    const failed = r.data?.ok === false || r.data?.isError === true;
    console.log(`  <<< ${when(r.time)} 返回 ${failed ? '❌ 失败' : '✅ 成功'}`);
  }
}
