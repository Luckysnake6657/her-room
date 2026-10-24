% MATLAB 沙箱 wrapper（模板：__OUT__/__QUEUE__/__USERCODE__/__REC__/__STUBS__ 由 PowerShell 替换）
% ① 关掉桩函数的同名警告 ② 挂上桩目录 ③ 读预置输入队列 ④ 设录制文件 ⑤ 跑用户代码
%
% 输出方式：**diary**（实测在中文 Windows + R2025b 下写出来的就是 UTF-8，中文正常）。
% ⚠️ 两个反例，别再走回头路：
%   • 加 `feature('DefaultCharacterSet','UTF-8')` → 中文全变 `?`（就是被它搞坏的）；
%   • 改成 `evalc` + `unicode2native` 落盘 → 一样得到 `?`。
%   而同一句中文用 diary 原样写，UTF-8 读出来是对的（见 scripts/matlab-sandbox 的编码实验结论）。
warning('off', 'MATLAB:dispatcher:nameConflict');
addpath('__STUBS__', '-begin');
global SANDBOX_INPUT_QUEUE SANDBOX_INPUT_IDX SANDBOX_RECFILE
SANDBOX_INPUT_QUEUE = {};
try
    fid = fopen('__QUEUE__', 'r');
    if fid > 0
        while true
            ln = fgetl(fid);
            if ~ischar(ln), break; end
            SANDBOX_INPUT_QUEUE{end+1} = ln;
        end
        fclose(fid);
    end
catch
end
SANDBOX_INPUT_IDX = 1;
SANDBOX_RECFILE = '__REC__';
diary('__OUT__'); diary on;
try
    % ⚠️ 不能用 run()：MATLAB 在这台中文 Windows 上按 GBK 读 .m 文件，我们写的是 UTF-8，
    %    于是她代码里的中文**在解析阶段**就变成 `?`（实测「请输入百分制成绩分数，回车键确认，谢谢！」
    %    整句变成 ??????????,?????,??!）。这里显式按 UTF-8 读 + 执行，中文才是对的。
run('__USERCODE__');
catch err
    disp(getReport(err, 'basic'));
    disp('SANDBOX_USER_CODE_ERROR');
end
diary off;
