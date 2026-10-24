// 校验 QQ 文件读取功能的各部分是否都在源码里。
import fs from 'node:fs';

const b = fs.readFileSync('D:/qq-bridge/src/bridge.js', 'utf8');
const s = fs.readFileSync('D:/qq-bridge/src/safe-fetch.js', 'utf8');

const checks = [
  ['safe-fetch: 通用下载函数 safeFetchAnyBuffer', s.includes('export async function safeFetchAnyBuffer')],
  ['safe-fetch: 逐跳重定向校验保留', s.includes('REDIRECT_STATUSES.has(result.statusCode)')],
  ['bridge: 导入 safeFetchAnyBuffer', b.includes("import { safeFetchBuffer, safeFetchAnyBuffer, looksLikeImageBuffer }")],
  ['bridge: 文本类扩展名白名单', b.includes('const TEXT_FILE_EXT = new Set([')],
  ['bridge: 文本格式启发式探测', b.includes('function looksLikeTextBuffer')],
  ['bridge: 下载并缓存函数', b.includes('async function fetchAndCacheQqFile')],
  ['bridge: file 段采集 kind/url/fileId', b.includes("kind: 'file',") && b.includes('fileId: String(d.file_id')],
  ['bridge: 消息文本内联文件内容', b.includes('[文件内容结束]')],
  ['bridge: 二进制文件只给元数据', b.includes('二进制/不支持预览')],
  ['bridge: 处理入口先下载后构造文本', b.includes('await fetchAndCacheQqFile(f).catch(() => {})')],
  ['bridge: 下载失败不阻塞（有错误标记）', b.includes('读取失败：')],
  ['安全: 单文件大小上限', b.includes('MAX_FILE_BYTES')],
  ['安全: 内联字符上限', b.includes('MAX_FILE_INLINE_CHARS')],
  ['安全: 缓存条目上限', b.includes('FILE_CACHE_MAX')],
];

let ok = 0;
for (const [name, pass] of checks) {
  if (pass) ok++;
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
}
console.log(`\n${ok}/${checks.length} 通过`);
