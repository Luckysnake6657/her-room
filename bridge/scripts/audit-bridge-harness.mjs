// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as office from '../src/office-extract-worker.mjs';
import * as officeSafe from '../src/office-extract-safe.mjs';
// 情感模块：bridge.js 里 `import * as emotionNet`，但本 harness 会把 import 行整条剥掉、
// 依赖靠注入沙箱全局来补 —— 所以新增模块必须在这里也 import 并 ... 展开（否则 bridge.js 一加载就 ReferenceError，
// 全部走 harness 的用例会一起挂）。
import * as emotionNet from '../src/emotion-net.js';
// 消息列表解析（bridge.js 里调用 `parseMessageList(...)`）：同样必须注入，
// 否则沙箱里 ReferenceError，而调用点在端点 try/catch 里 → 表现为"发送莫名失败"
import { parseMessageList } from '../src/message-list.js';
// 记忆衰退曲线（bridge.js 里 `memoryDecayScore(...)` / `humanAgo(...)`；import 行会被剥掉，必须注入）
import * as memoryDecay from '../src/memory-decay.js';
// 每轮注入的行为规则文本（2026-10-02 从 buildWakePromptV2 抽成模块）。
// 漏注入的表现是"整个提示词构建立刻 ReferenceError"——测试会当场炸，不会静默（这点比情感模块那种被 catch 吞掉的好）。
import * as promptRules from '../src/prompt-rules.js';
import * as matlabSandbox from '../src/matlab-sandbox.js';
import * as nowPlaying from '../src/now-playing.js';
import * as voice from '../src/voice.js';
import * as speech from '../src/speech.js';
import * as diary from '../src/diary.js';
import * as weather from '../src/weather.js';
import * as gallery from '../src/gallery.js';
import * as songs from '../src/songs.js';
import * as affectResidue from '../src/affect-residue.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], http: [], msgSeq: 0 };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  // 让测试能造"被引用的老消息"：`resolveReplyInfo` 走 bot.getMessage（OneBot 服务端查，
  // 所以连几天前的消息都能拿到 —— 引用里要带它的时间，避免模型猜"这是哪来的"）。
  // ⚠️ 这些钩子必须挂在**类**上（类定义在 harness 作用域，注入进 vm 的是同一个对象）；
  //    不能直接塞进那个 `return {...}` —— 那段是在 vm 里求值的，引用外层变量会 ReferenceError。
  const botInstances = [];
  class FakeBot {
    constructor() { botInstances.push(this); }
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
    async getMessage(id) { return FakeBot.getMessageFixture ? FakeBot.getMessageFixture(id) : null; }
  }
  FakeBot.getMessageFixture = null;
  FakeBot.instances = botInstances;
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  // bridge.js 里有 `export function filterMemoryForChat(...)`（为方便测试直接 import，
  // 见文件末尾的注释）。但这里是 vm.runInContext 按**普通脚本**跑的，遇到 `export`
  // 会直接 SyntaxError: Unexpected token 'export' —— 结果是整套 audit 里 bridge 相关的
  // 用例长期静默失败（只在末尾报一句 "FAILED test-audit-bridge.mjs: exit 1"）。
  // 所以剥掉顶层 export 关键字（不是删除函数，函数本体仍定义在全局）。
  source = source.replace(/^export\s+/gm, '');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    // 会话繁忙判定的内部状态：用于离线复现"会话永久繁忙"这类死锁
    // （真实环境下要等事件流丢一次 turn/end 才能复现，没法按需触发）。
    isConversationBusyV2, v2TurnStartAt, collectors, collectorLastEventAt, pendingWakeKeys,
    markPendingWake, createTurnCollector,
    // 清掉"投递租约"（测试里要连续投递两次时用；生产里它由 turn/end 释放）
    clearPendingWake, disarmPendingWakeLease,
    // 跨会话回声 / 进群提示：纯函数，便于离线验证
    getSocialV2State, buildCrossSessionEchoLine, buildJoinNoticeLine, describeNoticeEvent, dedupeEventList,
    isWakeRateLimited, sessionStorageSlug, buildContextSeedLine,
    // 兜底重试链路（"忙碌 vs 限流"的顺序 bug 就出在这里；retryMs 可配，测试不用真等 60s）
    deferWakeReasonV2, wakeRetryMs, collectorIdleLimitMs, deferLogState,
    // 限流分档：有人直接找她 → 宽松额度；她自己回访/概率唤醒 → 严格额度
    isDirectWakeV2, wakePriorityV2,
    // 真正投递的唤醒提示词（含每轮注入的分寸/排版行）
    buildWakePromptV2,
    // 禁言：被禁期间不唤醒（发不出去=白花钱），解禁后叫她"对禁言说两句"
    isMutedV2, clearMuteStateV2, triggerUnmuteWakeV2, handleNoticeEvent, scheduleWakeV2,
    // 沉睡前观察：'unseen-unread' 立即返回那条路也要计入观察（否则群里热闹时她无限空转）
    preSleepWaitBlockedV2, hasExplicitEndV2, isSleepingConfigV2,
    // 正在长轮询的会话集合（测试要造"幽灵等待"：名额占着但声明的结束时间早过了）
    activeWaits,
    // 引用的解析与渲染（2026-10-01：引用要带"那条消息是多久之前说的"）
    resolveReplyInfo,
    setGetMessageFixture: (fn) => { SnowLumaWebSocketClient.getMessageFixture = fn; },
    getBotInstances: () => SnowLumaWebSocketClient.instances,
    // 报错对外处理（2026-10-02：只通知管理员 + 折叠 + 瞬时错误补一次唤醒）
    notifyAgentError, agentErrorNotices, notifyOwnerOnly,
    // 全局静默（2026-10-02：管理员要"能远程开关"；她自己是做不到的，见 test-silent-all.mjs）
    parseSilenceCommand, setSilentAll, silentAllBlocks, shouldBlockSilentReply,
    // 真正投递一次唤醒（用来验证"哪些唤醒被记账、账记在哪一档"）
    sendWakePromptV2,
    // 入站消息去重（同一 messageId 被重复推送时只处理第一次）
    seenIncomingRefs,
    // 管理员强制撤回 / 强制扮演命令的解析 + "命令口吻"判定（离线可测：他都能怎么下命令）
    parseAdminRecallCommand, parseAdminRoleCommand, parseAdminCommandTone,
    // 撤回留痕（她自己撤的要在记录里标出来，否则"记录是发过的"对不上账）
    markSelfRecalled,
    // 控制台填的"会话"容错（裸群号/QQ号 → group:/private:）
    coerceConversationKey,
    // 角色扮演状态的持久化（2026-09-29：这几个字段原来不在写盘白名单里，重启就丢）
    rolePlayFieldsForSave, restoreRolePlayFields,
    // 老的"静默模式"（roleState.mode）读写：测试要验证"静默期间学习照常"必须能开关它
    readRoleState, writeRoleState,
    // 群语料库 + 聊天风格模版（2026-09-29：拿聊天数据"学"说话方式；通用层 + 每群层）
    feedGroupCorpus, readGroupCorpus, describeGroupStyle, collectGroupCorpusRows,
    buildChatStyleLine, groupStyleProfiles, generalStyleProfile, groupStyleExamples,
    // 情感模块：熔断状态（连续报错自动停用，防止"一堆 bug"拖累主流程）
    emotionRuntimeState, emotionFault, updateEmotionFromMessage, buildEmotionLineFor,
    // 学习类消费端的统一入口（2026-10-02：语料库/情感/黑话原来散在 reserved2 分支里，
    // 静默模式一开就全断粮 —— 现在收成一个入口，且必须在那些 early-return 之前调用）
    feedLearning, learningPrevTextFor,
    // 执行申请通道（2026-10-10）：她只能申请、不能执行；桥接只存文本 + 通知管理员，**没有执行路径**
    readTaskRequests, appendTaskRequest, decideTaskRequest, parseTaskRequestCommand, taskRequestRateOk, looksLikeShortYes,
    // 申请自动开工（2026-10-10）：批准 → 桥接自己把活投给专用工作会话；看门狗兜底不许停在 approved
    runTaskRequest, finishTaskRequest, sweepTaskRequests, buildTaskRunnerPrompt, taskRunnerConfig, ensureWorkSession,
    saveTaskRequests,
    // 挂起提问/审批的登记口：测试要验证"他回「批准 #N」时不会被挂起的提问吞掉"
    registerPending,
    // 消息的可读时间（2026-09-30：她把 12 分钟前的事说成"上午"，根因是模型只拿到毫秒 epoch）
    humanTime, withHumanTime,
    // 发送节奏与刷屏节流（2026-09-30：间隔下限 / 群里热闹时收紧 / 没人接话不许连发）
    computeGapsV2, conversationHeat, consecutiveSelfSends, sendRateLimitInfo, sendLimitError,
    // 消息列表解析（2026-10-01：全角标点让 JSON.parse 抛错 → 整串 JSON 被当一条发到 QQ 上）
    parseMessageList,
    // 文件消息链路：PPT/DOCX 等文档取字后要能被内联进提示词（端到端验证用）
    fetchAndCacheQqFile, segmentsToText, messageFileCache,
    // 按需看图（工具）：页号解析 + 按会话找文档
    parsePageSpec, findConversationDocuments,
    // 图片链路：文档内嵌图 / QQ 图片最终要变成 {type:'image'} 视觉输入
    resolveMediaList, extractMediaFromSegments,
    // 系统回执的"人格"问题（2026-10-10）：统一出口 + 给她留便条，别让她的号和她的记忆对不上
    notifyOwnerSystem, recordSystemReceiptNote,
    // 引用 id 漂移取证（2026-10-12）：网关 get_msg 对同名 id 解析不稳 → 记下来 + 定期复查落证据
    recordQuoteIdWatch, sweepQuoteIdWatch, readQuoteWatch, QUOTE_WATCH_FILE, QUOTE_DRIFT_FILE,
    // 退役会话的垃圾回收（2026-10-12）：stopSessionWork 会报 invalid session/control baseline，
    // 只写日志的话旧会话可能还在烧 token → 记进清单并自动重试
    noteSessionGc, sweepSessionGc, readSessionGc, SESSION_GC_FILE,
    // 发文件：目录锁 / 敏感锁 / 一次性全路径许可（2026-10-10 管理员要的"就给她这一次的权限"）
    sendFileConfig, resolveSendFilePath, parsePathGrantCommand, activePathGrant, grantPathAccess, revokePathAccess, canGrantByShortYes,
    // 「我刚发出去的文件」指纹台账（2026-10-16 申请 #38）：SnowLuma 登的是他的号，所以桥接
    // 发出去的文件会作为 from=管理员 的事件回环回来 —— 靠这个台账认出自己的回声，
    // 别当成他发来的文件（还会对她自己唱的歌跑语音转文字，往她脑子里灌噪声）
    recordSelfFileSent, matchSelfFileEcho, recentSelfFiles,
    // 「今天日记还没写」的轻提醒（2026-10-18 申请 #45）：判据 + 文案。
    // ⚠️ 本 harness 把 ROOT 指到临时目录，所以真实渲染时 diaryTodayCount() 恒为 0
    //    （临时目录里没有日记）—— 那正好是"该提醒"的分支，方便测渲染。
    //    "今天已经写过 → 不提醒"那条用 shouldNudgeDiary 纯函数覆盖。
    shouldNudgeDiary, DIARY_NUDGE_TEXT,
    // 会话轮换判断：**必须按"解开后"的体量**（压缩后的大小会骗人，见函数注释）
    sessionNeedsRotation, sessionHistoryRawBytes, sessionHistoryBytes, sessionFilePath,
    formatMemoryV2, pruneCoreMemory, memoryTtlMs, normalizeImportance, appendMemoryV2,
    // 记忆注入的"真实账本"：要离线复现"她这一轮到底看到了哪几条记忆"，
    // 必须能拿到全局 socialV2（只灌 coreMemory 进去再渲染），否则测的是一份空记忆。
    socialV2, saveSocialV2State, looksLikeBehaviorRule, looksLikeStandingRule, hasStandingRule, memoryInjectBudget, formatMemoryV2ForChat,
    // 工具日志：从 DSH 的 tool/result 事件抠"成功没有/失败原因"（结构是嵌套两层的，踩过坑）
    describeToolResult,
    // 防"半个 emoji → API 400"：按码点截断 / 清除孤立代理项 / 提示词出口兜底
    clip, stripLoneSurrogates, withSlangContext,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    // 这个 harness 把 bridge.js 的 ROOT 指到临时目录，所以 state/roles 都是空的。
    // 测试要"预置一张角色卡/人格卡"时得知道路径（临时角色卡库就靠它验证）。
    paths: { root: ROOT, stateDir: STATE_DIR, rolesDir: path.join(ROOT, 'roles'), rolePlayDir: ROLE_PLAY_DIR },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, path, http, crypto, zlib, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    // bridge.js 显式 import 了 TextDecoder（不依赖全局）；这里给它一份，
    // 否则编码探测会静默退化成"有损 UTF-8"，测试就测不到真实路径了。
    TextDecoder: (await import('node:util')).TextDecoder,
    TextEncoder: (await import('node:util')).TextEncoder,
    // process 是刻意裁剪过的（exit 会抛错，避免被测代码偷偷退出）。但 bridge.js 还会读
    // env / cwd / version 这类只读字段；补齐它们，否则 harness 在启动阶段就 TypeError
    // （和上面的 export 一样，属于 harness 自己漏配，不是被测代码的问题）。
    process: {
      pid: process.pid, platform: process.platform, kill: process.kill,
      exit: (code) => { throw new Error('unexpected exit ' + code); },
      env: { USERPROFILE: temp }, cwd: () => root, argv: ['node', 'src/bridge.js'],
      version: process.version, versions: process.versions, on: () => {}, once: () => {},
    },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    // OneBot 的 HTTP 发送口（`onebotSend` 走 fetch 打 SnowLuma 的 /send_private_msg）：
    // harness 原来**没有 fetch**，于是"真的发一条消息"这条路在离线测试里根本走不通 ——
    // 2026-09-30 要测"发送间隔 / 真实发送时刻 / 引用段 / 刷屏节流"时才补上。
    // 只认 SnowLuma 的地址，别的地址照旧报错（不削弱原有用例：那些路径本来就该失败）。
    fetch: async (url, init = {}) => {
      const target = String(url);
      const base = String(config?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      if (!target.startsWith(base)) throw new Error(`harness fetch: 未预设的地址 ${target}`);
      const action = target.slice(base.length).replace(/^\/+/, '');
      let body = null;
      try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = init.body ?? null; }
      calls.http.push({ action, url: target, body });
      if (action === 'delete_msg') return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: null }) };
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: ++calls.msgSeq } }) };
    },
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector, parseMessageList,
    // 记忆衰退曲线：注意 `normalizeImportance as normalizeMemImportance` 这个**别名**也要给到沙箱
    // （import 行被剥掉后，bridge.js 里用的就是别名）
    ...memoryDecay,
    normalizeMemImportance: memoryDecay.normalizeImportance,
    ...promptRules,
    ...matlabSandbox,
    ...nowPlaying,
    ...voice,
    ...speech,
    ...diary,
    ...weather,
    ...gallery,
    ...songs,
    ...affectResidue,
    // vm 里 import 会被剥掉：桥接用到的 child_process 函数必须注入，否则脚本一加载就 ReferenceError
    execFileSync, spawn,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...office, ...officeSafe, ...emotionNet,
    // ⚠️ 还要把**命名空间对象本身**也放进去：桥接里写的是 `emotionNet.configure(...)`，
    //    而 `...emotionNet` 只展开成员名（configure/scoreText…），不提供 `emotionNet` 这个标识符。
    //    漏了这一行 → 沙箱里 `emotionNet is not defined` → 被桥接的 try/catch 吞掉 → **静默失效**
    //    （集成测试当场抓到，不然上线后就是"情绪永远不动、日志里啥也没有"）。
    emotionNet,
    // ⚠️ 同理：桥接里写的是 `affectResidue.mixPad(...)`，光有 `...affectResidue` 只展开成员名，
    //    不提供 `affectResidue` 这个标识符。漏了 → 沙箱里 ReferenceError → 被 buildEmotionLineFor
    //    的 try/catch 吞成空串 → **语气行静默消失**（test-emotion 一次挂 5 条）。2026-10-14。
    affectResidue,
    ...globals,
  });
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
