/**
 * 把"模型可能传来的各种形状"统一成 `string[]`（要发的消息列表）。
 *
 * ## 为什么必须有这个模块（2026-10-01 真实事故，管理员截图）
 * 她发了这么一条到 QQ 上（**方括号、引号、逗号全都在**）：
 * ```
 * ["你都坐这儿跟我贫了，肯定是赶上了", "几点的车"，"不对，问错了", "睡了没"]
 * ```
 * 原因：她把 `messages` 参数传成了**字符串**，而当时的兜底逻辑是
 * `if (trimmed.startsWith('[')) { try { JSON.parse } catch {} }` —— 那串里第 3 项前面是
 * **全角逗号（，）**，`JSON.parse` 抛错 → `catch {}` 什么都不做 → **整个字符串当一条消息发了出去**。
 * 这是最糟的一类失败：**不报错、不重试、用户直接看到原始 JSON**。
 *
 * 而且这段逻辑在 MCP（3 个工具）和桥接（3 个端点）里**各抄了一份**，所以这里统一成一份。
 *
 * ## 解析顺序（每一步都尽量不改变消息内容）
 * 1. 数组 → 逐项字符串化
 * 2. 字符串 → 去掉 markdown 围栏、首尾空白
 * 3. `[` 开头且形如列表（`[` 后面紧跟引号）：
 *    a. 严格 `JSON.parse`
 *    b. 失败 → **按引号扫描**（支持 `"…"` 和 `“…”`，处理 `\"` 转义）——**原样保留内容**，
 *       所以消息里的全角逗号不会被改掉
 *    c. 仍失败 → 去掉外层方括号当一条发（宁可少分条，也绝不把 JSON 文本发出去）
 * 4. `"` / `“` 开头的单条 JSON 字符串 → 剥引号
 * 5. 其它 → 就是一条普通消息
 *
 * @param {unknown} input 模型传来的原值
 * @returns {{ messages: string[], repaired: boolean, note: string }}
 *   `repaired=true` 表示"输入不是干净的数组、我们做了修复"，调用方可以据此提醒模型下次传数组。
 */

const FENCE = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;
/** 像列表的字符串：左括号后面紧跟（可含空白的）引号 —— 用来把"[图片]"这种正常消息排除掉。
 *  方括号/引号都兼容全角（模型中文输出时经常手滑成全角）。 */
const LOOKS_LIKE_LIST = /^[\[［]\s*["“'‘]/;
/** 引号对：ASCII 双/单引号 + 全角双/单引号 */
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };

/** 剥掉 markdown 围栏（模型常把 JSON 包在 ```json 里） */
function stripFence(s) {
  const m = s.match(FENCE);
  return m ? m[1].trim() : s;
}

/**
 * 按引号扫出所有片段：`"a","b"` / `“a”，“b”` / `['a','b']` 都能抓，且**内容原样保留**。
 * 只处理一层引号，不处理嵌套对象（消息列表里不该有）。
 */
function scanQuotedSegments(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s[i];
    const close = QUOTE_PAIRS[open];
    if (!close) { i++; continue; }
    // "" 与 '' 支持反斜杠转义；全角引号不需要
    const escaped = open === '"' || open === "'";
    let j = i + 1;
    let buf = '';
    let closed = false;
    while (j < s.length) {
      if (escaped && s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
      if (s[j] === close) { closed = true; break; }
      buf += s[j];
      j++;
    }
    if (!closed) break;                       // 引号没闭合 → 放弃扫描
    out.push(buf);
    i = j + 1;
  }
  return out;
}

export function parseMessageList(input) {
  const clean = (arr) => arr.map((x) => String(x ?? '').trim()).filter(Boolean);

  // ① 已经是数组（含嵌套数组拍平到一层）
  if (Array.isArray(input)) {
    const flat = input.flat(2).filter((x) => x != null);
    return { messages: clean(flat), repaired: false, note: '' };
  }
  if (input == null) return { messages: [], repaired: false, note: '' };
  if (typeof input !== 'string') return { messages: [String(input).trim()].filter(Boolean), repaired: true, note: '不是字符串也不是数组' };

  const trimmed = stripFence(input).trim();
  if (!trimmed) return { messages: [], repaired: false, note: '' };

  // ② 形如列表的字符串
  if (LOOKS_LIKE_LIST.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const msgs = clean(parsed.flat(2));
        if (msgs.length) return { messages: msgs, repaired: false, note: '' };
      }
    } catch { /* 落到按引号扫描 */ }
    const scanned = clean(scanQuotedSegments(trimmed));
    if (scanned.length) {
      return { messages: scanned, repaired: true, note: 'JSON 不合法（多半是全角逗号/引号），已按引号自动切开' };
    }
    if (/[\]］]$/.test(trimmed)) {
      const inner = trimmed.slice(1, -1).trim().replace(/^["“'‘]|["”'’]$/g, '').trim();
      if (inner) return { messages: [inner], repaired: true, note: '看着像数组但没抓到引号片段，已去掉方括号当一条发' };
    }
    return { messages: [trimmed], repaired: true, note: '看着像数组但解析不出来，原样当一条' };
  }

  // ③ 整个字符串被 JSON 序列化了（"\"你好\"" → 你好）
  if (trimmed.startsWith('"') || trimmed.startsWith('“')) {
    const segs = scanQuotedSegments(trimmed);
    if (segs.length) return { messages: clean(segs), repaired: true, note: '整串是 JSON 字符串，已剥掉引号' };
    const stripped = trimmed.replace(/^["“]|["”]$/g, '').trim();
    if (stripped) return { messages: [stripped], repaired: true, note: '整串是 JSON 字符串，已剥掉引号' };
  }

  // ④ 普通一条
  return { messages: [trimmed], repaired: false, note: '' };
}
