/**
 * 执行申请队列（"数字员工"的**工作收件箱**）：2026-10-10 起，她只能申请、不能执行。
 *
 *  她 `qq_request_action` → state/task-requests.json（pending）+ 私聊通知你
 *    → 你在 QQ 私聊说「批准 #12」/「驳回 #12」（或直接改这里）
 *    → **你在有权限的这一侧真的去做**（这一步永远是人的/agent 的判断，桥接不代劳）
 *    → `node scripts/requests.mjs done 12 --result "结果..."` → 结果写回她的上下文
 *
 * 用法：
 *   node scripts/requests.mjs                     # 待办（默认只看 pending）
 *   node scripts/requests.mjs all                 # 全部（含已完成）
 *   node scripts/requests.mjs show 12             # 看一条的完整内容
 *   node scripts/requests.mjs approve 12          # 等价于在 QQ 私聊说「批准 #12」
 *   node scripts/requests.mjs reject 12 --reason "太危险/没必要"
 *   node scripts/requests.mjs done 12 --result "查到了：…（命令与输出摘要）"
 *   node scripts/requests.mjs failed 12 --result "跑失败：错误原因…"
 *
 * ⚠️ 这个脚本**不执行申请里的内容**：它只是读写队列 + 把结果写回她的上下文。
 *    真正执行的是"有权限的这一侧"（你/agent），这是设计上故意留给人判断的一步。
 */
import fs from 'node:fs';
import { readConsoleToken } from './lib/console-token.mjs';

const BASE = 'http://127.0.0.1:3100';
const token = readConsoleToken() || (fs.existsSync('state/console-token') ? fs.readFileSync('state/console-token', 'utf8').trim() : '');
const argv = process.argv.slice(2);
const cmd = String(argv[0] ?? 'list');
const id = String(argv[1] ?? '').trim();
const argOf = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

async function api(path, method = 'GET', body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || json?.ok === false) throw new Error(`HTTP ${r.status} ${json?.error ?? ''}`);
  return json;
}
const fmt = (r) => {
  const when = new Date(Number(r.at)).toLocaleString('zh-CN');
  return `#${r.id} [${r.status}] ${r.kind} · ${r.key} · ${when}\n    要做：${r.summary}${r.detail ? `\n    细节：${r.detail}` : ''}`
    + `${r.result ? `\n    结果：${r.result}` : ''}${r.decidedBy ? `\n    决定：${r.status} by ${r.decidedBy}` : ''}`;
};

try {
  if (cmd === 'list' || cmd === 'all') {
    const { requests } = await api('/api/socialV2/task-requests');
    // ⚠️ 2026-10-10 修：以前 list 只查 pending —— **一被批准就从我的视野里消失了**，
    //   于是出现"他批了、她等着、我这边什么都没发生"的空窗（他直接问我"在做吗"）。
    //   现在默认把「已批准、等执行」也列出来，因为那才是**该我干的活**。
    const list = cmd === 'all' ? requests
      : requests.filter((r) => r.status === 'pending' || r.status === 'approved');
    if (!list.length) { console.log('✅ 没有待处理申请（pending / approved 都是空的）'); process.exit(0); }
    const approved = list.filter((r) => r.status === 'approved');
    const running = approved.filter((r) => Number(r.runnerStartedAt) > 0);
    console.log(`${cmd === 'all' ? '全部' : '待处理'}申请 ${list.length} 条`
      + `${approved.length ? `（已批准 ${approved.length} 条${running.length ? `，其中 ${running.length} 条**正在自动执行**` : ''}）` : ''}：\n`);
    for (const r of list) console.log(fmt(r) + '\n');
    // 2026-10-10：批准之后**桥接自己就开工了**（taskRunner），所以这里的措辞要跟得上 ——
    // 以前写的是"等我去执行"，那是人肉传动的年代。
    if (running.length) console.log('↑ 标着"自动执行中"的那些正在被工作会话处理，不用管；等它自己回报。');
    else if (approved.length) console.log('↑ 已批准但**还没开工**：看门狗最多 stuckMinutes 分钟内会补跑；想立刻跑就 `run <id>`。');
    else console.log('这些还没批：等他回「批准 <id>」；批完桥接会自动开工。');
    process.exit(0);
  }
  if (cmd === 'run') {
    // 手动补跑（看门狗没到点、但你想立刻开工时用）
    const r = await api('/api/socialV2/task-request-update', 'POST', { id, status: 'approved', by: argOf('--by', 'requests.mjs') });
    console.log(`✅ #${id} 已置为 approved（桥接会自动开工）→ ${r.request?.status}`);
    process.exit(0);
  }
  if (cmd === 'show') {
    const { requests } = await api('/api/socialV2/task-requests');
    const r = requests.find((x) => String(x.id) === id);
    if (!r) { console.log(`没有 #${id}`); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  if (cmd === 'approve' || cmd === 'reject') {
    // reject 必须说明理由（她上下文里那条便条就靠它）；approve 可以不说。
    const reason = argOf('--reason', '');
    if (cmd === 'reject' && !reason.trim()) {
      console.error('❌ 驳回必须写理由：node scripts/requests.mjs reject <id> --reason "为什么不做"');
      console.error('   （没有理由，她只会收到一句"驳回了"，然后就这一个问题反复猜/反复问）');
      process.exit(1);
    }
    const r = await api('/api/socialV2/task-request-update', 'POST', {
      id, status: cmd === 'approve' ? 'approved' : 'rejected',
      result: reason, by: argOf('--by', 'requests.mjs'),
    });
    console.log(`✅ #${id} → ${r.request.status}（她的上下文里已写入一条系统消息）`);
    process.exit(0);
  }
  if (cmd === 'done' || cmd === 'failed') {
    // ⚠️ 必须用 --result（2026-10-10 现场：有人写成位置参数 `done 7 "结果…"`，
    //    结果被静默丢掉，她上下文里只剩一句"做完了"、什么也拿不到）。
    //    所以这里强制要求显式给结果：要么 --result，要么 --result-file（长清单别挤命令行）。
    let result = argOf('--result', '');
    const resultFile = argOf('--result-file', '');
    if (!result.trim() && resultFile) {
      try { result = fs.readFileSync(resultFile, 'utf8'); }
      catch (error) { console.error(`❌ 读不到 --result-file：${error?.message ?? error}`); process.exit(1); }
    }
    if (!result.trim()) {
      console.error(`❌ ${cmd === 'done' ? 'done' : 'failed'} 必须给结果：`);
      console.error(`   node scripts/requests.mjs ${cmd} <id> --result "结果摘要…"`);
      console.error(`   node scripts/requests.mjs ${cmd} <id> --result-file state/some-output.txt   # 长清单/长输出用这个`);
      process.exit(1);
    }
    const r = await api('/api/socialV2/task-request-update', 'POST', {
      id, status: cmd, result, by: argOf('--by', 'requests.mjs'),
    });
    console.log(`✅ #${id} → ${r.request.status}，结果已写回她的会话（下次醒来她会看到，带 ${result.trim().length} 字结果）`);
    process.exit(0);
  }
  console.log('用法见文件头注释：list | all | show <id> | approve <id> | reject <id> --reason "…" | done <id> --result "…"');
} catch (error) {
  console.error(`❌ ${error?.message ?? error}`);
  console.error('（桥接在跑吗？控制台令牌对吗？）');
  process.exit(1);
}
