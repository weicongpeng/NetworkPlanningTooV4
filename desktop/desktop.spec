# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（Windows 桌面离线版，onedir）。

构建（在仓库根目录执行）：
    pyinstaller --noconfirm --clean desktop/desktop.spec
输出：
    dist/NetworkPlanningTool/{NPT.exe, _internal/}

说明：
- console 由环境变量 NPT_CONSOLE 控制（CI 冒烟取 1 便于看日志；tag 发行会用 0 重新打包，
  避免发布包自带控制台窗口）
- 不加 UPX、不用 onefile：降低杀软误报与启动开销
- GDAL 栈由 pyogrio wheel 提供，收集逻辑见 hooks/hook-pyogrio.py
"""
import os

DESKTOP_DIR = SPECPATH  # noqa: F821 - PyInstaller 注入的 spec 所在目录
ROOT_DIR = os.path.dirname(DESKTOP_DIR)
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")
FRONTEND_DIST = os.path.join(ROOT_DIR, "frontend", "dist-renderer")
TEMPLATE_DIR = os.path.join(ROOT_DIR, "template")
ICON_PATH = os.path.join(DESKTOP_DIR, "app.ico")

console = os.environ.get("NPT_CONSOLE", "0") == "1"

datas = [
    (FRONTEND_DIST, "frontend/dist-renderer"),
    (TEMPLATE_DIR, "template"),
]

# 版本文件（CI 在 PyInstaller 前生成；本地缺失时跳过）
_VERSION_FILE = os.path.join(DESKTOP_DIR, "version.json")
if os.path.isfile(_VERSION_FILE):
    datas.append((_VERSION_FILE, "."))

hiddenimports = [
    # passlib / python-jose 动态加载的后端
    "passlib.handlers.bcrypt",
    "jose.backends.cryptography_backend",
    # uvicorn 按字符串动态导入的协议/事件循环实现
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # python-multipart：starlette 在 try/except 中导入，冻结时容易漏收
    # 漏收后 request.form() 抛错 → 所有文件上传返回 400 "There was an error parsing the body"
    "multipart",
    "multipart.multipart",
    # pywebview 运行时按平台选择的后端
    "webview.platforms.winforms",
    "tools.spike",
]

a = Analysis(
    [os.path.join(DESKTOP_DIR, "launcher.py")],
    pathex=[BACKEND_DIR, DESKTOP_DIR],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[os.path.join(DESKTOP_DIR, "hooks")],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "fiona",
        "matplotlib",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "cefpython3",
        "IPython",
        "notebook",
        "pytest",
        "tkinter",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="NPT",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=console,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON_PATH if os.path.isfile(ICON_PATH) else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="NetworkPlanningTool",
)
