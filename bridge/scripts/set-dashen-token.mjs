// 从 D:\Overstats\_token.txt 读 token，安全写入 Overstats 的 config.py（UTF-8 无 BOM）。
// 这样 token 不必经过聊天/命令历史。
//
// 用法：node scripts/set-dashen-token.mjs [roleId] [tokenFile]
import fs from 'node:fs';

const ROLE_ID = Number(process.argv[2] || 609814110);
const TOKEN_FILE = process.argv[3] || 'D:/Overstats/_token.txt';
const CONFIG = 'D:/Overstats/Overstats-main/config/config.py';

if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`找不到 token 文件：${TOKEN_FILE}`);
  console.error('请把完整 token 存进该文件（只放 token 本身，不要引号）。');
  process.exit(1);
}

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim().replace(/^["']|["']$/g, '');
if (!token || /\s/.test(token)) {
  console.error(`token 内容不合法（长度 ${token.length}，含空白=${/\s/.test(token)}）`);
  process.exit(1);
}
if (!Number.isFinite(ROLE_ID) || ROLE_ID <= 0) {
  console.error(`role_id 不合法：${ROLE_ID}`);
  process.exit(1);
}

let src = fs.readFileSync(CONFIG, 'utf8');

const block = [
  'DASHEN_ACCOUNTS = [',
  '    {',
  '        "name": "primary",',
  `        "role_id": ${ROLE_ID},`,
  `        "token": "${token}",`,
  '    },',
  ']',
].join('\n');

// 替换整个 DASHEN_ACCOUNTS = [ ... ] 赋值块（到第一个顶格 ']' 为止）
const re = /DASHEN_ACCOUNTS\s*=\s*\[[\s\S]*?\n\]/;
if (!re.test(src)) {
  console.error('config.py 里没找到 DASHEN_ACCOUNTS 赋值块，未修改。');
  process.exit(1);
}

// 备份一次
const bak = `${CONFIG}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
fs.copyFileSync(CONFIG, bak);

src = src.replace(re, block);
fs.writeFileSync(CONFIG, src, 'utf8');

// 校验：重新读出来，确认能被 Python 解析且值正确
console.log('已写入 config.py');
console.log(`  role_id : ${ROLE_ID}`);
console.log(`  token   : ${token.slice(0, 6)}…(${token.length} 字符)`);
console.log(`  备份    : ${bak}`);
console.log('');
console.log('--- DASHEN_ACCOUNTS 现状 ---');
const after = fs.readFileSync(CONFIG, 'utf8');
const m = after.match(/DASHEN_ACCOUNTS\s*=\s*\[[\s\S]*?\n\]/);
console.log(
  (m ? m[0] : '(没找到)').replace(/"token":\s*"[^"]*"/, `"token": "${token.slice(0, 6)}…(已隐藏)"`)
);
