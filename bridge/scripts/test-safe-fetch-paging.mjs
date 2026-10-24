/**
 * 回归测试：`safeFetch` 的**分页**（2026-10-10，她在执行申请 #1 里提的需求：
 * "抓一次只有开头那截，长文永远读不到后半段"）。
 *
 * 这里只测**纯函数 pageOf**（不联网，秒级）：
 *   [1] 基本切片：offset/window 的边界（0 / 正好一页 / 最后一页 / 越界）
 *   [2] **按码点切**：emoji 和中文都不能被劈开（用 `slice` 就会劈开代理对 → 之后每次请求带非法字符）
 *   [3] 参数卫生：负数/NaN/小数 offset 都被规整；window 至少 1
 *
 * 联网那条路（真抓一个长页面、拿 nextOffset 续读）由 scripts/test-mcp-web-search.mjs 覆盖 —— 
 * 它依赖外网，所以不放进这条快测里。
 *
 * 用法: node scripts/test-safe-fetch-paging.mjs
 */
import { pageOf } from '../src/safe-fetch.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

console.log('\n[1] 基本分页');
{
  const text = '0123456789';
  check('offset=0 window=4 → 前 4 个', pageOf(text, 0, 4).page === '0123', pageOf(text, 0, 4).page);
  check('offset=4 window=4 → 中间 4 个', pageOf(text, 4, 4).page === '4567', pageOf(text, 4, 4).page);
  check('offset=8 window=4 → 只剩 2 个（不报错）', pageOf(text, 8, 4).page === '89', pageOf(text, 8, 4).page);
  check('offset 越界 → 空串（不是异常）', pageOf(text, 99, 4).page === '', JSON.stringify(pageOf(text, 99, 4).page));
  check('totalChars 是整段长度', pageOf(text, 0, 4).totalChars === 10, String(pageOf(text, 0, 4).totalChars));
  check('offset 原样带回（方便续读对齐）', pageOf(text, 4, 4).offset === 4);
}

console.log('\n[2] 必须按**码点**切：emoji / 中文不能被劈开');
{
  // "👨‍👩‍👧" 这类 ZWJ 序列 + 普通 emoji：用 slice 切会留下半个代理项
  const text = '中文🙂测试🚀尾巴';
  const points = Array.from(text);
  let bad = null;
  for (let off = 0; off <= points.length; off++) {
    for (const win of [1, 2, 3, 5]) {
      const { page } = pageOf(text, off, win);
      // 半个代理项的特征：出现了孤立的高/低代理码元
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(page)) {
        bad = `offset=${off} window=${win} → ${JSON.stringify(page)}`;
        break;
      }
    }
    if (bad) break;
  }
  check('任何 offset/window 组合都不会产生孤立代理项', bad === null, bad ?? '');
  // 逐页拼起来应等于原文（分页不丢字）
  let rebuilt = '';
  for (let off = 0; off < points.length; off += 3) rebuilt += pageOf(text, off, 3).page;
  check('按 3 字一页拼回来 == 原文', rebuilt === text, JSON.stringify(rebuilt));
  check('单页里不会有半个 emoji', Array.from(pageOf(text, 2, 1).page).length === 1, JSON.stringify(pageOf(text, 2, 1).page));
}

console.log('\n[3] 参数卫生');
{
  check('offset=-5 → 当作 0', pageOf('abcdef', -5, 2).page === 'ab', pageOf('abcdef', -5, 2).page);
  check('offset=NaN → 当作 0', pageOf('abcdef', NaN, 2).page === 'ab', pageOf('abcdef', NaN, 2).page);
  check('offset=2.7 → 向下取整为 2', pageOf('abcdef', 2.7, 2).page === 'cd', pageOf('abcdef', 2.7, 2).page);
  check('window=0 → 至少 1（不会返回空页把续读卡死）', pageOf('abcdef', 0, 0).page === 'a', pageOf('abcdef', 0, 0).page);
  check('text 为 null/undefined → 空串不抛错', pageOf(null, 0, 5).page === '' && pageOf(undefined, 0, 5).page === '');
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
