% 验收用例 A：管理员给的「实验三 Matlab 绘图」（2026-10-13）
% 覆盖：plot / semilogy / meshgrid+mesh / surf / subplot 组合，全部 saveas 到 PNG。
% 在沙箱里这些绘图调用会被桩接住（只录音），出图由重放那一遍完成。
x = linspace(0, 2*pi, 400);
y1 = sin(x).*cos(5*x);
figure('Visible','off'); plot(x, y1); grid on; title('y = sin(x)cos(5x)'); xlabel('x'); ylabel('y');
saveas(gcf, 'ex3_1_plot.png');

y2 = abs(1000*sin(4*x)) + 1;
figure('Visible','off'); semilogy(x, y2); grid on; title('semilogy: y = |1000 sin(4x)| + 1');
saveas(gcf, 'ex3_2_semilogy.png');

[X, Y] = meshgrid(x, x); Z = sin(X).*cos(Y);
figure('Visible','off'); mesh(X, Y, Z); title('mesh: z = sin(x)cos(y)');
saveas(gcf, 'ex3_3_mesh.png');

figure('Visible','off'); surf(X, Y, Z); title('surf: z = sin(x)cos(y)');
saveas(gcf, 'ex3_4_surf.png');

figure('Visible','off');
subplot(2,2,1); plot(x, y1); title('plot');
subplot(2,2,2); semilogy(x, y2); title('semilogy');
subplot(2,2,3); mesh(X, Y, Z); title('mesh');
subplot(2,2,4); surf(X, Y, Z); title('surf');
saveas(gcf, 'ex3_5_subplot.png');
disp('实验三 全部完成');
