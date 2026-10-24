// PDF 提取的「带硬超时」入口。
//
// 为什么需要 worker 而不是普通 setTimeout：extractPdfText 内部有同步的
// zlib.inflateSync，一旦遇到超大流就会阻塞事件循环，setTimeout 根本不会被触发。
// 只有把工作放进独立线程才能可靠地超时终止。
//
// 用法：
//   const r = await extractPdfTextSafe(buffer, { timeoutMs: 10000 });
//   r -> { ok, text, truncated, timedOut, error, stats }
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function extractPdfTextSafe(buf, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const innerBudgetMs = Math.max(1000, timeoutMs - 1500);

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'pdf-extract-worker.mjs'), {
        workerData: { buffer: buf, budgetMs: innerBudgetMs },
        // 传 Buffer 时用 transferList 更高效，但这里数据不大，直接克隆即可
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动提取线程：${error?.message ?? error}`, text: '' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(() => {
      // 线程里可能有同步 inflateSync 卡着，terminate 能强制结束
      finish({ ok: false, timedOut: true, text: '', error: `提取超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    timer.unref?.();

    worker.on('message', (msg) => {
      if (msg?.ok) {
        finish({
          ok: true,
          text: msg.text ?? '',
          engine: msg.engine ?? 'unknown',
          truncated: !!msg.truncated,
          timedOut: !!msg.timedOut,
          stats: msg.stats ?? {},
          warnings: msg.warnings ?? [],
        });
      } else {
        finish({ ok: false, error: msg?.error ?? '提取失败', text: '' });
      }
    });
    worker.on('error', (error) => finish({ ok: false, error: `提取线程异常：${error?.message ?? error}`, text: '' }));
    worker.on('exit', (code) => {
      if (!settled && code !== 0) finish({ ok: false, error: `提取线程退出码 ${code}`, text: '' });
    });
  });
}
