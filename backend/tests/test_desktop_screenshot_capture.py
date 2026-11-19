"""桌面壳取景截图：可在 Linux CI 验证的纯逻辑与状态机契约。

Win32 / WinForms 交互无法在 CI 真实执行，但坐标裁剪（多屏虚拟屏左上角为负）、
结果序号发布、非 Windows 降级这些契约必须在这里守住。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_capture():
    path = Path(__file__).resolve().parents[2] / "desktop" / "screenshot_capture.py"
    spec = importlib.util.spec_from_file_location("desktop_screenshot_capture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clip_rect_translates_virtual_screen_origin():
    """多屏时虚拟屏左上角可能为负：屏幕矩形要减掉 origin 才是图像坐标。"""
    capture = _load_capture()
    origin = (-1920, -200)
    assert capture.clip_rect_to_image(
        (-1920, -200, 0, 880), origin, (3840, 1080)
    ) == (0, 0, 1920, 1080)
    assert capture.clip_rect_to_image(
        (100, 100, 900, 700), origin, (3840, 1080)
    ) == (2020, 300, 2820, 900)


def test_clip_rect_clamps_and_rejects_empty():
    capture = _load_capture()
    origin = (0, 0)
    assert capture.clip_rect_to_image(
        (-50, -20, 300, 200), origin, (800, 600)
    ) == (0, 0, 300, 200)
    assert capture.clip_rect_to_image(
        (700, 500, 1200, 900), origin, (800, 600)
    ) == (700, 500, 800, 600)
    assert capture.clip_rect_to_image((500, 300, 500, 300), origin, (800, 600)) is None
    assert capture.clip_rect_to_image((700, 500, 600, 400), origin, (800, 600)) is None


def test_non_windows_degrades_cleanly(tmp_path):
    """非 Windows：supported=False、窗口识别返回 None、发起会话不建蒙层。"""
    capture = _load_capture()
    assert capture.supported() is (capture.os.name == "nt")
    if capture.os.name != "nt":
        assert capture.window_rect_at((10, 10)) is None

    controller = capture.ScreenshotCaptureController(tmp_path)
    result = controller.start(hide_im_window=False)
    if capture.os.name != "nt":
        assert result["started"] is False
        assert result["unsupported"] is True
        assert result["seq"] == 0
        assert controller.status(result["seq"]) == {
            "seq": 0, "ready": False, "cancelled": False, "pending": False,
        }
        assert controller.take_image() is None


def test_publish_result_is_consumed_once(tmp_path):
    """结果序号自增、PNG 读后即弃：避免敏感画面常驻内存 / 前端重复消费。"""
    capture = _load_capture()
    controller = capture.ScreenshotCaptureController(tmp_path)
    abort = controller._abort
    baseline = controller.status(0)["seq"]

    controller._publish(b"fake-png", False, abort)
    status = controller.status(baseline)
    assert status["seq"] == baseline + 1
    assert status["ready"] is True
    assert status["cancelled"] is False
    assert controller.take_image() == b"fake-png"
    assert controller.take_image() is None
    assert controller.status(baseline)["ready"] is False

    # 被新会话替换的旧线程不得再发布过期结果
    controller._abort = capture.threading.Event()
    controller._publish(b"stale", False, abort)
    assert controller.take_image() is None


def test_frame_ready_controls_settle_wait_only(tmp_path, monkeypatch):
    """等待只由 frame_ready 决定，与「隐藏窗口截图」开关解耦。

    关闭开关时前端同样完成 DOM 稳定化并等两帧，壳层必须立即抓屏；
    watchdog / 旧前端未稳定化才等待，保证不会把还没画出来的会话窗口拍进去。
    """
    capture = _load_capture()
    sleeps: list = []
    monkeypatch.setattr(capture.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(capture, "_ensure_dpi_aware", lambda: None)
    # 让 _run 在抓屏前就因虚拟屏尺寸为 0 提前返回，避免在 Linux 上碰 Win32
    monkeypatch.setattr(capture, "virtual_screen_rect", lambda: (0, 0, 0, 0))

    first = capture.ScreenshotCaptureController(tmp_path)
    first._run(False, True, first._abort)
    assert sleeps == []

    second = capture.ScreenshotCaptureController(tmp_path)
    second._run(False, False, second._abort)
    assert sleeps == [capture.CAPTURE_SETTLE_SECONDS]

    third = capture.ScreenshotCaptureController(tmp_path)
    third._run(True, False, third._abort)
    assert sleeps == [capture.CAPTURE_SETTLE_SECONDS] * 2


def test_start_passes_frame_ready_to_worker(tmp_path, monkeypatch):
    capture = _load_capture()
    monkeypatch.setattr(capture, "supported", lambda: True)
    captured: list = []

    class _NoopThread:
        def __init__(self, *_args, **kwargs):
            captured.append(kwargs.get("args", ()))

        def start(self):
            pass

    monkeypatch.setattr(capture.threading, "Thread", _NoopThread)
    controller = capture.ScreenshotCaptureController(tmp_path)
    controller.start(hide_im_window=True, frame_ready=True)
    assert captured[0][:2] == (True, True)


def test_start_reuses_pending_result_when_frontend_polls_late(tmp_path, monkeypatch):
    """全局热键由壳层直接完成取景、前端轮询晚到：不能重开一轮蒙层，直接复用结果。"""
    capture = _load_capture()
    monkeypatch.setattr(capture, "supported", lambda: True)
    controller = capture.ScreenshotCaptureController(tmp_path)
    controller._publish(b"png", False, controller._abort)
    assert controller.status(0)["seq"] == 1
    # 上面的 status 视作前端已消费；重新发布模拟一次新的晚到结果
    controller._publish(b"late", False, controller._abort)

    class _NoopThread:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(capture.threading, "Thread", _NoopThread)
    result = controller.start(hide_im_window=False)
    assert result == {"started": True, "busy": False, "unsupported": False, "seq": 1}
    assert controller.status(result["seq"])["ready"] is True
    assert controller.take_image() == b"late"
    # 消费后再次调用 start 必须真正发起新会话，不能一直 replay 旧结果
    second = controller.start(hide_im_window=False)
    assert second["started"] is True and second["seq"] == 2


def test_cancel_result_does_not_block_later_screenshots(tmp_path, monkeypatch):
    """用户按 ESC 取消一轮后，后续 Alt+Z / 剪刀按钮必须还能正常发起新取景。"""
    capture = _load_capture()
    monkeypatch.setattr(capture, "supported", lambda: True)
    started: list = []

    class _NoopThread:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            started.append(True)

    monkeypatch.setattr(capture.threading, "Thread", _NoopThread)
    controller = capture.ScreenshotCaptureController(tmp_path)
    abort = controller._abort
    controller._publish(None, True, abort)  # 模拟 ESC 取消
    assert controller._cancelled is True

    # 前端晚到的 POST：回放取消结果，让前端 poll 到 cancelled 并收起蒙层
    first = controller.start(hide_im_window=False)
    assert first["started"] is True and first["busy"] is False
    assert controller.status(first["seq"])["cancelled"] is True
    assert controller._result_unclaimed is False

    # 关键回归：取消结果消费后，下一次热键/剪刀必须真正起新会话
    second = controller.start(hide_im_window=False)
    assert second["started"] is True and second["busy"] is False
    assert second["seq"] == 1
    assert len(started) == 1  # 只起了一个真实取景线程


def test_selection_handles_and_resize():
    """四边四角把手可命中，拖动后按相反角固定重算选区。"""
    capture = _load_capture()
    rect = (100, 100, 300, 240)
    assert len(capture.handles_for_rect(rect)) == 8
    assert capture.hit_handle(rect, (200, 100)) == "n"
    assert capture.hit_handle(rect, (300, 170)) == "e"
    assert capture.hit_handle(rect, (100, 240)) == "sw"
    assert capture.hit_handle(rect, (200, 170)) is None
    assert capture.resize_rect(rect, "nw", (80, 70)) == (80, 70, 300, 240)
    assert capture.resize_rect(rect, "se", (360, 260)) == (100, 100, 360, 260)
    # 拖到对边之外会翻转：忽略，避免选区消失
    assert capture.resize_rect(rect, "e", (90, 170)) == rect


def test_confirm_button_and_magnifier_clamp():
    """确认按钮与放大镜靠近屏幕边缘时不越界。"""
    capture = _load_capture()
    assert capture.confirm_rect_for((100, 100, 300, 240), (800, 600)) == (300, 248, 384, 278)
    btn = capture.confirm_rect_for((700, 500, 790, 590), (800, 600))
    assert btn[2] <= 800 and btn[3] <= 600
    assert capture.point_in_rect((310, 255), capture.confirm_rect_for((100, 100, 300, 240), (800, 600)))
    assert capture.magnifier_source((10, 20), (800, 600)) == (0, 0, 96, 96)
    assert capture.magnifier_source((790, 590), (800, 600)) == (704, 504, 800, 600)


def test_confirm_by_enter_or_button_only_after_selection():
    """松手后可用回车或点确定完成；没有选区时回车不能把取景当成取消。"""
    capture = _load_capture()
    button = (300, 248, 384, 278)
    assert capture.confirm_requested((10, 10), None, False, False, True) is False
    assert capture.confirm_requested((10, 10), button, False, False, True) is True
    assert capture.confirm_requested((310, 255), button, True, False, False) is True
    assert capture.confirm_requested((10, 10), button, False, False, False) is False


def test_drag_mode_ignores_hover_until_committed():
    """自动识别的虚线框不能当成已提交选区：未松手前拖动一律是框选。"""
    capture = _load_capture()
    rect = (100, 100, 300, 240)
    # hover 草稿即使覆盖了鼠标，也绝不能进入 move/resize
    assert capture.choose_drag_mode(False, rect, (200, 170), None) == "create"
    assert capture.choose_drag_mode(False, rect, (200, 170), "n") == "create"
    # 松手提交后：命中把手缩放、点内部移动、点外部重新框选
    assert capture.choose_drag_mode(True, rect, (300, 170), "e") == "resize"
    assert capture.choose_drag_mode(True, rect, (200, 170), None) == "move"
    assert capture.choose_drag_mode(True, rect, (10, 10), None) == "create"
    assert capture.choose_drag_mode(True, None, (200, 170), None) == "create"


def test_magnifier_only_before_selection_commit():
    """放大镜在框选阶段跟随鼠标，松手提交后立即退出。"""
    capture = _load_capture()
    assert capture.should_show_magnifier(False) is True
    assert capture.should_show_magnifier(True) is False


def test_element_rect_at_degrades_off_windows():
    """非 Windows：UIA 元素识别返回 None，调用方回退窗口/整屏，点击捕获仍可用。"""
    capture = _load_capture()
    if capture.os.name != "nt":
        assert capture.element_rect_at((100, 100)) is None


def test_magnifier_crosshair_marks_cursor_pixel_outside_cursor():
    """放大镜在光标右下不遮挡光标；十字交叉点对应光标指向的源像素。"""
    capture = _load_capture()
    for center in ((400, 300), (10, 20), (790, 590), (0, 0), (800, 600)):
        src, lens, cross = capture.magnifier_layout(center, (800, 600))
        assert 0 <= src[0] and src[2] <= 800
        assert 0 <= src[1] and src[3] <= 600
        assert lens[2] - lens[0] == 192 and lens[3] - lens[1] == 192
        # 交叉点落在放大镜方框内
        assert lens[0] <= cross[0] <= lens[2]
        assert lens[1] <= cross[1] <= lens[3]
        # 按 2 倍映射反算：交叉点对应的源像素就是光标位置
        assert src[0] + (cross[0] - lens[0]) // 2 == center[0]
        assert src[1] + (cross[1] - lens[1]) // 2 == center[1]

    # 屏幕中央：放大镜在光标右下 18px（光标留在方框外），交叉点落在方框正中
    _src, lens, cross = capture.magnifier_layout((400, 300), (800, 600))
    assert lens[0] == 418 and lens[1] == 318
    assert (lens[0] + lens[2]) // 2 == cross[0]
    assert (lens[1] + lens[3]) // 2 == cross[1]


def test_cursor_feedback_around_committed_selection():
    """取景阶段用传统箭头提示点击/拖动，提交后把手双向缩放、内部四向十字。"""
    capture = _load_capture()
    rect = (100, 100, 300, 240)
    assert capture.cursor_for_point(False, rect, (200, 170)) == "arrow"
    assert capture.cursor_for_point(True, rect, (200, 170)) == "arrow"
    assert capture.cursor_for_point(True, rect, (100, 170)) == "we"
    assert capture.cursor_for_point(True, rect, (200, 100)) == "ns"
    assert capture.cursor_for_point(True, rect, (300, 240)) == "nwse"
    assert capture.cursor_for_point(True, rect, (100, 240)) == "nesw"
    assert capture.cursor_for_point(True, rect, (10, 10)) == "arrow"
