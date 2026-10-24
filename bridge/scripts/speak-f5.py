#!/usr/bin/env python3
"""她说的话 → 语音（F5-TTS 零样本克隆 + 降调后处理，2026-10-14）。

管理员要的是"**像若叶睦**"+"**带点情感起伏**"。经过实测（数据都在 assets/voice/mutsumi/ 里）：

  · **为什么是 F5**：CosyVoice 2 的 requirements 锁死 `grpcio==1.57.0`/`torch==2.3.1`，
    对 Python 3.12 没有预编译包（`Failed to build 'grpcio'`），要装它得再装一个 Python 3.10；
    GPT-SoVITS 卡在 `pyopenjtalk`（需要 C++ 编译器）。RVC 试过且**不成立**：
    它的内容编码器会把发音拉向训练语言，而素材只有日语 → 咬字全毁（可懂度 23 → 1~4）。
  · **为什么参考用"干声 + 情绪句"**：明日方舟那批是干声（peak −4.23dB，比动画干净得多）；
    按 F0 相对起伏筛出她情绪最明显的句子当参考，输出起伏能高 80%（0.139 → 0.251）。
    ⚠️ 参考文本必须是**日语原文**（F5 对 ref_text 很敏感，用 whisper 转写得到）。
  · **为什么降调**：实测 F5 输出音高普遍偏高 25~35%（252Hz vs 她的 188Hz），
    降调 12% 后落到 207.8Hz，差距减半 —— 这是"更像"最直接的一步。
  · **推理步数必须 64**：32 步会让音高掉到 200Hz（差 52.6Hz），音色明显不对。

用法：
  python scripts/speak-f5.py "要说的话" 输出.wav [--calm]
输出：一行 UTF-8 JSON：{"ok":true,"wav":"...","seconds":3.2,"ms":9000}
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE_DIR = os.path.join(ROOT, "assets", "voice", "mutsumi")
# 情绪参考（她自己情绪最明显的两句话拼成）与平静参考（默认用情绪版，更自然）
REF_EMO = os.path.join(VOICE_DIR, "v6", "ref-emotion.wav")
TXT_EMO = os.path.join(VOICE_DIR, "v6", "ref-emotion.txt")
REF_CALM = os.path.join(VOICE_DIR, "v5", "ref-merged.wav")
TXT_CALM = os.path.join(VOICE_DIR, "v5", "ref-merged.txt")
FFMPEG = os.path.join(ROOT, "tools", "ffmpeg.exe")
# 降调：音高 ×0.88，时长不变（asetrate 改采样率、atempo 抵消速度变化）
PITCH_FACTOR = float(os.environ.get("VOICE_PITCH", "0.88"))


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def main():
    args = [a for a in sys.argv[1:]]
    if len(args) < 2:
        emit({"ok": False, "error": "用法: speak-f5.py <文本> <输出wav> [--calm]"})
        return 0
    text, out_wav = args[0].strip(), args[1]
    calm = "--calm" in args
    if not text:
        emit({"ok": False, "error": "文本是空的"})
        return 0

    ref, reftxt_file = (REF_CALM, TXT_CALM) if calm else (REF_EMO, TXT_EMO)
    if not (os.path.isfile(ref) and os.path.isfile(reftxt_file)):
        emit({"ok": False, "error": f"参考素材缺失: {ref}"})
        return 0
    ref_text = open(reftxt_file, encoding="utf-8").read().strip()

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    import time
    t0 = time.time()
    try:
        import torch
        torch.backends.cudnn.enabled = False      # cuDNN 在这台机器上报 127，关掉即可
        from f5_tts.api import F5TTS
        f5 = F5TTS(model="F5TTS_v1_Base")
        raw = out_wav + ".raw.wav"
        wav, _sr, _ = f5.infer(ref_file=ref, ref_text=ref_text, gen_text=text, file_wave=raw,
                               nfe_step=64, cfg_strength=2.5)
        seconds = round(len(wav) / 24000.0, 2)
    except Exception as e:
        emit({"ok": False, "error": f"合成失败: {type(e).__name__}: {e}"})
        return 0

    # 降调（音高 ×0.88、时长不变）；失败就退回原音，不让整条链断掉
    try:
        if os.path.isfile(FFMPEG) and abs(PITCH_FACTOR - 1.0) > 0.005:
            r = subprocess.run(
                [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", raw,
                 "-af", f"asetrate=24000*{PITCH_FACTOR},aresample=24000,atempo={1/PITCH_FACTOR:.6f}",
                 "-ar", "24000", "-ac", "1", out_wav],
                capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                os.replace(raw, out_wav)
        else:
            os.replace(raw, out_wav)
    except Exception:
        try:
            os.replace(raw, out_wav)
        except OSError:
            pass
    finally:
        try:
            os.remove(raw)
        except OSError:
            pass

    emit({"ok": True, "wav": out_wav, "seconds": seconds, "ms": int((time.time() - t0) * 1000),
          "ref": ("calm" if calm else "emotion"), "pitch": PITCH_FACTOR})
    return 0


if __name__ == "__main__":
    sys.exit(main())
