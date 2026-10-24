function sandbox_replay(recFile, outFile)
% 重放器（模板：__RECFILE__/__OUTFILE__ 由 PowerShell 替换）：在**正常权限**的 MATLAB 里
% 逐条重放沙箱录下的绘图调用，真的把图出出来。
%
% 关键点：
%   • 录制里凡是指向占位对象的第一参数（`saveas(gcf,...)` 里的 gcf、`title(gca,...)` 里的 gca）
%     在重放时替换成真的 gcf/gca；
%   • 单条失败只记一行 REPLAY_WARN，不让整批图全丢；
%   • 结果写进 outFile（桥接读它判断哪几张图出来了）。
recFile = '__RECFILE__';
outFile = '__OUTFILE__';
lines = {};
try
    fid = fopen(recFile, 'r');
    if fid > 0
        while true
            ln = fgetl(fid);
            if ~ischar(ln), break; end
            ln = strtrim(ln);
            if ~isempty(ln), lines{end+1} = ln; end
        end
        fclose(fid);
    end
catch
end

log = {};
madeFiles = {};
for i = 1:numel(lines)
    try
        r = jsondecode(lines{i});
    catch
        log{end+1} = sprintf('REPLAY_WARN 第 %d 条解析失败', i);
        continue
    end
    fn = r.fn;
    a = r.args;
    % ⚠️ jsondecode 会把"只有一个元素的数组"降级成那个元素本身（`["on"]` → `'on'`），
    %    所以非 cell 就直接包一层 —— 千万别 num2cell（`num2cell('on')` 会拆成 {'o','n'}，
    %    实测重放 `grid('on')` 变成 `grid('o','n')` 直接报错）。
    if ~iscell(a), a = {a}; end
    if numel(a) == 1 && isempty(a{1}), a = {}; end   % 无参调用（gcf 之类）
    vals = cell(1, numel(a));                        % 逐参数解码（录制侧是逐个 jsonencode 的）
    for k = 1:numel(a)
        if ischar(a{k})
            try, vals{k} = jsondecode(a{k}); catch, vals{k} = a{k}; end
        else
            vals{k} = a{k};
        end
    end
    a = vals;
    % 占位对象 → 真的当前图/坐标轴
    if ~isempty(a) && isstruct(a{1}) && isfield(a{1}, 'sandboxPlaceholder')
        switch fn
            case {'saveas', 'print', 'savefig', 'exportgraphics'}
                a{1} = gcf;
            otherwise
                a{1} = gca;
        end
    end
    try
        feval(fn, a{:});
        if any(strcmp(fn, {'saveas', 'print', 'savefig', 'exportgraphics'}))
            for k = 1:numel(a)
                if ischar(a{k}) && ~isempty(a{k})
                    madeFiles{end+1} = a{k};
                end
            end
        end
    catch err
        log{end+1} = sprintf('REPLAY_WARN %s: %s', fn, err.message);
    end
end

out = {};
out{end+1} = sprintf('REPLAY_DONE 重放 %d 条，生成 %d 个文件', numel(lines), numel(madeFiles));
for k = 1:numel(madeFiles)
    out{end+1} = sprintf('REPLAY_FILE %s', madeFiles{k});
end
for k = 1:numel(log)
    out{end+1} = log{k};
end
try
    fidw = fopen(outFile, 'w');
    if fidw > 0
        for k = 1:numel(out)
            fprintf(fidw, '%s\n', out{k});
        end
        fclose(fidw);
    end
catch
end
