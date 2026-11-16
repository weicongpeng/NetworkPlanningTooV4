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
import queue
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

# 后端服务句柄：由 _boot_backend_and_open 在后台线程里填，main() 关窗后用它收尾
_SERVER: Any = None
_SERVER_THREAD: Optional[threading.Thread] = None
_STARTUP_FAILED = False


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
        # 用户在后端就绪前就关了窗：main() 已置 should_exit，别傻等到超时
        if _SERVER is not None and getattr(_SERVER, "should_exit", False):
            return False
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.15)  #  lifespan 一结束（服务可接客）尽快感知，缩短重启后白屏等待
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


# 无边框窗口（WinForms FormBorderStyle.None）没有原生标题栏，窗口样式里也就不带最小化/最大化
# 箱位；系统据此丢弃任务栏图标点击发来的 WM_SYSCOMMAND(SC_MINIMIZE)，用户看到的就是
# 「点任务栏图标没反应，既不能最小化也不能还原」。这里只补样式位（不设 WS_CAPTION，仍无原生标题栏）。
GWL_STYLE = -16
GWL_WNDPROC = -4
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
WM_NCCALCSIZE = 0x0083
# 原生标题栏拖动：WM_NCLBUTTONDOWN 命中 HTCAPTION 后系统进入自己的移动循环
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
SW_RESTORE = 9
# 非客户区命中码：用同一个入口（WM_NCLBUTTONDOWN）告诉系统拉哪条边/哪个角，
# 系统随即进入自己的缩放循环 —— 四边四角都能拉，最小尺寸/DPI/贴边语义全按原生走
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17
RESIZE_HIT_TESTS = {
    "w": HTLEFT,
    "e": HTRIGHT,
    "n": HTTOP,
    "nw": HTTOPLEFT,
    "ne": HTTOPRIGHT,
    "s": HTBOTTOM,
    "sw": HTBOTTOMLEFT,
    "se": HTBOTTOMRIGHT,
}
# DWM 窗口外观：Win11 圆角偏好属性（DWMWA_WINDOW_CORNER_PREFERENCE = 33）
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2


class _DwmMargins(ctypes.Structure):
    """DwmExtendFrameIntoClientArea 的四边扩展量。"""

    _fields_ = [
        ("cxLeftWidth", ctypes.c_int),
        ("cxRightWidth", ctypes.c_int),
        ("cyTopHeight", ctypes.c_int),
        ("cyBottomHeight", ctypes.c_int),
    ]


class _WindowRect(ctypes.Structure):
    """GetWindowRect 的窗口矩形。"""

    _fields_ = [
        ("left", ctypes.c_long), ("top", ctypes.c_long),
        ("right", ctypes.c_long), ("bottom", ctypes.c_long),
    ]


# 持有子类化后的窗口过程引用：ctypes 回调对象被 GC 之后再收到窗口消息会直接崩溃
_wndproc_refs: list = []
# 已装钩子的窗口句柄：全屏切换会让 WinForms 重建句柄，需要在新句柄上重装
_wndproc_hwnd: Optional[int] = None


def _enable_taskbar_minimize(window: Any) -> None:
    """给无边框主窗口补最小化/最大化/系统菜单/可缩放样式位。

    仅 Windows 生效；窗体尚未就绪或非桌面壳时静默跳过。WinForms 重算窗口样式
    （切换 FormBorderStyle，如全屏进出）时会把样式位覆盖回 CreateParams，所以全屏
    切换后要再补一次（见 _make_fullscreen_handler）。

    WS_THICKFRAME 不是为了让系统画边框，而是**贴边分屏的前提**：Windows 只对"可缩放"
    的窗口做 Snap（左右半屏、四角四分屏、Win11 贴靠布局），缺这一位时拖到屏幕边缘
    只会停在原地。它带出来的 8px 原生边框由 `_install_client_area_wndproc` 吃掉。
    """
    native = getattr(window, "native", None)
    if os.name != "nt" or native is None:
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.GetWindowLongW.restype = ctypes.c_long
        user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
        user32.SetWindowLongW.restype = ctypes.c_long
        user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]

        handle = native.Handle
        hwnd = ctypes.c_void_p(int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle))
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        wanted = style | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_THICKFRAME
        if wanted != style:
            user32.SetWindowLongW(hwnd, GWL_STYLE, wanted)
            # 改完样式位必须让系统重算非客户区，否则新加的边框/贴边语义不生效
            user32.SetWindowPos(
                hwnd, None, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
            _log.info("已补齐无边框窗口的最小化/最大化/可缩放样式（任务栏可最小化、拖到屏幕边缘可贴边分屏）")
    except Exception as exc:  # noqa: BLE001
        _log.warning("补充窗口最小化/最大化样式失败（任务栏点击与贴边分屏可能不可用）：%s", exc)


def _install_client_area_wndproc(window: Any) -> None:
    """让客户区铺满整个窗口，吃掉 WS_THICKFRAME 带出来的原生边框。

    贴边分屏要求窗口"可缩放"，但无边框窗口加上 WS_THICKFRAME 后系统会在四周留出
    8px 非客户区 —— 页面被缩进一圈、露出底色。这里子类化窗口过程，把 WM_NCCALCSIZE
    的客户区直接算成整个窗口矩形：既保留"可缩放 → 可贴边"的系统语义，又维持页面满铺。
    原生边缘缩放随之消失，窗口缩放改由自绘把手经 window-control resize-edge 交给系统缩放循环。

    仅 Windows 生效；任何一步失败都只记日志（退化为带一圈细边框，不影响功能）。
    """
    global _wndproc_hwnd
    native = getattr(window, "native", None)
    if os.name != "nt" or native is None:
        return
    handle = native.Handle
    hwnd = int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle)
    if _wndproc_hwnd == hwnd:
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        get_ptr = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
        set_ptr = getattr(user32, "SetWindowLongPtrW", user32.SetWindowLongW)
        get_ptr.restype = ctypes.c_void_p
        get_ptr.argtypes = [ctypes.c_void_p, ctypes.c_int]
        set_ptr.restype = ctypes.c_void_p
        set_ptr.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        call_proc = user32.CallWindowProcW
        call_proc.restype = ctypes.c_ssize_t
        call_proc.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t,
        ]

        wndproc_type = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t, ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t,
        )
        old_proc = get_ptr(ctypes.c_void_p(hwnd), GWL_WNDPROC)
        if not old_proc:
            # 拿不到原过程就不要装钩子：转发失败会让窗口收不到任何消息（直接白屏/无响应）
            raise RuntimeError("读取原窗口过程失败")

        def _wndproc(hwnd_: Any, msg: int, wparam: int, lparam: int) -> int:
            # 客户区 = 整个窗口（默认过程会把 WS_THICKFRAME 的边框扣掉）
            if msg == WM_NCCALCSIZE and wparam:
                return 0
            return call_proc(old_proc, hwnd_, msg, wparam, lparam)

        callback = wndproc_type(_wndproc)
        set_ptr(ctypes.c_void_p(hwnd), GWL_WNDPROC, ctypes.cast(callback, ctypes.c_void_p))
        _wndproc_refs.extend([callback, old_proc])
        _wndproc_hwnd = hwnd
        # 装上钩子后再触发一次非客户区重算：补 WS_THICKFRAME 的那一刻系统按"有边框"
        # 算过一次，客户区已经缩进 8px，不重算会一直露着那圈边框
        user32.SetWindowPos(
            ctypes.c_void_p(hwnd), None, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        _log.info("已子类化窗口过程：客户区铺满整窗（去掉 WS_THICKFRAME 的原生边框）")
    except Exception as exc:  # noqa: BLE001
        _log.warning("子类化窗口过程失败（无边框窗口会露出一圈原生边框）：%s", exc)


def _nudge_window_rect(window: Any) -> None:
    """让 DWM 立刻按新样式重合成一次：窗口矩形 +1px 再还原。

    pywebview 先用 ``FormBorderStyle.None`` 建窗，DWM 在**建窗那一刻**就缓存了
    「无边框 → 不画投影、直角」的合成结论；之后我们在 shown 事件里补 WS_THICKFRAME、
    子类化 WM_NCCALCSIZE（客户区=整窗）并不会让它重新判定。只有窗口矩形真的变化
    （移动 / 还原）才触发一次重新合成 —— 这就是用户报的「刚打开没有阴影、不是圆角，
    拖动一下马上恢复正常」。这里在启动时主动做一次不可见的尺寸抖动替代用户拖窗。

    最大化窗口不画投影（Windows 原生行为），也不做尺寸抖动，避免把最大化状态改掉。
    """
    native = getattr(window, "native", None)
    handle = getattr(native, "Handle", None) if native is not None else None
    if os.name != "nt" or handle is None:
        return
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle)
        hwnd_ptr = ctypes.c_void_p(hwnd)
        user32.IsZoomed.argtypes = [ctypes.c_void_p]
        user32.IsZoomed.restype = ctypes.c_bool
        if user32.IsZoomed(hwnd_ptr):
            return
        user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(_WindowRect)]
        user32.GetWindowRect.restype = ctypes.c_bool
        user32.SetWindowPos.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
        ]
        user32.SetWindowPos.restype = ctypes.c_bool
        rect = _WindowRect()
        if not user32.GetWindowRect(hwnd_ptr, ctypes.byref(rect)):
            return
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width <= 0 or height <= 0:
            return
        flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
        user32.SetWindowPos(hwnd_ptr, None, rect.left, rect.top, width + 1, height, flags)
        user32.SetWindowPos(hwnd_ptr, None, rect.left, rect.top, width, height, flags)
    except Exception as exc:  # noqa: BLE001
        _log.warning("强制 DWM 重合成失败（窗口外观可能要拖动一次才正常）：%s", exc)


def _apply_window_frame_appearance(window: Any) -> None:
    """补齐无边框窗口的系统投影与 Win11 圆角（不必等用户拖一下窗口）。

    - ``DwmExtendFrameIntoClientArea`` 扩 1px 玻璃边框进客户区：我们的窗口过程对
      ``WM_NCCALCSIZE`` 返回 0（客户区铺满整窗），DWM 默认就此判定没有边框可投影；
      显式扩展一次才会给窗口画上和其它软件一样的系统阴影。
    - ``DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE, ROUND)``：Win11 对
      FormBorderStyle.None 的窗口默认不倒角，显式指定圆角；Win10 没有该属性，
      调用失败只记日志，不影响其它窗口功能。
    - 最后强制一次重合成（见 ``_nudge_window_rect``），让上述属性在首帧就生效。
    """
    native = getattr(window, "native", None)
    handle = getattr(native, "Handle", None) if native is not None else None
    if os.name != "nt" or handle is None:
        return
    try:
        dwmapi = ctypes.WinDLL("dwmapi")
        hwnd = ctypes.c_void_p(int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle))
        margins = _DwmMargins(1, 1, 1, 1)
        dwmapi.DwmExtendFrameIntoClientArea.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(_DwmMargins),
        ]
        dwmapi.DwmExtendFrameIntoClientArea.restype = ctypes.c_long
        dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))

        preference = ctypes.c_int(DWMWCP_ROUND)
        dwmapi.DwmSetWindowAttribute.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
        ]
        dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
        dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(preference), ctypes.sizeof(preference),
        )
        _nudge_window_rect(window)
        _log.info("已补齐无边框窗口的 DWM 投影与圆角")
    except Exception as exc:  # noqa: BLE001
        _log.warning("设置窗口投影/圆角失败（不影响窗口功能）：%s", exc)


def _apply_window_frame(window: Any) -> None:
    """窗口显示后 / 全屏切换重建句柄后，重刷样式位、窗口过程与 DWM 外观。

    顺序要紧：先补 WS_THICKFRAME 等样式位，再子类化窗口过程吃掉多出来的原生边框，
    最后显式让 DWM 按最终样式重画投影与圆角（否则要等用户拖一下窗口才正常）。
    """
    _enable_taskbar_minimize(window)
    _install_client_area_wndproc(window)
    _apply_window_frame_appearance(window)


# 窗口动作串行队列：minimize / maximize / restore / destroy 内部会同步 Invoke 到
# WinForms GUI 线程，绝不能在 uvicorn 事件循环线程里等它。用单 worker 保证动作按点击顺序执行。
_window_action_queue: Optional["queue.Queue"] = None
_window_action_lock = threading.Lock()


def _window_action_worker() -> None:
    while True:
        perform, name = _window_action_queue.get()  # type: ignore[union-attr]
        try:
            perform()
        except Exception:  # noqa: BLE001
            _log.exception("窗口动作执行失败（%s）", name)
        finally:
            _window_action_queue.task_done()  # type: ignore[union-attr]


def _dispatch_window_action(perform: Callable[[], None], name: str = "npt-window-action") -> None:
    """把会阻塞的原生窗口动作丢进独立线程串行执行，HTTP 请求 / 事件循环立即返回。

    用户报的「打开项目沟通后再点最小化/最大化没反应，几十秒后才生效」有两层原因：
    IM 高频轮询把请求排在后面，而``window.minimize()/maximize()``本身又是 pywebview
    内部的 ``Control.Invoke``（从 uvicorn 线程同步等 GUI 线程）——一旦排队或 GUI 线程忙，
    整个 asyncio 事件循环跟着冻结。与 drag / resize-edge 一样解耦到独立线程后，
    窗口动作只排队、不占用事件循环，请求立即应答。
    """
    global _window_action_queue
    with _window_action_lock:
        if _window_action_queue is None:
            _window_action_queue = queue.Queue()
            threading.Thread(
                target=_window_action_worker, name="npt-window-actions", daemon=True
            ).start()
    _window_action_queue.put((perform, name))


def _run_window_loop(window: Any, perform: Callable[[], None], thread_name: str) -> None:
    """把阻塞式的原生窗口循环（拖动/缩放）派发到 WinForms GUI 线程执行。

    SendMessage(WM_NCLBUTTONDOWN) 会一直阻塞到用户松开鼠标，所以放独立线程等待、
    HTTP 请求立即返回。而 Invoke 本身必须走 GUI 线程：鼠标捕获在 WebView2 子窗口上，
    在 uvicorn 线程里 ReleaseCapture 既释放不了捕获，系统也拿不到后续鼠标消息。
    """
    native = window.native

    def _invoke() -> None:
        try:
            from System import Func, Type

            # 与 _limit_maximized_to_work_area 同一套 pythonnet 调用方式
            native.Invoke(Func[Type](perform))
        except Exception:  # noqa: BLE001
            # pythonnet/Invoke 不可用（旧环境）：退回直接调用，至少不影响窗口其它功能
            perform()

    threading.Thread(target=_invoke, name=thread_name, daemon=True).start()


def _start_caption_drag(window: Any) -> None:
    """按系统原生标题栏的方式拖动窗口（等价于按住标题栏拖）。

    为什么不用 pywebview 的 `.pywebview-drag-region`：它按鼠标位移自己挪窗口，
    Windows 的移动循环根本没有参与 —— 这正是"拖到屏幕边缘不会最大化/分屏"的根因。
    这里发 WM_NCLBUTTONDOWN(HTCAPTION)，系统进入自己的移动循环，贴边分屏、四分屏、
    Win11 贴靠布局、拖动中把最大化窗口还原，全部按原生行为走。

    关键点：按下时鼠标捕获在 WebView2 子窗口上，**ReleaseCapture 必须在 GUI 线程
    执行**才有效；在 uvicorn 线程直接调用既释放不了捕获，系统移动循环也拿不到后续
    鼠标消息（表现为按住标题栏完全拖不动）。所以用 native.Invoke 把
    「ReleaseCapture + WM_NCLBUTTONDOWN」派发到 WinForms UI 线程，阻塞的移动循环
    放独立线程等待，不挡 HTTP 请求与事件循环。
    """
    native = getattr(window, "native", None)
    if os.name != "nt" or native is None:
        return

    def _perform() -> None:
        try:
            class _POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

            class _RECT(ctypes.Structure):
                _fields_ = [
                    ("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long),
                ]

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            handle = native.Handle
            hwnd = int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle)

            user32.IsZoomed.argtypes = [ctypes.c_void_p]
            user32.IsZoomed.restype = ctypes.c_bool
            user32.GetCursorPos.argtypes = [ctypes.POINTER(_POINT)]
            user32.GetCursorPos.restype = ctypes.c_bool
            user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(_RECT)]
            user32.GetWindowRect.restype = ctypes.c_bool
            user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
            user32.ShowWindow.restype = ctypes.c_bool
            user32.SetWindowPos.argtypes = [
                ctypes.c_void_p, ctypes.c_void_p,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
            ]
            user32.SetWindowPos.restype = ctypes.c_bool
            user32.ReleaseCapture.argtypes = []
            user32.ReleaseCapture.restype = ctypes.c_bool
            user32.SendMessageW.argtypes = [
                ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t,
            ]
            user32.SendMessageW.restype = ctypes.c_ssize_t

            # 最大化窗口先还原，并按拖动起点的横向比例把窗口放到光标下。
            # 直接对最大化窗口注入 HTCAPTION，部分 Windows 版本不会自动还原。
            if user32.IsZoomed(ctypes.c_void_p(hwnd)):
                pt = _POINT()
                user32.GetCursorPos(ctypes.byref(pt))
                rect = _RECT()
                user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect))
                width = max(1, rect.right - rect.left)
                ratio = min(1.0, max(0.0, (pt.x - rect.left) / width))
                user32.ShowWindow(ctypes.c_void_p(hwnd), SW_RESTORE)
                restored = _RECT()
                user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(restored))
                new_x = pt.x - int(ratio * max(1, restored.right - restored.left))
                new_y = pt.y - 16  # 光标保持在标题栏内，避免落到内容区
                user32.SetWindowPos(
                    ctypes.c_void_p(hwnd), None, new_x, new_y, 0, 0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )

            # ReleaseCapture 在 UI 线程才有效：捕获原本在 WebView2 子窗口上。
            user32.ReleaseCapture()
            user32.SendMessageW(ctypes.c_void_p(hwnd), WM_NCLBUTTONDOWN, HTCAPTION, 0)
        except Exception:  # noqa: BLE001
            _log.exception("原生标题栏拖窗失败（本次拖动无效）")

    _run_window_loop(window, _perform, "npt-caption-drag")


def _start_native_resize(window: Any, direction: str) -> bool:
    """按系统原生边缘缩放拖拽（等价于抓住窗口边框/角落拉）。

    与标题栏拖动同源：发 WM_NCLBUTTONDOWN 命中 HTLEFT/HTTOP… 后由 Windows 进入自己的
    缩放循环 —— 四边四角都能拉，最小尺寸、DPI 缩放、贴边语义全按系统行为走。
    早先前端逐帧发 resize 请求的做法只能锚定左上角单向外扩，拉不了左边和上边。

    返回是否成功发起（方向非法或非 Windows 环境返回 False）。
    """
    hit = RESIZE_HIT_TESTS.get(direction)
    native = getattr(window, "native", None)
    if hit is None or os.name != "nt" or native is None:
        return False

    def _perform() -> None:
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            handle = native.Handle
            hwnd = int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle)
            user32.ReleaseCapture.argtypes = []
            user32.ReleaseCapture.restype = ctypes.c_bool
            user32.SendMessageW.argtypes = [
                ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t,
            ]
            user32.SendMessageW.restype = ctypes.c_ssize_t

            # ReleaseCapture 在 UI 线程才有效：捕获原本在 WebView2 子窗口上
            user32.ReleaseCapture()
            user32.SendMessageW(ctypes.c_void_p(hwnd), WM_NCLBUTTONDOWN, hit, 0)
        except Exception:  # noqa: BLE001
            _log.exception("原生边缘缩放失败（本次拖拽无效）")

    _run_window_loop(window, _perform, "npt-window-resize")
    return True


def _limit_maximized_to_work_area(window: Any, enable: bool) -> None:
    """把无边框窗口的最大化范围限定到显示器工作区（排除任务栏）。

    frameless 窗口没有最大化边框可依，WinForms 会直接铺满整个显示器，任务栏盖住
    页面下沿，底部控件看不见。这里显式设置 MaximizedBounds：
    - enable=True：取窗口当前所在显示器的工作区；
    - enable=False：清空限制，避免窗口移到其他显示器后仍按旧屏幕收口。

    仅 Windows 生效；窗体尚未就绪或非桌面壳时静默跳过。
    """
    native = getattr(window, "native", None)
    if os.name != "nt" or native is None:
        return
    try:
        import clr  # pywebview 已加载 CLR，显式导入保证 .NET 类型可用

        clr.AddReference("System.Windows.Forms")
        from System import Func, Type
        from System.Drawing import Rectangle
        from System.Windows.Forms import Screen

        bounds = Screen.FromControl(native).WorkingArea if enable else Rectangle.Empty

        def _apply() -> None:
            native.MaximizedBounds = bounds

        # js_api 回调跑在后台线程，WinForms 控件属性只能在 GUI 线程设置
        if native.InvokeRequired:
            native.Invoke(Func[Type](_apply))
        else:
            _apply()
    except Exception as exc:  # noqa: BLE001
        _log.warning("设置窗口最大化边界失败（窗口可能盖住任务栏）：%s", exc)


def _make_fullscreen_handler(window: Any, state: Optional[dict] = None) -> Callable[[bool], None]:
    """构造全屏回调：把前端的「全屏 / 退出全屏」转成桌面主窗口的系统级全屏。

    WebView2 里的 HTML Fullscreen API 只会让网页内容占满 WebView 自身（窗口不变，
    标题栏仍在）；桌面端必须由壳层把窗口切成全屏才能真正布满整个屏幕。
    pywebview 只提供 toggle_fullscreen()、没有状态查询，这里按本进程记录期望状态，
    只在状态真的变化时切换；退出全屏后补一次 maximize()，回到启动时的最大化窗口
    （pywebview 的退出分支会先把窗口置为 Normal + 进入全屏前的尺寸）。

    state 可与窗口控制回调共享（自绘标题栏查询窗口状态时一并返回 fullscreen）。
    """
    if state is None:
        state = {"fullscreen": False}
    # 记住进入全屏前的最大化状态：普通窗口启动后退出全屏不该被强行最大化，
    # 否则自绘标题栏刚修好的圆角/阴影又没了（最大化窗口本来就不画投影/圆角）。
    was_maximized = {"value": bool(state.get("maximized", False))}

    def _handler(fullscreen: bool) -> None:
        fullscreen = bool(fullscreen)
        if fullscreen == state.get("fullscreen", False):
            return
        if fullscreen:
            was_maximized["value"] = bool(state.get("maximized", False))
            # 真全屏要盖住任务栏：先清掉工作区限制，否则最大化会被收口到任务栏之上
            _limit_maximized_to_work_area(window, False)
        window.toggle_fullscreen()
        # 全屏切换重设了 FormBorderStyle，样式位可能被 CreateParams 覆盖回去 → 再补一次；
        # WinForms 还可能重建窗口句柄（旧句柄上的窗口过程钩子随之失效），按新句柄重装，
        # 并按最终样式重画 DWM 投影/圆角
        _apply_window_frame(window)
        state["fullscreen"] = fullscreen
        if not fullscreen:
            if was_maximized["value"]:
                _limit_maximized_to_work_area(window, True)
                window.maximize()
            else:
                _limit_maximized_to_work_area(window, False)
            # 与窗口控制共享 state 时同步缓存：不等 on_resize（GUI 线程时序），
            # 否则标题栏按钮可能短暂显示错误图标
            state["maximized"] = was_maximized["value"]

    return _handler


def _restore_foreground(window: Any) -> bool:
    """把桌面主窗口带回前台（取景截图后焦点可能留在别的应用窗口）。

    非 Windows / 无原生句柄时直接返回 False，由前端的 visibilitychange 提示兜底。
    Win32 调用派发到 UI 线程执行、HTTP 请求立即返回；SetForegroundWindow 受系统
    「前台锁定」限制可能被忽略，故补一次 HWND_TOPMOST → HWND_NOTOPMOST 的 Z 序闪烁。

    注意：绝不能无条件 ``ShowWindow(SW_RESTORE)`` —— 它对最大化窗口就是「还原」，
    会让每次截图后主窗口从最大化缩回普通尺寸（用户报的「截图完窗口自动变小」）。
    只对最小化窗口做 restore，其余情况只改 Z 序，位置尺寸一律不动。
    """
    native = getattr(window, "native", None)
    handle = getattr(native, "Handle", None) if native is not None else None
    if os.name != "nt" or handle is None:
        return False

    def _perform() -> None:
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            hwnd = ctypes.c_void_p(
                int(handle.ToInt64() if hasattr(handle, "ToInt64") else handle)
            )
            user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
            user32.ShowWindow.restype = ctypes.c_bool
            user32.IsIconic.argtypes = [ctypes.c_void_p]
            user32.IsIconic.restype = ctypes.c_bool
            user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
            user32.SetForegroundWindow.restype = ctypes.c_bool
            user32.BringWindowToTop.argtypes = [ctypes.c_void_p]
            user32.BringWindowToTop.restype = ctypes.c_bool
            user32.SetWindowPos.argtypes = [
                ctypes.c_void_p, ctypes.c_void_p,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
            ]
            user32.SetWindowPos.restype = ctypes.c_bool

            # SW_RESTORE 会把最大化窗口还原成普通尺寸；只有最小化时才需要它
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            # -1 = HWND_TOPMOST，-2 = HWND_NOTOPMOST；只改 Z 序不动位置尺寸
            flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
            user32.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0, flags)
            user32.SetWindowPos(hwnd, ctypes.c_void_p(-2), 0, 0, 0, 0, flags)
        except Exception:  # noqa: BLE001
            _log.exception("恢复窗口前台失败（截图回焦降级为网页提示）")

    _run_window_loop(window, _perform, "npt-window-activate")
    return True


def _make_window_control_handler(window: Any, state: dict) -> Callable[[str, dict], dict]:
    """构造窗口控制回调（frameless 自绘标题栏的按钮/把手 → pywebview 原生动作）。

    - state 与全屏回调共享，并在 maximized/restored 事件里持续更新：
      Win+↑/↓、任务栏还原等系统路径同样触发 on_resize → 缓存自然收敛，
      前端只在按钮响应与窗口聚焦时读取，不需要轮询。
    - close 走 window.destroy()：会触发 FormClosing → events.closing，
      保留 _make_close_handler 的看门狗与后台更新例外；
      不能复用 _make_exit_handler（它无条件武装看门狗）。
    - resize-edge 把拖拽交给系统原生缩放循环（四边四角），不逐帧改窗口尺寸。
    """

    def _on_maximized(*_args: Any, **_kwargs: Any) -> None:
        state["maximized"] = True

    def _on_restored(*_args: Any, **_kwargs: Any) -> None:
        state["maximized"] = False

    for event, callback in (("maximized", _on_maximized), ("restored", _on_restored)):
        try:
            # Event.__iadd__ 把回调 append 进事件对象（并返回 self），
            # 先取到对象再 +=，属性增赋值写法 getattr(...) += 不是合法表达式
            window_event = getattr(window.events, event)
            window_event += callback
        except Exception as exc:  # noqa: BLE001
            _log.warning("订阅窗口 %s 事件失败（标题栏按钮状态可能不同步）：%s", event, exc)

    def _handler(action: str, params: dict) -> dict:
        if action == "state":
            return {
                "maximized": bool(state.get("maximized", False)),
                "fullscreen": bool(state.get("fullscreen", False)),
            }
        if action == "minimize":
            # pywebview 的 minimize() 会同步 Invoke 到 GUI 线程；放独立线程执行，
            # 不让事件循环等它（IM 浮窗打开后这一等就是几十秒）。
            _dispatch_window_action(window.minimize, "npt-window-minimize")
            return {"maximized": bool(state.get("maximized", False))}
        if action == "toggle-maximize":
            target = not state.get("maximized", False)

            def _toggle() -> None:
                if target:
                    _limit_maximized_to_work_area(window, True)
                    window.maximize()
                else:
                    window.restore()
                    _limit_maximized_to_work_area(window, False)

            _dispatch_window_action(_toggle, "npt-window-toggle-maximize")
            # 乐观更新：响应立即带回目标状态，events.maximized/restored 再兜底校准
            state["maximized"] = target
            return {"maximized": target}
        if action == "close":
            _log.info("收到窗口关闭请求（标题栏关闭按钮）")

            def _close() -> None:
                try:
                    window.destroy()
                except Exception:  # noqa: BLE001
                    _log.exception("关闭窗口失败，2 秒后强制结束进程")
                    _force_exit_after(2)

            _dispatch_window_action(_close, "npt-window-close")
            return {}
        if action == "drag":
            # 系统移动循环会阻塞到用户松开鼠标 → 与 HTTP 请求解耦，立即返回
            _start_caption_drag(window)
            return {"maximized": bool(state.get("maximized", False))}
        if action == "activate":
            # 截图共享其它应用窗口后把主窗口拉回前台；非 Windows / 无句柄时返回 False
            return {"activated": _restore_foreground(window)}
        if action == "resize-edge":
            # 系统缩放循环会阻塞到用户松开鼠标 → 与 HTTP 请求解耦，立即返回
            if not _start_native_resize(window, str(params.get("direction") or "")):
                raise ValueError(f"未知缩放方向: {params.get('direction')!r}")
            return {"maximized": bool(state.get("maximized", False))}
        raise ValueError(f"未知窗口控制动作: {action}")

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


# 启动页：窗口创建后立即显示它，后端在后台线程启动；就绪后再导航到真正的应用地址。
# 否则「双击图标 / 切运行模式重启」后要等整份后端导入 + lifespan 跑完才出现窗口，
# 那段时间用户只看到空白（共享↔单机切换重启时尤其明显）。
# 模式切换重启（NPT_DESKTOP_SWITCHING=1，由 spawn_relaunch 注入）显示专属文案：
# 告诉用户"应用没有坏，是在切数据空间"，与普通启动区分开。
SPLASH_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>%(title)s</title>
<style>
html,body{height:100%%;margin:0}
body{display:flex;align-items:center;justify-content:center;flex-direction:column;
background:#0b1220;color:#e2e8f0;font-family:"Microsoft YaHei",system-ui,sans-serif}
.ring{width:42px;height:42px;border:4px solid rgba(226,232,240,.22);border-top-color:#38bdf8;
border-radius:50%%;animation:spin .9s linear infinite;margin-bottom:18px}
@keyframes spin{to{transform:rotate(360deg)}}
.t{font-size:15px;letter-spacing:.5px}
.h{font-size:12px;color:#94a3b8;margin-top:10px;max-width:420px;text-align:center;line-height:1.6}
</style></head>
<body class="pywebview-drag-region"><div class="ring"></div>
<div class="t">%(text)s</div>
<div class="h">%(hint)s</div>
</body></html>"""

_SPLASH_TEXT_DEFAULT = "正在启动，请稍候…"
_SPLASH_HINT_DEFAULT = "首次启动或切换运行模式时需要一点时间"
_SPLASH_TEXT_SWITCHING = "正在切换运行模式，请稍候…"
_SPLASH_HINT_SWITCHING = "数据空间切换中：正在关闭旧实例并启动新配置档，请勿手动关闭窗口"


def _splash_html() -> str:
    """按启动场景生成过渡页文案。

    模式切换重启（spawn_relaunch 注入 NPT_DESKTOP_SWITCHING=1）时明确告知目标模式，
    避免用户把"应用消失又出现"误判为崩溃或更新失败。
    """
    if os.environ.get("NPT_DESKTOP_SWITCHING") == "1":
        profile = os.environ.get("NPT_DESKTOP_PROFILE") or "shared"
        mode_name = "共享模式" if profile == "shared" else "单机模式"
        return SPLASH_HTML % {
            "title": APP_NAME,
            "text": f"正在切换到{mode_name}，请稍候…",
            "hint": _SPLASH_HINT_SWITCHING,
        }
    return SPLASH_HTML % {
        "title": APP_NAME,
        "text": _SPLASH_TEXT_DEFAULT,
        "hint": _SPLASH_HINT_DEFAULT,
    }


def _error_html(message: str) -> str:
    return (
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<title>{APP_NAME}</title></head>"
        "<body style=\"font-family:'Microsoft YaHei',system-ui,sans-serif;padding:32px;"
        "color:#e2e8f0;background:#0b1220\">"
        f"<h3>{APP_NAME} 启动失败</h3><p>{message}</p>"
        f"<p style=\"color:#94a3b8;font-size:12px\">日志：{_log_path_hint()}</p></body></html>"
    )


# ------------------------------------------------------------ 全局截图热键（可配置）

HOTKEY_ID = 0x4E50  # 'NP'
WM_HOTKEY = 0x0312
WM_APP_RELOAD_HOTKEY = 0x8000 + 1  # WM_APP + 1，通知热键线程重注册组合键

_hotkey_lock = threading.Lock()
_hotkey_thread_id = 0
_hotkey_status: dict = {"registered": False, "conflict": False, "error": 0, "hotkey": ""}
_hotkey_status_event = threading.Event()

# 全局热键命中后优先让前端完成 DOM 稳定化再 POST（保证「屏幕原样」的会话窗口
# 已合成进冻结帧）。WebView2 在后台久了定时器会被 Chromium 压到分钟级，故留一个
# 2s watchdog 兜底：前端没接管时壳层自行抓屏，热键始终可用。
SCREENSHOT_WATCHDOG_SECONDS = 2.0
_screenshot_watchdog_lock = threading.Lock()
_screenshot_watchdog: Optional[threading.Timer] = None
_screenshot_watchdog_token = 0


def _screenshot_watchdog_fire(token: int) -> None:
    """前端 2s 内没有接管这一轮热键：壳层自行兜底抓屏（frameReady=False 让它等一帧）。"""
    global _screenshot_watchdog
    with _screenshot_watchdog_lock:
        if token != _screenshot_watchdog_token:
            return  # 已被更新的热键取代
        _screenshot_watchdog = None
    from app import desktop_bridge

    if not desktop_bridge.claim_screenshot_round():
        return  # 前端已 POST 接管，避免重复铺蒙层
    try:
        from app.services import desktop_screenshot_settings as cfg

        settings = cfg.load_settings(_default_data_root())
        result = desktop_bridge.screenshot("start", {
            "hideImWindow": bool(settings["hideImWindow"]),
            "frameReady": False,
        })
        _log.info("截图热键兜底取景已发起：%s", bool(result and result.get("started")))
    except Exception:  # noqa: BLE001
        _log.exception("截图热键兜底取景失败")


def _arm_screenshot_watchdog(desktop_bridge: Any) -> None:
    """登记一轮热键：递增前端轮询序号，并安排可取消的兜底 Timer。"""
    global _screenshot_watchdog, _screenshot_watchdog_token
    desktop_bridge.notify_screenshot_hotkey()
    with _screenshot_watchdog_lock:
        if _screenshot_watchdog is not None:
            _screenshot_watchdog.cancel()
        _screenshot_watchdog_token += 1
        token = _screenshot_watchdog_token
        timer = threading.Timer(
            SCREENSHOT_WATCHDOG_SECONDS, _screenshot_watchdog_fire, args=(token,)
        )
        timer.daemon = True
        _screenshot_watchdog = timer
    timer.start()


def _register_screenshot_hotkey(user32: Any, cfg: Any) -> None:
    """按本机配置注册组合键；冲突与其它系统错误分开记录，供设置面板提示。

    RegisterHotKey 必须在**注册线程**里调用/注销，所以本函数只被热键线程执行。
    """
    settings = cfg.load_settings(_default_data_root())
    flags, vk = cfg.to_win32_hotkey(settings)
    ok = bool(user32.RegisterHotKey(None, HOTKEY_ID, flags, vk))
    error = int(ctypes.get_last_error()) if not ok else 0
    conflict = (not ok) and cfg.is_conflict_error(error)
    with _hotkey_lock:
        _hotkey_status.update({
            "registered": ok,
            "conflict": conflict,
            "error": error,
            "hotkey": cfg.format_hotkey(settings),
        })
    if ok:
        _log.info("已注册全局截图热键 %s", cfg.format_hotkey(settings))
    elif conflict:
        _log.warning("全局截图热键 %s 已被其它应用占用（1409）", cfg.format_hotkey(settings))
    else:
        _log.warning("注册全局截图热键失败：%s", error)


def reload_screenshot_hotkey() -> dict:
    """设置保存后让热键线程注销并按新配置重注册，返回注册结果。

    线程通过 ``PostThreadMessageW`` 收到 WM_APP_RELOAD_HOTKEY 后自己完成切换，
    不重建线程，避免出现热键真空期；``_hotkey_status_event`` 让 HTTP 请求等到结果，
    前端据此判断「是否与其它应用冲突」。
    """
    global _hotkey_thread_id
    if os.name != "nt":
        return {"registered": False, "conflict": False, "unsupported": True}
    with _hotkey_lock:
        thread_id = _hotkey_thread_id
    if not thread_id:
        return {"registered": False, "conflict": False, "pending": True}

    _hotkey_status_event.clear()
    try:
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.PostThreadMessageW.argtypes = [
            wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        ]
        user32.PostThreadMessageW.restype = ctypes.c_bool
        if not user32.PostThreadMessageW(thread_id, WM_APP_RELOAD_HOTKEY, 0, 0):
            return {"registered": False, "conflict": False,
                    "error": int(ctypes.get_last_error())}
    except Exception:  # noqa: BLE001
        _log.exception("通知截图热键线程重注册失败")
        return {"registered": False, "conflict": False, "error": -1}
    if not _hotkey_status_event.wait(1.5):
        _log.warning("等待截图热键重注册结果超时")
    with _hotkey_lock:
        return dict(_hotkey_status)


def _make_screenshot_handler(controller: Any) -> Callable[[str, dict], dict]:
    """把截图会话控制器 + 热键重注册包装成 desktop_bridge 的单一回调。"""
    def handler(action: str, params: dict) -> dict:
        if action == "start":
            return controller.start(
                bool(params.get("hideImWindow", False)),
                bool(params.get("frameReady", False)),
            )
        if action == "status":
            return controller.status(int(params.get("after") or 0))
        if action == "image":
            return {"png": controller.take_image()}
        if action == "cancel":
            return controller.cancel_active()
        if action == "apply":
            return reload_screenshot_hotkey()
        if action == "hotkey-status":
            with _hotkey_lock:
                return dict(_hotkey_status)
        raise ValueError(f"未知截图动作: {action}")

    return handler


def _start_screenshot_hotkey(on_hotkey: Callable[[], None]) -> None:
    """注册系统级截图快捷键（仅 Windows 桌面壳，组合键由本机配置读取）。

    RegisterHotKey(hwnd=None) 把 WM_HOTKEY 投到**注册线程**的消息队列，因此必须在
    专用线程里跑 GetMessageW 循环；GUI 线程已被 pywebview/WinForms 占用，不能复用。
    热键只负责「记一次事件」（见 desktop_bridge），由前端轮询端点拉取，避免跨线程
    直接操作 WebView2 控件 / evaluate_js 在窗口最小化时失效。
    只要应用进程不退出，本线程常驻，故在其它应用窗口按快捷键也能触发截图。
    """
    if os.name != "nt":
        return

    def _loop() -> None:
        global _hotkey_thread_id
        try:
            from ctypes import wintypes

            from app.services import desktop_screenshot_settings as cfg

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            user32.RegisterHotKey.argtypes = [
                wintypes.HWND, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
            ]
            user32.RegisterHotKey.restype = ctypes.c_bool
            user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.UnregisterHotKey.restype = ctypes.c_bool
            user32.PeekMessageW.argtypes = [
                ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
            ]
            user32.PeekMessageW.restype = ctypes.c_bool
            user32.GetMessageW.argtypes = [
                ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                ctypes.c_uint, ctypes.c_uint,
            ]
            user32.GetMessageW.restype = ctypes.c_int
            kernel32.GetCurrentThreadId.restype = wintypes.DWORD

            msg = wintypes.MSG()
            # PeekMessage 会为当前线程建立消息队列，之后 PostThreadMessageW 才能投递
            user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)  # PM_NOREMOVE
            with _hotkey_lock:
                _hotkey_thread_id = int(kernel32.GetCurrentThreadId())
            _register_screenshot_hotkey(user32, cfg)

            while True:
                result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if result in (0, -1):  # WM_QUIT / 出错
                    break
                if msg.message == WM_APP_RELOAD_HOTKEY:
                    user32.UnregisterHotKey(None, HOTKEY_ID)
                    _register_screenshot_hotkey(user32, cfg)
                    _hotkey_status_event.set()
                elif msg.message == WM_HOTKEY and int(msg.wParam or 0) == HOTKEY_ID:
                    try:
                        on_hotkey()
                    except Exception:  # noqa: BLE001
                        _log.exception("处理全局截图热键失败")
            user32.UnregisterHotKey(None, HOTKEY_ID)
        except Exception:  # noqa: BLE001
            _log.exception("全局截图热键线程异常（应用内快捷键仍可用）")
            _hotkey_status_event.set()

    threading.Thread(
        target=_loop, daemon=True, name="npt-screenshot-hotkey",
    ).start()


def _create_window() -> Any:
    """创建主窗口并注册各类回调（初始显示启动页）。"""
    import webview

    # 必须开启，否则 WebView2 会直接取消所有导出下载
    webview.settings["ALLOW_DOWNLOADS"] = True
    # 无边框窗口由前端自绘标题栏：只有自身带 .pywebview-drag-region 的元素按下才拖动窗口，
    # 避免标题栏上的下载/最小化/最大化/关闭按钮按下被误判为拖窗
    webview.settings["DRAG_REGION_DIRECT_TARGET_ONLY"] = True
    width, height, min_size = _window_size()
    window = webview.create_window(
        APP_NAME,
        html=_splash_html(),
        width=width,
        height=height,
        min_size=min_size,
        # 以普通窗口启动（窗口尺寸已按屏幕 92% 适配）：最大化窗口在 Windows 上本来
        # 就没有系统投影和 Win11 圆角，用户看到的「刚打开样式不正常、拖一下才恢复」
        # 正是启动了最大化态；普通窗口配合 _apply_window_frame 首帧就有阴影与圆角。
        maximized=False,
        # pywebview 默认 text_select=False 会注入 CSS 全局禁用文本选择，网页端能复制的
        # 文字在桌面端选不中；打开后与浏览器行为一致
        text_select=True,
        # 标题栏由前端自绘（含应用下载入口），窗口不再用原生边框；
        # easy_drag 默认 True 会让页面任意按下都拖动窗口（地图没法用），必须关闭，
        # 拖动只走标题栏的 .pywebview-drag-region 机制
        frameless=True,
        easy_drag=False,
    )
    # 窗口状态缓存：最大化/还原事件 + 全屏回调共同维护，供自绘标题栏查询
    win_state: dict = {"fullscreen": False, "maximized": False}
    # 无边框窗口补最小化/最大化样式位：必须在窗体真正显示后再做（webview.start 的 func
    # 线程早于 create_window，这时 window.native 还没就绪，直调会静默跳过）
    def _on_shown(*_args: Any) -> None:
        # 补样式位 → 子类化窗口过程吃掉原生边框 → 让 DWM 首帧就画投影/圆角
        _apply_window_frame(window)

    try:
        window.events.shown += _on_shown
    except Exception as exc:  # noqa: BLE001
        _log.warning("订阅窗口显示事件失败（任务栏点击可能无法最小化）：%s", exc)
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

        desktop_bridge.set_fullscreen_handler(_make_fullscreen_handler(window, win_state))
        desktop_bridge.set_window_control_handler(
            _make_window_control_handler(window, win_state)
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("注入窗口全屏/控制回调失败（地图全屏将退化为应用内全屏）：%s", exc)
    # 注入取景截图会话：桌面端由壳层直接抓整屏 + 置顶蒙层框选，不再依赖
    # WebView2 的共享窗口选择器；未注入时端点返回 403，前端降级到网页端旧流程。
    try:
        from app import desktop_bridge
        from screenshot_capture import ScreenshotCaptureController

        controller = ScreenshotCaptureController(_default_data_root())
        desktop_bridge.set_screenshot_handler(_make_screenshot_handler(controller))
        _log.info("已注入桌面取景截图会话回调")
    except Exception as exc:  # noqa: BLE001
        _log.warning("注入取景截图回调失败（截图将降级为窗口选择方式）：%s", exc)
    # 系统级截图快捷键：组合键取自本机配置，窗口不在前台 / 最小化 / 其它应用窗口都能触发
    try:
        from app import desktop_bridge

        def _on_screenshot_hotkey() -> None:
            # 只登记「待取景」并安排 watchdog，绝不在这里直接抓屏：会话窗口是 WebView2
            # 内的 DOM 浮层，必须由前端先完成 DOM 稳定化（清标记 / 关遮罩 / 收下拉 /
            # 等两帧）才能让屏幕原样出现在冻结帧里。Win32 消息线程必须保持极短。
            _arm_screenshot_watchdog(desktop_bridge)

        _start_screenshot_hotkey(_on_screenshot_hotkey)
    except Exception as exc:  # noqa: BLE001
        _log.warning("注册全局截图热键失败（应用内快捷键仍可用）：%s", exc)
    return window


def _open_when_ready(window: Any, port: int, url: str) -> None:
    """GUI 线程外执行：等后端就绪 → 把启动页导航到真正的应用页面。

    后端线程在 main() 里、创建窗口**之前**就已启动：import app + lifespan（数秒）
    与 WebView2 运行时冷启动并行进行，切模式重启时启动页停留时间最短。
    """
    global _STARTUP_FAILED
    if not _wait_ready(port):
        _log.error("后端启动超时（%s 秒），日志: %s", READY_TIMEOUT_SECONDS, _log_path_hint())
        _STARTUP_FAILED = True
        _show_startup_error(window, "后端服务启动超时，请把日志发送给技术支持。")
        return
    _log.info("后端就绪，切换到应用页面")
    try:
        window.load_url(url)
    except Exception as exc:  # noqa: BLE001
        # load_url 不可用（pywebview 版本差异）时退回页面内跳转
        _log.warning("窗口导航失败（改用页面内跳转）：%s", exc)
        window.load_html(
            f"<script>location.replace({url!r})</script>",
            base_uri=url,
        )


def _show_startup_error(window: Any, message: str) -> None:
    """启动失败时把原因显示在窗口里（窗口已存在，不再弹模态框挡住它）。"""
    try:
        window.load_html(_error_html(message))
    except Exception as exc:  # noqa: BLE001
        _log.warning("显示启动失败页失败：%s", exc)
        _message_box(f"程序启动失败，请将日志发送给技术支持：\n{_log_path_hint()}", 0x10)


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

    if args.selftest:
        server, thread = _start_server(sock)
        if not _wait_ready(port):
            _log.error("后端启动超时（%s 秒），日志: %s", READY_TIMEOUT_SECONDS, _log_path_hint())
            _message_box(f"程序启动失败，请将日志发送给技术支持：\n{_log_path_hint()}", 0x10)
            return 1
        _log.info("后端就绪")
        return _run_selftest(port)

    # 后端先在独立线程起跑（import app + lifespan 要数秒），与随后的 WebView2 运行时
    # 初始化并行——窗口出现时后端通常已就绪大半，切模式重启的启动页停留时间最短
    global _SERVER, _SERVER_THREAD
    _SERVER, _SERVER_THREAD = _start_server(sock)

    import webview

    # 窗口先显示启动页；webview.start 的 func 在 GUI 起来后只负责等就绪并导航
    window = _create_window()
    _log.info("打开桌面窗口（启动页），等待后端就绪")
    # private_mode=False + storage_path：localStorage 持久化（否则每次启动掉登录）
    webview.start(
        _open_when_ready,
        (window, port, f"http://127.0.0.1:{port}/?v={_asset_version()}"),
        private_mode=False,
        storage_path=str(data_root / "webview"),
    )
    _log.info("窗口已关闭，正在退出")
    # 后台更新（用户点了「后台运行」）：进程继续跑到安装脚本拉起为止。
    # 这期间仍持有单实例互斥体：用户再点图标会被"后台更新中"的提示挡住，
    # 避免新实例的进程被随后的 taskkill 兜底误杀。
    _continue_background_update()
    # 释放单实例互斥体：收尾阶段（停服务、解释器退出）不再阻止用户重新启动，
    # 也避免安装器的 AppMutex 检测把安装挡下来
    _release_single_instance()
    # 后端由 _boot_backend_and_open 在后台线程启动：窗口可能在它起来之前就被关掉
    # （用户等不及直接关窗），这里按实际拿到的句柄收尾，拿不到就交给进程退出
    if _SERVER is not None:
        _SERVER.should_exit = True
    if _SERVER_THREAD is not None:
        _SERVER_THREAD.join(timeout=5)
    return 1 if _STARTUP_FAILED else 0


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
