"""只读执行器

为什么不用 ORM 会话跑分析查询：分析 SQL 是动态拼的聚合查询，需要明确的超时中断与
"绝不写入"保证。这里用独立 sqlite3 连接 + PRAGMA query_only=1 + progress handler 超时。
（WAL 库在只读连接可能无法初始化 -shm，故连接失败时退回普通连接，但仍置 query_only。）
"""
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings

DEFAULT_TIMEOUT_SECONDS = 10.0


class QueryTimeout(RuntimeError):
    """查询超过时间预算被中断"""


def _connect(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.as_posix()}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.Error:
        con = sqlite3.connect(str(path), timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=1")
    return con


def execute(sql: str, params: Optional[Dict[str, Any]] = None,
            timeout: float = DEFAULT_TIMEOUT_SECONDS,
            db_path: Optional[Path] = None) -> Dict[str, Any]:
    """执行只读查询，返回 {rows, columns, row_count, elapsed_ms}。"""
    path = Path(db_path) if db_path else (settings.DATA_DIR / "data.db")
    if not path.exists():
        raise FileNotFoundError(f"数据库不存在：{path}")

    started = time.monotonic()
    deadline = started + max(timeout, 0.5)
    con = _connect(path)

    def _guard() -> int:
        return 1 if time.monotonic() > deadline else 0

    try:
        con.set_progress_handler(_guard, 20000)
        cur = con.execute(sql, params or {})
        raw_rows = cur.fetchall()
        columns: List[str] = [d[0] for d in (cur.description or [])]
    except sqlite3.OperationalError as exc:
        if "interrupt" in str(exc).lower():
            raise QueryTimeout(f"查询超时（>{timeout:.0f}s），请缩小时间范围或减少分组维度")
        raise
    finally:
        con.close()

    rows = [{col: row[col] for col in columns} for row in raw_rows]
    return {
        "rows": rows,
        "columns": columns,
        "row_count": len(rows),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def explain(sql: str, params: Optional[Dict[str, Any]] = None,
            db_path: Optional[Path] = None) -> List[str]:
    """EXPLAIN QUERY PLAN，用于测试断言"没有全表 SCAN"。"""
    path = Path(db_path) if db_path else (settings.DATA_DIR / "data.db")
    con = _connect(path)
    try:
        cur = con.execute("EXPLAIN QUERY PLAN " + sql, params or {})
        return [str(row["detail"]) for row in cur.fetchall()]
    finally:
        con.close()
