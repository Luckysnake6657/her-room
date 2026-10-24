// 清理工作区里排查过程留下的临时文件。
// 保留：思维链导出（交付物）+ 本 README。
// 删除前逐个说明理由，并在删除后校验。
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/deepseekharness';

const targets = [
  { p: 'agenttoken.txt', why: '二代会话 token 明文（敏感，已无用）' },
  { p: 'guardtoken.txt', why: 'DSH launch token 明文（敏感，已无用）' },
  { p: 'config', dir: true, why: 'SnowLuma 早期测试的幽灵副本：runtime.json 与真身重复；webui.json 是过期密码哈希，易误导' },
  { p: 'logs', dir: true, why: 'SnowLuma 3:06 启动日志副本；真身日志在 D:\\SnowLuma\\logs' },
  { p: 'session-dump.jsonl', why: '早期原始会话转储（154KB）；已有更好的 Markdown 导出' },
  { p: 'snowluma.out.log', why: 'SnowLuma 启动日志（调试遗留）' },
  { p: 'snowluma.err.log', why: 'SnowLuma 错误日志（调试遗留）' },
  { p: 'launch-bridge.bat', why: '我用的启动辅助脚本；桌面快捷方式已覆盖此用途' },
  { p: 'persist-marker.txt', why: '记忆持久化测试的临时标记' },
];

const keep = ['群聊思维链-这是好ow啊.md', 'README-工作区说明.md'];

console.log('=== 删除 ===');
let freed = 0;
for (const t of targets) {
  const full = path.join(root, t.p);
  if (!fs.existsSync(full)) { console.log(`  (跳过，不存在) ${t.p}`); continue; }
  let size = 0;
  const stat = fs.statSync(full);
  if (t.dir) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else size += fs.statSync(f).size; } };
    walk(full);
    fs.rmSync(full, { recursive: true, force: true });
  } else {
    size = stat.size;
    fs.rmSync(full, { force: true });
  }
  freed += size;
  console.log(`  ✅ ${t.p}  (${Math.round(size / 1024 * 10) / 10} KB) — ${t.why}`);
}
console.log(`\n共释放 ${Math.round(freed / 1024 * 10) / 10} KB`);

console.log('\n=== 保留 ===');
for (const k of keep) {
  const full = path.join(root, k);
  console.log(`  ${fs.existsSync(full) ? '✅' : '(待创建)'} ${k}`);
}

console.log('\n=== 清理后的工作区 ===');
for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  const full = path.join(root, e.name);
  const size = e.isDirectory() ? '(目录)' : Math.round(fs.statSync(full).size / 1024) + ' KB';
  console.log(`  ${e.name.padEnd(30)} ${size}`);
}
