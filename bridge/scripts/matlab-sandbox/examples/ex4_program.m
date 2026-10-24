% 验收用例 B：管理员给的「实验四 Matlab 程序设计」（2026-10-13）
% ① 百分制 → 五级制（带交互提示；沙箱里没有键盘，靠预置输入队列喂值）
% ② 300 以内：各位数字之和为奇数、且为素数（isprime + mod + floor 那类）
score = input('请输入百分制成绩分数，回车键确认，谢谢！\n');
fprintf('原始分数为%d分，五分制评级为%s\n', score, grade(score));

res = [];
for n = 1:300
    if isprime(n)
        digits = num2str(n) - '0';
        if mod(sum(digits), 2) == 1
            res(end+1) = n; %#ok<AGROW>
        end
    end
end
fprintf('300 以内（各位数字之和为奇数 且 为素数）共 %d 个：\n', numel(res));
disp(res);

% 函数：脚本末尾的局部函数（R2016b+ 支持，这样她不用交两个文件）
function g = grade(score)
if score > 90
    g = 'A';
elseif score > 80
    g = 'B';
elseif score > 70
    g = 'C';
elseif score > 60
    g = 'D';
else
    g = 'F';
end
end
