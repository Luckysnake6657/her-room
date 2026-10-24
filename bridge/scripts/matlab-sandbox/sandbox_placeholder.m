function h = sandbox_placeholder()
% 图形对象的占位（沙箱里没有真的 figure，桩函数返回它，好让 `gcf`/`gca`/`set` 之类不报错）。
% 重放那一遍用的是**真** MATLAB 图形对象，所以录制里凡是出现占位的地方，重放时改成 gcf/gca。
h = struct('sandboxPlaceholder', true);
