// Office 文档取字的「带硬超时」入口（PPT/PPTX/DOCX/XLSX/ODP）。
//
// 和 pdf-extract-safe.mjs 同样的理由：解压是同步的，遇到 zip 炸弹会让
// zlib.inflateRawSync 卡住事件循环，setTimeout 根本不会触发 ——
// 只有塞进 worker 线程才能可靠地超时并强制终止。
//
// 用法：
//   const r = await extractOfficeTextSafe(buffer, { name, timeoutMs: 8000 });
//   r -> { ok, text, kind, crude, timedOut, error, stats }
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function extractOfficeTextSafe(buf, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'office-extract-worker.mjs'), {
        workerData: {
          buffer: buf,
          name: String(opts.name ?? ''),
          opts: {
            ...(opts.images ? { images: opts.images } : {}),
            ...(opts.includePageText ? { includePageText: true } : {}),
          },
        },
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
      finish({ ok: false, timedOut: true, text: '', error: `文档解析超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    timer.unref?.();

    worker.on('message', (msg) => {
      if (msg?.ok) {
        finish({
          ok: true,
          text: msg.text ?? '',
          kind: msg.kind ?? '',
          crude: !!msg.crude,
          stats: msg.stats ?? {},
          images: msg.images ?? [],
          pageTexts: msg.pageTexts ?? [],
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
