"""控制台编码加固：让 print 与日志在 GBK(cp936) 控制台/重定向流下不再抛
`UnicodeEncodeError`。

背景（2026-10-12 桌面端「地理化数据上传失败」）：地理化数据解析里有带 emoji 的
调试 print（如 `[GeoDataService] 🔴🔴🔴 文件名: ...`）。网页端/服务端由 `main.py`
在最早处做了编码加固，而桌面端（`desktop/launcher.py` 直接 `create_app()`）**没有走
`main.py`**：Windows 下 print 到 cp936 控制台（或重定向文件，默认 ANSI 代码页）时抛
`'gbk' codec can't encode character '\U0001f534' in position 17`，异常顺着业务代码
冒到接口层，整个导入被报成"上传失败"，错误信息极易被误判成源文件内容问题。

加固三件事（幂等，可在任何 print/日志之前调用）：
1. `PYTHONIOENCODING`/`PYTHONUTF8`（setdefault，主要影响子进程）
2. 替换 `builtins.print`：编码失败时降级为 GBK 安全串，管道断开时静默 ——
   业务代码里的 print 不再可能中断业务逻辑
3. Windows 下让 stdout/stderr 宽松：`errors="replace"`。
   `force_utf8=True`（网页端/服务端）沿用既有行为强制 utf-8；
   `force_utf8=False`（桌面端）保留流原生编码（cp936 控制台里中文照常可读），
   只把无法编码的字符（emoji 等）退化成 `?`
"""
from __future__ import annotations

import builtins
import os
import sys

_PATCHED = False


def setup_console_encoding(force_utf8: bool = True) -> None:
    """给 print 与 stdout/stderr 兜底（可重复调用）。"""
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUTF8", "1")
    _patch_print()
    _make_streams_lenient(force_utf8)


def _patch_print() -> None:
    global _PATCHED
    if _PATCHED:
        return
    _PATCHED = True
    original_print = builtins.print

    def _safe_print(*args, **kwargs):
        try:
            original_print(*args, **kwargs)
        except UnicodeEncodeError:
            # 目标流编码不下（GBK 控制台打印 emoji 等）：降级为可编码的字符串。
            # 非 str 参数也一并 str() 后兜底，否则重试仍会失败。
            safe_args = []
            for arg in args:
                text = arg if isinstance(arg, str) else str(arg)
                safe_args.append(text.encode("gbk", errors="replace").decode("gbk"))
            original_print(*safe_args, **kwargs)
        except OSError:
            # stdout/stderr 已关闭或管道断开（nohup/容器/无控制台环境）时静默忽略
            pass

    builtins.print = _safe_print


def _make_streams_lenient(force_utf8: bool) -> None:
    """Windows 下把真实文本流放宽（只动 `io.TextIOWrapper`，绝不替换流对象）。

    只做 in-place `reconfigure`：不认识的流（如 pytest 的捕获对象）直接跳过，
    以免替换掉别人手里的流导致输出捕获/重定向失效。
    """
    import io

    if sys.platform != "win32":
        return
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if not isinstance(stream, io.TextIOWrapper):  # 窗口模式（console=False）下为 None
            continue
        try:
            if force_utf8:
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(errors="replace")
        except Exception:  # noqa: BLE001
            pass
