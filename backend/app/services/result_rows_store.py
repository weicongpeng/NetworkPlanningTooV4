"""工具类任务结果行的分页落盘（站间距计算 / 批量距离匹配的页内结果列表）。

背景：这两个工具原本只把结果写成 Excel 供下载，页面上看不到内容。页内列表要求
「懒加载 + 内部滚动」，而结果行数可能很大（站间距=站点数、距离匹配=匹配×命中
多对多），因此不能整表塞进计算接口的响应里。

落盘格式（JSONL，与结果 Excel 同目录同 stem）：
    第 1 行：{"columns": [...], "total": N}
    第 N 行：行数组（与 columns 等长）

首行带 total，分页读取时无需扫描全文件即可知道总数；行内容只在命中页时解析。
文件由调用方负责随结果 Excel 一并清理（同目录、同 stem）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Sequence, Tuple

ROWS_SUFFIX = ".rows.jsonl"

# 单页上限：防止前端传超大 limit 把响应撑爆
MAX_PAGE_SIZE = 1000
DEFAULT_PAGE_SIZE = 200


class ResultRowsError(Exception):
    """结果行文件缺失或非法。"""


def rows_path(result_id: str) -> Path:
    """结果行文件路径。

    result_id 只允许是纯文件名（结果 Excel 的 stem）：拒绝路径分隔符与
    相对路径片段，避免越出 OUTPUT_DIR 读到任意文件。
    """
    from app.core.config import settings

    name = (result_id or "").strip()
    if not name or name != Path(name).name or "/" in name or "\\" in name:
        raise ResultRowsError("结果标识非法")

    out_dir = Path(settings.OUTPUT_DIR).resolve()
    path = (out_dir / f"{name}{ROWS_SUFFIX}").resolve()
    if path.parent != out_dir:
        raise ResultRowsError("结果标识非法")
    if not path.is_file():
        raise ResultRowsError("结果已过期，请重新计算")
    return path


def _native(value: Any) -> Any:
    """numpy/pandas 标量 → Python 原生类型。

    否则 json 会走 default=str 把 numpy.float64 写成字符串，前端拿到的距离
    变成字符串而无法排序/比较。
    """
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return item()
        except Exception:  # noqa: BLE001
            return value
    return value


def write_rows(result_id: str, columns: Sequence[str], rows: Sequence[Sequence[Any]]) -> Path:
    """写入结果行文件（覆盖同名）。"""
    from app.core.config import settings

    out_dir = Path(settings.OUTPUT_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{result_id}{ROWS_SUFFIX}"

    with path.open("w", encoding="utf-8") as f:
        f.write(json.dumps(
            {"columns": list(columns), "total": len(rows)}, ensure_ascii=False
        ) + "\n")
        for row in rows:
            # default=str 兜底：极端情况下仍有不可序列化对象（如 Timestamp）
            f.write(json.dumps(
                [_native(v) for v in row], ensure_ascii=False, default=str
            ) + "\n")
    return path


def read_page(result_id: str, offset: int = 0, limit: int = DEFAULT_PAGE_SIZE) -> Tuple[List[str], int, List[List[Any]]]:
    """读取一页结果行，返回 (columns, total, rows)。

    offset 越界返回空页；limit 上限 MAX_PAGE_SIZE。
    """
    path = rows_path(result_id)
    offset = max(0, int(offset or 0))
    limit = min(MAX_PAGE_SIZE, max(1, int(limit or DEFAULT_PAGE_SIZE)))

    with path.open("r", encoding="utf-8") as f:
        head = json.loads(f.readline() or "{}")
        columns = head.get("columns") or []
        total = int(head.get("total") or 0)

        # 跳过前 offset 行：只做 readline，不解析
        for _ in range(offset):
            if not f.readline():
                return columns, total, []

        rows: List[List[Any]] = []
        for _ in range(limit):
            line = f.readline()
            if not line:
                break
            rows.append(json.loads(line))

    return columns, total, rows
