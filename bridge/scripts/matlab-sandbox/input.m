function varargout = input(prompt, varargin)
% 沙箱里的 input：不读键盘，按"预置输入队列"顺序返回（这样交互式作业也能无人值守跑）。
% 放在沙箱目录里 → 当前目录优先于内置函数 → 用户脚本里的 input('请输入…') 会走到这里。
% 队列来自 wrapper 读的 sandbox_inputs.txt；没有队列就报一条清楚的错，而不是挂在那儿等键盘。
global SANDBOX_INPUT_QUEUE SANDBOX_INPUT_IDX
if isempty(SANDBOX_INPUT_QUEUE) || SANDBOX_INPUT_IDX > numel(SANDBOX_INPUT_QUEUE)
    error('SANDBOX_NO_INPUT: 这个盒子没有键盘输入（跑交互式代码需要预置输入值）');
end
v = SANDBOX_INPUT_QUEUE{SANDBOX_INPUT_IDX};
SANDBOX_INPUT_IDX = SANDBOX_INPUT_IDX + 1;
if nargin > 0 && ischar(prompt)
    fprintf('%s', prompt);
end
fprintf('%s\n', v);   % 模拟"人输入了什么"，输出里能看到这次用掉哪个值
if nargin > 1 && ischar(varargin{1}) && strcmpi(varargin{1}, 's')
    varargout{1} = v;
else
    varargout{1} = str2double(v);
end
