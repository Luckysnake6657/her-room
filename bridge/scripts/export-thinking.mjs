// 把某个 QQ 会话的"思维链 + 动作"导出成可读的 Markdown，便于人工查看。
//
// 用法: node scripts/export-thinking.mjs <sessionId> <输出文件> [标题]
//
// 会话日志是【多帧 zstd】拼接：Node 的流式解压只读第一帧，必须按 magic(28 B5 2F FD) 切帧；
// 且文本正文挂在 stream 条目**自身**的 `texts` 数组上（没有中间的 chunk 层）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const sessionId = process.argv[2]
  ?? 'session-02056f69-3248-423a-be19-39619b9f8974';
const outPath = process.argv[3]
  ?? 'D:/deepseekharness/群聊思维链-session-02056f69.md';
const title = process.argv[4] ?? '群聊「这是好ow啊」思维链导出';

const dir = `C:/Users/zjin6/.dsh/sessions/--D-qq-bridge-state-agents--/${sessionId}`;
// 别写死 v3：升级到 v4 后同一个目录里 v3/v4 并存，v3 已经冻结不再追加
const file = sessionFileIn(dir);
if (!fs.existsSync(file)) { console.error('会话文件不存在:', file); process.exit(1); }

function loadRecords(path) {
  const buf = fs.readFileSync(path);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  }
  let text = '';
  for (let i = 0; i < offs.length; i++) {
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* skip */ }
  }
  const recs = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch { /* skip */ } }
  return { recs, frames: offs.length, bytes: buf.length };
}

const { recs, frames, bytes } = loadRecords(file);
const when = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '?');
const joinTexts = (c) => (Array.isArray(c.texts) ? c.texts.join('') : (c.text ?? ''));

// 脱敏：会话日志里带 agent token，导出前掩掉
const maskTokens = (s) => String(s ?? '')
  .replace(/[a-f0-9]{32}/gi, '<token>')
  .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"<token>"');

const out = [];
out.push(`# ${title}`);
out.push('');
out.push(`- 会话 ID：\`${sessionId}\``);
out.push(`- 源文件：\`${file}\``);
out.push(`- 大小：${Math.round(bytes / 1024)} KB（${frames} 个 zstd 帧，${recs.length} 条记录）`);
out.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
out.push('');

// 概况
const types = new Map();
for (const r of recs) types.set(r.type, (types.get(r.type) ?? 0) + 1);
const asst = recs.filter((r) => r.type === 'assistant/message');
let inTok = 0, outTok = 0, reasonTok = 0;
for (const m of asst) { const u = m.data?.usage ?? {}; inTok += u.inputTokens ?? 0; outTok += u.outputTokens ?? 0; reasonTok += u.reasoningTokens ?? 0; }
out.push('## 概况');
out.push('');
out.push('| 指标 | 值 |');
out.push('|---|---|');
out.push(`| 模型步数 | ${asst.length} |`);
out.push(`| 工具调用 | ${recs.filter((r) => r.type === 'tool/call').length} |`);
out.push(`| 输入 tokens | ${inTok.toLocaleString('zh-CN')} |`);
out.push(`| 输出 tokens | ${outTok.toLocaleString('zh-CN')}（含推理 ${reasonTok.toLocaleString('zh-CN')}） |`);
out.push(`| turn | start ${recs.filter((r) => r.type === 'turn/start').length} / end ${recs.filter((r) => r.type === 'turn/end').length} |`);
out.push('');

// 正文
out.push('---');
out.push('');
out.push('## 逐轮回放');
out.push('');
let stepNo = 0;
for (const r of recs) {
  if (r.type === 'user/message') {
    const c = r.data?.message?.content ?? r.data?.content;
    const str = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : '';
    out.push(`### 📥 桥接投递  ·  ${when(r.time)}`);
    out.push('');
    out.push('```text');
    out.push(maskTokens(str).slice(0, 4000));
    out.push('```');
    out.push('');
  } else if (r.type === 'assistant/message') {
    stepNo++;
    const u = r.data?.usage ?? {};
    out.push(`### 🤖 模型回合 #${stepNo}  ·  ${when(r.time)}  ·  推理 ${u.reasoningTokens ?? 0} / 输出 ${u.outputTokens ?? 0} tokens`);
    out.push('');
    for (const s of r.data?.stream ?? []) {
      const c = s ?? {};
      if (c.type === 'reasoning-chunks') {
        const t = maskTokens(joinTexts(c)).trim();
        if (t) { out.push('**【思维链】**'); out.push(''); out.push('> ' + t.replace(/\n/g, '\n> ')); out.push(''); }
      } else if (c.type === 'text-chunks') {
        const t = maskTokens(joinTexts(c)).trim();
        if (t) { out.push('**【对外文本草稿】**（reserved2 下不会自动发送，需工具）'); out.push(''); out.push('```text'); out.push(t); out.push('```'); out.push(''); }
      }
    }
  } else if (r.type === 'tool/call') {
    const name = String(r.data?.name ?? '').replace('mcp__snowluma__', '').replace('mcp__snowluma-host__', 'host:');
    let args = r.data?.arguments ?? '';
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep */ } }
    out.push(`- 🔧 **${name}**  ·  ${when(r.time)}`);
    out.push('  ```json');
    out.push('  ' + maskTokens(JSON.stringify(args)).slice(0, 700));
    out.push('  ```');
  } else if (r.type === 'tool/result') {
    const failed = r.data?.ok === false || r.data?.isError === true;
    out.push(`- ${failed ? '❌' : '✅'} 工具返回  ·  ${when(r.time)}`);
  }
}

import path from 'node:path';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n'), 'utf8');
console.log('已导出:', outPath);
console.log('大小:', Math.round(fs.statSync(outPath).size / 1024), 'KB');
console.log('模型回合数:', asst.length, '| 工具调用:', recs.filter((r) => r.type === 'tool/call').length);
console.log('tokens: 输入', inTok, '/ 输出', outTok, '（推理', reasonTok, '）');
