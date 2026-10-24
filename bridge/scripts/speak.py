#!/usr/bin/env python3
"""她说的话 → 语音（2026-10-14，管理员要的"她也能发语音"，音色选**本地神经 TTS**）。

为什么是 ChatTTS（都按这台机器的实际算力定的）：
  • 机器是 **RTX 4070 Laptop 8GB** + i7-14650HX + 32G —— 跑得动，所以不用退而求其次用 SAPI 那种机械音；
  • ChatTTS 是**为对话训练**的，中文口语感、停顿、语气都自然（SAPI 的 Huihui 完全比不了）；
  • **音色固定**：启动时采样一个 speaker embedding 存成 .pt，之后一直用它 —— 她的声音是"同一个人"，
    不会每次换嗓子。要换音色就重新采样挑一个（`--sample-voice`）。
  • **全程本地**：模型在本机、推理在本机，不出网（和他的"别传别人服务器"一个道理）。

用法：
  合成：  python scripts/speak.py "要说的话" 输出.wav
  采样音色：python scripts/speak.py --sample-voice assets/voice/chengmowen.pt ["用来采样的句子"]
输出：一行 UTF-8 JSON（stdout）：{"ok":true,"wav":"...","ms":1234,"seconds":3.2}
"""
import json
import os
import sys
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VOICE = os.path.join(ROOT, "assets", "voice", "chengmowen.pt")


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def load_chat():
    import ChatTTS
    chat = ChatTTS.Chat()
    if not chat.load(compile=False, source="huggingface"):
        raise RuntimeError("ChatTTS 模型加载失败（模型没下全？检查 HF_ENDPOINT/HF_HUB_DISABLE_XET）")
    return chat


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        emit({"ok": False, "error": "用法: speak.py <文本> <输出wav> | speak.py --sample-voice <音色.pt> [句子]"})
        return 0

    t0 = time.time()
    try:
        import torch
        import ChatTTS
    except Exception as e:
        emit({"ok": False, "error": f"依赖没装好（torch/ChatTTS）: {e}"})
        return 0

    sampling = args[0] == "--sample-voice"
    voice_path = args[1] if sampling and len(args) > 1 else DEFAULT_VOICE
    try:
        chat = load_chat()
    except Exception as e:
        emit({"ok": False, "error": str(e)})
        return 0

    # 采样音色：随机取一个 speaker，存下来长期用（她的声音就定下来了）
    if sampling:
        text = args[2] if len(args) > 2 else "宝宝，我在呢。今天想跟你说点事情。"
        try:
            torch.manual_seed(int(os.environ.get("VOICE_SEED", "42")))
            spk = chat.sample_random_speaker()
            os.makedirs(os.path.dirname(voice_path), exist_ok=True)
            torch.save(spk, voice_path)
            wavs = chat.infer([text], params_infer_code=ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=0.3, top_P=0.7, top_K=20))
            import soundfile as sf
            sf.write(voice_path.replace(".pt", "-试听.wav"), wavs[0], 24000)
            emit({"ok": True, "voice": voice_path, "preview": voice_path.replace(".pt", "-试听.wav"), "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            emit({"ok": False, "error": f"采样失败: {type(e).__name__}: {e}"})
        return 0

    text = args[0]
    out_wav = args[1] if len(args) > 1 else os.path.join(os.environ.get("TEMP", "/tmp"), "her-voice.wav")
    if not text.strip():
        emit({"ok": False, "error": "文本是空的"})
        return 0

    # 加载固定音色（没有就现采一个并存下来 —— 第一次跑完她的声音就固定了）
    spk = None
    try:
        if os.path.isfile(voice_path):
            spk = torch.load(voice_path, map_location="cpu")
        else:
            torch.manual_seed(int(os.environ.get("VOICE_SEED", "42")))
            spk = chat.sample_random_speaker()
            os.makedirs(os.path.dirname(voice_path), exist_ok=True)
            torch.save(spk, voice_path)
    except Exception as e:
        emit({"ok": False, "error": f"音色加载失败: {e}"})
        return 0

    try:
        wavs = chat.infer(
            [text],
            params_infer_code=ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=0.3, top_P=0.7, top_K=20),
            params_refine_text=ChatTTS.Chat.RefineTextParams(prompt="[oral_1][laugh_0][break_4]"),
        )
        import soundfile as sf
        os.makedirs(os.path.dirname(os.path.abspath(out_wav)), exist_ok=True)
        sf.write(out_wav, wavs[0], 24000)
        seconds = round(wavs[0].shape[-1] / 24000.0, 2)
        emit({"ok": True, "wav": out_wav, "seconds": seconds, "ms": int((time.time() - t0) * 1000), "voice": voice_path})
    except Exception as e:
        emit({"ok": False, "error": f"合成失败: {type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
