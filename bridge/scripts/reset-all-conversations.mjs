// 重置两个 QQ 会话，解除"会话繁忙"卡死，让积压消息能被处理。
import fs from 'node:fs';

const consoleToken = fs.readFileSync('D:/qq-bridge/state/console-token', 'utf8').trim();
const keys = ['private:984776985', 'group:1054156254'];

for (const key of keys) {
  const before = JSON.parse(fs.readFileSync('D:/qq-bridge/state/social-v2.json', 'utf8')).conversations?.[key];
  console.log(`\n[${key}] 重置前：unread=${(before?.unread ?? []).length} 条，lastAiReplyAt=${before?.lastAiReplyAt ? new Date(before.lastAiReplyAt).toLocaleTimeString('zh-CN') : '-'}`);
  try {
    const res = await fetch('http://127.0.0.1:3100/api/session/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(25000),
    });
    const body = (await res.text()).replace(/\s+/g, ' ');
    console.log(`  POST /api/session/reset -> ${res.status} ${body.slice(0, 180)}`);
  } catch (e) {
    console.log('  重置失败:', e.cause?.code ?? e.message);
  }
}

console.log('\n=== 重置后映射 ===');
console.log(fs.readFileSync('D:/qq-bridge/state/sessions.json', 'utf8').replace(/\s+/g, ' '));
