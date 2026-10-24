#!/usr/bin/env node
/**
 * detect-capabilities.mjs —— 探测本机"高级工具"的环境，写 state/capabilities.json。
 *
 * 桌面壳的「工具」页读这个文件显示可用/不可用；缺哪个就是哪项为 false。
 * 基础功能（聊天/情感/记忆/日记）不依赖这里，永远可用。
 *
 * 用法：node scripts/detect-capabilities.mjs
 */
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const SETTINGS = 'D:\\QQaibot\\settings.json';
let cfg = {};
try { cfg = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch {}
const tools = cfg.tools || {};
const BRIDGE = cfg.bridgeDir || 'D:\\qq-bridge';

function exists(p) { try { return !!p && existsSync(p); } catch { return false; } }
function hasCmd(name) {
  try {
    execSync(`where ${name}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return true;
  } catch { return false; }
}

const caps = {
  // 基础（永远可用）
  chat: true, emotion: true, memory: true, diary: true, stickers: true,
  // 高级（看环境）
  phone: exists(tools.adb) || hasCmd('adb'),
  matlab: exists(tools.matlab) || hasCmd('matlab'),
  bili: Boolean(String(tools.biliCookie || '').trim()),
  wmpvp: Boolean(String(tools.wmpvpToken || '').trim()),
  voice: exists(path.join(BRIDGE, 'state', 'speak-server.log')),
  details: {
    adb: tools.adb || (hasCmd('adb') ? 'adb (PATH)' : ''),
    matlab: tools.matlab || (hasCmd('matlab') ? 'matlab (PATH)' : ''),
    bili: tools.biliCookie ? '已配置 cookie' : '',
    wmpvp: tools.wmpvpToken ? '已配置 token' : '',
  },
  updatedAt: Date.now(),
};

const out = path.join(BRIDGE, 'state', 'capabilities.json');
try {
  writeFileSync(out, JSON.stringify(caps, null, 2) + '\n');
  console.log(`[caps] 已写入 ${out}`);
  console.log(`[caps] 基础: chat/emotion/memory/diary/stickers = 全可用`);
  console.log(`[caps] 高级: phone=${caps.phone} matlab=${caps.matlab} bili=${caps.bili} wmpvp=${caps.wmpvp} voice=${caps.voice}`);
} catch (error) {
  console.error(`[caps] 写入失败: ${error?.message ?? error}`);
  process.exitCode = 1;
}
