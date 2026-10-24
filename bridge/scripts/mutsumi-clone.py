#!/usr/bin/env python3
"""把若叶睦的素材切出"纯参考段"并克隆出多个版本（2026-10-14）。

管理员反馈"比较像了，但还是有点差距"——克隆的像度**上限由参考音频决定**，所以这一版做了三件事：
  ① **按逐词时间轴切纯单句**：把相邻词间隔 >0.45s 视为断句，只保留**连续说话 4.5~8 秒**的段落，
     参考文本用**那一小段的逐词转写**（比整段转写精确，F5 对 ref_text 很敏感）；
  ② **降噪 + 响度归一**（ffmpeg afftdn + loudnorm）：动画原声难免有底噪/背景音；
  ③ **提高推理步数**（nfe_step 32→64、cfg_strength 2.0→2.5）：更贴参考，代价是慢一倍。

用法：python scripts/mutsumi-clone.py <素材wav> <输出目录> [版本数=4]
输出：一行 JSON：{"ok":true,"versions":[{ref,refText,clone,seconds}...]}
"""
import json
import os
import subprocess
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

GEN_TEXT = "这是一段语音测试，用来确认音色。今天天气不错，适合出门走走。"
GAP = 0.45          # 词间隔超过它就算断句
MIN_SEC, MAX_SEC = 4.0, 8.0


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def find_clean_spans(words):
    """把逐词时间轴合成"连续说话"的段落，返回 [{'start','end','text'}]。"""
    spans, cur = [], []
    for w in words:
        if cur and (w.start - cur[-1].end) > GAP:
            spans.append(cur)
            cur = []
        cur.append(w)
    if cur:
        spans.append(cur)
    out = []
    for grp in spans:
        start, end = grp[0].start, grp[-1].end
        dur = end - start
        if MIN_SEC <= dur <= MAX_SEC:
            out.append({"start": round(start, 2), "end": round(end, 2), "dur": round(dur, 2),
                        "text": "".join(x.word for x in grp).strip()})
    return out


def main():
    src = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(src)
    want = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    os.makedirs(outdir, exist_ok=True)
    ff = ffmpeg_exe()

    import numpy as np
    import wave
    with wave.open(src, "rb") as w:
        sr = w.getframerate()
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _info = model.transcribe(audio, language="ja", beam_size=1, word_timestamps=True)
    words = []
    for s in segs:
        for w in (s.words or []):
            words.append(w)
    spans = find_clean_spans(words)
    if not spans:
        emit({"ok": False, "error": "找不到够长的连续说话段（素材太碎？）"})
        return 0
    # 挑时长最长、最有代表性的几段
    spans.sort(key=lambda x: -x["dur"])
    picked = spans[:want]

    from f5_tts.api import F5TTS
    f5 = F5TTS(model="F5TTS_v1_Base")

    versions = []
    for i, sp in enumerate(picked, 1):
        raw = os.path.join(outdir, f"clean-{i:02d}-raw.wav")
        ref = os.path.join(outdir, f"clean-{i:02d}.wav")
        clone = os.path.join(outdir, f"clone-{i:02d}.wav")
        # 切出来：**直接 numpy 切片**（ffmpeg 的 -ss/-t 在这台上产出过空文件）
        import soundfile as sf
        a, b = int(sp["start"] * sr), int(sp["end"] * sr)
        if b - a < sr:      # 切出来不足 1 秒就没意义
            continue
        sf.write(raw, audio[a:b], sr)
        # 降噪 + 响度归一
        subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-i", raw,
                        "-af", "afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "24000", "-ac", "1", ref], check=True)
        try:
            wav, _sr, _ = f5.infer(ref_file=ref, ref_text=sp["text"], gen_text=GEN_TEXT,
                                   file_wave=clone, nfe_step=64, cfg_strength=2.5)
            seconds = round(len(wav) / 24000.0, 2)
            versions.append({"ref": ref, "refText": sp["text"], "refSeconds": sp["dur"],
                             "clone": clone, "seconds": seconds})
        except Exception as e:
            versions.append({"ref": ref, "refText": sp["text"], "refSeconds": sp["dur"],
                             "clone": None, "error": f"{type(e).__name__}: {e}"})
    res = {"ok": True, "genText": GEN_TEXT, "versions": versions}
    with open(os.path.join(outdir, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=2)
    emit(res)
    return 0


if __name__ == "__main__":
    sys.exit(main())
