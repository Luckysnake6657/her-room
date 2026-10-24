// 解压 Overstats 源码 tarball 到目标目录（顶层多一层 Overstats-main/，剥掉）。
// 用 npm 自带的 tar 库，避免依赖系统 tar.exe（本机不可用）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/zjin6/AppData/Roaming/npm/node_modules/npm/');
const tar = require('tar');

const tarball = process.argv[2] || 'D:/overstats-main.tar.gz';
const dest = process.argv[3] || 'D:/Overstats';

fs.mkdirSync(dest, { recursive: true });
console.log(`解压 ${tarball} -> ${dest}`);

await tar.x({
  file: tarball,
  cwd: dest,
  strip: 1, // 去掉顶层 Overstats-main/
});

const entries = fs.readdirSync(dest);
console.log(`完成。顶层条目 ${entries.length} 个：`);
console.log('  ' + entries.slice(0, 40).join('\n  '));

// 关键文件体检
for (const rel of ['run.py', 'requirements.txt', 'config/config.py', 'src/server.py', 'Faststart.md', 'OVERSTATS_API.md']) {
  const p = path.join(dest, rel);
  console.log(`  ${fs.existsSync(p) ? '✅' : '❌'} ${rel}`);
}
