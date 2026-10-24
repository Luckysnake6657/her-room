// 人格卡读写往返测试：读 → 写 → 落盘校验 → 还原 → 超长警告。
// 关键是结束时必须把角色卡还原成原始内容。
import fs from 'node:fs';

const TOKEN = process.argv[2];
const NAME = '程莫雯';
const FILE = `D:/qq-bridge/roles/${NAME}.md`;
if (!TOKEN) {
  console.error('用法: node test-role-editor.mjs <consoleToken>');
  process.exit(1);
}

const post = (body) =>
  fetch(`http://127.0.0.1:3100/api/roles/content?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  }).then((r) => r.json());

const orig = fs.readFileSync(FILE, 'utf8');
console.log(`  原始: ${orig.length} 字符`);

// 1. 读
let r = await fetch(
  `http://127.0.0.1:3100/api/roles/content?name=${encodeURIComponent(NAME)}&token=${TOKEN}`,
  { signal: AbortSignal.timeout(20000) }
);
let j = await r.json();
console.log(`  读接口: ok=${j.ok} chars=${j.chars} 内容与文件一致=${j.content === orig} isCurrent=${j.isCurrent}`);

// 2. 写（追加测试标记）
let res = await post({ name: NAME, content: orig + '\n<!-- qqbridge-test -->\n' });
console.log(`  写接口: ok=${res.ok} chars=${res.chars} overLimit=${res.overLimit}`);
const afterWrite = fs.readFileSync(FILE, 'utf8');
console.log(`  落盘: 含测试标记=${afterWrite.includes('qqbridge-test')}  备份存在=${fs.existsSync(FILE + '.bak')}`);

// 3. 还原
res = await post({ name: NAME, content: orig });
const restored = fs.readFileSync(FILE, 'utf8');
console.log(`  还原: ok=${res.ok} 与原始完全一致=${restored === orig}`);

// 4. 超长警告
res = await post({ name: NAME, content: orig + '\n' + 'x'.repeat(200) });
console.log(`  超长: overLimit=${res.overLimit}  warning=${JSON.stringify(res.warning || '')}`);

// 5. 空内容应被拒
res = await post({ name: NAME, content: '   ' });
console.log(`  空内容: ok=${res.ok} error=${JSON.stringify(res.error || '')}`);

// 最终还原并核对
const fin = await post({ name: NAME, content: orig });
const final = fs.readFileSync(FILE, 'utf8');
console.log(`  ── 最终: 与原始一致=${final === orig} (${final.length} 字符) 还原ok=${fin.ok}`);
if (final !== orig) {
  console.error('❌ 角色卡未还原！请检查 ' + FILE);
  process.exit(1);
}
console.log('  ✅ 全部通过，角色卡完好');
