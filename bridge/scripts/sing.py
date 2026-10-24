#!/usr/bin/env python3
"""一键翻唱：给她一首歌，她还你一首用她嗓子唱的（2026-10-14）。

链路（全自动）：
    <你的歌>  →  demucs 分离人声  →  RVC 换成她的音色  →  混回伴奏  →  mp3 + flac
    （人声分离只留人声；RVC 只换音色、不动旋律；混音时人声 1.0 / 伴奏 0.7，带限幅）

用法：
    python scripts/sing.py "D:\\path\\to\\song.aac"
    python scripts/sing.py song.mp3 --index-rate 0.6 --protect 0.4 --vocal 1.0 --inst 0.7
    python scripts/sing.py song.mp3 --pitch 2          # 升 2 个半音（会改旋律，慎用）
    python scripts/sing.py song.mp3 --model mutsumi.pth

为什么保持原调：管理员要的是"她用她的嗓子唱这首歌"，所以默认 --pitch 0。
她的模型实测音域 200~387Hz（约 11 个半音），落在这个范围外的旋律会不稳 —— 这是说话素材训出来的
模型的天花板，跟工具链无关。

产物落在 state/sing/ 下：song.wav（转码）、sep/（分离）、vocals-rym.wav（换完音色的干声）、
cover-01.mp3 / cover-01.flac / cover-01.wav（成品）。
"""
import argparse
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RVC_ROOT = os.path.join(ROOT, "third_party", "Retrieval-based-Voice-Conversion-WebUI-main")
WORK = os.path.join(ROOT, "state", "sing")
FFMPEG = os.path.join(ROOT, "tools", "ffmpeg.exe")
DEFAULT_MODEL = "rym.pth"
DEFAULT_INDEX = os.path.join(RVC_ROOT, "logs", "rym", "added_IVF520_Flat_nprobe_1_rym_v2.index")


SPEAK_PORT = 3111


def speak_pids():
    """找监听 speak-server 端口的进程 PID（这台机器是 Windows）。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace").stdout
    except Exception:
        return set()
    pids = set()
    for line in (out or "").splitlines():
        if f":{SPEAK_PORT}" in line and "LISTENING" in line.upper():
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    return pids


def quiet_speak_server():
    """跑 RVC 前让 speak-server 让路。

    2026-10-17 实测：它常驻占 3.7GB 显存，而这台卡只有 8GB —— RVC 合成时明明
    "4.23 GiB free" 却连 100 MiB 都切不出来（CUDA Graphs 的私有池把块切碎了）。
    停掉它（显存回到 190MiB）之后，45 秒的副歌 28 秒就跑完了。
    所以：**唱歌时它让路，唱完立刻回来**。代价是她这几分钟发不了语音（异步的，无所谓）。
    """
    pids = speak_pids()
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True)
    if pids:
        time.sleep(3)
        print(f"  让路：停掉 speak-server（PID {'、'.join(sorted(pids))}）", flush=True)
    return bool(pids)


def resume_speak_server():
    """把 speak-server 拉回来（后台起，不占我们的 stdout）。"""
    try:
        # ⚠️ 必须**彻底脱离**（2026-10-17 实测）：只给 DEVNULL 不够 ——
        #    子进程仍继承父进程的句柄，导致 sing.py 明明跑完了却**不退出**，
        #    调用方（桥接）一直等它，最后被当成超时（我那次卡了 10 分钟以上）。
        #    start_new_session + CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS 才算真脱离。
        _flags = 0
        for _name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
            _flags |= getattr(subprocess, _name, 0)
        subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "scripts", "speak-server.py")],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, creationflags=_flags,
        )
        print("  恢复：speak-server 已在后台启动（约 20 秒后可用）", flush=True)
    except Exception as e:
        print(f"  ⚠️ 恢复 speak-server 失败：{e}", flush=True)


def probe_duration(path):
    """拿音频时长（秒）；拿不到返回 0（调用方会退化成"从头开始"）。"""
    try:
        r = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr or "")
        if not m:
            return 0.0
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        return 0.0


def run(cmd, cwd=None, timeout=None, label="", env=None):
    print(f"[sing] {label or cmd[0]} …", flush=True)
    t0 = time.time()
# encoding 必须显式给 utf-8：Windows 中文 locale 下 text=True 会按 GBK 解码，
    # 子进程（RVC / demucs）输出里只要有非 GBK 字节就 UnicodeDecodeError 把整条链打断
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "")[-1200:]
        raise RuntimeError(f"{label or cmd[0]} 失败（rc={r.returncode}）：\n{tail}")
    print(f"[sing]   ✓ {label} 用时 {time.time()-t0:.0f}s", flush=True)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song", help="要唱的歌（任意 ffmpeg 认得的格式）")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="RVC 模型名（assets/weights 下的）")
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--index-rate", type=float, default=0.75)
    ap.add_argument("--protect", type=float, default=0.33)
    ap.add_argument("--pitch", type=int, default=0, help="变调半音（默认 0=保持原调，别乱改）")
    ap.add_argument("--vocal", type=float, default=1.0, help="人声音量")
    ap.add_argument("--inst", type=float, default=0.7, help="伴奏音量")
    ap.add_argument("--name", default="cover-01", help="输出文件名（不含扩展名）")
    ap.add_argument("--acappella", action="store_true",
                    help="清唱：不要伴奏，只留她的人声（RVC 输出本身就是清唱）")
    ap.add_argument("--clip", type=float, default=45,
                    help="只处理副歌的秒数（默认 45）：**先截这一段再分离+换音色**，"
                         "8GB 显存跑整首会 CUDA OOM，跑 45 秒稳。传 0 = 处理整首（会 OOM，慎用）")
    ap.add_argument("--clip-at", type=float, default=0.25,
                    help="副歌从时长的百分之几开始（默认 0.25 = 25%% 处，避开前奏）")
    args = ap.parse_args()

    if not os.path.isfile(args.song):
        print(f"找不到文件：{args.song}")
        return 2
    os.makedirs(WORK, exist_ok=True)
    song_wav = os.path.join(WORK, "song.wav")
    vocals = os.path.join(WORK, "sep", "htdemucs", "song", "vocals.wav")
    inst = os.path.join(WORK, "sep", "htdemucs", "song", "no_vocals.wav")
    converted = os.path.join(WORK, "vocals-rym.wav")
    out_wav = os.path.join(WORK, f"{args.name}.wav")

    # ① 转码成 44.1k 立体声 wav（demucs 吃什么格式都行，但统一一下更稳）
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", args.song, "-ar", "44100", "-ac", "2", song_wav],
        label="转码")
    # ①b **只截副歌**（2026-10-17）：8GB 卡上 RVC 处理 4 分多钟的歌要 7.4GB 显存，
    #    实测直接 CUDA OOM（把 speak-server 停掉也一样，不是被挤，是真不够）。
    #    所以默认只做副歌：先截一段，后面的 demucs 和 RVC 都只碰这一段 ——
    #    demucs 从 233s 降到几十秒，RVC 的显存也降到 1/5，**稳**。
    #    副歌位置按"时长的 --clip-at（默认 25%）"起算，避开前奏。
    proc_wav = song_wav
    if args.clip > 0:
        proc_wav = os.path.join(WORK, "clip.wav")
        dur = probe_duration(song_wav)
        start = max(0.0, dur * max(0.0, min(0.9, args.clip_at)))
        if dur > 0 and start + args.clip > dur:
            start = max(0.0, dur - args.clip)
        print(f"[sing] 只做副歌：{start:.1f}s 起，取 {args.clip:.0f}s（全曲 {dur:.1f}s）", flush=True)
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{args.clip:.3f}",
             "-i", song_wav, "-ar", "44100", "-ac", "2", proc_wav],
            label=f"截取副歌({args.clip:.0f}s)")
    # ⚠️ demucs 用**输入文件名**当输出子目录（2026-10-17 踩到）：输入叫 clip.wav
    #    就产出 sep/htdemucs/clip/vocals.wav。原来这里硬写 "song"，于是"只做副歌"时
    #    读到的是**上一次整首的旧干声**（旧文件在，"分离没产出"的检查也照样通过）——
    #    结果 RVC 处理了 1:53 的整首。子目录必须跟着 proc_wav 走。
    _stem = os.path.splitext(os.path.basename(proc_wav))[0]
    vocals = os.path.join(WORK, "sep", "htdemucs", _stem, "vocals.wav")
    inst = os.path.join(WORK, "sep", "htdemucs", _stem, "no_vocals.wav")
    # ② 分离人声
    # ⚠️ demucs 用 **CPU**（-d cpu）：这台机器的卡只有 8GB，常驻的 speak-server（F5+RVC）
    #    已经占着一部分，再让 demucs 上 GPU 会 CUDA OOM（2026-10-14 实测 stderr：
    #    "memory 1.10 GiB is allocated by PyTorch" —— 她那次唱歌失败就是这个）。
    #    分离在 CPU 上慢一些（原本 36 秒），但整条链已经是异步的，慢点无所谓；
    #    省下的显存全留给 RVC（那一步必须 GPU，否则慢十倍）。
    # ⚠️ **必须 --jobs 1**（2026-10-16 实测）：demucs 默认按 CPU 核数开并行，每份各占内存，
    #    再叠加常驻的 speak-server（F5+RVC 几 GB），进程会直接崩 ——
    #    rc=3221225477 = 0xC0000005 ACCESS_VIOLATION，24 秒就死，日志里只有 traceback。
    #    单线程慢一些，但整条链是异步的，慢无所谓；**跑不完才是问题**。
    # ⚠️ 先删可能要读的那个旧产物（不然"分离没产出"的检查会被旧文件骗过去）
    for _stale in (vocals, inst):
        try:
            if os.path.isfile(_stale): os.remove(_stale)
        except Exception:
            pass
    run([sys.executable, "-m", "demucs", "-d", "cpu", "--jobs", "1", "--two-stems=vocals",
         "-o", os.path.join(WORK, "sep"), proc_wav],
        cwd=ROOT, timeout=3600, label="分离人声(demucs/CPU)")
    if not os.path.isfile(vocals):
        print("分离没产出 vocals.wav")
        return 1
    # ③ RVC 换音色（保持原调）
    #    ⚠️ 先让 speak-server 让路（详见 quiet_speak_server 的注释），跑完在 finally 里恢复。
    quieted = quiet_speak_server()
    try:
        run([sys.executable, "infer/cli.py", "--model", args.model, "--input", vocals, "--output", converted,
              "--pitch", str(args.pitch), "--index", args.index, "--index-rate", str(args.index_rate),
             "--protect", str(args.protect), "--f0-method", "rmvpe", "--overwrite"],
            cwd=RVC_ROOT, timeout=3600, label="换音色(RVC)",
        # 必须给 PYTHONPATH：RVC 的脚本要 import infer/…，不给就报 No module named 'infer'
        env={**os.environ, "PYTHONPATH": RVC_ROOT, "PYTHONUTF8": "1",
             # ★ CUDA 显存碎片（2026-10-17 实测）：8GB 卡上 RVC 会 CUDA OOM，
             #   报错原文就建议开这个 —— "If reserved but unallocated memory is large try
             #   setting PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to avoid fragmentation"。
             #   当时 GPU 只用了 1.8G/8G，不是真不够，是碎片把可用块切碎了。
                 "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"})
    finally:
        if quieted:
            resume_speak_server()
    # ④ 出两个形态（2026-10-17 起默认都出，RVC 只跑一次）：
    #    · 清唱（-=acap）→ 发语音条
    #    · 带伴奏（=out_wav）→ 发 mp3 文件
    #    管理员的意思一直是"带伴奏照常发 mp3，清唱发语音" —— 但那是**一次 RVC** 产出的两份，
    #    不是跑两遍（跑两遍要停/起两次 speak-server，还多花 25 秒）。
    acap_wav = os.path.join(WORK, f"{args.name}-acap.wav")
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", converted,
         "-af", "alimiter=limit=0.95:level=false,volume=0.9",
         "-ar", "44100", "-ac", "2", acap_wav], label="清唱（发语音条用）")
    if args.acappella:
        # 只要清唱：把它当成主产物
        out_wav = acap_wav
    else:
        filt = (f"[0:a]aresample=44100,aformat=channel_layouts=stereo,volume={args.vocal}[vo];"
                f"[1:a]aresample=44100,volume={args.inst}[bo];"
                f"[vo][bo]amix=inputs=2:duration=first:normalize=0[m];"
                f"[m]alimiter=limit=0.95:level=false,volume=0.9[out]")
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", converted, "-i", inst,
             "-filter_complex", filt, "-map", "[out]", "-ar", "44100", "-ac", "2", out_wav], label="混音")
    # ④.5 截"副歌"（管理员 2026-10-14：只发副歌也行 —— 语音条有时长上限）
    #   不猜结构，直接选**能量最高**的连续 N 秒（人声+伴奏的总能量，副歌通常最响）。
    if args.clip and args.clip > 1:
        import numpy as np
        import soundfile as sf
        y, sr = sf.read(out_wav, dtype="float32")
        mono = y.mean(axis=1) if y.ndim > 1 else y
        win = int(args.clip * sr)
        if len(mono) > win:
            hop = max(1, int(sr * 0.5))
            energy = np.convolve(mono.astype(np.float64) ** 2, np.ones(win), mode="valid")
            start = int(np.argmax(energy[::hop]) * hop)
            start = max(0, min(start, len(mono) - win))
            seg = y[start:start + win]
            clip_wav = os.path.join(WORK, f"{args.name}-clip.wav")
            sf.write(clip_wav, seg, sr)
            print(f"[sing] 副歌：{args.clip:.0f}s（从 {start/sr:.1f}s 处，能量最高）→ {os.path.relpath(clip_wav, ROOT)}", flush=True)
            out_wav = clip_wav

    # ⑤ 出 mp3（320k）和 flac（无损）
    mp3 = os.path.join(WORK, f"{args.name}.mp3")
    flac = os.path.join(WORK, f"{args.name}.flac")
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", out_wav, "-codec:a", "libmp3lame", "-b:a", "320k", mp3],
        label="转 mp3")
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", out_wav, "-codec:a", "flac", flac],
        label="转 flac")
    for p in (mp3, flac, out_wav):
        print(f"[sing] 产物：{os.path.relpath(p, ROOT)}  {os.path.getsize(p)/1024/1024:.1f}MB", flush=True)
    print("[sing] 完成。发送用：qq_send_file（mp3 4MB 左右够日常听；flac 无损但大一点）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
