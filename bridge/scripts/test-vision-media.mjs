// 视觉/图片链路自检脚本：
// 1. 校验配置默认模型为 DeepSeek-V4-Flash-Vision-Exp
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
// 多模态模型清单：DSH 0.1.5 的 llm-deepseek 里声明 inputModalities 含 image 的模型。
// deepseek-flash（DeepSeek-V41-Flash）是当前默认；deepseek-v4-flash-vision-exp 为历史默认。
const MULTIMODAL_MODELS = ['deepseek-flash', 'deepseek-v4-flash-vision-exp'];
check('config.dsh.model 为多模态模型', MULTIMODAL_MODELS.includes(config.dsh?.model), `当前 ${config.dsh?.model}`);
// 2026-10-22：原来硬编码查 === 'max'，管理员把档位降到 medium 后它误报。
// 该断言的本意是"配置的思考档位合法"，不是"必须 max"。
check('config.dsh.reasoningEffort 是合法档位', ['off', 'low', 'high', 'max'].includes(config.dsh?.reasoningEffort), `当前 ${config.dsh?.reasoningEffort}`);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

// ── 图片体积上限（2026-09-30 用户截图："上下文理解能力还是有问题"）────────────
// 现场：群里一张 4.2MB 的照片被**给文件用的 4MB 上限**挡掉，她什么也没看到，
// 只能在群里说"图我这边没刷出来"。QQ 图片动辄 3~8MB，图片必须单独给额度。
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const cfg = readJson(path.join(ROOT, 'config.json'));
  const cap = Number(cfg?.socialV2?.media?.maxImageBytes) || 0;
  const check = (name, ok, detail) => {
    if (ok) { passed += 1; console.log(`✅ ${name}`); }
    else { failed += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  check('图片上限单独配置（config.socialV2.media.maxImageBytes）', cap >= 8 * 1024 * 1024, `现在是 ${Math.round(cap / 1024 / 1024)}MB`);
  check('不再和"文件"共用 4MB 上限', !/const MAX_MEDIA_BYTES = 4 \* 1024 \* 1024/.test(bridge));
  check('取额度走 maxImageBytes()（可被配置覆盖）', /function maxImageBytes\(\)/.test(bridge) && /let MAX_MEDIA_BYTES = maxImageBytes\(\)/.test(bridge));
  check('没看到图时提示里带原因（她才能如实说、用户知道该改哪）', /没看到内容：\$\{img\?\.error/.test(bridge));
  check('像素上限仍在（防图片炸弹）', /MAX_MEDIA_PIXELS = 64_000_000/.test(bridge));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
