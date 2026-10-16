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
import json
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
from typing import Any, Callable, Optional, Tuple

APP_NAME = "网优引擎"
MUTEX_NAME = "Local\\NPTDesktop"
READY_PATH = "/api/v1/system/status"
# 启动时 lifespan 会做数据索引检查与地图缓存预热，首次启动可能较慢
READY_TIMEOUT_SECONDS = 120
# OTA 安装 helper 会等本进程退出后才静默安装；窗口关闭超过该秒数仍存活则强制结束进程
EXIT_GRACE_SECONDS = 20
# 本机后端端口：必须是固定值，否则每次启动 origin（含端口）都变，WebView2 的
# localStorage 会整体重置 —— 语言/主题/登录态等设置永远"保存不住"。
# 端口被占用时向上找一个空闲端口并记进 DATA_ROOT/last_port.json，下次优先复用。
PREFERRED_PORT = 18789
PREFERRED_PORT_TRIES = 20
PORT_STATE_FILE = "last_port.json"

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


def _select_desktop_profile(data_root: Path) -> str:
    """选当前运行模式配置档并完成存量数据迁移。

    必须在导入 app.core.config 之前执行：config 在导入时就按
    NPT_DESKTOP_PROFILE 定型全部业务数据路径（数据库引擎同理）。
    显式注入了 NPT_DESKTOP_PROFILE（调试/测试）时尊重环境变量，
    否则读上次登录写入的 active_profile.json（默认 shared）。
    """
    from app.core.desktop_profiles import (
        active_profile_from_env,
        ensure_legacy_migrated,
        read_active_profile,
        write_active_profile,
    )

    if not os.environ.get("NPT_DESKTOP_PROFILE"):
        os.environ["NPT_DESKTOP_PROFILE"] = read_active_profile(data_root)
    profile = active_profile_from_env()
    write_active_profile(data_root, profile)
    # 旧版本平铺在数据根的业务数据首启时一次性迁入 shared 档
    ensure_legacy_migrated(data_root, profile)
    _log.info("桌面配置档：%s（业务数据根：%s/profiles/%s）", profile, data_root, profile)
    return profile


def _bootstrap_environment() -> Path:
    data_root = _default_data_root()
    os.environ.setdefault("NPT_DATA_ROOT", str(data_root))
    os.environ.setdefault("NPT_DESKTOP", "1")
    # 配置档选择先于一切 app 导入（路径在 config 导入时定型）
    _select_desktop_profile(data_root)
    # Windows 无 fork，桌面版统一走线程池（跳过 ProcessPoolExecutor）
    os.environ.setdefault("NPT_MAX_WORKERS", "1")
    os.environ.setdefault("NPT_HOST", "127.0.0.1")
    os.environ.setdefault("NPT_RELOAD", "false")
    # 在线授权与 OTA：服务器地址（可在系统环境变量覆盖）
    os.environ.setdefault("NPT_SERVER_URL", "https://app.pengwc.asia")
    os.environ.setdefault("NPT_DESKTOP_CHANNEL", "stable")
    # 版本必须以包内 version.json 为准（不能用 setdefault）：OTA 升级脚本由**旧版本**
    # 进程拉起，重启的新进程会继承旧进程环境里的 NPT_DESKTOP_VERSION（旧版本号），
    # setdefault 会一直沿用旧值——「桌面授权」页的「当前版本」列、OTA「是否已生效」
    # 的判定都会卡在升级前的版本上（version.json 缺失时才退回环境变量，供源码调试）。
    # 用户可见表现：点「重启并更新」后自动打开的应用里版本还是旧的、提示"更新未生效"，
    # 手动再关一次再开才对——这条必须保证"重启即完成"，不能依赖用户再重启一次。
    # （升级脚本也会在拉起前 `set "NPT_DESKTOP_VERSION="` 兜底清掉继承值。）
    version = _desktop_version()
    if version:
        os.environ["NPT_DESKTOP_VERSION"] = version
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


def _desktop_version() -> str:
    """读取打包时注入的 version.json（CI 在 PyInstaller 前写入；缺失返回空串）。"""
    try:
        data = json.loads((_bundle_dir() / "version.json").read_text(encoding="utf-8"))
        return str(data.get("version") or "")
    except Exception:
        return ""


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


def _release_single_instance() -> None:
    """主动释放互斥体句柄。

    关窗后进程还要收尾（停服务、解释器退出），这段时间互斥体仍被持有；用户马上
    再点一次图标就会误报「程序已在运行」。窗口一关就释放句柄，立刻允许新实例启动。
    """
    global _MUTEX_HANDLE
    handle, _MUTEX_HANDLE = _MUTEX_HANDLE, None
    if not handle or os.name != "nt":
        return
    try:
        ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(ctypes.c_void_p(handle))
    except Exception:  # noqa: BLE001
        pass


# -------------------------------------------------------------- 服务与窗口

def _saved_port_path(data_root: Optional[Path]) -> Optional[Path]:
    return data_root / PORT_STATE_FILE if data_root else None


def _read_saved_port(data_root: Optional[Path]) -> Optional[int]:
    """上次成功监听的端口（保证 origin 稳定）。"""
    path = _saved_port_path(data_root)
    if not path or not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("port")
        return int(value) if isinstance(value, int) else None
    except Exception:  # noqa: BLE001
        return None


def _write_saved_port(data_root: Optional[Path], port: int) -> None:
    path = _saved_port_path(data_root)
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"port": port}), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        _log.warning("记录本机端口失败（不影响启动）：%s", exc)


def _try_bind(port: int) -> Optional[socket.socket]:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # 上次进程刚退出时端口可能处于 TIME_WAIT，允许复用
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
        return sock
    except OSError:
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass
        return None


def _create_bound_socket(data_root: Optional[Path] = None) -> Tuple[socket.socket, int]:
    """绑定 127.0.0.1 的稳定端口，返回已监听 socket 与实际端口。

    端口必须尽量固定：WebView2 的 localStorage 按 origin（含端口）隔离，
    随机端口会让语言/主题/登录态等本地设置每次启动都被清空。
    """
    candidates: list = []
    saved = _read_saved_port(data_root)
    if saved:
        candidates.append(saved)
    candidates.extend(range(PREFERRED_PORT, PREFERRED_PORT + PREFERRED_PORT_TRIES))
    for port in candidates:
        sock = _try_bind(port)
        if sock is not None:
            _write_saved_port(data_root, port)
            return sock, port
    # 兜底：系统分配空闲端口（仍记录下来，下次优先复用）
    sock = _try_bind(0)
    if sock is None:  # pragma: no cover - 极端情况
        raise RuntimeError("无法绑定本机回环端口")
    port = sock.getsockname()[1]
    _write_saved_port(data_root, port)
    _log.warning("固定端口均被占用，本次使用随机端口 %s（本地设置可能无法保留）", port)
    return sock, port


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


def _force_exit_after(delay: float) -> None:
    """兜底定时器：delay 秒后进程仍存活则直接结束。

    关窗后若被 WebView2 / 后台线程拖住，进程迟迟不退出会让用户再启动时误报
    「程序已在运行」；OTA 升级脚本也会永久卡在等待本进程退出。这里保证进程一定会退出。
    """

    def _worker() -> None:
        time.sleep(delay)
        _log.warning("窗口关闭后 %.0f 秒仍未退出，强制结束进程", delay)
        os._exit(0)

    threading.Thread(target=_worker, daemon=True, name="npt-force-exit").start()


def _make_exit_handler(window: Any) -> Callable[[], None]:
    """构造退出回调：先武装强制退出看门狗，再请求关闭窗口（destroy 可能阻塞）。"""

    def _exit_handler() -> None:
        _log.info("收到退出请求：关闭窗口（%s 秒内未退出将强制结束进程）", EXIT_GRACE_SECONDS)
        _force_exit_after(EXIT_GRACE_SECONDS)
        try:
            window.destroy()
        except Exception:  # noqa: BLE001
            _log.exception("请求关闭窗口失败，立即强制结束进程以保证 OTA 安装继续")
            os._exit(0)

    return _exit_handler


def _make_fullscreen_handler(window: Any) -> Callable[[bool], None]:
    """构造全屏回调：把前端的「全屏 / 退出全屏」转成桌面主窗口的系统级全屏。

    WebView2 里的 HTML Fullscreen API 只会让网页内容占满 WebView 自身（窗口不变，
    标题栏仍在）；桌面端必须由壳层把窗口切成全屏才能真正布满整个屏幕。
    pywebview 只提供 toggle_fullscreen()、没有状态查询，这里按本进程记录期望状态，
    只在状态真的变化时切换；退出全屏后补一次 maximize()，回到启动时的最大化窗口
    （pywebview 的退出分支会先把窗口置为 Normal + 进入全屏前的尺寸）。
    """
    state = {"fullscreen": False}

    def _handler(fullscreen: bool) -> None:
        fullscreen = bool(fullscreen)
        if fullscreen == state["fullscreen"]:
            return
        window.toggle_fullscreen()
        state["fullscreen"] = fullscreen
        if not fullscreen:
            window.maximize()

    return _handler


def _background_update_armed() -> bool:
    """本进程是否已转入后台更新（服务不可用时按未武装处理）。"""
    try:
        from app.services import desktop_update_service as updater

        return updater.is_background_armed()
    except Exception:  # noqa: BLE001
        return False


def _make_close_handler() -> Callable[[], None]:
    """窗口关闭事件处理器：武装「关不掉就强杀」看门狗。

    例外：用户点过「后台运行」——此时进程必须活到下载完成、安装脚本被拉起为止。
    若照常武装看门狗，窗口一关 20 秒后 os._exit 就会把下载线程一起杀掉，表现为
    "点了后台运行、关窗后什么都没发生"；这种场景交给 _continue_background_update
    在下载等待结束后再武装看门狗。
    """

    def _on_closing() -> None:
        if _background_update_armed():
            _log.info("后台更新进行中：窗口关闭不启动强制退出看门狗，等待下载完成后再退出")
            return
        _force_exit_after(EXIT_GRACE_SECONDS)

    return _on_closing


def _run_window(port: int, data_root: Path) -> None:
    import webview

    # 必须开启，否则 WebView2 会直接取消所有导出下载
    webview.settings["ALLOW_DOWNLOADS"] = True
    width, height, min_size = _window_size()
    # ?v= 资源版本：升级后避免 WebView2 复用缓存的旧 index.html/旧前端
    window = webview.create_window(
        APP_NAME,
        f"http://127.0.0.1:{port}/?v={_asset_version()}",
        width=width,
        height=height,
        min_size=min_size,
        maximized=True,  # 启动即最大化（表格/地图列多，窗口越大越好用）
        # pywebview 默认 text_select=False 会注入 CSS 全局禁用文本选择，网页端能复制的
        # 文字在桌面端选不中；打开后与浏览器行为一致
        text_select=True,
    )
    # 关窗也要兜底：正常关闭路径被卡住时进程不退出，用户再启动会误报「程序已在运行」
    try:
        window.events.closing += _make_close_handler()
    except Exception as exc:  # noqa: BLE001
        _log.warning("订阅窗口关闭事件失败（不影响使用）：%s", exc)
    # 注入退出回调：后端"重启并安装"时用它关闭窗口并让本进程退出（同进程桥接）
    try:
        from app import desktop_bridge

        desktop_bridge.set_exit_handler(_make_exit_handler(window))
        _log.info("已注入桌面桥接退出回调")
    except Exception as exc:  # noqa: BLE001
        _log.warning("注入桌面桥接退出回调失败（自动升级退避为手动重启）：%s", exc)

    # 注入标题回调：前端把「运行模式 + 实时同步状态」写到窗口标题栏（失败仅影响标题展示）
    try:
        from app import desktop_bridge

        desktop_bridge.set_title_handler(window.set_title)
    except Exception as exc:  # noqa: BLE001
        _log.warning("注入窗口标题回调失败（标题将只显示应用名）：%s", exc)
    # 注入全屏回调：地图页「全屏」让主窗口真全屏（覆盖整个屏幕、无标题栏）
    try:
        from app import desktop_bridge

        desktop_bridge.set_fullscreen_handler(_make_fullscreen_handler(window))
    except Exception as exc:  # noqa: BLE001
        _log.warning("注入窗口全屏回调失败（地图全屏将退化为应用内全屏）：%s", exc)
    # private_mode=False + storage_path：localStorage 持久化（否则每次启动掉登录）
    webview.start(private_mode=False, storage_path=str(data_root / "webview"))


def _log_path_hint() -> str:
    return str(_default_data_root() / "logs" / "desktop.log")


def _background_update_marker_exists(data_root: Path) -> bool:
    """用户选了「后台运行」且更新尚未结束（标记文件由 desktop_update_service 维护）。"""
    try:
        return (data_root / "updates" / "background_update.json").is_file()
    except Exception:  # noqa: BLE001
        return False


def _clear_stale_background_marker(data_root: Path) -> None:
    """清理残留的「后台更新中」标记。

    上一进程若在后台更新中被强杀（进程崩溃/被结束），finally 不执行、标记会留下来；
    本进程已拿到单实例互斥体 = 没有别的进程在后台更新，标记必然是残留。
    """
    try:
        (data_root / "updates" / "background_update.json").unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def _continue_background_update() -> None:
    """窗口已关闭但用户选了「后台运行」：等下载完成后自动安装，再让进程退出。

    后台更新由本进程内的 desktop_update_service 驱动（下载线程 + 状态），
    窗口关掉后进程要活到安装脚本被拉起，否则下载会随进程一起消失。
    等待期间不武装关窗看门狗（见 _make_close_handler）；等待结束（拉起安装/失败/超时）
    后再武装，保证收尾阶段无论被什么卡住都有界退出。
    """
    try:
        from app.services import desktop_update_service as updater
    except Exception as exc:  # noqa: BLE001
        _log.warning("后台更新不可用（导入失败）：%s", exc)
        return
    if not updater.is_background_armed():
        return
    _log.info("后台更新已启用：窗口已关闭，继续下载并在完成后自动安装")
    try:
        result = updater.wait_background_update()
        _log.info("后台更新结束：%s", result)
    except Exception as exc:  # noqa: BLE001
        _log.warning("后台更新异常：%s", exc)
    finally:
        # 安装脚本已被拉起（或更新失败）：进程要在有界时间内退出，脚本才能继续安装
        _force_exit_after(EXIT_GRACE_SECONDS)


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

    # 编码加固必须早于任何 print/日志：桌面端不走 backend/main.py，Windows 下业务
    # 代码里的 print（如地理化数据导入的调试输出带 emoji）写到 cp936 控制台/重定向流
    # 会抛 UnicodeEncodeError，顺着业务逻辑冒成"上传失败"（2026-10-12 实测）
    _ensure_backend_on_path()
    from app.core.console_encoding import setup_console_encoding

    setup_console_encoding(force_utf8=False)

    data_root = _bootstrap_environment()
    _setup_logging(data_root)
    _log.info(
        "桌面启动器启动，版本: %s，数据根: %s",
        os.environ.get("NPT_DESKTOP_VERSION") or "unknown",
        data_root,
    )

    if not _acquire_single_instance():
        _log.info("检测到已有实例在运行，退出")
        if _background_update_marker_exists(data_root):
            _message_box("正在后台下载并安装新版本，安装完成后会自动打开，请稍候。", 0x40)
        else:
            _message_box("程序已在运行，请在任务栏切换到已打开的窗口。", 0x40)
        return 0

    # 单实例已就绪：没有别的进程在后台更新，残留标记（上次被强杀遗留）清掉，
    # 避免之后误报"正在后台更新"
    _clear_stale_background_marker(data_root)

    sock, port = _create_bound_socket(data_root)
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
    # 后台更新（用户点了「后台运行」）：进程继续跑到安装脚本拉起为止。
    # 这期间仍持有单实例互斥体：用户再点图标会被"后台更新中"的提示挡住，
    # 避免新实例的进程被随后的 taskkill 兜底误杀。
    _continue_background_update()
    # 释放单实例互斥体：收尾阶段（停服务、解释器退出）不再阻止用户重新启动，
    # 也避免安装器的 AppMutex 检测把安装挡下来
    _release_single_instance()
    server.should_exit = True
    thread.join(timeout=5)
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
