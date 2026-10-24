#!/usr/bin/env python3
"""启动 RVC 的 WebUI，并顺手补掉两个依赖冲突（2026-10-14）。

为什么要这个包装脚本，而不是直接 `python webui.py`：

这台机器上**两套 TTS 引擎共用一份 Python 环境**，依赖互相打架：
  · F5-TTS 需要新的 `huggingface_hub`（它要 `BucketNotFoundError`）和 numpy≥2；
  · RVC 的 gradio 4.x 还在 `from huggingface_hub import HfFolder`，而新版 hub 把这个类删了。
    直接跑就 `ImportError: cannot import name 'HfFolder'`。

**这里用运行时补丁把它补上**（不降级、不动任何包），于是 RVC 的 WebUI 和她的发音服务
（`speak-server.py`，走 F5 + RVC）能同时活着 —— 管理员要用 WebUI 手动调参数，不能为了这个
把她的发音链路拆了。

用法：python scripts/start-rvc-webui.py [--port 7865] [--share]
"""
import argparse
import os
import runpy
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RVC_ROOT = os.path.join(ROOT, "third_party", "Retrieval-based-Voice-Conversion-WebUI-main")


def patch_huggingface_hub():
    """给新版 huggingface_hub 补回被删掉的 HfFolder（gradio 4.x 还在用）。"""
    import huggingface_hub

    if hasattr(huggingface_hub, "HfFolder"):
        return "已是旧版，无需补丁"

    class _HfFolder:                       # 只要方法在就行；这里没有 token 要存
        @staticmethod
        def get_token():
            return None

        @staticmethod
        def save_token(token):
            return None

        @staticmethod
        def delete_token():
            return None

        @staticmethod
        def get_token_path():
            return os.path.join(os.path.expanduser("~"), ".huggingface", "token")

    huggingface_hub.HfFolder = _HfFolder
    # 有些代码写 `from huggingface_hub import HfFolder`，这句把属性挂到模块上就够了
    return "已补 HfFolder"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7865)
    ap.add_argument("--share", action="store_true", help="生成 gradio 公网分享链接（默认不生成）")
    args, rest = ap.parse_known_args()

    os.chdir(RVC_ROOT)
    sys.path.insert(0, RVC_ROOT)
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    print(f"[rvc-webui] {patch_huggingface_hub()}", flush=True)
    print(f"[rvc-webui] 启动 WebUI，端口 {args.port}", flush=True)

    # 直接把 webui.py 当 __main__ 跑（它会自己解析 --port/--share）
    sys.argv = ["webui.py", "--port", str(args.port)] + (["--share"] if args.share else []) + rest
    runpy.run_path(os.path.join(RVC_ROOT, "webui.py"), run_name="__main__")


if __name__ == "__main__":
    sys.exit(main())
