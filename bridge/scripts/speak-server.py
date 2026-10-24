#!/usr/bin/env python3
"""常驻的语音合成服务（2026-10-14）。

**引擎（2026-10-14 晚更新）**：默认走 `rvc` —— 管理员给了若叶睦的 RVC 模型（`RYM.zip`，
180 epochs / 48k / IVF520），实测音色比 F5 接近得多（音高 237.7Hz vs F5 的 258.1Hz，她本人 187.8Hz）。
链路：**文字 → F5 生成底音（保证咬字）→ RVC 换成她的音色 → 降调 12%**。

为什么还要 F5 打底：RVC 是**音色转换**，它需要有个人声输入；而 F5 的咬字是满分的（23/23）。
直接让 RVC 吃 TTS 输出会有损失（实测可懂度 11/23），但换来的是音色接近得多 —— 管理员原话
"F5 太中性了"，所以音色优先。

设 `VOICE_ENGINE=f5` 可以退回纯 F5（音色中性但咬字最好）。

为什么常驻：直接每次起 python 光加载模型就要 ~19 秒（加推理约 30 秒），聊天没法用。
这个服务把模型**只加载一次**：加载 F5 + RVC 两个，之后每句约 10~15 秒。

协议（本地 HTTP，只用标准库）：
  POST http://127.0.0.1:3111/speak   {"text": "...", "calm": false}
  → {"ok": true, "wav": "<绝对路径>", "seconds": 5.7, "ms": 8200, "engine": "rvc"}
  GET  http://127.0.0.1:3111/health  → {"ok": true, "ready": true, "engine": "rvc"}

安全：只监听 127.0.0.1；只接受一句话文本（长度上限）；输出写到固定目录；
      不接受任何路径参数（避免被当成写文件的原语）。
"""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE_DIR = os.path.join(ROOT, "assets", "voice", "mutsumi")
OUT_DIR = os.path.join(ROOT, "state", "voice-out")
TMP_DIR = os.path.join(ROOT, "state", "voice-tmp")
REF_EMO = os.path.join(VOICE_DIR, "v6", "ref-emotion.wav")
TXT_EMO = os.path.join(VOICE_DIR, "v6", "ref-emotion.txt")
REF_CALM = os.path.join(VOICE_DIR, "v5", "ref-merged.wav")
TXT_CALM = os.path.join(VOICE_DIR, "v5", "ref-merged.txt")
FFMPEG = os.path.join(ROOT, "tools", "ffmpeg.exe")
# RVC（管理员给的模型）
RVC_ROOT = os.path.join(ROOT, "third_party", "Retrieval-based-Voice-Conversion-WebUI-main")
RVC_MODEL = os.environ.get(
    "VOICE_RVC_MODEL",
    os.path.join(VOICE_DIR, "rvc-external", "RYM", "rym.pth"))
RVC_INDEX = os.environ.get(
    "VOICE_RVC_INDEX",
    os.path.join(VOICE_DIR, "rvc-external", "RYM", "added_IVF520_Flat_nprobe_1_rym_v2.index"))
ENGINE = os.environ.get("VOICE_ENGINE", "rvc").strip().lower()      # rvc | f5
# RVC 变调（半音）。**符号是反的**：实测 f0_up_key=-2 会把 F0 从 209.8 抬到 242.4（+2.2 半音），
# 所以"降调"要传**正数**。+2 半音 ≈ ×0.891 → 209.8 / 1.122 ≈ 187（正好她本人 187.8Hz）。
RVC_SEMITONES = int(os.environ.get("VOICE_RVC_SEMITONES", "0"))
PITCH_FACTOR = float(os.environ.get('VOICE_PITCH', '1.0'))    # 外挂降调**关掉**了：改用 RVC 自己的 f0_up_key
EQ_GAIN = float(os.environ.get('VOICE_EQ_GAIN', '0'))      # 高频搁架增益（dB）
EQ_FREQ = float(os.environ.get('VOICE_EQ_FREQ', '3000'))    # 搁架起点（Hz）
PORT = int(os.environ.get("VOICE_PORT", "3111"))
try:
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("tuning_page", os.path.join(ROOT, "scripts", "voice-tuning-page.py"))
    _mod = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_mod)
    TUNING_PAGE = _mod.PAGE
except Exception:
    TUNING_PAGE = "<h1>调音台页面加载失败</h1>"
# 调音台可改的（初始值 = 上面的默认）
_PITCH = 1.0
_EQ = 0.0
_SEMI = 0
_IRATE = 0.75
_PROT = 0.33
MAX_CHARS = 200
KEEP_FILES = 30

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

_lock = threading.Lock()
_state = {"f5": None, "rvc": None, "ready": False, "lastError": None, "engine": ENGINE}


def load_model():
    """启动时加载一次；失败也照常起服务（好让 /health 能把原因报出来）。"""
    try:
        import torch
        torch.backends.cudnn.enabled = False        # 这台机器 cuDNN 报 127，关掉即可
        from f5_tts.api import F5TTS
        _state["f5"] = F5TTS(model="F5TTS_v1_Base")
    except Exception as e:
        _state["lastError"] = f"F5 加载失败: {type(e).__name__}: {e}"
        return
    if ENGINE == "rvc":
        try:
            sys.path.insert(0, RVC_ROOT)
            cwd0 = os.getcwd()
            os.chdir(RVC_ROOT)                      # RVC 的配置按 cwd 找 assets
            try:
                from infer.cli import create_config
                from infer.vc.modules import VC
                vc = VC(create_config())
                # get_vc 收的是**模型名**（它自己按 weight_root 找 assets/weights/<name>），
                # 传完整路径会被拼成 "assets\weights/D:\..." → Errno 22（2026-10-14 实测）
                model_name = os.path.basename(RVC_MODEL)
                weights_dir = os.path.join(RVC_ROOT, "assets", "weights")
                os.makedirs(weights_dir, exist_ok=True)
                dst = os.path.join(weights_dir, model_name)
                if os.path.isfile(RVC_MODEL) and not os.path.isfile(dst):
                    import shutil
                    shutil.copyfile(RVC_MODEL, dst)
                vc.get_vc(model_name)
                _state["rvc"] = vc
            finally:
                os.chdir(cwd0)
        except Exception as e:
            _state["lastError"] = f"RVC 加载失败: {type(e).__name__}: {e}"
            _state["engine"] = "f5"                 # 退回 F5，别整个哑掉
    _state["ready"] = True


def prune_outputs():
    for d in (OUT_DIR, TMP_DIR):
        try:
            files = sorted((os.path.join(d, f) for f in os.listdir(d) if f.endswith(".wav")),
                           key=os.path.getmtime, reverse=True)
            for old in files[KEEP_FILES:]:
                try:
                    os.remove(old)
                except OSError:
                    pass
        except OSError:
            pass


def _seconds(wav):
    return len(wav) / 24000.0


def trim_silence(wav, sr=24000, thresh_db=-45.0, pad_ms=35):
    """去掉首尾静音。

    2026-10-17 实测（silencedetect）：F5 每段生成的音频**前后都带近 1 秒空白** ——
    一条 13.5 秒的话里 6 秒是静音，三段拼起来就是"说一句、停一秒、再说一句"，
    管理员听到的"卡顿"就是这个。段间还会额外加 0.15 秒 gap，雪上加霜。

    做法：20ms 一帧算 RMS，找到第一个/最后一个超过阈值的帧，各留 pad_ms 余量。
    **只削静音，不碰波形本身**，所以不会影响音色和响度关系。
    """
    if wav is None or not len(wav):
        return wav
    y = np.asarray(wav, dtype=np.float32)
    win = max(1, int(sr * 0.02))
    n = len(y) // win
    if n < 2:
        return y
    frames = y[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    db = 20.0 * np.log10(rms + 1e-12)
    voiced = np.where(db > thresh_db)[0]
    if not voiced.size:
        return y                                   # 整段都静音：原样返回，别削成空
    pad = int(pad_ms / 1000.0 / 0.02)              # 帧数
    a = max(0, int(voiced[0]) - pad) * win
    b = min(n, int(voiced[-1]) + 1 + pad) * win
    if b <= a:
        return y
    return y[a:b]


def squeeze_silence(wav, sr=24000, thresh_db=-45.0, min_pause_ms=300, keep_ms=140):
    """把**段落中间**的长静音压短。

    2026-10-17 实测：F5 生成的音频里，静音不是只出现在首尾 —— 是**每说约 2 秒就停 1 秒**
    （一条 13.5 秒的话有 6 段静音、合计 6 秒）。所以只 trim 首尾没用（试过，静音一段没少）。
    这个函数找所有超过 min_pause_ms 的静音区间，把它们压到 keep_ms（留一点换气感）。
    **只删静音样本，不改波形**，所以音色/响度关系不动。
    """
    if wav is None or not len(wav):
        return wav
    y = np.asarray(wav, dtype=np.float32)
    win = max(1, int(sr * 0.02))
    n = len(y) // win
    if n < 2:
        return y
    frames = y[: n * win].reshape(n, win)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    db = 20.0 * np.log10(rms + 1e-12)
    voiced = db > thresh_db
    if voiced.all():
        return y

    min_frames = max(1, int(min_pause_ms / 1000.0 / 0.02))
    keep_frames = max(1, int(keep_ms / 1000.0 / 0.02))
    out, i = [], 0
    while i < n:
        if voiced[i]:
            out.append(i)
            i += 1
            continue
        j = i
        while j < n and not voiced[j]:
            j += 1
        run = j - i
        # 长静音：只保留开头 keep_frames 帧（后面的帧丢掉 = 时间被压缩）
        take = run if run < min_frames else keep_frames
        out.extend(range(i, min(j, i + take)))
        i = j
    if not out:
        return y
    idx = np.array(out, dtype=np.int64)
    # 按帧展开成样本索引（每帧 win 个样本）
    sample_idx = (idx[:, None] * win + np.arange(win)[None, :]).ravel()
    result = y[sample_idx]
    # 末尾不足一帧的部分原样贴上（通常就是最后那点静音，无所谓）
    return result.astype(np.float32)


def split_sentences(text, max_len=20):
    """把一句话切成适合合成的短句。

    F5 是零样本，**长句偶发只念开头**（2026-10-14 实测：同一句有时 4.17s、有时只 1.38s，
    发出去就只剩前几个字）。切句后每段独立合成、独立校验，坏的那段重试即可。
    """
    import re
    raw = [s for s in re.split(r'(?<=[。！？!?；;])', text) if s.strip()]
    out = []
    for s in raw:
        s = s.strip()
        while len(s) > max_len:
            cut = max(s.rfind('，', 0, max_len), s.rfind('、', 0, max_len), s.rfind(',', 0, max_len))
            if cut <= 0:
                cut = max_len
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if s:
            out.append(s)
    return out or [text]


def f5_raw(seg, calm, seed, tmp_path):
    """F5 生成底音，写到 tmp_path（24k 单声道）。"""
    ref, reftxt_file = (REF_CALM, TXT_CALM) if calm else (REF_EMO, TXT_EMO)
    ref_text = open(reftxt_file, encoding="utf-8").read().strip()
    kwargs = dict(ref_file=ref, ref_text=ref_text, gen_text=seg, file_wave=tmp_path,
                  nfe_step=64, cfg_strength=2.5)
    try:
        _state["f5"].infer(seed=seed, **kwargs)
    except TypeError:
        _state["f5"].infer(**kwargs)
    data, sr = sf.read(tmp_path, dtype="float32")
    return np.asarray(data, dtype=np.float32), sr


def synth_segment(seg, calm, seed, idx):
    """一段文字的最终音频（24k）。rvc 模式：F5 打底 → RVC 换音色；f5 模式：直接用 F5。"""
    tmp_in = os.path.join(TMP_DIR, f"in-{idx}-{seed}.wav")
    base, sr = f5_raw(seg, calm, seed, tmp_in)
    if _state["engine"] != "rvc" or _state["rvc"] is None:
        return base, sr
    try:
        status, result = _state["rvc"].vc_single(
            0,               # speaker id
            tmp_in,
            _SEMI,           # f0_up_key：半音。用 RVC 内建变调把 F5 底音的高音高降下来 ——
                             # 比外挂降调干净（外挂那步在常驻服务里行为不一致，折腾过两轮）
            "rmvpe",
            RVC_INDEX if os.path.isfile(RVC_INDEX) else "",
            _IRATE,          # index_rate
            0,               # resample_sr：0 = 跟随模型
            1.0,             # rms_mix_rate
            _PROT,           # protect
        )
        if not result or result[0] is None or result[1] is None:
            return base, sr          # RVC 出问题就退回 F5 底音，别整句报废
        out_sr, audio = result[0], np.asarray(result[1], dtype=np.float32)
        return audio, out_sr
    except Exception:
        return base, sr


def synthesize(text, calm=False, over=None):
    """over: 参数覆盖（调音台用）—— pitch/eq/semitones/index_rate/protect。"""
    over = over or {}
    global PITCH_FACTOR, EQ_GAIN, RVC_SEMITONES, RVC_INDEX_RATE, RVC_PROTECT
    global _PITCH, _EQ, _SEMI, _IRATE, _PROT
    if "pitch" in over:      _PITCH = float(over["pitch"])
    if "eq" in over:         _EQ = float(over["eq"])
    if "semitones" in over:  _SEMI = int(over["semitones"])
    if "index_rate" in over: _IRATE = float(over["index_rate"])
    if "protect" in over:    _PROT = float(over["protect"])
    ref, reftxt_file = (REF_CALM, TXT_CALM) if calm else (REF_EMO, TXT_EMO)
    if not (os.path.isfile(ref) and os.path.isfile(reftxt_file)):
        return {"ok": False, "error": f"参考素材缺失: {ref}"}
    if not _state["ready"]:
        return {"ok": False, "error": f"模型未就绪: {_state['lastError']}"}
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)
    stamp = time.strftime("%H%M%S") + f"-{int(time.time()*1000) % 1000:03d}"
    raw = os.path.join(OUT_DIR, f"v-{stamp}.raw.wav")
    final = os.path.join(OUT_DIR, f"v-{stamp}.wav")
    t0 = time.time()
    segs = split_sentences(text)
    parts = []
    retries = 0
    with _lock:                                   # 单卡串行，别并发生成
        for n, seg in enumerate(segs):
            # ⚠️ 0.10 秒/字太松了：中文语速约 5~6 字/秒（0.17~0.20 秒/字），
            #    原来 28 字只要求 2.8 秒 = 念出 11 个字就算"合格"，**剩下 17 个字静静丢掉、还不报错**。
            #    2026-10-14 管理员反馈"语音没讲完就结束了"，根子在这里。
            floor = max(0.8, len(seg) * 0.18)
            best = None
            best_sr = 24000
            for attempt in range(4):
                wav, sr = synth_segment(seg, calm, 42 + attempt * 977, n)
                if best is None or len(wav) > len(best):
                    best, best_sr = wav, sr
                if len(wav) / float(sr) >= floor:
                    break
                retries += 1
            else:
                # 4 次都没达到下限：仍用最长的那个，但**说出来**（以前是静默丢字）
                got = (len(best) / float(best_sr)) if best is not None else 0.0
                print(f"[speak-server] ⚠️ 第 {n+1} 段只合成出 {got:.2f}s（下限 {floor:.2f}s，{len(seg)} 字）"
                      f"：{seg[:20]}", flush=True)
            parts.append((best, best_sr))
    # 统一到 24k 再拼接（RVC 输出可能是 48k）
    norm = []
    for wav, sr in parts:
        if sr != 24000:
            n_out = int(round(len(wav) * 24000.0 / sr))
            wav = np.interp(np.linspace(0, len(wav) - 1, n_out), np.arange(len(wav)), wav).astype(np.float32)
        # ⚠️ **不要逐段做峰值归一化**（2026-10-17 管理员反馈"卡顿/忽大忽小"的根源）：
        #    原来每段都拉到 0.99，于是小声的那段被放大、大声的被压 —— 几段接起来
        #    音量一跳一跳，听起来就是"卡顿"。段与段之间要**保持相对音量**，
        #    只有真的超过 1.0（会削波）时才压，而且只压到刚好不超。
        # ★ 先去掉首尾静音（F5 每段前后都带近 1 秒空白，不 trim 拼起来就是"说一句停一秒"）
        wav = trim_silence(wav)
        m = float(np.max(np.abs(wav))) if wav.size else 0.0
        if m > 1.0:
            wav = wav / m * 0.999
        norm.append(wav)
    # 段间停顿：trim 之后每段已经是"干净的一句话"，0.15 秒反而太拖 —— 缩到 0.12 秒，
    # 听着像"换气"，不像"卡住"。
    gap = np.zeros(int(0.12 * 24000), dtype=np.float32)
    merged = np.concatenate([x for p in norm for x in (p, gap)][:-1]) if norm else np.zeros(1, dtype=np.float32)
    # 拼接后再归一化一次：RVC 的输出很满，几段接起来峰值会 >1（实测削波 6 个采样）。
    # 放在写文件之前，python 层做最可靠 —— 别指望 ffmpeg 的 limiter 兜（它默认还会把电平顶上去）。
    # ★ 目标峰值 **-3 dB（0.708）**，不是 0.95（-0.45dB）。
    #   原因：QQ 语音要过 **Silk 有损编码**，峰值贴顶的音频一进编码器就溢出，
    #   播放端听到的就是"爆音"。留 3dB 余量是音频交付的常规做法。
    HEADROOM = 0.708
    peak = float(np.max(np.abs(merged))) if merged.size else 0.0
    if peak > HEADROOM:
        merged = merged / peak * HEADROOM
    # ★ 把段落中间的"每 2 秒停 1 秒"压掉（上面的 trim 只治首尾，治不了这个）
    merged = squeeze_silence(merged)
    seconds = round(len(merged) / 24000.0, 2)
    sf.write(raw, merged, 24000)
    # ── 后处理（2026-10-14 晚，**纯 python 实现，不用 ffmpeg**）──────────────────
    # 为什么不用 ffmpeg：同样的滤镜链手动跑没问题，但在服务里跑完输出却完全没变
    # （F0 210.5Hz、质心 1659Hz，跟没处理一模一样），日志还报成功 —— 不再跟它纠缠。
    #
    # 两件事，都照实测数据定：
    #   ① **变调**：librosa 的 pitch_shift（phase vocoder，变调不变时长）。之前用 ffmpeg 的
    #      asetrate 会连共振峰一起压低 → 声音发闷，管理员正是听出"依旧中性化"。
    #   ② **压高频**：真正的病根是**亮度**。F5 底音频谱质心 2598Hz，她本人只有 1373Hz（高 89%）；
    #      RVC 换成她的音色后仍继承这份亮度（1663Hz）。用一个高频搁架把它压下来。
    try:
        import librosa
        y = merged.astype(np.float32)
        if abs(_PITCH - 1.0) > 0.005:
            # 用 scipy.resample 降调：改播放速率（音高 ×PITCH_FACTOR），时长保持不变。
            # 为什么不用 librosa.effects.pitch_shift：单独跑有效（213.7→189.0Hz），
            # 但在服务里跑完 F0 一点没变 —— 排查到落盘比对都没找出原因（2026-10-14），
            # 不再纠缠，换成这个**单测验证过**的做法（192.7Hz）。
            # 代价：resample 会连共振峰一起压 → 所以下面的 EQ 增益要相应减小（默认 -5dB 而不是 -9dB）。
            import scipy.signal as _ss
            n_out = max(1, int(round(y.size / _PITCH)))
            y = _ss.resample(y, n_out).astype(np.float32)
        # 高频搁架：3kHz 以上按 EQ_GAIN 衰减（默认 -9dB），用 FFT 域实现
        if _EQ < -0.1:
            n = int(2 ** np.ceil(np.log2(max(1024, y.size))))
            Y = np.fft.rfft(y, n=n)
            f = np.fft.rfftfreq(n, 1.0 / 24000.0)
            g = np.ones_like(f)
            hi = f >= EQ_FREQ
            g[hi] = 10 ** (_EQ / 20.0)
            # 3k 附近平滑过渡（1 个倍频程），别做成硬墙
            band = (f >= EQ_FREQ / 2) & (f < EQ_FREQ)
            if band.any():
                t = (np.log2(f[band]) - np.log2(EQ_FREQ / 2)) / 1.0
                g[band] = 10 ** ((_EQ * t) / 20.0)
            y = np.fft.irfft(Y * g, n=n)[:y.size].astype(np.float32)
        # 同上：留 -3dB 给编码器（EQ 之后高频被压，峰值可能变，所以这里再压一次）
        peak2 = float(np.max(np.abs(y))) if y.size else 0.0
        if peak2 > HEADROOM:
            y = y / peak2 * HEADROOM
        merged = y
        print(f"[speak-server] ✅ 后处理完成（pitch×{_PITCH}, EQ {_EQ}dB@{EQ_FREQ:.0f}Hz, semi={_SEMI}, irate={_IRATE}, protect={_PROT}）", flush=True)
    except Exception as e:
        print(f"[speak-server] ⚠️ 后处理失败，用原始音频: {type(e).__name__}: {e}", flush=True)
    seconds = round(len(merged) / 24000.0, 2)
    sf.write(final, merged, 24000)
    try:
        for f in os.listdir(TMP_DIR):                       # 中间文件不留在磁盘上
            if f.startswith("in-"):
                os.remove(os.path.join(TMP_DIR, f))
    except OSError:
        pass
    prune_outputs()
    return {"ok": True, "wav": final, "seconds": seconds, "ms": int((time.time() - t0) * 1000),
            "ref": "calm" if calm else "emotion", "pitch": PITCH_FACTOR,
            "engine": _state["engine"], "segments": len(segs), "retries": retries}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):                  # 静音：日志由桥接侧记
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            # 调音台：浏览器里改参数直接试听（比跟 RVC 的 gradio 版本缠下去省事得多）
            body = TUNING_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/audio/"):
            # 只认 voice-out 里的文件名（basename 兜掉目录穿越），别让它变成任意读文件的原语
            name = os.path.basename(self.path[len("/audio/"):].split("?")[0])
            fp = os.path.join(OUT_DIR, name)
            if not (name.endswith(".wav") and os.path.isfile(fp)):
                self._send(404, {"ok": False, "error": "not found"})
                return
            data = open(fp, "rb").read()
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "ready": _state["ready"], "error": _state["lastError"],
                             "engine": _state["engine"],
                             "params": {"pitch": _PITCH, "eq": _EQ, "semitones": _SEMI,
                                        "index_rate": _IRATE, "protect": _PROT}})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/speak"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > 64 * 1024:
                self._send(400, {"ok": False, "error": "请求体太大或为空"})
                return
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            text = str(data.get("text") or "").strip()
            calm = data.get("calm") is True
            if not text:
                self._send(400, {"ok": False, "error": "text 不能为空"})
                return
            if len(text) > MAX_CHARS:
                text = text[:MAX_CHARS]
            self._send(200, synthesize(text, calm, data.get("over")))
        except Exception as e:
            self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    print(f"[speak-server] 引擎={ENGINE} 加载模型…", flush=True)
    load_model()
    print(f"[speak-server] ready={_state['ready']} engine={_state['engine']} err={_state['lastError']}", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[speak-server] 监听 http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
