/**
 * 回归测试：MATLAB 沙箱的**纯逻辑**（2026-10-13）。
 *
 * 背景：管理员装了 MATLAB R2025b，要她（QQ 里的机器人）能自己跑作业里的程序和函数 ——
 * 包括**出图**。实测：MATLAB 出图必须再起 MATLABWindow.exe，而"最多 1 个进程"的沙箱会把
 * 图形栈一起挡掉（1816 配额不足），所以做成了两遍：沙箱里跑（只录音、命令锁死）+ 正常环境重放（出图）。
 *
 * 这个用例钉住那套逻辑里**容易出错、又最容易悄悄退化**的五件事：
 *   [1] 要不要走绘图模式（该走才走；普通计算别白搭一遍重放）
 *   [2] 代码预检（黑名单 + `!`/`@system`/shell 特征三道闸）
 *   [3] 频率上限（每分钟/每小时）
 *   [4] 输出截断（长输出要切，并且明确告诉她被切了）
 *   [5] 重放输出解析（哪几张图出来了、哪些调用失败）+ 审计条目形状
 */
import {
  needsPlotMode, checkMatlabCode, matlabRateInfo, truncateMatlabOutput,
  parseReplayOutput, matlabAuditEntry, MATLAB_DRAW_FNS,
} from '../src/matlab-sandbox.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`); }
};

console.log('\n[1] 要不要走绘图模式（该走才走，普通计算别白搭一遍重放）');
{
  check('实验三那种画图代码 → 要', needsPlotMode('x=linspace(0,2*pi); plot(x, sin(x)); saveas(gcf, "a.png");'));
  check('mesh/surf → 要', needsPlotMode('mesh(X,Y,Z);') && needsPlotMode('surf(X,Y,Z);'));
  check('`grid on` 这种无括号命令 → 要', needsPlotMode('grid on;'));
  check('纯计算（实验四那种）→ 不要', !needsPlotMode('for n=1:300, if isprime(n), disp(n); end, end'));
  check('纯计算 + input → 不要', !needsPlotMode("s = input('分数？'); disp(grade(s));"));
  // 变量名里含绘图函数名不该误判（只看"调用形式"）
  check('变量名 `plot_data = 1` 不算画图调用', !needsPlotMode('plot_data = 1; total = plot_data + 2;'));
  check('空代码 → 不要', !needsPlotMode(''));
  check('绘图函数表够长（覆盖常见作业）', MATLAB_DRAW_FNS.length >= 50, `${MATLAB_DRAW_FNS.length} 个`);
}

console.log('\n[2] 代码预检：黑名单 + 三道加强闸（运行前就拒，连进程都不起）');
{
  const deny = (code) => checkMatlabCode(code);
  check('system → 拒', !deny("system('cmd /c dir')").ok);
  check('builtin 绕过 → 拒', !deny("builtin('system','cmd /c dir')").ok);
  check('eval → 拒', !deny("eval('disp(1)')").ok);
  check('feval/str2func 拼函数名 → 拒', !deny("f=str2func('sys'+'tem'); feval(f,'x')").ok);
  check('读文件 fileread → 拒', !deny("t=fileread('C:/secret.txt')").ok);
  check('写文件 fopen/save → 拒', !deny("fid=fopen('a.txt','w'); save('b.mat');").ok);
  check('!cmd 转义 → 拒', !deny('!cmd /c echo x').ok);
  check('@system 句柄 → 拒', !deny('f = @system; f("cmd /c echo x");').ok);
  check('字符串里出现 cmd.exe → 拒', !deny("disp('C:/Windows/System32/cmd.exe')").ok);
  // 正常的作业代码要放行（别把她正经的东西也拦了）
  check('实验三的绘图代码 → 放行', deny('x=linspace(0,2*pi,100); plot(x,sin(x)); saveas(gcf,"a.png");').ok);
  check('实验四的函数+循环 → 放行', deny('function g=grade(s)\nif s>90, g="A"; else, g="F"; end\nend').ok);
  check('input 也放行（沙箱里有预置输入队列）', deny("s = input('分数？');").ok);
  const hits = deny("system('x'); eval('y')").hits;
  check('被拒时说清是哪些东西', hits.includes('system') && hits.includes('eval'), JSON.stringify(hits));
}

console.log('\n[3] 频率上限（每分钟 2 次 / 每小时 10 次）');
{
  const now = Date.now();
  check('第一次 → 放行', !matlabRateInfo([], now).limited);
  check('一分钟内第 2 次 → 放行', !matlabRateInfo([now - 1000], now).limited);
  check('一分钟内第 3 次 → 拦（reason=minute）', matlabRateInfo([now - 1000, now - 2000], now).limited === true
    && matlabRateInfo([now - 1000, now - 2000], now).reason === 'minute');
  check('一小时满 10 次 → 拦（reason=hour）',
    matlabRateInfo(Array.from({ length: 10 }, (_, i) => now - (i + 1) * 120000), now).reason === 'hour');
  check('可配（设 0 = 不限制）', !matlabRateInfo(Array.from({ length: 20 }, (_, i) => now - i * 1000), now, { maxPerMinute: 0, maxPerHour: 0 }).limited);
}

console.log('\n[4] 输出截断（长输出要切，并明确告诉她）');
{
  const short = truncateMatlabOutput('max=160440.5\n', 4000);
  check('短输出不动', short.text === 'max=160440.5\n' && short.truncated === false);
  const long = truncateMatlabOutput('x'.repeat(9000), 4000);
  check('长输出被切到 4000 并带说明', long.truncated === true && long.text.length < 4200 && /已截断/.test(long.text));
  check('截断说明里带上限（她知道为什么短了）', /4000/.test(long.text));
}

console.log('\n[5] 重放输出解析 + 审计条目');
{
  const r = parseReplayOutput([
    'REPLAY_DONE 重放 34 条，生成 2 个文件',
    'REPLAY_FILE ex3_1_plot.png',
    'REPLAY_FILE ex3_2_semilogy.png',
    'REPLAY_WARN mesh: 值必须是数值类型',
  ].join('\n'));
  check('认出"重放完成"', r.done === true);
  check('认出两张图', r.files.length === 2 && r.files[0] === 'ex3_1_plot.png', JSON.stringify(r.files));
  check('认出失败的那条调用', r.warns.length === 1 && /mesh/.test(r.warns[0]), JSON.stringify(r.warns));
  const empty = parseReplayOutput('');
  check('空输出不炸', empty.done === false && empty.files.length === 0);

  const e = matlabAuditEntry({ key: 'private:1', code: 'plot(1:3)', exitCode: 0, ms: 1234, plot: true, files: ['a.png'], truncated: false });
  check('审计条目带 key/退出码/耗时/是否画图/产物', e.key === 'private:1' && e.exitCode === 0 && e.ms === 1234 && e.plot === true && e.files[0] === 'a.png');
  check('审计里的代码被截断（别把日志写爆）', matlabAuditEntry({ code: 'x'.repeat(9000) }).code.length === 2000);
  check('审计里没有 undefined 字段', !JSON.stringify(e).includes('undefined'));
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
