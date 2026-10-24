/**
 * 回归测试：**发文件工具**（申请 #3：她说"网关支持发文件，但没接到我工具上"）。
 *
 * 这是提示注入最想要的能力（一次注入就能把本机文件发出去），所以用例重点全在**边界**：
 *   [1] 正常路径（出站目录里的文件）→ 真的调 upload_private_file / upload_group_file
 *   [2] **目录锁**：出站目录之外的文件（含 `..` 与符号链接绕过）一律拒绝
 *   [3] **敏感路径锁**：出站目录里的 .env / 凭据 / 令牌 也不许发（光靠目录不够）
 *   [4] 大小上限、目录不是文件、文件不存在 → 明确报错
 *   [5] 既有闸门一个都不能少：令牌 / 会话白名单 / 工具开关 / 全局静默
 *   [6] 源码级：新工具没破坏"最小能力面"（MCP 前缀仍在白名单内，不需要放开任何前缀）
 *
 * 用法: node scripts/test-send-file.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const GKEY = 'group:456';
const PKEY = 'private:123';

const h = await bridgeHarness({
  config: { socialV2: { enabled: true, tools: { sendFile: true } }, ownerQQ: 123, allow: { private: ['123'], groups: ['456'] } },
});
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;
h.setMode('reserved2');

const req = (p, body, agentToken = '', method = 'POST') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method,
    headers: { 'x-console-token': 'fixture-console-token', ...(agentToken ? { 'x-agent-token': agentToken } : {}), 'content-type': 'application/json' } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
  r.on('error', reject); r.end(method === 'GET' ? undefined : JSON.stringify(body ?? {}));
});
const uploads = () => (h.calls.http ?? []).filter((c) => /^upload_/.test(String(c.action)));

try {
  // 准备"出站目录"和几个文件（harness 的 ROOT 是临时目录）
  const outbox = path.join(h.paths.root, 'state', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const good = path.join(outbox, '报告.txt');
  fs.writeFileSync(good, '这是一份报告');
  const outside = path.join(h.paths.root, 'state', 'outside.txt');
  fs.writeFileSync(outside, '不该被发出去');
  const secretInOutbox = path.join(outbox, '.env');
  fs.writeFileSync(secretInOutbox, 'TOKEN=super-secret');
  const credsInOutbox = path.join(outbox, '.credentials.yaml');
  fs.writeFileSync(credsInOutbox, 'x: y');
  const big = path.join(outbox, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(13 * 1024 * 1024, 1));   // 超 12MB 上限

  const gAgent = h.getSocialV2State(GKEY)?.agentToken;
  const pAgent = h.getSocialV2State(PKEY)?.agentToken;

  console.log('\n[1] 正常路径：出站目录里的文件真的发出去（调 upload_* 而不是 send_*_msg）');
  {
    const r = await req('/api/socialV2/send-file', { key: GKEY, file: good }, gAgent);
    check('群聊发文件 200', r.status === 200 && r.json?.ok === true, JSON.stringify(r).slice(0, 200));
    const up = uploads();
    check('调的是 upload_group_file', up.some((c) => c.action === 'upload_group_file'), JSON.stringify(up).slice(0, 200));
    check('传了文件路径与 group_id', /报告\.txt/.test(JSON.stringify(up)) && up.some((c) => c.body?.group_id === 456), JSON.stringify(up).slice(0, 240));
    check('没有误用发文本的端点', !(h.calls.http ?? []).some((c) => /send_group_msg/.test(String(c.action))));
    const r2 = await req('/api/socialV2/send-file', { key: PKEY, file: good, name: '给管理员.txt' }, pAgent);
    check('私聊发文件 200 且调 upload_private_file', r2.status === 200 && uploads().some((c) => c.action === 'upload_private_file'), JSON.stringify(r2).slice(0, 160));
    check('自定义文件名带上去了', uploads().some((c) => c.body?.name === '给管理员.txt'), JSON.stringify(uploads().slice(-1)));
  }

  console.log('\n[2] 目录锁：出站目录之外的文件一律不发');
  {
    const before = uploads().length;
    for (const [label, file] of [
      ['仓库里的普通文件', outside],
      ['用 .. 绕出去（文件确实存在，测的是目录锁不是"文件不存在"）', path.join(outbox, '..', 'outside.txt')],
      ['绝对路径指向配置', path.join(h.paths.root, 'config.json')],
    ]) {
      const r = await req('/api/socialV2/send-file', { key: GKEY, file }, gAgent);
      check(`${label} → 拒绝（400）`, r.status === 400 && /出站目录/.test(String(r.json?.error ?? '')), JSON.stringify(r).slice(0, 160));
    }
    // 符号链接绕过：在出站目录里放一个指向外面的软链
    try {
      const link = path.join(outbox, 'link.txt');
      fs.symlinkSync(outside, link);
      const r = await req('/api/socialV2/send-file', { key: GKEY, file: link }, gAgent);
      check('出站目录里的符号链接指向外面 → 也拒绝（realpath 之后判）', r.status === 400, JSON.stringify(r).slice(0, 160));
    } catch { check('符号链接用例（本机不允许建链接，跳过）', true); }
    check('这一整段一次都没真发出去', uploads().length === before, `uploads ${before} → ${uploads().length}`);
  }

  console.log('\n[3] 敏感路径锁：出站目录里的凭据也不许发（光靠目录不够）');
  {
    const before = uploads().length;
    for (const [label, file] of [['.env', secretInOutbox], ['.credentials.yaml', credsInOutbox]]) {
      const r = await req('/api/socialV2/send-file', { key: GKEY, file }, gAgent);
      check(`${label} → 拒绝`, r.status === 400 && /敏感/.test(String(r.json?.error ?? '')), JSON.stringify(r).slice(0, 160));
    }
    check('一次都没发出去', uploads().length === before);
  }

  console.log('\n[4] 其它输入卫生');
  {
    const tooBig = await req('/api/socialV2/send-file', { key: GKEY, file: big }, gAgent);
    check('超过 12MB → 拒绝并说明大小', tooBig.status === 400 && /太大/.test(String(tooBig.json?.error ?? '')), JSON.stringify(tooBig).slice(0, 160));
    const dir = await req('/api/socialV2/send-file', { key: GKEY, file: outbox }, gAgent);
    check('传目录 → 拒绝', dir.status === 400 && /目录/.test(String(dir.json?.error ?? '')), JSON.stringify(dir).slice(0, 160));
    const nope = await req('/api/socialV2/send-file', { key: GKEY, file: path.join(outbox, '没有这个.txt') }, gAgent);
    check('文件不存在 → 拒绝且文案说清', nope.status === 400 && /不存在|读不到/.test(String(nope.json?.error ?? '')), JSON.stringify(nope).slice(0, 160));
    const empty = await req('/api/socialV2/send-file', { key: GKEY, file: '' }, gAgent);
    check('file 为空 → 400', empty.status === 400, JSON.stringify(empty).slice(0, 120));
  }

  console.log('\n[5] 既有闸门一个都不能少');
  {
    const badToken = await req('/api/socialV2/send-file', { key: GKEY, file: good }, pAgent);
    check('跨会话令牌 → 403', badToken.status === 403, String(badToken.status));
    const notAllowed = await req('/api/socialV2/send-file', { key: 'group:999999', file: good }, gAgent);
    check('白名单外的会话 → 403/400', notAllowed.status === 403 || notAllowed.status === 400, String(notAllowed.status));
    h.setSilentAll(true, 'test');
    const silent = await req('/api/socialV2/send-file', { key: GKEY, file: good }, gAgent);
    check('全局静默下 → 403（静默时发文件也是"在群里出声"）', silent.status === 403 && /全局静默/.test(String(silent.json?.error ?? '')), JSON.stringify(silent).slice(0, 160));
    h.setSilentAll(false, 'test');
    // 工具开关：关掉后要被拦
    const prev = h.cfg.socialV2.tools.sendFile;
    h.cfg.socialV2.tools.sendFile = false;
    const off = await req('/api/socialV2/send-file', { key: GKEY, file: good }, gAgent);
    check('工具开关关掉 → 403', off.status === 403 && /工具未启用/.test(String(off.json?.error ?? '')), JSON.stringify(off).slice(0, 160));
    h.cfg.socialV2.tools.sendFile = prev;
  }

  console.log('\n[6] 一次性全路径许可（管理员：「我发出允许查询全路径的指令就给她这一次的权限」）');
  {
    const p = h.parsePathGrantCommand;
    const g1 = p('允许全路径');
    check('认「允许全路径」', g1?.action === 'grant' && g1.uses === 1 && g1.whole === true, JSON.stringify(g1));
    check('认「给她一次全路径权限」', p('给她一次全路径权限')?.action === 'grant' && p('给她一次全路径权限').whole === true);
    check('认次数「允许全路径 3 次」', p('允许全路径3次')?.uses === 3);
    check('认时限「允许全路径 10 分钟」', p('允许全路径10分钟')?.ttlMs === 10 * 60 * 1000);
    check('上限夹住（最多 5 次 / 30 分钟）',
      p('允许全路径99次')?.uses === 5 && p('允许全路径999分钟')?.ttlMs === 30 * 60 * 1000);
    check('认撤销「撤销全路径」', p('撤销全路径')?.action === 'revoke');
    check('否定也算收回（「不允许全路径」）', p('不允许全路径')?.action === 'revoke');
    check('普通聊天不误判', p('我把文件放桌面了') === null && p('你全路径是啥意思') === null);
    check('命令后面还带话 → whole=false（那条消息仍要投给她）',
      p('允许全路径，把桌面那个发我')?.whole === false
      && p('让她把桌面那个报告发我')?.whole === false);

    console.log('  ── 按意图认（2026-10-10 管理员：「不需要特定指令，意思到了就行」）');
    const grantish = [
      '你直接发吧，我给你权限',
      '这次特批',
      '桌面上的你也能发',
      '破例一次',
      '可以发桌面上的文件',
      '让她把桌面那个报告发我',
      '能不能给她开个权限',
      '允许你发任意文件',
      '我给你开个后门',
    ];
    for (const s of grantish) {
      const r = p(s);
      check(`认得出意图：「${s}」`, r?.action === 'grant', JSON.stringify(r));
    }
    const notGrant = [
      '我给你发个文件',
      '发你一张图',
      '你现在能发文件吗',
      '文件放哪了',
      '发我看看',
      '那个文件我没改',
      '撤回那条消息',
      '她发的东西我不满意',
      // 2026-10-13 现场：他说「我试试能不能截图给你看」（他想**自己**截图），旧判据把里面的"能"
      // 当成 allowVerb、"截图"当成文件类目标 → 连着开了两次全路径许可。这类"试探/自述"一律不算授权。
      '我试试能不能截图给你看',
      '我试试能不能截图给你看',
      '我看看能不能截张图给你',
      '试一下能不能发图片',
      '能不能发桌面上的文件',
      '可不可以发文件给她',
    ];
    for (const s of notGrant) {
      check(`不误判：「${s}」`, p(s) === null, JSON.stringify(p(s)));
    }

    console.log('  ── 她必须能"自查"许可状态，而且开许可要叫醒她（2026-10-10 现场："管理员明明开了、她还在说不行"）');
    {
      const noGrant = await req('/api/socialV2/prompt?key=' + encodeURIComponent(GKEY), null, gAgent, 'GET');
      check('qq_get_prompt 里能看到"现在只能发这些目录"',
        noGrant.status === 200 && noGrant.json?.fileSend?.fullPathGrant?.active === false
        && Array.isArray(noGrant.json?.fileSend?.allowedDirs), JSON.stringify(noGrant.json?.fileSend ?? {}).slice(0, 200));
      h.grantPathAccess({ uses: 2, ttlMs: 60 * 1000, by: 'test' });
      const withGrant = await req('/api/socialV2/prompt?key=' + encodeURIComponent(GKEY), null, gAgent, 'GET');
      check('开了许可之后，qq_get_prompt 立刻能看到（剩几次 + 多久过期）',
        withGrant.json?.fileSend?.fullPathGrant?.active === true
        && withGrant.json?.fileSend?.fullPathGrant?.usesLeft === 2
        && Number(withGrant.json?.fileSend?.fullPathGrant?.expiresInSec) > 0,
        JSON.stringify(withGrant.json?.fileSend ?? {}).slice(0, 200));
      h.revokePathAccess('test');
      const woke = h.buildWakePromptV2(GKEY, 'pathGrant');
      check('开许可有一条专门的唤醒说法（不然她永远不知道开了）',
        /全路径许可/.test(woke) && /qq_send_file/.test(woke), woke.slice(-200));
      const src0 = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
      const wakeCalls = (src0.match(/scheduleWakeV2\(.*?'pathGrant'\)/g) ?? []).length;
      check('开许可的三个入口都会叫醒她（显式意图/短确认/控制台）', wakeCalls >= 3, `找到 ${wakeCalls} 处`);
    }

    const before = uploads().length;
    const denied = await req('/api/socialV2/send-file', { key: GKEY, file: outside }, gAgent);
    check('没有许可时：outbox 之外 → 400，且文案给出路（说"允许全路径"）',
      denied.status === 400 && /全路径/.test(String(denied.json?.error ?? '')), JSON.stringify(denied.json).slice(0, 200));

    const g = await req('/api/socialV2/path-grant', { action: 'grant', uses: 2, minutes: 5 }, '');
    check('控制台端点能开许可', g.status === 200 && g.json?.pathGrant?.uses === 2, JSON.stringify(g.json).slice(0, 160));

    const okOutside = await req('/api/socialV2/send-file', { key: GKEY, file: outside }, gAgent);
    check('有许可 → outbox 之外真的发出去了', okOutside.status === 200 && uploads().length === before + 1, JSON.stringify(okOutside.json).slice(0, 160));
    check('响应里带剩余次数（2 → 1）', okOutside.json?.pathGrantLeft === 1, JSON.stringify(okOutside.json).slice(0, 160));

    const dotEnvOutside = path.join(h.paths.root, '.env');
    fs.writeFileSync(dotEnvOutside, 'TOKEN=super-secret');
    const sec = await req('/api/socialV2/send-file', { key: GKEY, file: dotEnvOutside }, gAgent);
    check('**许可下敏感文件照样拒**（许可放开的是位置，不是凭据）',
      sec.status === 400 && /敏感/.test(String(sec.json?.error ?? '')), JSON.stringify(sec.json).slice(0, 160));
    check('被拒不会白扣次数（还剩 1 次）', h.activePathGrant()?.uses === 1);

    const second = await req('/api/socialV2/send-file', { key: GKEY, file: outside }, gAgent);
    check('第二次用掉最后一次 → 许可自动作废', second.status === 200 && h.activePathGrant() === null, JSON.stringify(second.json).slice(0, 160));
    const third = await req('/api/socialV2/send-file', { key: GKEY, file: outside }, gAgent);
    check('用尽后立刻恢复硬限制', third.status === 400 && /只允许发/.test(String(third.json?.error ?? '')), JSON.stringify(third.json).slice(0, 160));

    h.grantPathAccess({ uses: 3, ttlMs: 60 * 1000, by: 'test' });
    check('许可生效', h.activePathGrant()?.uses === 3);
    const revoked = await req('/api/socialV2/path-grant', { action: 'revoke' }, '');
    check('控制台端点能收回', revoked.status === 200 && h.activePathGrant() === null);
    h.grantPathAccess({ uses: 3, ttlMs: 60 * 1000, by: 'test' });
    h.socialV2.pathGrant.expiresAt = Date.now() - 1;
    check('过期即失效（顺手清掉假状态）', h.activePathGrant() === null && h.socialV2.pathGrant === null);

    console.log('  ── "意思到了"的最后一环：她说发不出去 + 他回一个「行」');
    // 先让一次真实失败把"她刚提过"的记号打上（端点是这么记的）
    const fail = await req('/api/socialV2/send-file', { key: GKEY, file: outside }, gAgent);
    check('撞墙会记下"她刚提过要许可"', fail.status === 400 && Number(h.socialV2.pathGrantAsked?.at) > 0, JSON.stringify(h.socialV2.pathGrantAsked));
    check('他说「行」→ 算开了许可', h.canGrantByShortYes('行') === true);
    check('他说「开」→ 也算', h.canGrantByShortYes('开') === true);
    check('他说「我给你发个文件」→ 不算（方向反了）', h.canGrantByShortYes('我给你发个文件') === false);
    check('他纯聊天「行吧那就这样」→ 不算短确认', h.canGrantByShortYes('行吧那就这样') === false);
    // ⚠️ 2026-10-10 实测踩到：他发了个写着「批准」的表情（本意是批准她刚递的申请），
    //    被这条路抢走并 return → 申请反而没批。所以"批申请"那套词必须留给申请分支。
    for (const w of ['批准', '同意', '通过', '批', '准了', '准']) {
      check(`「${w}」留给"批申请"，不当许可短确认`, h.canGrantByShortYes(w) === false);
    }
    // 时间/状态边界
    h.socialV2.pathGrantAsked = { key: GKEY, at: Date.now() - 31 * 60 * 1000 };
    check('记号过期（31 分钟前）→ 不算', h.canGrantByShortYes('行') === false);
    h.socialV2.pathGrantAsked = { key: GKEY, at: Date.now() };
    h.grantPathAccess({ uses: 1, ttlMs: 60 * 1000, by: 'test' });
    check('已经有一次在生效 → 不重复叠加', h.canGrantByShortYes('行') === false);
    h.revokePathAccess('test');
    check('没有记号时 → 不算（防止把普通"行"当授权）', (() => {
      h.socialV2.pathGrantAsked = null;
      return h.canGrantByShortYes('行') === false;
    })());
  }

  console.log('\n[7] 工具面与守卫');
  {
    const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
    check('MCP 里注册了 qq_send_file', mcp.includes("'qq_send_file'"));
    check('工具描述里写明了"只能发出站目录"', /出站目录/.test(mcp));
    check('工具描述里也写明了一次性许可怎么来（她自己能请管理员开）', /允许全路径/.test(mcp) && /一次性许可/.test(mcp));
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    check('端点里明确有"出站目录 + 敏感路径"两道锁', /resolveSendFilePath/.test(src) && /SEND_FILE_DENY_RE/.test(src));
    check('realpath 之后再判（防 .. 与符号链接）', /fs\.realpathSync/.test(src));
    check('许可只认管理员：命令解析在 isOwner 分支里', /const gc = parsePathGrantCommand\(plainContent\)/.test(src));
    check('许可端点进了 adminOnlyV2Paths（她的 agent token 不能自己开）', /'\/api\/socialV2\/path-grant'\]/.test(src));
    check('许可落盘（重启不凭空多/少）', /pathGrant: socialV2\.pathGrant \? \{ \.\.\.socialV2\.pathGrant \}/.test(src));
    check('短确认开许可排在"批申请"之后（不许抢「批准」）',
      src.indexOf('canGrantByShortYes(plainContent)') > src.indexOf('parseTaskRequestCommand(plainContent)'));
    check('"批申请"的词在许可短确认里被明确排掉', /留给"批申请"|批申请"那套词|必须先.*批申请/.test(src) || /\^\(批\|批准\|准\|准了\|同意\|通过/.test(src));
  }
} finally {
  await new Promise((r) => server.close(r));
  await h.close();
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
