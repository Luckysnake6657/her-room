// 批量跑一批离线回归测试，只打印每个脚本的末行（通过/失败汇总），最后给出总表。
// 用法：node scripts/run-test-batch.mjs [脚本名…]   不带参数就跑内置清单。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT = [
  'test-tone-and-bubbles.mjs', 'test-admin-command.mjs', 'test-office-extract.mjs', 'test-file-size-limits.mjs',
  // 旧版 .doc 正文读不出来（2026-10-13：他发实验指导书 .doc，她 4 次只收到"没有可取的图"，
  // 最后只能让他拍照片）—— 提取器能扫出文字，但端点/工具没人用 r.text
  'test-doc-legacy-text.mjs',
  // QQ 分享卡片要读出标题/摘要/链接（2026-10-14：小黑盒帖子是 JS 空壳页抓不到正文，
  // 但他一转发起 QQ 就把标题/摘要/链接放进卡片了，桥接却压成 [卡片消息] 全丢掉）
  'test-card-segment.mjs',
  // 全路径许可意图识别不能误报（2026-10-14：「你权限没那么大吧」「哦牛批」都开了一次许可；
  // 误判 = 白开一次"能发任意文件"的口子）
  'test-path-grant-intent.mjs',
  // 许可第三次误报（2026-10-18）：他随口一句「我现在给你的权限不低」就开了许可。
  // 判据已错三次、每次都是"太宽"——这条专锁"闲聊/陈述已给的权限不得授权"，
  // 并锁 owner 守卫（只有管理员能开）
  'test-path-grant-chat.mjs',
  // 别把"自己发出去的文件回声"当成他发来的文件（2026-10-16：她唱完发出去的 mp3
  // 以 from=管理员 的事件回环回来，被记成"他发来的文件"，还对她自己唱的歌跑 whisper）
  'test-self-file-echo.mjs',
  // 唱歌是异步的，工具不许"谎报唱完"（2026-10-16：15:28 工具回"唱完了、已经发给他"，
  // 实际 15:40:02 才发出去 —— 她只能替一个没发生的事实作证）
  'test-sing-async-honesty.mjs',
  // 「今天还没写日记」的轻提醒（2026-10-18 申请 #45：她 10/17 整天没写）
  // 锁"每天最多一次" + "标记不许落盘"（落盘会让测试把当天提醒吃掉）
  'test-diary-nudge.mjs',
  // 「行，……」当起句成了口头禅（2026-10-16 申请 #41：他连指出四次"这个我看已经成你口头禅了"
  // →"你说话得练练口语化了"）—— 这条规矩的价值全在具体性，抽象话等于没写
  'test-tone-opener.mjs',
  'test-text-encoding.mjs', 'test-incoming-dedupe.mjs', 'test-mute-reaction.mjs',
  'test-lone-surrogate.mjs', 'test-session-rotation-dimension.mjs', 'test-session-file-format.mjs', 'test-system-receipts.mjs', 'test-direct-wake-limit.mjs',
  // 引用 id 漂移取证（2026-10-12）：网关 get_msg 对同名 id 解析不稳 → 记下来 + 定期复查落证据。
  // 和 test-quote-time.mjs（渲染侧兜底）配对：一个管"显示对"，一个管"留证据"。
  'test-quote-drift.mjs',
  // 线路优化（2026-10-12）：① 一次发太多条自动截断而不是整条拒绝（省一整轮往返）；
  // ② 停不掉的退役会话进"垃圾回收"清单并自动重试（别让旧会话白烧 token）。
  'test-send-overflow.mjs', 'test-session-gc.mjs',
  // 按她自己的诉求做的三件事（申请 #26，管理员 2026-10-13「我这次遵循她的选择」）：
  // 连续性（seed 可配）+ 别断在半路（过期想法端到眼前）+ 读懂图（不扩权、只用现有工具）
  'test-continuity.mjs',
  // MATLAB 沙箱（2026-10-13）：她要能自己跑作业代码 + 出图 → 纯逻辑（绘图判断/代码预检/限频/截断/重放解析）
  'test-matlab-sandbox-logic.mjs',
  // 无头浏览器渲染（2026-10-14）：SPA 分享页抓不到正文 → web_fetch 自动渲染兜底；
  // 纯逻辑（要不要渲染 / 内网必须前置拒 / 浏览器探测）离线可测
  'test-safe-render-logic.mjs',
  // 「他正在听/看什么」（2026-10-14）：系统媒体会话 → 便条进她的上下文（她不需要新工具）
  'test-now-playing.mjs',
  // 天气（2026-10-23，宁波）：环境信息进提示词 + 日记抬头带星期/天气 + 低权重新增情绪
  'test-weather.mjs',
  // 语音转文字（2026-10-14）：AMR → ffmpeg → faster-whisper（本机）；纯逻辑离线可测
  'test-voice-transcribe.mjs',
  'test-speech-logic.mjs',
  'test-diary-logic.mjs',
  'test-gallery-logic.mjs',
  'test-songs-logic.mjs',
  'test-affect-residue.mjs',
  'test-wake-retry-loop.mjs', 'test-role-play.mjs', 'test-recall.mjs',
  'test-md-to-plain.mjs', 'test-console-section-refresh.mjs', 'test-core-memory.mjs',
  'test-core-memory-persist.mjs', 'test-stickers.mjs', 'test-sticker-classify.mjs',
  'test-sticker-emojiid.mjs', 'test-forward.mjs', 'test-slang-learn.mjs',
  'test-vision-media.mjs', 'test-paper-pdfs.mjs',
  // 需要命令行参数的脚本（test-pdf-safe.mjs <pdf…>、test-role-editor.mjs <token>）
  // 不放进来：它们不带参数退出码就是 1，会被误报成失败。
  'test-qq-mode-plugin.mjs', 'test-setup-dsh-idempotent.mjs',
  // setup-dsh 的集成回归（配置保留、失败即停、Windows CLI 回调、preset bundle 链接与注册）。
  // 以前只在文档里让人手动跑 `node scripts/test-audit-setup.mjs` —— 手动的东西等于不存在，
  // 而 2026-10-10 那次 preset 换 bundle 形式恰恰需要它守住"装上了没有"。~1s，放进来。
  'test-audit-setup.mjs',
  'test-mux-reconnect.mjs', 'test-ow-hero-aliases.mjs', 'test-v2-wait.mjs',
  'test-wait-unseen.mjs', 'test-dsh-v2-wait.mjs', 'test-cross-send-modes.mjs',
  'test-cross-send-no-notify.mjs', 'test-audit.mjs', 'test-mcp-host.mjs',
  'test-mcp-web-search.mjs', 'test-mcp-safe.mjs', 'test-mcp-servers-stdio.mjs',
  // 群语料库 / 群风格卡（2026-09-29：拿群聊数据"学"说话方式）
  'test-group-style.mjs',
  // 情感模块（2026-09-30：离线训练 + 在线推理；无权重即中性、只注入学过的维度）
  'test-emotion.mjs',
  // 消息的可读时间（2026-09-30：她把 12 分钟前说成"上午" → 模型只拿到毫秒 epoch）
  'test-message-time.mjs',
  // 「他（owner）」的印象变体并回一条（2026-10-13：12 个碎片各只有 1~8 分，
  // 一条都排不进注入位 → 她每轮只看到【对群友的印象】空标题）
  'test-owner-impression-merge.mjs',
  // 发送节奏 / 刷屏节流（2026-09-30：同一时间发出 / 长上下文不引用 / 群里热闹时刷屏）
  'test-send-pacing.mjs',
  // 消息列表解析（2026-10-01：全角逗号让 JSON.parse 抛错 → 整串 JSON 被当一条发到 QQ 上）
  'test-message-list.mjs',
  // 记忆衰退曲线 + 年龄标签（2026-10-01：她把两天前的旧事当今天讲）
  'test-memory-decay.mjs',
  // 省 token 的守卫（2026-10-01：工具面去重，但规则不许两边都丢、也不许又涨回去）
  'test-token-budget.mjs',
  // 工具日志要记得下失败原因（2026-10-01：45 条失败的 error 全是 null，等于黑盒）
  'test-tool-log-reason.mjs',
  // 沉睡前观察：'unseen-unread' 立即返回也要算观察（2026-10-01：群里热闹时她无限空转烧 token）
  'test-presleep-observe.mjs',
  // 幽灵等待：连接被掐断后名额不释放会把会话冻住（2026-10-01：她自己报了 3 次，卡十几分钟）
  'test-ghost-wait.mjs',
  // 引用要带"那条消息是多久之前说的"（2026-10-01：她认不出自己 5 天前说的话，猜成了"别的群"）
  'test-quote-time.mjs',
  // 同一条消息不能递给她两遍（2026-10-01：真等到消息那条路不标记已读 → 下一轮又交一遍）
  'test-wait-handover.mjs',
  // agent 报错不许发进出事的会话（2026-10-02：8 条 SSE 报错被发进两个群）
  'test-agent-error-notice.mjs',
  // 全局静默（2026-10-02：管理员要"能远程开关"；她自己是做不到的）
  'test-silent-all.mjs',
  // 他交代的长期禁令（"CS2 群里别说话"）存成了印象，被预算挤掉 → 每轮都没进提示词
  'test-standing-rule.mjs',
  // 静默不该断粮：语料库/情感/黑话原来散在静默 return 之后，静默一开全停学
  'test-learning-feed.mjs',
  // 每轮注入的行为规则清单（规则文本已抽到 src/prompt-rules.js，这条守住"每条都真进了提示词"）
  'test-prompt-rules.mjs',
  // 执行申请通道：她只能申请不能执行；桥接只存文本、没有执行路径；批准只认管理员私聊措辞
  'test-task-requests.mjs',
  // 长文续读（申请 #1）：web_fetch 的 offset 分页 —— 纯函数快测，不联网
  'test-safe-fetch-paging.mjs',
  // 发文件（申请 #3）：出站目录锁 + 敏感路径锁 + 四道既有闸门
  'test-send-file.mjs',
  // 申请自动开工（批准 → 桥接自己投给工作会话）+ 看门狗（不许停在 approved 干等）
  'test-task-runner.mjs',
];

const list = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const rows = [];
for (const name of list) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lines = out.trim().split('\n').filter(Boolean);
  const tail = lines.slice(-2).join(' | ').slice(0, 220);
  const ok = r.status === 0;
  rows.push({ name, ok, status: r.status, sec: ((Date.now() - started) / 1000).toFixed(1), tail });
  console.log(`${ok ? '✅' : '❌'} ${name}（${rows.at(-1).sec}s, exit ${r.status}）${ok ? '' : `\n   ${tail}`}`);
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n===== 汇总：${rows.length - failed.length}/${rows.length} 通过${failed.length ? `，失败：${failed.map((r) => r.name).join('、')}` : ''} =====`);
process.exit(failed.length ? 1 : 0);
