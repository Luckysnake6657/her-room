// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// ⚠️ 语义提醒（2026-10-10 踩到）：返回值是**探针命中的那一层** node_modules，不保证等于
// `<DSH 全局安装目录>/node_modules`。0.2.0 下探针（@deepseek-ai/dsh-persona）落在
// `…/npm/node_modules/@deepseek-ai/dsh/node_modules`，于是想读 DSH 自己的 package.json
// 不能写 `<返回值>/@deepseek-ai/dsh/package.json`（拿到的是 undefined），
// 要么用 `name` 字段自校验，要么把「DSH 包目录本身」另列一条候选。
// 症状很隐蔽：版本号静默变成"未知"，没有任何报错。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules）
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}
