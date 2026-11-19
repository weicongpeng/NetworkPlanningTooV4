"""Windows 桌面壳的「取景式截图」会话（仅桌面形态）。

与网页端 ``getDisplayMedia`` 的窗口选择器不同，这里由壳层直接冻结整屏画面并铺一层
置顶、鼠标穿透的 WinForms 蒙层：鼠标停在哪个顶层窗口上就高亮该窗口矩形，单击即截取；
按住拖拽则自由框选；ESC / 右键取消。因为蒙层是系统级窗口，桌面应用即使不在前台、
用户正在操作其它应用，全局热键一样能进入取景并截取别的窗口。

设计约束（与 ``ImScreenshotDialog`` 的后续流程对齐）：
- 只裁剪当前屏幕可见画面，不枚举后台窗口、不提供窗口列表；
- 结果只产出一帧 PNG 二进制 + 递增序号，标注 / 剪贴板 / 待发送附件仍全部由前端负责；
- 会话交互跑在独立 STA 线程，HTTP 端点立即返回，不阻塞 uvicorn / pywebview GUI 线程；
- 蒙层设 ``WS_EX_TRANSPARENT`` 让 ``WindowFromPoint`` 穿透到真正的下层窗口，
  鼠标与按键状态用 30ms 的 WinForms Timer 轮询，避免低级钩子与跨线程委托。
"""
from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from ctypes import wintypes
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_log = logging.getLogger("desktop")

# Win32 常量
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOOLWINDOW = 0x00000080
GA_ROOT = 2
DWMWA_EXTENDED_FRAME_BOUNDS = 9
VK_LBUTTON = 0x01
VK_RBUTTON = 0x02
VK_ESCAPE = 0x1B
VK_RETURN = 0x0D
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
COINIT_APARTMENTTHREADED = 0x2
# watchdog / 旧前端未做 DOM 稳定化时的兜底等待：让 WebView2 合成一帧再抓屏。
# 与「隐藏窗口截图」开关无关；新前端带 frame_ready=true 时壳层立即抓屏。
CAPTURE_SETTLE_SECONDS = 0.09
# 取景蒙层的鼠标/按键轮询周期（毫秒）
POLL_INTERVAL_MS = 30
# 拖动超过该像素才算「自由框选」，否则视为单击选中自动识别的窗口
DRAG_THRESHOLD = 4


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long), ("top", ctypes.c_long),
        ("right", ctypes.c_long), ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def supported() -> bool:
    """只有 Windows 桌面壳支持取景截图（服务器 / Linux 开发环境降级返回 False）。"""
    return os.name == "nt"


def _ensure_dpi_aware() -> None:
    """统一按物理像素工作，否则多屏 / 缩放时高亮框与裁剪会整体错位。

    pywebview 可能已经设置过 DPI 感知，重复调用会返回失败，忽略即可。
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:  # noqa: BLE001 - 旧系统 / 已设置
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass


def virtual_screen_rect() -> Tuple[int, int, int, int]:
    """返回整个虚拟屏幕的 ``(left, top, width, height)``（物理像素）。"""
    user32 = ctypes.windll.user32
    return (
        int(user32.GetSystemMetrics(SM_XVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_YVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
    )


def window_rect_at(point: Tuple[int, int], overlay_hwnd: int = 0) -> Optional[Tuple[int, int, int, int]]:
    """鼠标所在位置的**顶层窗口**矩形（屏幕坐标，含不可见窗口过滤）。

    ``DWMWA_EXTENDED_FRAME_BOUNDS`` 不含阴影边框，比 ``GetWindowRect`` 更贴合肉眼可见
    的窗口边界；DWM 关闭 / 调用失败时回退 ``GetWindowRect``。蒙层自身因
    ``WS_EX_TRANSPARENT`` 不参与命中测试，这里再做一次兜底。
    """
    if os.name != "nt":
        return None
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        user32.WindowFromPoint.argtypes = [POINT]
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
        user32.GetAncestor.restype = wintypes.HWND
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.IsWindowVisible.restype = ctypes.c_bool

        child = user32.WindowFromPoint(POINT(int(point[0]), int(point[1])))
        if not child:
            return None
        root = user32.GetAncestor(child, GA_ROOT)
        if not root:
            root = child
        root_int = int(root)
        if (overlay_hwnd and root_int == overlay_hwnd) or not user32.IsWindowVisible(root):
            return None

        rect = RECT()
        try:
            dwm = ctypes.WinDLL("dwmapi")
            # HRESULT：S_OK 时 rect 为可见边界
            ok = dwm.DwmGetWindowAttribute(
                wintypes.HWND(root_int), ctypes.c_uint(DWMWA_EXTENDED_FRAME_BOUNDS),
                ctypes.byref(rect), ctypes.sizeof(rect),
            )
            if ok != 0:
                raise OSError("DwmGetWindowAttribute failed")
        except Exception:  # noqa: BLE001
            user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
            if not user32.GetWindowRect(wintypes.HWND(root_int), ctypes.byref(rect)):
                return None
        if rect.right <= rect.left or rect.bottom <= rect.top:
            return None
        return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))
    except Exception:  # noqa: BLE001 - 识别失败只影响高亮，用户仍可自由框选
        return None


def clip_rect_to_image(
    rect: Tuple[int, int, int, int],
    origin: Tuple[int, int],
    image_size: Tuple[int, int],
) -> Optional[Tuple[int, int, int, int]]:
    """屏幕矩形 → 整屏快照内的裁剪框（左闭右开），并钳制到图像范围。

    ``origin`` 是虚拟屏左上角（多屏时可能为负），把窗口/框选的屏幕坐标换成图像坐标。
    """
    left = max(0, min(image_size[0], int(rect[0]) - origin[0]))
    top = max(0, min(image_size[1], int(rect[1]) - origin[1]))
    right = max(0, min(image_size[0], int(rect[2]) - origin[0]))
    bottom = max(0, min(image_size[1], int(rect[3]) - origin[1]))
    if right <= left or bottom <= top:
        return None
    return (left, top, right, bottom)


def _grab_screen(size: Tuple[int, int]) -> Any:
    """冻结整屏一次；返回 RGB PIL Image，图像 (0,0) 即虚拟屏左上角。"""
    from PIL import ImageGrab

    image = ImageGrab.grab(all_screens=True)
    # 少数环境 all_screens 与 GetSystemMetrics 口径差 1px，按虚拟屏尺寸兜底裁齐
    if image.size != (size[0], size[1]):
        _log.info("整屏快照尺寸 %s 与虚拟屏 %s 不一致，按虚拟屏对齐", image.size, size)
        image = image.crop((0, 0, min(image.width, size[0]), min(image.height, size[1])))
    return image.convert("RGB")


def _encode_png(image: Any, box: Tuple[int, int, int, int]) -> bytes:
    cropped = image.crop(box)
    buffer = BytesIO()
    cropped.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _png_files(image: Any, temp_dir: Path) -> Tuple[Path, Path]:
    """生成蒙层用的「原图」与「暗化图」临时 PNG（WinForms Bitmap 从文件加载最稳）。"""
    from PIL import Image

    temp_dir.mkdir(parents=True, exist_ok=True)
    raw_path = temp_dir / "capture-raw.png"
    dim_path = temp_dir / "capture-dim.png"
    image.save(raw_path, format="PNG")
    dim = Image.blend(image, Image.new("RGB", image.size, (0, 0, 0)), 0.55)
    dim.save(dim_path, format="PNG")
    return raw_path, dim_path


def point_in_rect(point: Tuple[int, int], rect: Tuple[int, int, int, int]) -> bool:
    return rect[0] <= point[0] <= rect[2] and rect[1] <= point[1] <= rect[3]


def normalize_rect(rect: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
    left, top, right, bottom = rect
    if right < left:
        left, right = right, left
    if bottom < top:
        top, bottom = bottom, top
    return (left, top, right, bottom)


def handles_for_rect(rect: Tuple[int, int, int, int]) -> Dict[str, Tuple[int, int]]:
    """选区四边 + 四角的 8 个修整把手（屏幕坐标）。"""
    left, top, right, bottom = rect
    cx, cy = (left + right) // 2, (top + bottom) // 2
    return {
        "nw": (left, top), "n": (cx, top), "ne": (right, top),
        "e": (right, cy), "se": (right, bottom), "s": (cx, bottom),
        "sw": (left, bottom), "w": (left, cy),
    }


def hit_handle(rect: Tuple[int, int, int, int], point: Tuple[int, int],
               tolerance: int = 8) -> Optional[str]:
    for name, (hx, hy) in handles_for_rect(rect).items():
        if abs(point[0] - hx) <= tolerance and abs(point[1] - hy) <= tolerance:
            return name
    return None


def resize_rect(rect: Tuple[int, int, int, int], handle: str,
                point: Tuple[int, int]) -> Tuple[int, int, int, int]:
    """按拖到的位置重算选区；宽高太小时忽略本次移动，避免选区翻转消失。"""
    left, top, right, bottom = rect
    # 把手拖过对边会翻转选区：直接忽略这次移动
    if "w" in handle and point[0] > right - 8:
        return rect
    if "e" in handle and point[0] < left + 8:
        return rect
    if "n" in handle and point[1] > bottom - 8:
        return rect
    if "s" in handle and point[1] < top + 8:
        return rect
    if "w" in handle:
        left = point[0]
    if "e" in handle:
        right = point[0]
    if "n" in handle:
        top = point[1]
    if "s" in handle:
        bottom = point[1]
    result = normalize_rect((left, top, right, bottom))
    if result[2] - result[0] < 8 or result[3] - result[1] < 8:
        return rect
    return result


def confirm_rect_for(rect: Tuple[int, int, int, int],
                     screen_size: Tuple[int, int]) -> Tuple[int, int, int, int]:
    """确认按钮贴选区右下角，且始终留在画面内（与 rect 同坐标系，通常是客户区）。"""
    width, height = 84, 30
    left = max(0, min(int(rect[2]), int(screen_size[0]) - width - 2))
    top = max(0, min(int(rect[3]) + 8, int(screen_size[1]) - height - 2))
    return (left, top, left + width, top + height)


def confirm_requested(point: Tuple[int, int],
                      rect: Optional[Tuple[int, int, int, int]],
                      left_down: bool, click_pulse: bool,
                      enter_pressed: bool) -> bool:
    """回车，或左键落在「确定」按钮内即完成取景。"""
    if rect is None:
        return False  # 还没有选区时回车不结束取景
    if enter_pressed:
        return True
    return point_in_rect(point, rect) and (left_down or click_pulse)


def choose_drag_mode(selection_committed: bool,
                     selection: Optional[Tuple[int, int, int, int]],
                     point: Tuple[int, int], handle: Optional[str]) -> str:
    """未提交选区时拖动一定是框选；提交后命中把手才缩放、点内部才移动。"""
    if not selection_committed or selection is None:
        return "create"
    if handle:
        return "resize"
    if point_in_rect(point, selection):
        return "move"
    return "create"


def should_show_magnifier(selection_committed: bool) -> bool:
    """放大镜只在框选阶段可见；选区松手提交后立即退出。"""
    return not selection_committed


def cursor_for_point(selection_committed: bool,
                     selection: Optional[Tuple[int, int, int, int]],
                     point: Tuple[int, int]) -> str:
    """返回光标语义名：框选十字、四向移动、双边缩放或默认箭头。"""
    if not selection_committed:
        return "cross"
    if selection and point_in_rect(point, selection):
        handle = hit_handle(selection, point)
        if handle in ("n", "s"):
            return "ns"
        if handle in ("e", "w"):
            return "we"
        if handle in ("ne", "sw"):
            return "nesw"
        if handle in ("nw", "se"):
            return "nwse"
        return "move"
    return "arrow"


def magnifier_source(center: Tuple[int, int], image_size: Tuple[int, int],
                     radius: int = 48) -> Tuple[int, int, int, int]:
    """放大镜取 cursor 周围原始像素；靠近边缘时平移取样框而不是越界。"""
    left = max(0, min(int(image_size[0]) - radius * 2, int(center[0]) - radius))
    top = max(0, min(int(image_size[1]) - radius * 2, int(center[1]) - radius))
    return (left, top, left + radius * 2, top + radius * 2)


def magnifier_layout(center: Tuple[int, int], image_size: Tuple[int, int],
                     radius: int = 48, scale: int = 2
                     ) -> Tuple[Tuple[int, int, int, int], Tuple[int, int, int, int], Tuple[int, int]]:
    """返回 (取样框, 放大镜方框, 十字中心)；十字中心与光标位置始终重合。

    放大镜位置由取样框按缩放比例反推（lens = src * scale - center），而不是固定挂在
    光标右下角：取样框靠近屏幕边缘会被平移，只有按映射反推，放大图里光标对应的像素
    才仍落在光标自己的屏幕坐标上，十字才不会与光标错开。
    """
    cx, cy = int(center[0]), int(center[1])
    src = magnifier_source((cx, cy), image_size, radius)
    side = (src[2] - src[0]) * scale
    mx = cx - (cx - src[0]) * scale
    my = cy - (cy - src[1]) * scale
    cross = (mx + (cx - src[0]) * scale, my + (cy - src[1]) * scale)
    return src, (mx, my, mx + side, my + side), cross


def _run_overlay(
    raw_path: Path,
    dim_path: Path,
    origin: Tuple[int, int],
    size: Tuple[int, int],
    abort: threading.Event,
) -> Optional[Tuple[int, int, int, int]]:
    """铺满虚拟屏的置顶蒙层；返回屏幕坐标选区，取消返回 None。

    交互在 WinForms Timer 的 Tick 里完成（UI 线程内，避免跨线程 Invoke）：
    ``Cursor.Position`` + ``GetAsyncKeyState`` 轮询按键，``WindowFromPoint`` 取顶层窗口
    矩形高亮。蒙层设 WS_EX_TRANSPARENT 使命中测试穿透到下层窗口。
    """
    import clr  # noqa: F401 - pythonnet，冻结包已由 pywebview 引入

    clr.AddReference("System.Windows.Forms")
    clr.AddReference("System.Drawing")
    from System.Drawing import Bitmap, Color, Font, GraphicsUnit, Pen, Point, Rectangle, SolidBrush
    from System.Windows.Forms import (
        Application, Cursor, Cursors, Form, FormBorderStyle, FormStartPosition, Label, Timer,
    )

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user32.GetAsyncKeyState.restype = ctypes.c_short
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    user32.SetWindowLongW.restype = ctypes.c_long

    def pressed(vk: int) -> bool:
        return bool(int(user32.GetAsyncKeyState(vk)) & 0x8000)

    raw_bitmap = Bitmap(str(raw_path))
    dim_bitmap = Bitmap(str(dim_path))
    white_pen = Pen(Color.FromArgb(255, 255, 255, 255), 2)
    state: Dict[str, Any] = {
        "selection": None,       # 屏幕坐标矩形：框选中是草稿，松手后才是已提交选区
        "selection_committed": False,  # 松手提交前不显示把手/按钮，也不允许 resize/move
        "hover": None,           # 鼠标下的窗口候选框，虚线提示（不参与拖拽模式判定）
        "start": None,           # 框选 / 移动 / 缩放起点
        "mode": "idle",          # idle / create / move / resize
        "handle": None,
        "origin_rect": None,     # 拖拽开始时的选区，用于 move / resize 的基准
        "lbutton": False,
        "cursor": (-9999, -9999),
        "cursor_name": "",       # 避免每个 Tick 都给 form.Cursor 赋同一个对象
        "done": False,
        "cancelled": False,
        "overlay_hwnd": 0,
    }

    def to_client(rect: Tuple[int, int, int, int]) -> Tuple[int, int, int, int]:
        return (
            rect[0] - origin[0], rect[1] - origin[1],
            rect[2] - origin[0], rect[3] - origin[1],
        )

    form = Form()
    # .NET 枚举成员名 "None" 是 Python 关键字，不能用 FormBorderStyle.None 取值
    form.FormBorderStyle = getattr(FormBorderStyle, "None")
    form.StartPosition = FormStartPosition.Manual
    form.Bounds = Rectangle(origin[0], origin[1], size[0], size[1])
    form.TopMost = True
    form.ShowInTaskbar = False
    form.DoubleBuffered = True
    form.BackColor = Color.Black
    form.Text = "NPT Screenshot Overlay"
    # 强制创建句柄后补扩展样式：透明命中（让 WindowFromPoint 穿透）、不抢焦点、不进任务栏
    overlay_hwnd = int(form.Handle.ToInt64())
    state["overlay_hwnd"] = overlay_hwnd
    try:
        ex_style = int(user32.GetWindowLongW(wintypes.HWND(overlay_hwnd), GWL_EXSTYLE))
        user32.SetWindowLongW(
            wintypes.HWND(overlay_hwnd), GWL_EXSTYLE,
            ctypes.c_long(ex_style | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW),
        )
    except Exception:  # noqa: BLE001 - 样式失败时仍可用自由框选
        _log.warning("设置截图蒙层扩展样式失败（窗口自动识别可能退化为整屏）")

    hint = Label()
    hint.Text = "拖动框选 · 松手后拖边框修整 · 回车或点「确定」完成 · Esc/右键取消"
    hint.AutoSize = True
    hint.BackColor = Color.FromArgb(190, 20, 20, 20)
    hint.ForeColor = Color.White
    hint.Location = Point(16, 16)
    form.Controls.Add(hint)

    hover_pen = Pen(Color.FromArgb(255, 96, 165, 250), 1)
    handle_pen = Pen(Color.FromArgb(255, 37, 99, 235), 1)
    cross_pen = Pen(Color.FromArgb(255, 255, 255, 255), 1)
    handle_brush = SolidBrush(Color.FromArgb(255, 37, 99, 235))
    button_brush = SolidBrush(Color.FromArgb(235, 37, 99, 235))
    button_text = SolidBrush(Color.FromArgb(255, 255, 255, 255))
    button_font = Font("Microsoft YaHei", 10)
    cursor_map = {
        "cross": Cursors.Cross,       # 框选 / 自动识别窗口
        "move": Cursors.SizeAll,      # 选区内部：四向十字箭头
        "ns": Cursors.SizeNS,
        "we": Cursors.SizeWE,
        "nesw": Cursors.SizeNESW,
        "nwse": Cursors.SizeNWSE,
        "arrow": Cursors.Arrow,
    }

    def on_paint(_sender: Any, event: Any) -> None:
        graphics = event.Graphics
        graphics.DrawImage(dim_bitmap, 0, 0, size[0], size[1])
        selection = state["selection"]
        committed = state["selection_committed"]
        hover = state["hover"]
        if hover and (not committed or hover != selection):
            hl, ht, hr, hb = to_client(hover)
            graphics.DrawRectangle(hover_pen, hl, ht, max(1, hr - hl), max(1, hb - ht))
        if selection:
            l, t, r, b = to_client(selection)
            width, height = r - l, b - t
            if width > 0 and height > 0:
                graphics.SetClip(Rectangle(l, t, width, height))
                graphics.DrawImage(raw_bitmap, 0, 0, size[0], size[1])
                graphics.ResetClip()
                graphics.DrawRectangle(white_pen, l, t, width, height)
                if committed:
                    # 四边四角把手只在松手提交后出现；框选草稿阶段不显示
                    for hx, hy in handles_for_rect((l, t, r, b)).values():
                        graphics.FillRectangle(handle_brush, hx - 3, hy - 3, 6, 6)
                        graphics.DrawRectangle(handle_pen, hx - 3, hy - 3, 6, 6)
            if committed:
                btn = confirm_rect_for((l, t, r, b), size)
                btn_w, btn_h = btn[2] - btn[0], btn[3] - btn[1]
                graphics.FillRectangle(button_brush, btn[0], btn[1], btn_w, btn_h)
                graphics.DrawRectangle(white_pen, btn[0], btn[1], btn_w, btn_h)
                # 按实测文字尺寸居中，此前硬编码偏移会让「确定」贴边/被裁掉
                try:
                    measured = graphics.MeasureString("确定", button_font)
                    tx = btn[0] + (btn_w - measured.Width) / 2
                    ty = btn[1] + (btn_h - measured.Height) / 2
                except Exception:  # noqa: BLE001 - 老 GDI+ 兼容
                    tx, ty = btn[0] + btn_w / 2 - 11, btn[1] + btn_h / 2 - 8
                graphics.DrawString("确定", button_font, button_text, tx, ty)
        # 选区松手提交后放大镜退出；框选草稿阶段一直跟随鼠标（含拖动中）
        cursor = state["cursor"]
        if should_show_magnifier(committed) and cursor[0] > -9000:
            image_x, image_y = cursor[0] - origin[0], cursor[1] - origin[1]
            src, lens, (cross_x, cross_y) = magnifier_layout((image_x, image_y), size)
            lens_w, lens_h = lens[2] - lens[0], lens[3] - lens[1]
            graphics.DrawImage(
                raw_bitmap, Rectangle(lens[0], lens[1], lens_w, lens_h),
                Rectangle(src[0], src[1], src[2] - src[0], src[3] - src[1]),
                GraphicsUnit.Pixel,
            )
            graphics.DrawRectangle(white_pen, lens[0], lens[1], lens_w, lens_h)
            # 十字中心 = 光标指向像素在放大图里的位置，与光标屏幕坐标重合
            graphics.DrawLine(cross_pen, cross_x - 12, cross_y, cross_x + 12, cross_y)
            graphics.DrawLine(cross_pen, cross_x, cross_y - 12, cross_x, cross_y + 12)

    def finish(cancelled: bool, rect: Optional[Tuple[int, int, int, int]]) -> None:
        if state["done"]:
            return
        state["done"] = True
        state["cancelled"] = cancelled
        state["selection"] = rect
        timer.Stop()
        form.Close()

    def on_tick(_sender: Any, _event: Any) -> None:
        if state["done"]:
            return
        if abort.is_set() or pressed(VK_ESCAPE) or pressed(VK_RBUTTON):
            finish(True, None)
            return
        position = Cursor.Position
        screen = (int(position.X), int(position.Y))
        cursor_changed = screen != state["cursor"]
        state["cursor"] = screen
        full_screen = (
            origin[0], origin[1], origin[0] + size[0], origin[1] + size[1])
        hover = window_rect_at(screen, state["overlay_hwnd"]) or full_screen
        if hover != state["hover"]:
            cursor_changed = True
        state["hover"] = hover

        # 只读一次：高位=当前是否按下，低位=自上次轮询以来是否发生过按下。
        # 低位用于兜住比轮询周期还短的单击，否则整段「按下→松开」会被采样漏掉。
        lbutton_state = int(user32.GetAsyncKeyState(VK_LBUTTON))
        left_down = bool(lbutton_state & 0x8000)
        click_pulse = bool(lbutton_state & 0x0001)
        enter_pressed = bool(int(user32.GetAsyncKeyState(VK_RETURN)) & 0x8000)

        # 确认：仅已提交选区支持回车 / 点「确定」按钮
        # （蒙层透明，按钮用命中测试而非 WinForms 控件事件）
        selection = state["selection"]
        committed = state["selection_committed"]
        # 光标反馈：框选十字；提交后边框把手是双向缩放箭头，选区内部是四向十字。
        cursor_name = cursor_for_point(committed, selection, screen)
        if cursor_name != state["cursor_name"]:
            form.Cursor = cursor_map[cursor_name]
            state["cursor_name"] = cursor_name
        button_screen = None
        if committed and selection:
            btn = confirm_rect_for(to_client(selection), size)
            button_screen = (btn[0] + origin[0], btn[1] + origin[1],
                             btn[2] + origin[0], btn[3] + origin[1])
        if committed and confirm_requested(
                screen, button_screen, left_down,
                click_pulse and not state["lbutton"], enter_pressed):
            finish(False, selection)
            return

        if left_down and not state["lbutton"]:
            state["start"] = screen
            # hover 永远不参与模式判定；只有已提交选区才可能 resize/move
            handle = hit_handle(selection, screen) if committed and selection else None
            mode = choose_drag_mode(committed, selection, screen, handle)
            state["mode"] = mode
            state["handle"] = handle if mode == "resize" else None
            state["origin_rect"] = selection if mode in ("move", "resize") else None
            if mode == "create":
                # 重新框选：草稿阶段放大镜仍在，把手/按钮隐藏
                state["selection_committed"] = False
                state["selection"] = None
        elif left_down and state["start"] is not None:
            sx, sy = state["start"]
            if state["mode"] == "create":
                state["selection"] = normalize_rect((sx, sy, screen[0], screen[1]))
            elif state["mode"] == "move" and state["origin_rect"]:
                base = state["origin_rect"]
                dx, dy = screen[0] - sx, screen[1] - sy
                state["selection"] = (base[0] + dx, base[1] + dy,
                                      base[2] + dx, base[3] + dy)
            elif state["mode"] == "resize" and state["origin_rect"]:
                state["selection"] = resize_rect(
                    state["origin_rect"], state["handle"] or "", screen)
            cursor_changed = True
        elif not left_down and state["lbutton"]:
            # 松手：提交本轮框选（拖拽画出的矩形，或单击采纳的窗口矩形），
            # 但不结束取景；接下来只做边框修整直到回车/确定。
            if state["mode"] == "create" and state["start"] is not None:
                sx, sy = state["start"]
                if (abs(screen[0] - sx) <= DRAG_THRESHOLD
                        and abs(screen[1] - sy) <= DRAG_THRESHOLD):
                    state["selection"] = hover
                else:
                    state["selection"] = normalize_rect(
                        (sx, sy, screen[0], screen[1]))
                state["selection_committed"] = state["selection"] is not None
            state["mode"] = "idle"
            state["handle"] = None
            state["origin_rect"] = None
            cursor_changed = True
        state["lbutton"] = left_down

        if cursor_changed or left_down or state["lbutton"]:
            form.Invalidate()

    timer = Timer()
    timer.Interval = POLL_INTERVAL_MS
    timer.Tick += on_tick
    form.Paint += on_paint
    # Timer 在本 UI 线程创建，先 Start 再进入消息循环即可驱动 Tick；
    # 不依赖 Shown 事件，少一层跨语言委托绑定
    timer.Start()

    try:
        Application.Run(form)
    finally:
        try:
            timer.Stop()
            timer.Dispose()
        except Exception:  # noqa: BLE001
            pass
        for resource in (
            white_pen, hover_pen, handle_pen, cross_pen, handle_brush,
            button_brush, button_text, button_font, raw_bitmap, dim_bitmap,
        ):
            try:
                resource.Dispose()
            except Exception:  # noqa: BLE001
                pass

    if state["cancelled"] or not state["selection"]:
        return None
    return state["selection"]


class ScreenshotCaptureController:
    """截图会话状态机；端点只与它交互，不直接碰 Win32。

    结果以「序号 + 二进制」发布：前端发起时拿基线 seq，之后轮询 status，
    ``seq`` 增长且 ready 时再取一次 PNG。与既有 ``screenshot-hotkey`` 的序号轮询同范式，
    不依赖 ``evaluate_js``（窗口最小化时不可靠）。
    """

    def __init__(self, data_root: Path) -> None:
        self._data_root = Path(data_root)
        self._temp_dir = self._data_root / "screenshot_tmp"
        self._lock = threading.Lock()
        self._seq = 0
        self._image: Optional[bytes] = None
        self._cancelled = False
        self._running = False
        # 上一轮结果是否已经交给前端。只有「未消费」时才允许 replay 基线序号；
        # 否则一次取消/异常会把 _cancelled 永久留成 True，后续所有截图都被判成旧结果。
        self._result_unclaimed = False
        self._run_started_at = 0.0
        self._abort = threading.Event()

    def start(self, hide_im_window: bool = False,
              frame_ready: bool = False) -> Dict[str, Any]:
        """发起一次取景；已有会话进行中返回 ``busy``，不重复铺蒙层。

        ``frame_ready`` 表示前端已完成 DOM 稳定化并等过两个渲染帧，壳层可以立即
        抓屏；watchdog 兜底 / 旧前端传 False，壳层自行等待 WebView2 合成一帧。
        """
        if not supported():
            return {"started": False, "busy": False, "unsupported": True, "seq": self._seq}
        with self._lock:
            if self._running:
                # 蒙层异常残留（例如 WinForms 消息循环没退出）不能永久占住会话：
                # 超过 3 分钟视为卡死，终止旧轮并按新的一轮处理。
                if self._run_started_at and time.monotonic() - self._run_started_at > 180:
                    _log.warning("上一轮截图取景超时，强制中止并重新开始")
                    self._abort.set()
                    self._running = False
                    self._cancelled = True
                    self._seq += 1
                    self._result_unclaimed = False
                else:
                    return {"started": False, "busy": True, "unsupported": False, "seq": self._seq}
            if self._result_unclaimed:
                # 全局热键由壳层直接启动并已结束，前端轮询晚到时不能重开一轮蒙层：
                # 回退基线序号，让前端的 status(after) 立刻读到这次结果。
                # 只 replay 一次；前端消费后（status/take_image）标记清零，下一轮正常起蒙层。
                self._result_unclaimed = False
                _log.info("前端晚到，回放上一轮截图结果序号 %s", max(0, self._seq - 1))
                return {
                    "started": True, "busy": False, "unsupported": False,
                    "seq": max(0, self._seq - 1),
                }
            self._running = True
            self._image = None
            self._cancelled = False
            self._result_unclaimed = False
            self._run_started_at = time.monotonic()
            self._abort = threading.Event()
            seq = self._seq
            abort = self._abort
        thread = threading.Thread(
            target=self._run, args=(bool(hide_im_window), bool(frame_ready), abort),
            daemon=True, name="npt-screenshot-capture",
        )
        thread.start()
        _log.info("截图取景会话已启动（隐藏会话窗口=%s，前端已稳定=%s，基线序号=%s）",
                  hide_im_window, frame_ready, seq)
        return {"started": True, "busy": False, "unsupported": False, "seq": seq}

    def cancel_active(self) -> Dict[str, Any]:
        """前端关闭弹窗时中止仍在进行的取景，避免残留置顶蒙层抢焦点。"""
        with self._lock:
            active = self._running
            abort = self._abort
        if active:
            abort.set()
        return {"cancelled": active}

    def status(self, after_seq: int) -> Dict[str, Any]:
        with self._lock:
            changed = self._seq > int(after_seq or 0)
            ready = changed and self._image is not None
            cancelled = changed and self._cancelled
            if ready or cancelled:
                # 前端已看到这一轮结果：即使后续重复轮询也不能再当作「待回放」，
                # 否则 cancel 之后每次 start 都会命中 replay 分支，截图彻底失效。
                self._result_unclaimed = False
            return {
                "seq": self._seq,
                "ready": ready,
                "cancelled": cancelled,
                "pending": self._running,
            }

    def take_image(self) -> Optional[bytes]:
        """取出并清空最近一帧 PNG（读后即弃，避免敏感画面常驻磁盘/内存）。"""
        with self._lock:
            data = self._image
            self._image = None
            self._result_unclaimed = False
            return data

    def _publish(self, image: Optional[bytes], cancelled: bool, abort: threading.Event) -> None:
        with self._lock:
            # 被后续会话替换的旧线程不得再发布结果
            if self._abort is not abort:
                return
            self._image = image
            self._cancelled = cancelled
            self._result_unclaimed = True
            self._seq += 1
            self._running = False
            self._run_started_at = 0.0

    def _run(self, hide_im_window: bool, frame_ready: bool,
             abort: threading.Event) -> None:
        raw_path: Optional[Path] = None
        dim_path: Optional[Path] = None
        try:
            # 关闭「隐藏窗口截图」时前端同样要等两帧，保证屏幕上已打开的会话窗口
            # 完成懒加载 / 渐显后再抓；所以等待只由 frame_ready 决定，与开关无关。
            if not frame_ready:
                time.sleep(CAPTURE_SETTLE_SECONDS)
            if abort.is_set():
                self._publish(None, True, abort)
                return
            _ensure_dpi_aware()
            left, top, width, height = virtual_screen_rect()
            if width <= 0 or height <= 0:
                self._publish(None, True, abort)
                return
            origin = (left, top)
            image = _grab_screen((width, height))
            if abort.is_set():
                self._publish(None, True, abort)
                return
            raw_path, dim_path = _png_files(image, self._temp_dir)
            # STA：WinForms 消息循环要求单线程套间
            try:
                ctypes.windll.ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            except Exception:  # noqa: BLE001
                pass
            rect = _run_overlay(raw_path, dim_path, origin, (width, height), abort)
            if rect is None or abort.is_set():
                _log.info("截图取景已取消")
                self._publish(None, True, abort)
                return
            box = clip_rect_to_image(rect, origin, (width, height))
            if box is None:
                self._publish(None, True, abort)
                return
            png = _encode_png(image, box)
            self._publish(png, False, abort)
            _log.info("截图取景完成：%sx%s → %s 字节", box[2] - box[0], box[3] - box[1], len(png))
        except Exception:  # noqa: BLE001
            _log.exception("截图取景会话失败（前端按取消处理）")
            self._publish(None, True, abort)
        finally:
            for path in (raw_path, dim_path):
                try:
                    if path and path.is_file():
                        path.unlink()
                except Exception:  # noqa: BLE001
                    pass
