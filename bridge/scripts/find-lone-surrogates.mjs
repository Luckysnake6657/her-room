// 在会话帧里找"孤立代理项"（lone surrogate）。
//
// 为什么怀疑它：JS 的 String.slice 按 UTF-16 码元切，切在 emoji 中间会留下半个代理项
// （0xD800-0xDFFF 落单）。这种字符串 JSON.stringify 会原样输出成 \udXXX 转义，
// 发给模型 API 就是非法字符 → 400 INVALID_REQUEST。
// 而我最近加了一堆"按字符数截断"（记忆 60/50/64、上下文补丁 110），
// 私聊又能看到**所有来源**的记忆 → 最容易踩到。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionFileIn } from './session-file.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const base = path.join(process.env.USERPROFILE, '.dsh', 'sessions');
const prefix = process.argv[2] || '';

const re = /\\u(d[89ab][0-9a-f]{2})/gi; // JSON 里出现的代理项转义

let found = 0;
for (const dir of fs.readdirSync(base).filter((d) => d.includes('qq-bridge'))) {
  const sd = path.join(base, dir);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const sess of fs.readdirSync(sd)) {
    if (prefix && !sess.includes(prefix)) continue;
    // 升级后 v3 冻结：扫冻结的旧文件会漏掉新写进去的孤立代理项
    const f = sessionFileIn(path.join(sd, sess));
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const starts = [];
    let idx = buf.indexOf(MAGIC);
    while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
      let text = '';
      try { text = zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'); } catch { continue; }
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        // 只报"落单"的：前一个转义是高代理(高半)且紧跟着不是低代理，或反之
        const at = m.index;
        const prevIsHigh = /\\ud[89ab][0-9a-f]{2}$/i.test(text.slice(Math.max(0, at - 6), at));
        const nextIsLow = /^\\ud[c-f][0-9a-f]{2}/i.test(text.slice(at + 6, at + 12));
        const isHigh = /^\\ud[89ab]/i.test(m[0]);
        const paired = isHigh ? nextIsLow : prevIsHigh;
        if (paired) continue;
        found++;
        console.log(`★ 孤立代理项 ${m[0]}  @ ${sess.slice(0, 20)}… 第 ${i + 1} 帧  偏移 ${at}`);
        console.log('   …' + text.slice(Math.max(0, at - 120), at + 60).replace(/\\n/g, ' ') + '…\n');
        break; // 每帧报一次就够
      }
    }
  }
}
console.log(found ? `\n共发现 ${found} 处孤立代理项` : '\n没有发现孤立代理项');
