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

    class _NoopThread:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(capture.threading, "Thread", _NoopThread)
    result = controller.start(hide_im_window=False)
    assert result == {"started": True, "busy": False, "unsupported": False, "seq": 0}
    assert controller.status(result["seq"])["ready"] is True
    assert controller.take_image() == b"png"
