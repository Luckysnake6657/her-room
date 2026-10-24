/**
 * 回归：**引用要带"那条被引用的消息是多久之前说的"**（2026-10-01 修）。
 *
 * 现场（管理员截图问"私聊说的内容她怎么会看不到？"）：
 *   他引用她 9/26 18:33 在私聊说的一句「印象就是自来熟：上来一句"兔兔我是谁"…」说"厉害"。
 *   她只看到"谁 + 说了什么"，**没有时间**；而那条原文既不在她上下文里（22:22 会话刚轮换、只 seed 14 条），
 *   也不在桥接保留窗口里（每会话只留最近 100 条 → 私聊只覆盖到当天 17:15 之后）。
 *   于是她只能猜，还猜错了：「那大概是别的群里的，这边我看不到那条」——
 *   **QQ 的引用不可能跨会话**，这个猜测一定是错的。
 *
 * 修法：`resolveReplyInfo` 把 OneBot 返回的 `time`（秒）带出来，渲染成 `[引用 某人（5天前）：…]`；
 *   DIRECTION_HINT 说明"引用只可能来自同一个会话，别猜别的群"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};
const { bridgeHarness } = await import('./audit-bridge-harness.mjs');

const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  h.setMode('reserved2');
  const KEY = 'private:984776985';
  const SELF = 999;

  console.log('\n[1] 老消息：OneBot 的 time 是**秒**，要换算成毫秒再渲染年龄');
  {
    const fiveDaysAgoSec = Math.floor((Date.now() - 5 * 24 * 3600 * 1000) / 1000);
    h.setGetMessageFixture((id) => ({
      message_id: Number(id),
      time: fiveDaysAgoSec,
      sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
      message: [{ type: 'text', data: { text: '印象就是自来熟：上来一句“兔兔我是谁”' } }],
    }));
    const info = await h.resolveReplyInfo('private', 984776985, '-842301499', SELF);
    check('解析成功且带回时间', !!info && Number(info.time) > 0, JSON.stringify(info));
    const days = Math.round((Date.now() - Number(info.time)) / 86400000);
    check('时间换算对（5 天前，不是 1970 也不是 5 万天）', days === 5, `算出来 ${days} 天`);

    const rendered = await h.segmentsToText([{ type: 'reply', data: { id: '-842301499' } }], {
      resolveReply: (id) => h.resolveReplyInfo('private', 984776985, id, SELF),
    });
    console.log('    渲染结果:', rendered);
    check('引用里带上了**绝对时刻 + 相对年龄**',
      /\[引用 熊猫人永不为奴（\d+\/\d+ \d{2}:\d{2}，5天前/.test(rendered), rendered);
    // 2026-10-12 深夜：偏旧的引用要**当场**标"疑似旧引用头"（她本轮就能看到，不用靠常识发现"不搭"，
    // 也不用反问他"时间内容是啥"）。原来只在"两次解析不一致"时才标，把更常见的"客户端挂旧锚点"漏了。
    check('偏旧的引用当场标"⚠️疑似旧引用头"', /⚠️疑似旧引用头/.test(rendered), rendered);
  }

  console.log('\n[2] 刚说的话：应该是"刚刚/几分钟前"，不是"5天前"');
  {
    h.setGetMessageFixture((id) => ({
      message_id: Number(id),
      time: Math.floor((Date.now() - 30 * 1000) / 1000),
      sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
      message: [{ type: 'text', data: { text: '刚刚说的那句' } }],
    }));
    const rendered = await h.segmentsToText([{ type: 'reply', data: { id: '-1' } }], {
      resolveReply: (id) => h.resolveReplyInfo('private', 984776985, id, SELF),
    });
    console.log('    渲染结果:', rendered);
    check('30 秒前 → 时刻 + 刚刚', /（\d{2}:\d{2}，刚刚）/.test(rendered), rendered);
  }

  console.log('\n[2b] 旧同名消息兜底：同一 id 两次解析不一致时取**更新的**那条（2026-10-12 实测）');
  {
    const freshSec = Math.floor((Date.now() - 20 * 60 * 1000) / 1000);
    const oldSec = Math.floor(new Date('2026-09-29T14:38:00+08:00').getTime() / 1000);
    let call = 0;
    h.setGetMessageFixture((id) => {
      call += 1;
      const isOld = call === 1;
      return {
        message_id: Number(id),
        time: isOld ? oldSec : freshSec,
        sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
        message: [{ type: 'text', data: { text: isOld ? '第十八卷已经是青年期部下篇了' : '不过错的方向很集中' } }],
      };
    });
    const info = await h.resolveReplyInfo('private', 984776985, '-2063537997', SELF);
    check('第一次给旧同名、第二次给新消息 → 采用新的那条',
      !!info && Math.abs(Number(info.time) - freshSec * 1000) < 2000, JSON.stringify({ got: info?.time, want: freshSec * 1000 }));
    check('正文也用新的那条（不是旧同名）', /错的方向很集中/.test(String(info?.text ?? '')), String(info?.text ?? ''));
    check('这种"兜底救回来"的情况**不**打疑似标记', info?.suspectIdReuse !== true);
  }

  console.log('\n[2c] 客户端挂旧锚点（两次解析一致的老消息）→ 也要当场标"疑似旧引用头"');
  {
    const oldSec = Math.floor(new Date('2026-09-29T14:49:00+08:00').getTime() / 1000);
    h.setGetMessageFixture((id) => ({
      message_id: Number(id),
      time: oldSec,
      message_seq: 754835338,
      sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
      message: [{ type: 'text', data: { text: '凤雅龙剑举成大上段，基列奴在她背后' } }],
    }));
    const info = await h.resolveReplyInfo('private', 984776985, '1652952769', SELF);
    const rendered = await h.segmentsToText([{ type: 'reply', data: { id: '1652952769' } }], {
      resolveReply: (id) => h.resolveReplyInfo('private', 984776985, id, SELF),
    });
    console.log('    渲染结果:', rendered);
    // 解析结果本身不许被改（他真引用老消息时，内容得如实显示）
    check('仍然用那条老消息（两次一致，内容如实显示）', Math.abs(Number(info?.time) - oldSec * 1000) < 2000);
    check('当场标注"⚠️疑似旧引用头"（她本轮可见）',
      info?.suspectIdReuse === true && /⚠️疑似旧引用头/.test(rendered), rendered);
    check('标注不是"他在翻旧账"的结论（措辞用"疑似"）', /疑似/.test(rendered) && !/他真在翻旧账/.test(rendered));
  }

  console.log('\n[2d] 阈值可关：quote.anomalyHours=0 时不标（配置项仍然管用）');
  {
    const prevQuote = h.cfg.socialV2.quote;
    h.cfg.socialV2.quote = { ...(prevQuote ?? {}), anomalyHours: 0 };
    const oldSec = Math.floor(new Date('2026-09-29T14:49:00+08:00').getTime() / 1000);
    h.setGetMessageFixture((id) => ({
      message_id: Number(id), time: oldSec, message_seq: 1,
      sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
      message: [{ type: 'text', data: { text: '老消息' } }],
    }));
    const info = await h.resolveReplyInfo('private', 984776985, '-888888', SELF);
    check('关掉之后不打标', info?.suspectIdReuse !== true, JSON.stringify(info));
    h.cfg.socialV2.quote = prevQuote;
  }

  console.log('\n[2e] 偏旧引用 + 她刚从说话 → 直接给出"他大概要接你刚说的那句"（省掉她反问一轮）');
  {
    // 管理员 2026-10-12 深夜亲自澄清：他客户端显示引用的是她**刚说的**「躺着刷手机这状态，猜都不用猜」，
    // 报文里却是 9/29 的旧 id。既然"本意=接她刚说的那句"是高频情形，就把它当候选直接写进引用里。
    const key = 'private:984776985';
    const st = h.getSocialV2State(key);
    st.recentMessages.push({ sender: '我', isSelf: true, plain: '躺着刷手机这状态，猜都不用猜', text: '躺着刷手机这状态，猜都不用猜', time: Date.now() - 30000 });
    const oldSec = Math.floor(new Date('2026-09-29T14:49:00+08:00').getTime() / 1000);
    h.setGetMessageFixture((id) => ({
      message_id: Number(id), time: oldSec, message_seq: 754835338,
      sender: { user_id: 984776985, nickname: '熊猫人永不为奴' },
      message: [{ type: 'text', data: { text: '凤雅龙剑举成大上段' } }],
    }));
    // 换一个 id：同一个 id 在 [2c] 已经解析过，replyInfoCache 会直接命中（缓存里没有候选字段）
    const info = await h.resolveReplyInfo('private', 984776985, '1652952770', SELF);
    const rendered = await h.segmentsToText([{ type: 'reply', data: { id: '1652952770' } }], {
      resolveReply: (id) => h.resolveReplyInfo('private', 984776985, id, SELF),
    });
    console.log('    渲染结果:', rendered);
    check('info 里带上了候选（她最近 10 分钟内说的最后一句）',
      /躺着刷手机这状态/.test(String(info?.recentSelfHint?.text ?? '')), JSON.stringify(info?.recentSelfHint ?? null));
    check('渲染里给出"他大概是要接你刚说的「…」"', /他大概是要接你刚说的「躺着刷手机这状态/.test(rendered), rendered);
    // 反向：她自己最近没说话（只有对方说的）→ 不许瞎猜
    const st2 = h.getSocialV2State('private:777');
    st2.recentMessages.push({ sender: '他', isSelf: false, plain: '在吗', text: '在吗', time: Date.now() - 5000 });
    const info2 = await h.resolveReplyInfo('private', 777, '1652952769', 777);
    check('她最近没说话 → 不给候选（不瞎猜）', !info2?.recentSelfHint, JSON.stringify(info2?.recentSelfHint ?? null));
  }

  console.log('\n[3] 拿不到时间时不能崩、也不能编（照样出引用，只是没有括号）');  {
    h.setGetMessageFixture(() => null);   // OneBot 查不到（跨会话/已删除）
    const rendered = await h.segmentsToText([{ type: 'reply', data: { id: '-999' } }], {
      resolveReply: async () => ({ sender: '群友', text: '某句话' }),
    });
    check('没有时间就不加括号', /\[引用 群友：某句话\]/.test(rendered), rendered);
    check('解析不出（null）时退化成 [引用消息]', (await h.segmentsToText([{ type: 'reply', data: { id: '-999' } }],
      { resolveReply: () => null })) === '[引用消息]');
  }

  console.log('\n[4] 源码级守卫：别把时间又丢了');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    check('time 按秒→毫秒换算', /rawTime \* 1000/.test(src));
    check('渲染时用的是 resolveReplyInfo 算好的时刻+年龄（不能在渲染处调 humanTime：那是 main 作用域，渲染函数在模块顶层看不见它）',
      /info\.atText, info\.agoText\]\.filter\(Boolean\)\.join\('，'\)/.test(src) && /const withAgo = \(info\) =>/.test(src));
    check('DIRECTION_HINT 说明"引用不可能跨会话、别猜别的群"', /绝不会是别的群\/别的私聊/.test(src) && /别猜"大概是别的群"/.test(src));
  }
  console.log('\n[5] 引用旁证告警（2026-10-12 申请 #20）：被引消息比新消息早超阈值 → 留系统便条');
  {
    // 现场：他 15:22:37 的「哈」报文里 time 是新的，reply 段却带 9/29 的 id（差 12 天）。
    // 桥接/网关都只是照 id 取回，所以要有一个**不依赖客户端**的信号来判断这事还在不在。
    // ⚠️ 私聊的归属校验要求 user_id === convId 或 === selfId（resolveReplyInfo 里那道跨会话闸门），
    //    所以 fixture 的 user_id 必须给 984776985 —— 只放 sender.nickname 会被判"无法确认归属"直接返回 null。
    const oldSec = Math.floor((Date.now() - 12 * 24 * 3600 * 1000) / 1000);
    h.setGetMessageFixture((id) => ({
      message_id: Number(id),
      time: oldSec,
      user_id: 984776985,
      sender: { user_id: 984776985, nickname: '今晚吃兔兔' },
      message: [{ type: 'text', data: { text: '睡了，明天你想演再叫我' } }],
    }));
    const before = (h.getSocialV2State(KEY)?.recentMessages ?? []).length;
    const info = await h.resolveReplyInfo('private', 984776985, '369046228', SELF);
    const notes = (h.getSocialV2State(KEY)?.recentMessages ?? []).slice(before).filter((m) => m.system === true);
    check('超阈值的引用会留一条系统便条', notes.length === 1, `新增便条 ${notes.length} 条`);
    const note = String(notes[0]?.text ?? '');
    console.log('    便条:', note.slice(0, 130));
    check('便条带原始 reply id', note.includes('369046228'), note.slice(0, 120));
    check('便条带被引消息的真实时间与年龄', /9\/29|天前|小时前/.test(note) && /12/.test(note), note.slice(0, 140));
    check('便条说明"网关返回 id 与请求一致"（= 不是映射错）', /网关返回 id 与请求一致/.test(note), note.slice(0, 150));
    check('便条提醒别把旧内容当本轮话题', /别把被引的旧内容当成本轮话题/.test(note), note.slice(-90));
    check('引用本身照旧正常返回（告警不改变解析结果）', !!info && info.text === '睡了，明天你想演再叫我', JSON.stringify(info)?.slice(0, 120));

    // 防刷屏：**同一条老消息被反复引用**时不该反复留便条（他会连点同一条）。
    // ⚠️ 去重键取的是 **get_msg 返回的 messageId**（不是请求的 id），所以要模拟真实情况：
    //    他点的是同一条老消息 369046228，返回的 messageId 也是 369046228。
    const before2 = (h.getSocialV2State(KEY)?.recentMessages ?? []).length;
    await h.resolveReplyInfo('private', 984776985, '369046228', SELF);
    await h.resolveReplyInfo('private', 984776985, '369046228', SELF);
    const notes2 = (h.getSocialV2State(KEY)?.recentMessages ?? []).slice(before2).filter((m) => m.system === true);
    check('同一条老消息被反复引用 → 半小时内只留一条（不刷屏）', notes2.length === 0, `又新增 ${notes2.length} 条`);

    // 反向：正常的新鲜引用**不能**告警（否则她会被噪音淹没）
    h.setGetMessageFixture((id) => ({
      message_id: Number(id),
      time: Math.floor((Date.now() - 10 * 1000) / 1000),
      user_id: 984776985,
      sender: { user_id: 984776985, nickname: '今晚吃兔兔' },
      message: [{ type: 'text', data: { text: '刚发的一句' } }],
    }));
    const before3 = (h.getSocialV2State(KEY)?.recentMessages ?? []).length;
    await h.resolveReplyInfo('private', 984776985, '777001', SELF);
    const notes3 = (h.getSocialV2State(KEY)?.recentMessages ?? []).slice(before3).filter((m) => m.system === true);
    check('10 秒前的新鲜引用 → 不告警', notes3.length === 0, `新增 ${notes3.length} 条`);

    // 可关 / 可调阈值
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    check('阈值可配（socialV2.quote.anomalyHours，默认 6）', /socialV2\?\.quote\?\.anomalyHours \?\? 6/.test(src));
    check('阈值 <=0 时整个告警关掉', /if \(!\(hours > 0\) \|\| !info\?\.time\) return null/.test(src));
  }

} finally {
  await h.close();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
