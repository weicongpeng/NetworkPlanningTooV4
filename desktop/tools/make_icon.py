"""由 frontend/public/app-icon.png 生成 desktop/app.ico（构建期执行，产物不入库）。

用法：python desktop/tools/make_icon.py
依赖：pillow（见 desktop/requirements-desktop.txt）
"""
from __future__ import annotations

import sys
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = DESKTOP_DIR.parent
SRC = ROOT_DIR / "frontend" / "public" / "app-icon.png"
DST = DESKTOP_DIR / "app.ico"

SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("缺少 pillow，请先 pip install pillow（或安装 desktop/requirements-desktop.txt）")
        return 1

    if not SRC.is_file():
        print(f"源图标不存在：{SRC}")
        return 1

    image = Image.open(SRC).convert("RGBA")
    image.save(DST, format="ICO", sizes=SIZES)
    print(f"已生成 {DST}（{DST.stat().st_size} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
