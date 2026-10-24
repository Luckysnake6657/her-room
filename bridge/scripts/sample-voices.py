#!/usr/bin/env python3
"""批量抽音色 + **自动筛掉男声**（2026-10-14）。

为什么需要它：ChatTTS 的音色空间里有男有女，随机采样会抽到男声 —— 管理员听了直接"生理不适"。
所以抽样这一步要能**自动判性别**，只把女声端给他挑。

判性别用的是最朴素也最可靠的办法：**基频（F0）中位数**。
  · 成年男声一般 85~155 Hz；
  · 成年女声一般 165~255 Hz；
  · 这里把 165 Hz 当分界线（留一点余量），并且要求**有声帧足够多**（避免把静音/气声算进去）。
F0 估计用 numpy 自相关手写（零额外依赖，够用）。

用法：python scripts/sample-voices.py [个数=15] [输出目录]
输出：一行 UTF-8 JSON：{"ok":true,"kept":[{seed,f0,path,preview}...],"dropped":[{seed,f0}...]}
"""
import json
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 中性测试句：不提"宝宝"那种私密称呼，只用来听音色
TEST_LINE = "这是一段语音测试，用来确认音色。今天天气不错，适合出门走走。"
FEMALE_MIN_HZ = 165.0


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def median_f0(wav_np, sr=24000):
    """自相关估 F0，返回 (中位数Hz, 有声帧数)。静音/气声帧会被跳过。"""
    import numpy as np
    x = np.asarray(wav_np, dtype=np.float32).flatten()
    if x.size < sr // 2:
        return 0.0, 0
    # 预加重 + 去直流
    x = x - float(np.mean(x))
    frame = int(sr * 0.04)          # 40ms
    hop = int(sr * 0.02)            # 20ms
    f0s = []
    lo, hi = int(sr / 300), int(sr / 70)   # 70~300Hz 的 lag 范围
    for start in range(0, x.size - frame, hop):
        seg = x[start:start + frame]
        if float(np.sqrt(np.mean(seg ** 2))) < 0.01:   # 太轻的帧跳过（气声/静音）
            continue
        seg = seg * np.hanning(seg.size)
        ac = np.correlate(seg, seg, mode="full")[seg.size - 1:]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        window = ac[lo:hi]
        if window.size == 0:
            continue
        lag = lo + int(np.argmax(window))
        peak = float(ac[lag])
        if peak < 0.3:               # 自相关太弱 → 不像周期信号
            continue
        f0s.append(sr / lag)
    if not f0s:
        return 0.0, 0
    import numpy as np
    return float(np.median(f0s)), len(f0s)


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "assets", "voice", "candidates")
    os.makedirs(outdir, exist_ok=True)
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import ChatTTS
    except Exception as e:
        emit({"ok": False, "error": f"依赖没装好: {e}"})
        return 0

    chat = ChatTTS.Chat()
    if not chat.load(compile=False, source="huggingface"):
        emit({"ok": False, "error": "ChatTTS 模型加载失败"})
        return 0

    kept, dropped = [], []
    for i in range(count):
        seed = 1000 + i * 37
        try:
            torch.manual_seed(seed)
            spk = chat.sample_random_speaker()
            wavs = chat.infer([TEST_LINE], params_infer_code=ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=0.3, top_P=0.7, top_K=20))
            audio = wavs[0]
            f0, voiced = median_f0(audio)
            if voiced < 8 or f0 <= 0:
                dropped.append({"seed": seed, "f0": round(f0, 1), "why": "f0-估计不出来"})
                continue
            if f0 < FEMALE_MIN_HZ:
                dropped.append({"seed": seed, "f0": round(f0, 1), "why": "偏低(判为男声)"})
                continue
            pt = os.path.join(outdir, f"v{len(kept)+1:02d}-seed{seed}.pt")
            wav = os.path.join(outdir, f"v{len(kept)+1:02d}-seed{seed}.wav")
            torch.save(spk, pt)
            sf.write(wav, audio, 24000)
            kept.append({"seed": seed, "f0": round(f0, 1), "voiced": voiced, "path": pt, "preview": wav})
        except Exception as e:
            dropped.append({"seed": seed, "f0": 0, "why": f"{type(e).__name__}"})

    emit({"ok": True, "testLine": TEST_LINE, "femaleMinHz": FEMALE_MIN_HZ, "kept": kept, "dropped": dropped})
    return 0


if __name__ == "__main__":
    sys.exit(main())
