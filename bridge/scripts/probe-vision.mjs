// 决定性验证：她的模型到底**看不看得见图片**。
//
// 为什么要真跑一遍：`test-vision-media.mjs` 只校验了"config 里模型是多模态 + 端点能通"，
// 那只是**配置层面的证据**，不等于模型真的能读图。这里造一张内容已知的图
// （左半纯红、右半纯蓝）塞进 prompt，看她的回答是不是"红,蓝"。
//
// 建独立会话（同 preset / 同模型 / 同工作目录），不碰任何 QQ 会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const AGENTS_DIR = 'D:\\qq-bridge\\state\\agents';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ── 极简 PNG 编码器（真彩色，无滤波）────────────────────────────────────
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 2;  // 颜色类型 2 = 真彩色 RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // 滤波类型 none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── DSH 连接 ─────────────────────────────────────────────────────────────
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
function readFrames(sid) {
  // v3/v4 并存时挑活的那个（升级后 v3 冻结，读它会以为"她什么都没说"）
  const f = sessionFileIn(path.join(process.env.USERPROFILE, '.dsh', 'sessions', slug(AGENTS_DIR), sid));
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
/**
 * 从会话帧里捞"助手说了什么"。
 * 注意：这个 DSH 版本**不一定写 turn/end 帧**（实测只写 assistant/message），
 * 所以判定要同时看：
 *   • assistant/message 里的 {type:'text'} → 最终回答
 *   • assistant/message 里的 {type:'reasoning'} → 推理（她"看到了"的最直接证据）
 */
function harvest(sid, fromIdx) {
  const frames = readFrames(sid).slice(fromIdx);
  const texts = [];
  const reasonings = [];
  let errored = null;
  for (const raw of frames) {
    if (raw.includes('"turn/end"')) {
      try {
        const r = JSON.parse(raw)?.data?.reason;
        if (r?.kind === 'error') errored = r?.error?.message ?? JSON.stringify(r).slice(0, 200);
        if (r?.text) texts.push(r.text);
      } catch {}
    }
    if (!raw.includes('"assistant/message"')) continue;
    try {
      const content = JSON.parse(raw)?.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === 'text' && part.text?.trim()) texts.push(part.text);
        if (part?.type === 'reasoning' && part.text?.trim()) reasonings.push(part.text);
      }
    } catch {}
  }
  return { texts, reasonings, errored };
}

const token = launchToken();
if (!token) { console.error('拿不到 DSH launch token'); process.exit(1); }
const r0 = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' });
const cookie = r0.headers.get('set-cookie')?.split(';')[0];
if (!cookie) { console.error('DSH 认证失败（HTTP ' + r0.status + '）'); process.exit(1); }

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

// ── 造图：左半红、右半蓝 ─────────────────────────────────────────────────
const img = makePng(120, 60, (x) => (x < 60 ? [255, 0, 0] : [0, 0, 255]));
fs.writeFileSync('state/vision-probe.png', img);
console.log(`测试图   : 120x60 PNG，左半红 右半蓝，${img.length} 字节（也存到了 state/vision-probe.png）`);

const QUESTION = '看这张图：它的左半边和右半边分别是什么颜色？只回答两个颜色名，用逗号分隔，不要解释。';
const content = [
  { type: 'text', text: QUESTION },
  { type: 'image', mediaType: 'image/png', data: img.toString('base64'), name: 'vision-probe.png' },
];

const before = readFrames(sid).length;
const p = await rpc('session/prompt', { request: { sessionId: sid, requestId: randomUUID(), mode: 'queue', content } });
const pres = p?.result ?? p;
if (pres?.ok === false) {
  console.log('❌ prompt 直接被拒：', pres?.error?.message);
  process.exit(1);
}
console.log('已发送带图的 prompt，等待回答…');

let texts = [];
let reasonings = [];
let errored = null;
for (let i = 0; i < 48; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const h = harvest(sid, before);
  errored = h.errored;
  texts = h.texts;
  reasonings = h.reasonings;
  // 有最终文本就算完事；只有推理的话再多等一会儿（max 档推理可能很慢）
  if (texts.length) break;
  if (reasonings.length && i > 8) break;
}

console.log('─'.repeat(70));
if (errored) { console.log('❌ 请求出错：', errored); process.exit(1); }

const finalText = texts.join(' | ').trim();
const thinking = reasonings.join(' ').trim();
if (thinking) console.log('（她的推理片段）', thinking.replace(/\s+/g, ' ').slice(0, 260));
if (finalText) console.log('（她的最终回答）', finalText.slice(0, 300));
if (!finalText && !thinking) { console.log('⚠️ 既没捞到回答也没捞到推理，请手动看会话：', sid); process.exit(1); }

console.log('─'.repeat(70));
// 判定：最终回答或推理里只要同时出现"红""蓝"，就说明图**真的被看见了**。
// 用推理作证据是合理的——她不可能凭空说出"左半红右半蓝"这种图里才有的信息。
const blob = `${finalText} ${thinking}`.replace(/\s/g, '');
const sawRed = /红/.test(blob) || /red/i.test(blob);
const sawBlue = /蓝/.test(blob) || /blue/i.test(blob);
const saidCantSee = /看不到|无法查看|看不见|没有图片|未收到图|不能看|can'?t see|unable to (view|see)/i.test(blob);
if (sawRed && sawBlue) {
  console.log('✅ 结论：**她真的能看见图片**（左红右蓝都被她说对了，不是配置层面的推断）');
} else if (saidCantSee) {
  console.log('❌ 结论：模型看不到图片（它明确说看不到）');
} else {
  console.log(`⚠️ 结论不确定：没同时出现"红"和"蓝"（红=${sawRed} 蓝=${sawBlue}）——请看上面的原文`);
}
console.log(`（独立测试会话 ${sid}，不影响任何 QQ 会话）`);
