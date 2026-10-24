// PDF 内容流扫描器（线性、无回溯）。
//
// 为什么不用正则解析内容流：TJ 数组的正则在大流上会灾难性回溯
// （实测某 261KB 流卡死 120s+）。本模块是手写线性扫描，复杂度 O(n)。
//
// 已固化的坑（都踩过）：
//   1. Tj 的字符串在正则里必须用捕获组，否则命中拿不到内容 → 这里直接读，无此问题
//   2. 中文 PDF 用 hex 字符串 <00010002…> → 支持
//   3. 简单字体是 1 字节码、Type0/Identity-H 是 2 字节 CID → 按字体切换 byteMode
//   4. CMap/ToUnicode 流不是页面内容 → 由调用方排除（见 isContentStreamDict）
//   5. TJ 数组可能极大 → 元素数上限
//   6. 单个流解析失败不应中断整体 → 由调用方 try/catch

const MAX_ARRAY_ELEMS = 20000;
const MAX_TOKEN_LEN = 24;

const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelim = (c) => '()<>[]{}/%'.includes(c);

/** 判断一个流的字典是否是页面内容流（排除图片 / CMap / ToUnicode）。 */
export function isContentStreamDict(dict) {
  if (/\/Subtype\s*\/Image/.test(dict)) return false;
  if (/\/Type\s*\/CMap|CMapName|CIDInit|beginbfchar|beginbfrange/.test(dict)) return false;
  return true;
}

/**
 * 线性扫描内容流取文本。
 * @param {string} s 已解压的内容流（latin1）
 * @param {(name: string) => number|undefined} resolveFontObj 资源名(/F1) → 字体对象号
 * @param {Map<number, Map<number,string>>} cmapByFontObj 字体对象号 → ToUnicode 表
 * @param {Map<number, number>} byteModeByFontObj 字体对象号 → 1|2
 */
export function scanContentStream(s, resolveFontObj, cmapByFontObj, byteModeByFontObj = new Map(), deadline = 0) {
  const text = [];
  const n = s.length;
  let i = 0;
  let currentMap = null;
  let currentByteMode = 1;
  // 文本位置跟踪：用于判断真正的换行（见下）
  let lastX = null;
  let lastY = null;
  const fallbackMap = cmapByFontObj.size === 1 ? cmapByFontObj.values().next().value : null;
  const outOfTime = () => deadline > 0 && Date.now() > deadline;

  const skipWs = () => {
    while (i < n) {
      const c = s[i];
      if (isWs(c)) { i++; continue; }
      if (c === '%') { while (i < n && s[i] !== '\n') i++; continue; }
      break;
    }
  };

  const readBare = () => {
    const start = i;
    while (i < n && !isWs(s[i]) && !isDelim(s[i])) i++;
    return s.slice(start, i);
  };

  // 判定是否为"可读文字"码点：保留 ASCII、CJK、常用标点、全角字符。
  // 丢弃：私用区(E000-F8FF)、以及 CMap 缺失时产生的回退码点（藏文/僧伽罗等区段）。
  const isReadableCodePoint = (cp) => {
    if (cp === 9 || cp === 10 || cp === 13 || cp === 32) return true;
    if (cp >= 0x20 && cp <= 0x7e) return true;          // ASCII 可打印
    if (cp >= 0x4e00 && cp <= 0x9fff) return true;      // CJK 统一汉字
    if (cp >= 0x3400 && cp <= 0x4dbf) return true;      // CJK 扩展 A
    if (cp >= 0xf900 && cp <= 0xfaff) return true;      // CJK 兼容汉字
    if (cp >= 0x3000 && cp <= 0x303f) return true;      // CJK 标点
    if (cp >= 0xff00 && cp <= 0xffef) return true;      // 全角/半角
    if (cp >= 0x2010 && cp <= 0x203b) return true;      // 常用符号
    if (cp === 0x2014 || cp === 0x2018 || cp === 0x2019 || cp === 0x201c || cp === 0x201d) return true;
    if (cp >= 0x2000 && cp <= 0x206f) return true;      // 通用标点
    if (cp >= 0x00a0 && cp <= 0x00ff) return true;      // 拉丁补充
    if (cp >= 0x0400 && cp <= 0x04ff) return true;      // 西里尔（少量姓名）
    return false;
  };

  const decodeBytes = (bytes) => {
    if (!currentMap || !currentMap.size) {
      return currentByteMode === 1
        ? Buffer.from(bytes).toString('utf8')
        : bytes.reduce((a, b, k) => (k % 2 === 0 ? a : a + String.fromCharCode((bytes[k - 1] << 8) | b)), '');
    }
    let out = '';
    if (currentByteMode === 1) {
      for (const b of bytes) {
        const m = currentMap.get(b);
        out += m !== undefined ? m : String.fromCharCode(b);
      }
      return out;
    }
    for (let k = 0; k + 1 < bytes.length; k += 2) {
      const code = (bytes[k] << 8) | bytes[k + 1];
      const m = currentMap.get(code);
      out += m !== undefined ? m : String.fromCharCode(code);
    }
    if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
    return out;
  };

  const filterReadable = (str) => {
    let out = '';
    for (const ch of str) {
      if (isReadableCodePoint(ch.codePointAt(0))) out += ch;
    }
    return out;
  };

  const readLiteral = () => {
    i++; // '('
    const bytes = [];
    let depth = 1;
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        const nx = s[i + 1];
        if (nx === 'n') bytes.push(10);
        else if (nx === 'r') bytes.push(13);
        else if (nx === 't') bytes.push(9);
        else if (nx === 'b') bytes.push(8);
        else if (nx === 'f') bytes.push(12);
        else if (nx === '(' || nx === ')' || nx === '\\') bytes.push(nx.charCodeAt(0));
        else if (/[0-7]/.test(nx ?? '')) {
          let s2 = i + 1;
          let oct = '';
          while (oct.length < 3 && /[0-7]/.test(s[s2] ?? '')) oct += s[s2++];
          bytes.push(parseInt(oct, 8));
          i = s2;
          continue;
        } else if (nx === '\n') { /* 续行 */ }
        else bytes.push((nx ?? '').charCodeAt(0));
        i += 2;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      bytes.push(c.charCodeAt(0) & 0xff);
      i++;
    }
    return filterReadable(decodeBytes(bytes));
  };

  const readHex = () => {
    i++; // '<'
    let hi = -1;
    const bytes = [];
    while (i < n && s[i] !== '>') {
      const c = s[i++];
      const v = parseInt(c, 16);
      if (Number.isNaN(v)) continue; // 空白等
      if (hi < 0) hi = v;
      else { bytes.push((hi << 4) | v); hi = -1; }
    }
    if (hi >= 0) bytes.push(hi << 4);
    i++; // '>'
    return filterReadable(decodeBytes(bytes));
  };

  skipWs();
  let guard = 0;
  while (i < n) {
    // 时间预算保护：大流解析可能很久，超时立即返回已提取部分（不阻塞消息处理）
    if ((++guard & 0x3ff) === 0 && outOfTime()) break;
    const c = s[i];

    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < n && s[i] !== '\n') i++; continue; }

    if (c === '(') { const t = readLiteral(); if (t) text.push(t); skipWs(); continue; }
    if (c === '<' && s[i + 1] !== '<') { const t = readHex(); if (t) text.push(t); skipWs(); continue; }

    if (c === '[') {
      i++;
      const parts = [];
      while (i < n && s[i] !== ']') {
        const ch = s[i];
        if (isWs(ch)) { i++; continue; }
        if (ch === '(') { parts.push(readLiteral()); continue; }
        if (ch === '<') { parts.push(readHex()); continue; }
        if (ch === '[' || ch === ']') { i++; continue; }
        const start = i;
        while (i < n && !isWs(s[i]) && !isDelim(s[i])) i++;
        const tok = s.slice(start, i);
        if (tok.length > MAX_TOKEN_LEN) continue;
        const num = Number(tok);
        if (Number.isFinite(num) && parts.length < MAX_ARRAY_ELEMS) parts.push(num);
      }
      if (s[i] === ']') i++;
      skipWs();
      const op = readBare();
      if (op === 'TJ') {
        let line = '';
        for (const p of parts) {
          if (typeof p === 'string') line += p;
          else if (typeof p === 'number' && p < -150) line += ' ';
        }
        if (line.trim()) text.push(line);
      }
      continue;
    }

    if (c === '/') {
      i++;
      const start = i;
      while (i < n && !isWs(s[i]) && !isDelim(s[i])) i++;
      const name = s.slice(start, i);
      skipWs();
      // /F1 14 Tf 形式：读取数值，若随后是 Tf 则切换字体与字节模式
      const save = i;
      let sawNumber = false;
      while (i < n && /[-+.\d]/.test(s[i])) {
        const s2 = i;
        while (i < n && !isWs(s[i]) && !isDelim(s[i])) i++;
        if (i === s2) break;
        sawNumber = true;
        skipWs();
      }
      const op = readBare();
      if (op === 'Tf' && sawNumber) {
        const objNum = resolveFontObj(name);
        if (objNum !== undefined) {
          const m = cmapByFontObj.get(objNum);
          if (m) currentMap = m;
          const bm = byteModeByFontObj.get(objNum);
          if (bm) currentByteMode = bm;
        } else if (fallbackMap) {
          currentMap = fallbackMap;
        }
      } else if (op) {
        // 不是 Tf：回退并把这轮当普通记号
        i = save;
      }
      continue;
    }

    // 位置算子需要前导数值，这里先收集紧邻的数字参数
    const numsBefore = [];
    if (/[-+.\d]/.test(c) ) {
      const save2 = i;
      while (i < n && /[-+.\d]/.test(s[i])) {
        const st = i;
        while (i < n && !isWs(s[i]) && !isDelim(s[i])) i++;
        if (i === st) break;
        const v = Number(s.slice(st, i));
        if (Number.isFinite(v)) numsBefore.push(v);
        skipWs();
        if (numsBefore.length > 8) break;
      }
      if (i === save2) i = save2 + 1;
    }
    const op = readBare();
    if (!op) { i++; continue; }

    if (op === 'Td' || op === 'TD') {
      // Td: tx ty —— ty 不为 0 表示换到新行
      const ty = numsBefore.length >= 2 ? numsBefore[numsBefore.length - 1] : null;
      if (ty !== null && Math.abs(ty) > 0.5) {
        if (text.length && text[text.length - 1] !== '\n') text.push('\n');
      }
    } else if (op === 'T*' || op === 'ET') {
      if (text.length && text[text.length - 1] !== '\n') text.push('\n');
    } else if (op === 'Tm' && numsBefore.length >= 6) {
      // Tm: a b c d e f —— f 是 Y 坐标
      const y = numsBefore[5];
      if (lastY !== null && Math.abs(y - lastY) > 0.5) {
        if (text.length && text[text.length - 1] !== '\n') text.push('\n');
      }
      lastY = y;
    }
  }

  return text.join('');
}
