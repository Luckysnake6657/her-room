// 量一下 toneLine 现在多长（每轮都要注入），以及总提示词里各段占比。
import { bridgeHarness } from './audit-bridge-harness.mjs';

const b = await bridgeHarness({ config: { socialV2: { enabled: true } } });
try {
  b.setMode('reserved2');
  const p = b.buildWakePromptV2('private:123', 'private');
  console.log('整份唤醒提示词:', p.length, '字符 ≈', Math.round(p.length / 3), 'token');
  for (const seg of ['【说话分寸】', '【把话说成句】', '【像个人在打字】', '【搭得上话】', '【只报做过的】']) {
    const i = p.indexOf(seg);
    console.log('  ', seg, i >= 0 ? `从第 ${i} 字开始` : '（没找到）');
  }
  const from = p.indexOf('【说话分寸】');
  const to = p.indexOf('【搭得上话】');
  const end = p.indexOf('\n\n', p.indexOf('别硬接'));
  console.log('分寸三块合计:', end - from, '字符 ≈', Math.round((end - from) / 3), 'token');
} finally {
  await b.close();
}
