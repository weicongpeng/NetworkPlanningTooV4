"""Windows 桌面离线版启动器（PyInstaller 打包入口）。

运行模型：
- 主线程运行 pywebview 窗口（Windows 下 GUI 必须在主线程）
- 后台 daemon 线程运行 uvicorn，绑定 127.0.0.1 随机空闲端口（不触发防火墙弹窗）
- 可写数据在 %APPDATA%/NetworkPlanningTool（NPT_DATA_ROOT 可覆盖），与安装目录解耦，
  覆盖安装/卸载不影响用户数据
- Windows 命名互斥体保证单实例

另提供 --selftest（不建窗口）：起服务 → 健康检查 → GDAL/SPA 冒烟 → 退出码（CI 用）。
"""
from __future__ import annotations

import argparse
import ctypes
import logging
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Optional, Tuple

APP_NAME = "网络规划工具"
MUTEX_NAME = "Local\\NPTDesktop"
READY_PATH = "/api/v1/system/status"
# 启动时 lifespan 会做数据索引检查与地图缓存预热，首次启动可能较慢
READY_TIMEOUT_SECONDS = 120

_MUTEX_HANDLE: Optional[int] = None
_log = logging.getLogger("desktop")


# ---------------------------------------------------------------- 环境与日志

def _default_data_root() -> Path:
    """可写数据根：NPT_DATA_ROOT > %APPDATA%/NetworkPlanningTool（Windows）> 用户目录。"""
    env_root = os.environ.get("NPT_DATA_ROOT")
    if env_root:
        return Path(env_root)
    if os.name == "nt":
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(appdata) / "NetworkPlanningTool"
    # 非 Windows 仅用于本地调试
    return Path.home() / ".network-planning-tool"


def _bootstrap_environment() -> Path:
    data_root = _default_data_root()
    os.environ.setdefault("NPT_DATA_ROOT", str(data_root))
    os.environ.setdefault("NPT_DESKTOP", "1")
    # Windows 无 fork，桌面版统一走线程池（跳过 ProcessPoolExecutor）
    os.environ.setdefault("NPT_MAX_WORKERS", "1")
    os.environ.setdefault("NPT_HOST", "127.0.0.1")
    os.environ.setdefault("NPT_RELOAD", "false")
    return data_root


def _setup_logging(data_root: Path) -> None:
    log_dir = data_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(
            log_dir / "desktop.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
    ]
    if sys.stderr is not None:  # 窗口模式（console=False）下 stderr 为 None
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
        handlers=handlers,
        force=True,
    )


def _ensure_backend_on_path() -> None:
    """源码方式运行时把 backend/ 加入 sys.path；冻结包内 app 已打包，无需处理。"""
    if getattr(sys, "frozen", False):
        return
    backend = Path(__file__).resolve().parents[1] / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def _bundle_dir() -> Path:
    """只读资源根：冻结时 _MEIPASS（onedir 下即 _internal），源码时为仓库根。"""
    root = getattr(sys, "_MEIPASS", None)
    if root:
        return Path(root)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def _asset_version() -> str:
    """用内置 index.html 的 mtime 作为静态资源版本，升级后强制 WebView2 重新取页面。"""
    try:
        index = _bundle_dir() / "frontend" / "dist-renderer" / "index.html"
        return str(int(index.stat().st_mtime))
    except OSError:
        return "0"


def _window_size() -> tuple[int, int, tuple[int, int]]:
    """按屏幕分辨率适配窗口尺寸（小屏上固定 1440x900 会让底部按钮落到屏幕外）。"""
    width, height = 1440, 900
    min_width, min_height = 1024, 680
    if os.name == "nt":
        try:
            user32 = ctypes.windll.user32
            screen_w, screen_h = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
            if screen_w and screen_h:
                width = max(900, min(width, int(screen_w * 0.92)))
                height = max(600, min(height, int(screen_h * 0.92)))
        except Exception:
            pass
    return width, height, (min(min_width, width), min(min_height, height))


# ------------------------------------------------------------------ 单实例

def _message_box(text: str, flags: int) -> None:
    if os.name != "nt":
        print(text)
        return
    user32 = ctypes.windll.user32
    user32.MessageBoxW.restype = ctypes.c_int
    user32.MessageBoxW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_uint,
    ]
    user32.MessageBoxW(None, text, APP_NAME, flags)


def _acquire_single_instance() -> bool:
    """Windows 命名互斥体；已存在同名实例时返回 False。非 Windows 恒 True。"""
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    handle = kernel32.CreateMutexW(None, 0, MUTEX_NAME)
    if not handle:
        _log.warning("创建互斥体失败（err=%s），跳过单实例检查", ctypes.get_last_error())
        return True
    _MUTEX_HANDLE = handle  # 保持引用，避免句柄被回收导致互斥失效
    return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS


# -------------------------------------------------------------- 服务与窗口

def _create_bound_socket() -> Tuple[socket.socket, int]:
    """绑定 127.0.0.1 的随机空闲端口，返回已监听 socket 与实际端口。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    return sock, sock.getsockname()[1]


def _start_server(sock: socket.socket) -> Tuple[Any, threading.Thread]:
    import uvicorn

    from app.api import create_app

    config = uvicorn.Config(create_app(), log_config=None, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [sock]}, name="npt-uvicorn", daemon=True
    )
    thread.start()
    return server, thread


def _wait_ready(port: int, timeout: float = READY_TIMEOUT_SECONDS) -> bool:
    url = f"http://127.0.0.1:{port}{READY_PATH}"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.3)
    return False


def _run_window(port: int, data_root: Path) -> None:
    import webview

    # 必须开启，否则 WebView2 会直接取消所有导出下载
    webview.settings["ALLOW_DOWNLOADS"] = True
    width, height, min_size = _window_size()
    # ?v= 资源版本：升级后避免 WebView2 复用缓存的旧 index.html/旧前端
    webview.create_window(
        APP_NAME,
        f"http://127.0.0.1:{port}/?v={_asset_version()}",
        width=width,
        height=height,
        min_size=min_size,
    )
    # private_mode=False + storage_path：localStorage 持久化（否则每次启动掉登录）
    webview.start(private_mode=False, storage_path=str(data_root / "webview"))


def _log_path_hint() -> str:
    return str(_default_data_root() / "logs" / "desktop.log")


def _run_selftest(port: int) -> int:
    from tools.spike import run_spike

    return run_spike(base_url=f"http://127.0.0.1:{port}")


# -------------------------------------------------------------------- main

def main(argv: Optional[list] = None) -> int:
    multiprocessing.freeze_support()

    parser = argparse.ArgumentParser(prog="NPT", description=APP_NAME)
    parser.add_argument(
        "--selftest", action="store_true", help="启动后端并执行冒烟测试后退出（CI 用）"
    )
    args = parser.parse_args(argv)

    data_root = _bootstrap_environment()
    _setup_logging(data_root)
    _ensure_backend_on_path()
    _log.info("桌面启动器启动，数据根: %s", data_root)

    if not _acquire_single_instance():
        _log.info("检测到已有实例在运行，退出")
        _message_box("程序已在运行，请在任务栏切换到已打开的窗口。", 0x40)
        return 0

    sock, port = _create_bound_socket()
    _log.info("后端监听 127.0.0.1:%s", port)
    server, thread = _start_server(sock)
    if not _wait_ready(port):
        _log.error("后端启动超时（%s 秒），日志: %s", READY_TIMEOUT_SECONDS, _log_path_hint())
        _message_box(f"程序启动失败，请将日志发送给技术支持：\n{_log_path_hint()}", 0x10)
        return 1
    _log.info("后端就绪")

    if args.selftest:
        return _run_selftest(port)

    _log.info("打开桌面窗口")
    _run_window(port, data_root)
    _log.info("窗口已关闭，正在退出")
    server.should_exit = True
    thread.join(timeout=10)
    return 0


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception:
        logging.getLogger("desktop").exception("启动失败")
        try:
            _message_box(
                f"程序启动失败，请将日志发送给技术支持：\n{_log_path_hint()}", 0x10
            )
        except Exception:
            pass
    sys.exit(exit_code)
