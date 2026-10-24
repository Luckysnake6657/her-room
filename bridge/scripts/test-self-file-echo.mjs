/**
 * 回归：别把"我自己发出去的文件回声"当成他发来的文件（2026-10-16，申请 #38）。
 *
 * 现场：管理员说「你问问dsh为什么唱不了歌」—— 连着四次 `qq_sing` 都回"已经发给他"，
 *   可他那边"一直没收到"；同时产物**落到她自己的会话里**（13:04/13:09/13:31 三条 mp3，
 *   都挂在 owner 名下，他却说没发过）。
 *
 * 查实的真相（**不是发送失败**）：
 *   · 桥接与网关都明确报告发送成功 —— 网关 13:30:00 把语音条转 silk 上传 168504 字节
 *     （`PUT done in 418ms` → `发送：[语音]`），13:30:01-05 把 mp3 上传 10326769 字节
 *     （`highway upload done` → `发送：[文件:…mp3]`），**都发给了 user_id=984776985**。
 *   · 但 SnowLuma 是**登录他自己的号**在跑，所以这条文件**作为 from=管理员 的事件回环回来**，
 *     而 handleIncoming 里"事件带 file 段就先下载"**完全不检查这是不是自己刚发的**：
 *       - 她上下文里多出一条 **他"发来"的文件**（13:09:18 `isSelf=false isOwner=true`）；
 *       - 还对**她自己唱的歌**跑了语音转文字，留下 `Zither HarpZither Harp…` 这种垃圾。
 *   · bridge.log 里成对出现（UTC）：`05:07:41 工具发送文件` → `05:08:50 已下载 同名同体积`。
 *
 * 本用例锁：①记过指纹的文件被认成回声 ②**没记过的文件（他真发的）绝不能被吃掉**
 *   ③指纹必须看**内容**而不能只看名字/体积 ④过期与总量有界。
 *
 * 用法: node scripts/test-self-file-echo.mjs
 */
import { bridgeHarness } from './audit-bridge-harness.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  const B = (s) => Buffer.from(s, 'utf8');

  console.log('\n[1] 自己发出去的文件：回环回来必须被认成回声');
  {
    const mp3 = B('FAKE-MP3-BYTES-'.repeat(500));
    h.recordSelfFileSent(mp3, '反方向的钟（她唱的·带伴奏）.mp3', 'private:984776985');
    const hit = h.matchSelfFileEcho(mp3);
    check('同样的字节 → 认成回声', !!hit, JSON.stringify(hit));
    check('回声条目记得是发给谁的', hit?.key === 'private:984776985', JSON.stringify(hit?.key));
    check('回声条目留着原名（日志要用）', hit?.name === '反方向的钟（她唱的·带伴奏）.mp3', String(hit?.name));
    check('台账里确实有 1 条', h.recentSelfFiles.size >= 1, String(h.recentSelfFiles.size));
  }

  console.log('\n[2] 他真发的文件绝不能被吃掉（比回声污染更糟）');
  {
    const hisFile = B('TOTALLY-DIFFERENT-CONTENT-他发来的实验指导书');
    check('没记过的内容 → 不是回声', h.matchSelfFileEcho(hisFile) === null);
    // ⚠️ 关键反例：**大小一样但内容不同**也要区分开（只看体积的实现会在这里出错）
    const mine = B('A'.repeat(1000));
    const his = B('B'.repeat(1000));
    h.recordSelfFileSent(mine, 'x.mp3', 'private:984776985');
    check('体积相同、内容不同 → 他不是回声', h.matchSelfFileEcho(his) === null);
    check('而我自己那份仍然是回声', h.matchSelfFileEcho(mine) !== null);
  }

  console.log('\n[3] 脏输入不崩');
  {
    check('空 buffer → null', h.matchSelfFileEcho(Buffer.alloc(0)) === null);
    check('非 Buffer → null', h.matchSelfFileEcho('随便一个字符串') === null);
    check('null → null', h.matchSelfFileEcho(null) === null);
    let threw = false;
    try { h.recordSelfFileSent(null, 'x', 'k'); h.recordSelfFileSent('not buffer', 'x', 'k'); } catch { threw = true; }
    check('record 对坏输入不抛', !threw);
  }

  console.log('\n[4] 台账有界（不能无限长大）');
  {
    for (let i = 0; i < 60; i++) h.recordSelfFileSent(B('unique-' + i), `f${i}.mp3`, 'private:1');
    check('总量被卡在上限内（<=40）', h.recentSelfFiles.size <= 40, String(h.recentSelfFiles.size));
  }

  console.log('\n[5] 源码守卫：接收侧必须真的用这个台账');
  {
    const src = (await import('node:fs')).readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
    check('接收侧在收文件前查回声', /const echo = entry\?\.buffer \? matchSelfFileEcho\(entry\.buffer\) : null;/.test(src));
    check('命中回声就 continue（不进 incomingFiles）', /selfFileEchoes\.push\(\{ name: entry\.name/.test(src));
    check('发送成功后记指纹', /recordSelfFileSent\(fs\.readFileSync\(filePath\), name, `\$\{kind\}:\$\{id\}`\)/.test(src));
    check('用 sha256 而不是只比体积', /createHash\('sha256'\)/.test(src) && /`\$\{buffer\.length\}:\$\{h\}`/.test(src));
    // ⚠️ 这处最容易漏：光不 push 进 incomingFiles 不够 —— segmentsToText 是**按 fileId 查缓存**
    //    渲染文本的，缓存里已经有这份，所以必须给它打标记，否则"他发来的文件 + whisper 转写"
    //    照样出现在她的上下文里（第一次改完就是这个漏洞）。
    check('回声条目要打 selfEcho 标记', /entry\.selfEcho = true;/.test(src));
    check('segmentsToText 文件分支认这个标记（先于 error/text/音频转写判断）', /if \(cached\?\.selfEcho\) \{/.test(src));
    const iEcho = src.indexOf('if (cached?.selfEcho) {');
    const iAudio = src.indexOf('AUDIO_FILE_EXT.has(fileExtOf(fileName))');
    check('标记判断在"音频转写"之前（否则还是会对她自己唱的歌跑 whisper）', iEcho > 0 && iAudio > 0 && iEcho < iAudio, `echo@${iEcho} audio@${iAudio}`);
    check('语音条也记了指纹（现成音频那条路）', /recordSelfFileSent\(fs\.readFileSync\(chk\.real\)/.test(src));
    check('语音条也记了指纹（合成那条路）', /recordSelfFileSent\(fs\.readFileSync\(made\.wav\)/.test(src));
  }
} finally {
  await h.close();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
