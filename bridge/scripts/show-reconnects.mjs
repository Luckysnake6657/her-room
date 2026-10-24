// List every SnowLuma connect/disconnect transition in the bridge log with its cause.
import fs from 'node:fs';

const lines = fs.readFileSync('D:/qq-bridge/state/bridge.log', 'utf8').trimEnd().split(/\r?\n/);

console.log('=== 桥接启动 / SnowLuma 连接状态变化 ===');
for (const l of lines) {
  if (/桥接已启动|SnowLuma 已连接|连接断开|初始连接失败|机器人昵称|SnowLuma 错误/.test(l)) {
    console.log(l);
  }
}

console.log('\n=== 发送结果（成功/失败）===');
for (const l of lines) {
  if (/QQ 发送失败|\[send\]|工具统一发送/.test(l)) console.log(l);
}

const last = lines[lines.length - 1];
console.log('\n日志最后一行:', last);
console.log('日志总行数:', lines.length);
