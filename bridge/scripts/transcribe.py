#!/usr/bin/env python3
"""QQ 语音 → 文字（2026-10-14，管理员点名要的"进阶 3"）。

为什么是这套组合（都实测过）：
  • QQ 语音的容器是 **AMR**（实测 `record` 段给的 `file` 是 `xxx.amr`）——
    所以**不需要** silk 解码器（`pilk` 在这台机器上编译失败，那条路直接绕过）。
  • 解码交给 **imageio-ffmpeg 自带的 ffmpeg**（实测编解码器里有 `amr_nb`：
    decoders amrnb / libopencore_amrnb），不依赖系统装没装 ffmpeg。
  • 转写用 **faster-whisper small**（实测：模型加载 1.4s、8 秒语音转写 2.4s、语言判定 zh 置信度 1.00）。
  • **全程本地**：音频不出网、模型不出网（下载完就离线跑）。管理员明确要求"别传别人的服务器"。

隐私：本脚本只**读**音频、只**写**转写文本；转码出来的临时 wav 用完就删。
      （调用方（桥接）负责把下载到的 amr 也删掉 —— 本地只留文字。）

用法：python scripts/transcribe.py <音频文件路径>
输出：一行 UTF-8 JSON（stdout）：{"ok":true,"text":"...","lang":"zh","ms":2400,"seconds":8.0}
      失败也是 JSON（{"ok":false,"error":"..."}），调用方不用解析异常。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave

# HF 镜像 + 关掉 xet：实测国内直连 huggingface 的 xet 传输会 401，模型下不来
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODEL_NAME = os.environ.get("VOICE_ASR_MODEL", "small")


def emit(obj):
    """一律 UTF-8 直出：中文转写结果不能在这儿被 GBK 吃掉。"""
    data = json.dumps(obj, ensure_ascii=False)
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def audio_seconds(path):
    try:
        import imageio_ffmpeg  # noqa: F401
    except Exception:
        return None
    return None


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "用法: python transcribe.py <音频文件>"})
        return 0
    src = sys.argv[1]
    if not os.path.isfile(src):
        emit({"ok": False, "error": f"文件不存在: {src}"})
        return 0

    t_start = time.time()
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        emit({"ok": False, "error": f"找不到 ffmpeg（imageio-ffmpeg 没装好）: {e}"})
        return 0

    # ① 转成 whisper 要的规格：16k 单声道 wav。amr 就是靠这一步解开的。
    #
    # ⚠️ 后缀会骗人（2026-10-14 实测）：他发来的文件叫
    #    「反方向的钟-周杰伦-MP3在线免费播放与下载 - 歌曲宝MP3音乐下载_1296669103.mp3」，
    #    但内容是别的容器 —— ffmpeg 按 .mp3 选了 mp3 解复用器，直接报
    #    "Failed to find two consecutive MPEG audio frames"，白转一场。
    #    （QQ 文件消息的扩展名来自发送方，不能信。）
    #
    #    对策：先按原样试（AMR 语音条走这条最快）；失败就把输入复制成**没有扩展名**再试 ——
    #    这时 ffmpeg 只能靠文件头嗅探，反而认得出来。
    wav_path = os.path.join(tempfile.gettempdir(), f"asr-{os.getpid()}-{int(time.time()*1000)}.wav")
    probe_inputs = [src]
    noext = ""
    try:
        stem, ext = os.path.splitext(src)
        if ext:
            noext = os.path.join(tempfile.gettempdir(), f"asr-noext-{os.getpid()}-{int(time.time()*1000)}")
            shutil.copyfile(src, noext)
            probe_inputs.append(noext)
    except Exception:
        noext = ""   # 复制失败就只试原样

    try:
        last_err = ""
        ok = False
        for candidate in probe_inputs:
            proc = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", candidate,
                 "-ar", "16000", "-ac", "1", wav_path],
                capture_output=True, text=True, timeout=90,
            )
            if proc.returncode == 0 and os.path.isfile(wav_path):
                ok = True
                if candidate is not src:
                    emit_note = "(后缀不可信，已按内容嗅探)"     # 只做记录
                    print(f"[transcribe] {emit_note}", file=sys.stderr)
                break
            last_err = (proc.stderr or "").strip()[:200]
        if not ok:
            emit({"ok": False, "error": f"ffmpeg 转码失败: {last_err}"})
            return 0
        import numpy as np
        with wave.open(wav_path, "rb") as w:
            frames, rate = w.getnframes(), w.getframerate()
            audio = np.frombuffer(w.readframes(frames), dtype=np.int16).astype(np.float32) / 32768.0
        seconds = round(frames / float(rate or 16000), 1)
        if frames <= 0:
            emit({"ok": False, "error": "音频是空的"})
            return 0
    finally:
        try:
            os.remove(wav_path)      # 转码产物用完即删
        except OSError:
            pass
        if noext:
            try:
                os.remove(noext)         # 无后缀副本同样用完即删（隐私）
            except OSError:
                pass

    # ② 转写（直接喂数组，绕开 faster-whisper 与新版 av 的不兼容）
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        emit({"ok": False, "error": f"faster-whisper 没装好: {e}"})
        return 0
    try:
        model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
        # 语言：默认 zh（他说话是中文，固定语言更准更快）；音频文件/歌走 "auto" 自动检测
        # （2026-10-14 实测：英文歌被强制成 zh 时，25 秒只转出两个字）
        _lang = str(os.environ.get("TRANSCRIBE_LANG", "zh")).strip().lower()
# VAD 是给"说话"设计的：唱歌会被它当成非语音滤掉（2026-10-14 实测：英文歌 25 秒
        # 只转出两个字）。所以音频文件走 TRANSCRIBE_VAD=0 关掉它。
        _vad = str(os.environ.get("TRANSCRIBE_VAD", "1")).strip() not in ("0", "false", "no")
        _kw = {"beam_size": 1, "vad_filter": _vad}
        if _lang and _lang != "auto":
            _kw["language"] = _lang
        segments, info = model.transcribe(audio, **_kw)
        text = "".join(s.text for s in segments).strip()
    except Exception as e:
        emit({"ok": False, "error": f"转写失败: {type(e).__name__}: {e}"})
        return 0

    emit({
        "ok": True,
        "text": text,
        "lang": getattr(info, "language", "") or "",
        "langProb": round(float(getattr(info, "language_probability", 0) or 0), 2),
        "seconds": seconds,
        "ms": int((time.time() - t_start) * 1000),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
