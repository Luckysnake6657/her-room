// 完美平台 token 抓包代理（单主机 HTTPS 中间人，只针对 api.wmpvp.com）
//
// 原理：hosts 把 api.wmpvp.com 指到 127.0.0.1，本进程在 443 上用自签证书做 TLS 终端，
//       解密后把请求原样转发给真实 api.wmpvp.com，响应流式回传，并记录请求头/响应体。
//       只抓这一个域名；命中 token 自动写入 state/wmpvp-token.json（含备份与轮换提示）。
//
// 需要管理员：绑定 443 + hosts + 信任根证书。见 install-wmpvp-capture.ps1。
//
// 用法: node scripts/wmpvp-proxy.mjs [--port 443] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'state', 'wmpvp-capture');
const TOKEN_FILE = process.env.WMPVP_TOKEN_FILE || path.join(ROOT, 'state', 'wmpvp-token.json');
const SIGN_FILE = process.env.WMPVP_SIGN_FILE || path.join(ROOT, 'state', 'wmpvp-sign.json');
const CAPTURE_LOG = path.join(DIR, 'capture.jsonl');

const argv = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
};
const PORT = Number(getFlag('port', 443));
const VERBOSE = argv.includes('--verbose');
// 测试模式：不写 token / 签名，全部落到 *.test.json。
// 教训：曾经为了验证功能起了个 8443 测试代理，结果它把 curl 带进去的假 token
// 写进了生产 state/wmpvp-token.json，覆盖了真 token。所以非 443 端口默认就不许写生产文件。
const IS_TEST_PORT = PORT !== 443;
const NO_PERSIST = argv.includes('--no-persist') || IS_TEST_PORT;

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const vlog = (...a) => { if (VERBOSE) console.log(`[${ts()}]`, ...a); };

// 真实服务器地址。
// 关键坑：hosts 已经把 api.wmpvp.com 指到 127.0.0.1，所以**转发时不能再解析这个域名**，
// 否则会指回自己形成死循环（表现为 90003 / proxy upstream failed）。
// 因此在启动时用**公共 DNS 直接查 IP**（绕开被劫持的本地解析），
// Host 头与 TLS SNI 仍保持原域名。
//
// 另外我们不预先知道客户端真正的 API 域名（它运行时才拼出来），所以对**任意**
// *.wmpvp.com / *.wanmei.com 请求都在首次访问时用公共 DNS 动态解析并缓存。
const DNS_SERVERS = (process.env.WMPVP_DNS || '223.5.5.5,119.29.29.29').split(',').map((s) => s.trim());
const FALLBACK_IPS = {
  'api.wmpvp.com': ['112.13.210.86', '39.174.179.5', '39.173.157.74'],
  'appengine.wmpvp.com': ['112.16.226.30']
};

/** 用公共 DNS 解析，绕开被 hosts 劫持的本地解析。 */
async function resolveRealIps(host) {
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  try { resolver.setServers(DNS_SERVERS); } catch {}
  try {
    const addrs = await resolver.resolve4(host);
    // 过滤掉回环地址（防止仍然自环）
    const clean = (addrs || []).filter((a) => !a.startsWith('127.'));
    if (clean.length) return clean;
  } catch (e) {
    vlog(`公共 DNS 解析 ${host} 失败（${e.code || e.message}），试内置兜底`);
  }
  return FALLBACK_IPS[host] || [];
}

const ipCache = new Map();
async function getUpstreamIps(host) {
  if (ipCache.has(host)) return ipCache.get(host);
  const ips = await resolveRealIps(host);
  ipCache.set(host, ips);
  return ips;
}

const UPSTREAM_PORT = Number(process.env.WMPVP_UPSTREAM_PORT) || 443;
const PRIMARY_HOST = 'api.wmpvp.com';

const pfxPath = path.join(DIR, 'leaf.pfx');
const caPemPath = path.join(DIR, 'ca-cert.pem');
if (!fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
  console.error(`缺少证书（${pfxPath} 或 ${caPemPath}）\n请先运行: powershell -File scripts\\wmpvp-make-cert.ps1`);
  process.exit(1);
}
// PKCS#12 already contains the CA, but Node only sends the leaf unless we also
// hand it the issuer explicitly -- so pass the CA PEM as well, otherwise TLS
// clients fail with "self-signed certificate in certificate chain".
const serverTls = {
  pfx: fs.readFileSync(pfxPath),
  passphrase: 'qqbridge',
  ca: fs.readFileSync(caPemPath)
};

fs.mkdirSync(DIR, { recursive: true });

// ── token 落盘 ────────────────────────────────────────────────────
let wroteToken = false;
function saveToken(token, source) {
  token = String(token || '').trim();
  if (!token || token.length < 8) return false;

  // 已有且相同则跳过
  try {
    const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (cur?.token === token) return false;
  } catch {}

  // 备份旧 token
  // 测试模式下写到 *.test.json，绝不碰生产文件
  const target = NO_PERSIST ? TOKEN_FILE.replace(/\.json$/, '.test.json') : TOKEN_FILE;

  try {
    if (!NO_PERSIST && fs.existsSync(TOKEN_FILE)) {
      const bak = path.join(DIR, `wmpvp-token.${Date.now()}.json`);
      fs.copyFileSync(TOKEN_FILE, bak);
      log(`旧 token 已备份 → ${path.basename(bak)}`);
    }
  } catch {}

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ token, source, capturedAt: new Date().toISOString() }, null, 2), 'utf8');
  wroteToken = true;
  if (NO_PERSIST) {
    log(`[测试模式] 抓到 token ${token.slice(0, 8)}… → 只写入 ${path.basename(target)}（不碰生产文件）`);
    return true;
  }
  log(`\n${'='.repeat(62)}`);
  log(`  ✅ 抓到 token（来源: ${source}）`);
  log(`     ${token.slice(0, 10)}…${token.slice(-6)}  (长度 ${token.length})`);
  log(`     已写入 ${target}`);
  log(`  → 现在可以关掉本抓包程序（Ctrl+C），然后运行自检：`);
  log(`     node scripts\\check-wmpvp-token.mjs`);
  log(`${'='.repeat(62)}\n`);
  return true;
}

/** 从请求头里找 token 字段（大小写不敏感）。 */
function extractTokenFromHeaders(headers) {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'token' && typeof v === 'string' && v.trim()) return { token: v.trim(), key: k };
  }
  return null;
}

const b64urlJson = (s) => {
  try { return JSON.parse(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
};

/**
 * 从 URL query 里找 token。
 * 实测完美客户端把凭据放在 query 上（不是请求头）：
 *   ...?access_token=097819b5...9447
 * 所以这一步才是真正抓到 token 的关键，别删。
 * 另外 query 里的 `jt` 是一个 JWT，其 payload 的 `a` 字段就是同一个 access_token。
 */
function extractTokenFromUrl(url) {
  let u;
  try { u = new URL(url, 'https://placeholder.local'); } catch { return null; }
  for (const key of ['access_token', 'accessToken', 'token']) {
    const v = u.searchParams.get(key);
    if (v && v.trim().length >= 8) return { token: v.trim(), key: `query ${key}` };
  }
  const jt = u.searchParams.get('jt');
  if (jt) {
    const p = b64urlJson(jt.split('.')[1]);
    for (const k of ['a', 'access_token', 'accessToken', 'token']) {
      if (typeof p?.[k] === 'string' && p[k].length >= 8) return { token: p[k], key: `query jt.${k}` };
    }
  }
  return null;
}

/** 从响应体里找 accessToken/token（Android 客户端有的接口会回传）。 */
function extractTokenFromBody(text) {
  try {
    const j = JSON.parse(text);
    const stack = [j];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === 'string' && v.length >= 16 && /token/i.test(k) && !/refresh/i.test(k)) {
          return { token: v, key: k };
        }
        if (typeof v === 'object') stack.push(v);
      }
    }
  } catch {}
  return null;
}

function appendCapture(entry) {
  try {
    fs.appendFileSync(CAPTURE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

// ── 转发 ──────────────────────────────────────────────────────────
/** 依次尝试该域名的真实 IP，返回第一个连上的响应流。 */
function forwardOnce(req, body, host, ip) {
  const headers = { ...req.headers };
  headers.host = host; // 保持原域名，让上游按正确的 virtual host / SNI 处理
  delete headers['content-length'];
  if (body && body.length) headers['content-length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const up = https.request(
      {
        host: ip, // 用真实 IP，绕开被 hosts 劫持的域名解析
        port: UPSTREAM_PORT,
        method: req.method,
        path: req.url,
        headers,
        servername: host,
        timeout: 30000
      },
      (res) => resolve(res)
    );
    up.on('error', reject);
    up.on('timeout', () => { up.destroy(new Error('upstream timeout')); });
    if (body && body.length) up.write(body);
    up.end();
  });
}

async function forward(req, body, host) {
  // 动态解析任意域名（首次访问时查公共 DNS 并缓存），失败则回退到主域名 IP。
  let ips = await getUpstreamIps(host);
  if (!ips.length && host !== PRIMARY_HOST) {
    vlog(`${host} 解析不到 IP，回退到 ${PRIMARY_HOST}`);
    ips = await getUpstreamIps(PRIMARY_HOST);
  }
  let lastErr;
  for (const ip of ips) {
    try {
      const res = await forwardOnce(req, body, host, ip);
      vlog(`上游 ${host} via ${ip} → ${res.statusCode}`);
      return res;
    } catch (e) {
      lastErr = e;
      vlog(`上游 ${host} via ${ip} 失败: ${e.message}，换下一个`);
    }
  }
  throw lastErr || new Error('no upstream available');
}

const server = https.createServer(serverTls, (req, res) => {
  const host = (req.headers.host || '').split(':')[0] || 'api.wmpvp.com';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);

    // 抓 token：**先看 URL query**（完美客户端把 access_token 放在 query 上），
    // 再看请求头（api.wmpvp.com 那套把 token 放在 header）。
    const urlHit = extractTokenFromUrl(req.url);
    const headerHit = extractTokenFromHeaders(req.headers);
    const hit = urlHit || headerHit;
    if (hit) {
      const where = urlHit ? 'query' : 'header';
      log(`捕获 ${req.method} ${host}${req.url.slice(0, 90)} ← ${where} 里的 ${hit.key}`);
      saveToken(hit.token, `request ${where} ${hit.key}`);
    } else {
      vlog(`${req.method} ${host}${req.url.slice(0, 90)} (URL/头里都没有 token)`);
    }

    try {
      const upRes = await forward(req, body, host);
      const outChunks = [];
      upRes.on('data', (c) => { outChunks.push(c); res.write(c); });
      upRes.on('end', () => {
        res.end();
        const respBuf = Buffer.concat(outChunks);
        const text = respBuf.toString('utf8');
        // 响应体里也可能有 token（首次登录/刷新时）
        const bodyHit = extractTokenFromBody(text);
        if (bodyHit) saveToken(bodyHit.token, `response body ${bodyHit.key}`);

        appendCapture({
          t: new Date().toISOString(),
          method: req.method,
          host,
          url: req.url,
          reqHeaders: req.headers,
          reqBody: body.length ? body.toString('utf8').slice(0, 4000) : undefined,
          status: upRes.statusCode,
          respBody: text.slice(0, 8000)
        });

        // 顺手把"签名参数"落盘：pwaweblogin 的接口要 a/r/s/t 签名，
        // 而签名与 path 无关（实测两个不同 path 用同一签名），所以抓到一个就能复用它去调
        // /match-api/detail 这类接口。签名有时间窗口，抓到就要尽快用。
        try {
          const u = new URL(req.url, `https://${host}`);
          const a = u.searchParams.get('a');
          const r = u.searchParams.get('r');
          const sgn = u.searchParams.get('s');
          const t = u.searchParams.get('t');
          const at = u.searchParams.get('access_token');
          if (sgn && r && t) {
            const signTarget = NO_PERSIST ? SIGN_FILE.replace(/\.json$/, '.test.json') : SIGN_FILE;
            const prev = (() => { try { return JSON.parse(fs.readFileSync(signTarget, 'utf8')); } catch { return null; } })();
            if (!prev || prev.s !== sgn) {
              fs.writeFileSync(
                signTarget,
                JSON.stringify({ sign: sgn, appId: a || '20000', rand: r, ts: t, accessToken: at || '', host, capturedAt: new Date().toISOString() }, null, 2),
                'utf8'
              );
              log(`🔑 抓到接口签名 s=${String(sgn).slice(0, 12)}… (r=${r} t=${t}) → ${path.basename(signTarget)}${NO_PERSIST ? ' [测试模式]' : ''}`);
            }
          }
        } catch {}
      });
      upRes.on('error', (e) => { log(`上游响应错误: ${e.message}`); res.end(); });
    } catch (e) {
      log(`转发失败 ${req.url}: ${e.message}`);
      try {
        res.writeHead(599, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 90003, errorMessage: 'proxy upstream failed', data: null }));
      } catch {}
    }
  });
});

server.on('clientError', (err, socket) => {
  vlog('clientError: ' + err.message);
  try { socket.destroy(); } catch {}
});

server.on('error', (e) => {
  if (e.code === 'EACCES') {
    console.error(`\n❌ 绑定 ${PORT} 端口失败：权限不足。请用管理员运行（install-wmpvp-capture.ps1 会提权）。\n`);
  } else if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ ${PORT} 端口已被占用（可能上一次没关干净）。\n`);
  } else {
    console.error('服务错误: ' + e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  log('='.repeat(62));
  log('  完美平台 token 抓包代理已启动');
  log(`  监听: 0.0.0.0:${PORT}`);
  log(`  转发: api.wmpvp.com / appengine.wmpvp.com → 真实 IP（绕开 hosts 劫持）`);
  log(`  日志: ${CAPTURE_LOG}`);
  log('');
  log('  接下来：启动完美竞技平台并登录，本程序会自动抓下 token。');
  log('  抓到后按 Ctrl+C 退出，再运行 check-wmpvp-token.mjs 自检。');
  log('');
  log('  注意：日志含完整请求头（里面有 token），抓完记得删 capture.jsonl。');
  log('='.repeat(62));
});

// 退出时提示
process.on('SIGINT', () => {
  log(wroteToken ? '\n已抓到 token，正在退出…' : '\n未抓到 token（可能没登录成功），正在退出…');
  log(`提醒：抓完后请运行 scripts\\wmpvp-uninstall-capture.ps1 还原 hosts 和证书。`);
  process.exit(0);
});
