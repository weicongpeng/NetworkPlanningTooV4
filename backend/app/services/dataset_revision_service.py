"""数据集修订号：桌面端共享模式下判断「服务器数据是否更新过」的唯一依据。

为什么不用文件 mtime / 索引里的 uploadDate：
- 解包会保留原文件 mtime，跨机比较没有意义；
- `Workbook.updated_at` 从未被写入，`bulk_update_cells` 等写入也不更新它；
- 时间戳依赖各端时钟，无法做严格的新旧判定。

因此改为这里维护的单调递增 rev：任何改变数据集内容的写入路径都要 bump，
删除写墓碑（deleted），否则客户端「本地删除」会被当成「本地新建」被再次推上来。

设计约束：所有 API 都不抛异常——bump 是旁路记账，绝不能让业务写入失败。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _now_str() -> str:
    return datetime.now().isoformat()


def _session():
    from app.core.database import SessionLocal

    return SessionLocal()


def _lookup_group(data_id: str) -> tuple:
    """从内存索引取数据集组归属（删除后查不到，由调用方显式传入）。"""
    try:
        from app.services.data_service import data_service

        entry = data_service.index.get(data_id) or {}
        return entry.get("city"), entry.get("operator")
    except Exception:  # noqa: BLE001
        return None, None


def bump(
    data_id: str,
    *,
    updated_by: Optional[str] = None,
    sha256: Optional[str] = None,
    deleted: Optional[bool] = None,
    city: Optional[str] = None,
    operator: Optional[str] = None,
) -> Optional[int]:
    """推进数据集修订号，返回新的 rev（失败返回 None）。

    未传 sha256 时保留原值（调用方通常不知道内容摘要）。
    deleted 显式传 True/False 才覆盖墓碑标记（删除场景传 True，重新导入传 False）。
    city/operator 一般从索引自动取；删除场景索引里已没有条目，需调用方显式传。
    """
    if not data_id:
        return None
    auto_city, auto_operator = _lookup_group(data_id)
    db = _session()
    try:
        from app.models.database import DatasetRevision

        row = db.query(DatasetRevision).filter(DatasetRevision.data_id == data_id).first()
        if row is None:
            row = DatasetRevision(data_id=data_id, rev=0, deleted=False)
            db.add(row)
        row.rev = int(row.rev or 0) + 1
        row.updated_at = _now_str()
        row.updated_by = updated_by
        # 组快照：优先用显式传入值，其次索引实时值，最后保留原有值
        row.city = city if city is not None else (auto_city if auto_city is not None else row.city)
        row.operator = (
            operator if operator is not None
            else (auto_operator if auto_operator is not None else row.operator)
        )
        if sha256 is not None:
            row.sha256 = sha256
        if deleted is not None:
            row.deleted = bool(deleted)
        db.commit()
        return int(row.rev)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning(f"[数据集修订] bump 失败（不影响业务写入）data_id={data_id}: {exc}")
        return None
    finally:
        db.close()


def set_sha(
    data_id: str, sha256: str, *, city: Optional[str] = None, operator: Optional[str] = None
) -> Optional[int]:
    """只写入内容摘要、**不推进**修订号（下载侧调用）。

    下载是读操作：若每次 pull 都 bump，同组其它客户端会误判"服务器有更新"而反复
    整包下载（rev 抖动）。摘要仅用于后续快速比对，rev 只在真正写入时推进。
    """
    if not data_id:
        return None
    auto_city, auto_operator = _lookup_group(data_id)
    db = _session()
    try:
        from app.models.database import DatasetRevision

        row = db.query(DatasetRevision).filter(DatasetRevision.data_id == data_id).first()
        if row is None:
            row = DatasetRevision(data_id=data_id, rev=1, deleted=False, updated_at=_now_str())
            db.add(row)
        row.sha256 = sha256
        row.city = city if city is not None else (auto_city if auto_city is not None else row.city)
        row.operator = (
            operator if operator is not None
            else (auto_operator if auto_operator is not None else row.operator)
        )
        db.commit()
        return int(row.rev or 0)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning(f"[数据集修订] 摘要写入失败（不影响业务）data_id={data_id}: {exc}")
        return None
    finally:
        db.close()


def mark_deleted(
    data_id: str, *, updated_by: Optional[str] = None,
    city: Optional[str] = None, operator: Optional[str] = None,
) -> Optional[int]:
    """删除数据集：写墓碑并推进修订号（city/operator 必须由调用方在删除前捕获）。"""
    return bump(data_id, updated_by=updated_by, deleted=True, sha256="",
                city=city, operator=operator)


def get(data_id: str) -> Optional[dict]:
    db = _session()
    try:
        from app.models.database import DatasetRevision

        row = db.query(DatasetRevision).filter(DatasetRevision.data_id == data_id).first()
        return row.to_dict() if row else None
    finally:
        db.close()


def ensure(entries: Dict[str, Dict[str, Any]]) -> Dict[str, int]:
    """为尚无修订记录的数据集补建初始记录（rev=1），返回 {data_id: rev}。

    服务器上的存量数据此前没有修订记录，桌面端首次拉清单时必须能拿到一个可用的 rev，
    否则无法建立基线，后续每次同步都会误判为「有更新」。
    entries: {data_id: {"city":..., "operator":...}}
    """
    result: Dict[str, int] = {}
    if not entries:
        return result
    db = _session()
    try:
        from app.models.database import DatasetRevision

        existing = {
            r.data_id: r
            for r in db.query(DatasetRevision)
            .filter(DatasetRevision.data_id.in_(list(entries.keys())))
            .all()
        }
        now = _now_str()
        for data_id, group in entries.items():
            row = existing.get(data_id)
            if row is None:
                row = DatasetRevision(
                    data_id=data_id, rev=1, deleted=False, updated_at=now, updated_by="system",
                    city=(group or {}).get("city"), operator=(group or {}).get("operator"),
                )
                db.add(row)
                existing[data_id] = row
            elif row.city is None:
                row.city = (group or {}).get("city")
                row.operator = (group or {}).get("operator")
            result[data_id] = int(row.rev or 0)
        db.commit()
        return result
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning(f"[数据集修订] ensure 失败：{exc}")
        return result
    finally:
        db.close()


def list_group(city: Optional[str], operator: Optional[str]) -> list:
    """列出某组（含跨组时被删除的墓碑）的全部修订记录。"""
    db = _session()
    try:
        from app.models.database import DatasetRevision

        rows = db.query(DatasetRevision).filter(
            DatasetRevision.city == city, DatasetRevision.operator == operator
        ).all()
        return [r.to_dict() for r in rows]
    finally:
        db.close()


def remove(data_id: str) -> None:
    """彻底删除修订记录（数据集被物理清理时调用）。"""
    if not data_id:
        return
    db = _session()
    try:
        from app.models.database import DatasetRevision

        db.query(DatasetRevision).filter(DatasetRevision.data_id == data_id).delete()
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning(f"[数据集修订] 删除记录失败 data_id={data_id}: {exc}")
    finally:
        db.close()
