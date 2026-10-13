"""控制台编码加固：GBK 流下的 print 不再把业务逻辑炸掉。

回归背景（2026-10-12 桌面端·单机模式「地理化数据」上传失败）：
导入服务里有带 emoji 的调试 print（`[GeoDataService] 🔴🔴🔴 ...`），而桌面端
（`desktop/launcher.py` 直接 `create_app()`）**不走 `backend/main.py`**，
Windows 下 print 写到 cp936 控制台/重定向流时抛
`'gbk' codec can't encode character '\U0001f534' in position 17`；
异常顺着业务代码冒到接口层，变成"上传失败"，错误信息还被误判成文件内容问题。

修复：`app/core/console_encoding.setup_console_encoding()` 统一给 print 与
stdout/stderr 兜底，网页端（main.py）与桌面端（launcher.py）共用。
"""
from __future__ import annotations

import io
import sys

import pandas as pd
import pytest


def _gbk_stream():
    """严格 GBK 流（等价于中文 Windows 控制台 / 重定向文件的默认编码）。"""
    buf = io.BytesIO()
    return io.TextIOWrapper(buf, encoding="gbk", errors="strict"), buf


def test_gbk_stream_rejects_emoji_without_patch(monkeypatch):
    """先复现根因：严格 GBK 流写入 emoji 会抛 UnicodeEncodeError（用户看到的就是它）。"""
    stream, _ = _gbk_stream()
    monkeypatch.setattr(sys, "stdout", stream)

    with pytest.raises(UnicodeEncodeError) as exc:
        stream.write("[GeoDataService] 🔴🔴🔴 文件名: a.xlsx")
    assert "'gbk' codec can't encode character" in str(exc.value)


def test_safe_print_survives_gbk_stream(monkeypatch):
    """加固后：同样的内容不再抛异常（无法编码的字符退化为 ?）。"""
    from app.core.console_encoding import setup_console_encoding

    setup_console_encoding()

    stream, buf = _gbk_stream()
    monkeypatch.setattr(sys, "stdout", stream)

    print("[GeoDataService] 🔴🔴🔴 文件名: 测试.xlsx")  # 不应抛异常
    stream.flush()

    text = buf.getvalue().decode("gbk")
    assert "文件名: 测试.xlsx" in text
    assert "?" in text  # emoji 被替换成占位符


def test_safe_print_survives_non_str_arg(monkeypatch):
    """非 str 参数（__str__ 里带 emoji 的对象）也要兜底，否则重试仍会失败。"""
    from app.core.console_encoding import setup_console_encoding

    setup_console_encoding()

    stream, buf = _gbk_stream()
    monkeypatch.setattr(sys, "stdout", stream)

    class _Marker:
        def __str__(self) -> str:
            return "标记🔴"

    print("结果:", _Marker())
    stream.flush()
    assert "标记?" in buf.getvalue().decode("gbk")


def test_stream_reconfigure_on_windows(monkeypatch):
    """Windows 分支：把 stdout/stderr 变宽松（桌面端保留原编码，网页端强制 utf-8）。"""
    from app.core import console_encoding

    stream, buf = _gbk_stream()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "stdout", stream)
    monkeypatch.setattr(sys, "stderr", _gbk_stream()[0])

    # 桌面端：保留 GBK，仅放宽 errors → 直接 write 也不再抛
    console_encoding._make_streams_lenient(force_utf8=False)
    assert sys.stdout.encoding.lower() == "gbk"
    sys.stdout.write("直写🔴")  # 不应抛
    sys.stdout.flush()
    assert "直写?" in buf.getvalue().decode("gbk")

    # 网页端/服务端：强制 utf-8（与既有行为一致）
    stream2, buf2 = _gbk_stream()
    monkeypatch.setattr(sys, "stdout", stream2)
    console_encoding._make_streams_lenient(force_utf8=True)
    assert sys.stdout.encoding.lower() == "utf-8"
    sys.stdout.write("直写🔴")
    sys.stdout.flush()
    assert "直写🔴" in buf2.getvalue().decode("utf-8")


def test_geo_import_field_detection_is_gbk_safe(monkeypatch):
    """真实导入路径（字段检测里的调试 print）在 GBK 流下不再中断业务逻辑。"""
    from app.core.console_encoding import setup_console_encoding
    from app.services.geo_field_detector import GeoFieldDetector

    setup_console_encoding()

    stream, _ = _gbk_stream()
    monkeypatch.setattr(sys, "stdout", stream)

    df = pd.DataFrame(
        {"经度": [116.4], "纬度": [39.9], "方位角": [30], "小区名称": ["基站A"]}
    )
    detected = GeoFieldDetector().detect_fields(df)  # 内部有一批调试 print

    assert detected.get("longitude") == "经度"
    assert detected.get("latitude") == "纬度"
    assert detected.get("geometry_type") == "sector"
