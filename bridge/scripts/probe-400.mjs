// 对照实验：定位新会话为什么 INVALID_REQUEST(400)。
//
// 建一个和 QQ 会话**同 preset（qq-chat-v2）、同工作目录**的独立会话，分别发：
//   ① 一句无害短消息  → 若正常，说明 preset/工具面/模型参数没问题；
//   ② 那坨"群聊黑话表"正文 → 若 400，说明是**内容**被拒。
// 结果不靠 WebSocket 事件流判断，而是**直接读会话文件里的 error 帧**
// （DSH 会把 turn 结束原因落盘，见 scripts/find-session-errors.mjs 的同款解析）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { sessionFileIn } from './session-file.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const AGENTS_DIR = 'D:\\qq-bridge\\state\\agents';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function launchToken() {
  const d = path.join(os.homedir(), '.dsh', 'guard', 'logs');
  try {
    const files = fs.readdirSync(d).filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(d, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { n } of files) {
      try { const m = fs.readFileSync(path.join(d, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch {}
    }
  } catch {}
  return '';
}

const slug = (dir) => `--${String(dir).replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`;
function sessionFile(sid) {
  // 这些临时测试会话也走同一套存储：写死 v3 会在升级后读到已冻结的旧文件
  return sessionFileIn(path.join(process.env.USERPROFILE, '.dsh', 'sessions', slug(AGENTS_DIR), sid));
}
function readFrames(sid) {
  const f = sessionFile(sid);
  if (!fs.existsSync(f)) return [];
  const buf = fs.readFileSync(f);
  const starts = [];
  let idx = buf.indexOf(MAGIC);
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')); } catch {}
  }
  return out;
}
/** 从第 fromIdx 帧开始找 turn 结束原因 */
function lastTurnReason(sid, fromIdx = 0) {
  const frames = readFrames(sid);
  for (let i = frames.length - 1; i >= fromIdx; i--) {
    if (!frames[i].includes('"turn/end"')) continue;
    try {
      const obj = JSON.parse(frames[i]);
      const reason = obj?.data?.reason;
      if (reason) return reason.kind === 'error'
        ? { ok: false, err: reason?.error?.message ?? JSON.stringify(reason).slice(0, 200) }
        : { ok: true };
    } catch {}
  }
  return { ok: null, err: '没有找到 turn 结束帧（可能还在跑）' };
}

const token = launchToken();
if (!token) { console.error('拿不到 DSH launch token'); process.exit(1); }
const r0 = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = r0.headers.get('set-cookie')?.split(';')[0];
if (!cookie) { console.error('DSH 认证失败'); process.exit(1); }

async function rpc(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: { message: text.slice(0, 200) } }; }
}

const wsRes = await rpc('workspace/create', { request: { path: AGENTS_DIR } });
const wsId = wsRes?.result?.value?.workspace?.workspaceId ?? wsRes?.value?.workspace?.workspaceId;
const scRes = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: 'qq-chat-v2' } });
const sc = scRes?.result ?? scRes;
if (!sc?.ok) { console.error('建会话失败:', JSON.stringify(sc).slice(0, 300)); process.exit(1); }
const sid = sc.value.sessionId;
console.log('测试会话:', sid);
const smRes = await rpc('session/selectModel', { request: { sessionId: sid, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('模型     :', JSON.stringify((smRes?.result ?? smRes)?.value?.selected ?? '?'));

async function ask(label, text) {
  const before = readFrames(sid).length;
  const p = await rpc('session/prompt', { request: { sessionId: sid, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } });
  const pres = p?.result ?? p;
  if (pres?.ok === false) { console.log(`${label}: prompt 就失败了 ${pres?.error?.message}`); return; }
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = lastTurnReason(sid, before);
    if (r.ok !== null) { console.log(`${label}: ${r.ok ? '✅ 正常' : `❌ ${r.err}`}`); return; }
  }
  console.log(`${label}: ⏱ 60 秒内没等到结束帧`);
}

await ask('① 短消息      ', '在吗');
let slang = '';
try {
  const cfg = JSON.parse(fs.readFileSync('D:/qq-bridge/config.json', 'utf8'));
  const ct = cfg.consoleToken || fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
  const s = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8'));
  const k = Object.keys(s.conversations)[0];
  const j = await (await fetch(`http://127.0.0.1:3100/api/socialV2/prompt?key=${encodeURIComponent(k)}`, {
    headers: { 'x-console-token': ct, 'x-agent-token': s.conversations[k].agentToken },
  })).json();
  slang = String(j?.slang?.block ?? '');
} catch (e) { console.log('取黑话表失败:', e?.message ?? e); }
if (slang) { console.log(`（黑话表正文 ${slang.length} 字符，单独发它）`); await ask('② 黑话表正文  ', slang); }
else console.log('② 跳过：没取到黑话表正文');
console.log('\n（独立测试会话，不影响 QQ 会话）');
