// 诊断：DSH 的 remote.mux 事件流在"桥接也在连着"的情况下，第二个客户端到底收不收得到事件。
// 用法：node scripts/probe-mux-frames.mjs [秒数=90]
//
// 背景：scripts/test-dsh-v2-wait.mjs（真实的二代端到端测试）两次都超时，
// 但会话文件里 turn/start 与 turn/end **都齐全** —— 说明回合跑完了，只是测试没收到事件。
// 这个探针就是来区分"产品 bug（事件流不能多客户端）"还是"测试自己的问题"。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SECONDS = Number(process.argv[2] ?? 90);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const auth = { token: cfg.dsh?.authToken || discoverDshLaunchToken(), header: cfg.dsh?.authHeader, prefix: cfg.dsh?.authPrefix };
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, auth);

const cwd = path.join(ROOT, 'state', 'self-test-v2-wait');
fs.mkdirSync(cwd, { recursive: true });
const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
const sessionId = created.sessionId;
console.log('SESSION_CREATED', sessionId);

const counts = new Map();
let total = 0;
const stream = api.events.mux({});
const started = Date.now();
const loop = (async () => {
  for await (const envelope of stream) {
    total++;
    const frame = envelope.payload;
    const tag = frame?.type === 'session/event' ? `session/event:${frame.event?.type}` : String(frame?.type);
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (frame?.type === 'session/event' && frame.sessionId === sessionId) {
      console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${frame.event?.type}`);
    }
  }
})().catch((e) => console.error('stream error:', String(e?.message ?? e)));

stream.follow(sessionId);
const accepted = unwrap(await api.sessions.prompt({
  sessionId, mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字：收到' }],
}), 'session.prompt');
console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));

await new Promise((r) => setTimeout(r, SECONDS * 1000));
console.log(`\n${SECONDS}s 内收到 ${total} 个 frame：`);
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(total === 0
  ? '\n⚠️ 一个 frame 都没收到 → 事件流对这个客户端是"哑"的（多客户端/鉴权问题）'
  : '\n✅ 事件流有数据（再看上面有没有本会话的 session/event）');
try { await stream.close?.(); } catch {}
process.exit(0);
