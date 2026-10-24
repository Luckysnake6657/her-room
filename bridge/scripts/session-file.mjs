/**
 * 定位 DSH 会话历史文件的唯一入口 —— 所有 `scripts/` 下的排查脚本都从这里拿路径。
 *
 * 为什么不能写死 `session.v3.jsonl.zstd`（2026-10-10 实测踩到）：
 * DSH 从 0.1.5-rc.3 升到 0.2.0-rc.2 后，会话格式升到 v4，文件名变成
 * `session.v4.jsonl.zstd`；而且升级后**第一次写入**某个会话时，DSH 会新写一个 v4
 * 文件、把旧的 v3 留在同一个目录里**不删**。于是同一个会话目录下会同时躺着两个文件：
 *
 *   实测一个会话目录：v3 压缩 36.8 MB / 26916 帧 / 解开 120.61 MB
 *                     v4 压缩 19.5 MB /    45 帧 / 解开 120.67 MB   ← 活的（mtime 更新）
 *
 * v3 在升级那一刻就**冻结**了（不再追加），所以写死 v3 的脚本会永远去读那份旧快照：
 * "最后一条记录"停在升级前、turn/step 计数再也不动、体积也不再涨 —— 排查时会得出
 * "她的会话卡住了"这种完全错误的结论，而真正在写的 v4 一次都没被看过。
 *
 * 为什么按**版本号**挑、而不是"谁 mtime 新就用谁"：
 * mtime 只是"最后一次被碰过"的时间，复制／备份／toolkit 触碰一下就会翻新，用它可以被
 * 一个陈旧的 v3 盖过新的 v4；文件名里的版本号才是**格式的代际**，是 DSH 自己写下的、
 * 不依赖任何外部动作的事实。所以规则是「版本号大的优先，版本号相同再比 mtime」——
 * 后半句是兜底：同一代里可能因为轮换/重写留下多个文件，那时 mtime 才是有效判据。
 *
 * ⚠️ 帧粒度也随之变了（v3 一行一帧 → v4 一大块一帧，一个 zstd 帧里含很多行 JSONL）。
 *    所以**只换"怎么找到文件"不够**：凡是 `JSON.parse(整帧)` 的解析（默认"一帧一条记录"）
 *    在 v4 上都会退化成"只看到这一帧的第一条、或者直接 parse 失败"。本模块只管定位文件，
 *    解帧/按行切分由调用方负责 —— 这也是这里不导出"读事件"之类函数的原因。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 只认 DSH 自己写的这个名字：`session.v<数字>.jsonl.zstd`（v3/v4/以后都吃）。 */
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

/**
 * 给定一个**会话目录**（`…/sessions/--D-qq-bridge-state-agents--/<sessionId>`，
 * 目录里直接放着 session.v*.jsonl.zstd），返回"活的那个"文件的绝对路径。
 *
 * 不会抛异常：目录不存在（会话还没建过 / 已经被删）时返回
 * `path.join(dir, 'session.v4.jsonl.zstd')` —— 一个**不存在的路径**，让调用方原来的
 * `fs.existsSync` 分支和报错信息照常走。返回空串反而会变成"undefined 路径"这种噪音，
 * 所以要留一个可读的假路径。
 *
 * ⚠️ 边界行为与 `src/bridge.js` 里的同名函数**故意不同**（那边会话为空时返回空串，
 *    因为轮换判断把"空串"当成 0 字节的语义）。两边挑选规则（版本号优先、同版本比 mtime）
 *    必须保持一致，改这个函数时请顺手看一眼 bridge.js 的 `sessionFilePath`
 *    （`scripts/self-check.mjs` 里有一条守卫盯着 bridge.js 那边不许写死版本号）。
 */
export function sessionFileIn(dir) {
  const base = String(dir ?? '');
  let names = [];
  try { names = fs.readdirSync(base); } catch { /* 目录不存在：走下面的兜底 */ }

  let best = '';
  let bestVer = -1;
  let bestMtime = -1;
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;                       // 非会话文件（临时文件、子目录…）直接跳过
    const full = path.join(base, name);
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;           // 同名目录这种东西不该被当成候选
      mtime = st.mtimeMs;
    } catch { continue; }
    const ver = Number(m[1]);
    if (ver > bestVer || (ver === bestVer && mtime > bestMtime)) {
      best = full; bestVer = ver; bestMtime = mtime;
    }
  }
  return best || path.join(base, 'session.v4.jsonl.zstd');
}

/**
 * `sessionFileIn(path.join(containingDir, sessionId))` 的薄封装。
 *
 * 为什么留这一层：绝大多数排查脚本手里只有"会话根目录 + sessionId"这两样东西
 * （`state/sessions.json` 里存的就是 key→sessionId），薄封装省得每个脚本各拼一次路径、
 * 也省得以后目录结构再变时要改 20 多个文件。
 */
export function sessionFilePath(containingDir, sessionId) {
  return sessionFileIn(path.join(String(containingDir ?? ''), String(sessionId ?? '')));
}
