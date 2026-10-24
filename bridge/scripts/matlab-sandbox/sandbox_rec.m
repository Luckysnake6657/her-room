function varargout = sandbox_rec(fn, args)
% 录制器：把沙箱里被桩接住的绘图调用写成 JSONL，之后由桥接在**正常进程环境**下重放出图。
%
% 为什么这么绕：MATLAB R2025b 出图必须再起 MATLABWindow.exe，而在"最多 1 个进程"的沙箱里
% 图形栈起不来（实测限 1/限 6/AppContainer 三种都卡死或秒退；普通权限下 figure+plot+saveas
% 出 48KB PNG 正常）。所以沙箱里只**录音**，出图交给重放那一遍 —— 她的代码一个字不用改，
% 而"跑系统命令"那层仍然是内核级锁死的（沙箱限 1 个进程）。
global SANDBOX_RECFILE
persistent fid
if isempty(fid)
    fid = fopen(SANDBOX_RECFILE, 'a');
    if fid < 0, fid = []; end
end
if ~isempty(fid)
    try
        % ⚠️ 每个参数**单独** jsonencode 成字符串再放进数组：直接塞 args 的话，
        %   jsondecode 会在"多个同形状参数"时把它们合并成一个更高维数组（实测 mesh(X,Y,Z) 的
        %   三个 400x400 被并成 400x400x3 → 重放报"值必须是数值类型"），参数边界就丢了。
        parts = cell(1, numel(args));
        for k = 1:numel(args)
            try
                parts{k} = jsonencode(args{k});
            catch
                parts{k} = 'null';
            end
        end
        rec = struct('fn', fn, 'args', {parts});
        fprintf(fid, '%s\n', jsonencode(rec));
    catch
        % 参数不可序列化（函数句柄之类）就丢掉这一条：宁可少画一笔，也不许把沙箱弄崩
    end
end
if nargout > 0
    for k = 1:nargout
        varargout{k} = sandbox_placeholder();
    end
end
