"""任务结果明细行索引：把大 JSON 拆成可按页/按条件查询的行。

大结果仍保留在 result_json/sidecar 供导出与旧客户端使用；本服务只服务
结果页分页、搜索和地图按需加载，避免每次查看都解析整份 JSON。
"""
from __future__ import annotations

import json
import logging
import threading
import zlib
from typing import Any, Dict, Iterator, List, Optional, Tuple

from sqlalchemy import and_, func, insert, or_

from app.models.database import TaskResult, TaskResultRow, TaskResultSourceGroup

logger = logging.getLogger(__name__)

INDEXED_TASK_TYPES = ("neighbor", "tac", "tac_planning")
BATCH_SIZE = 5000

SessionLocal = None  # 测试/多形态可注入；为 None 时按调用时刻取当前 core 会话工厂

_scheduled: set[str] = set()
_scheduled_lock = threading.Lock()


def _new_session():
    factory = SessionLocal
    if factory is None:
        from app.core.database import SessionLocal as factory  # noqa: PLC0415
    return factory()


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _split_target(target: Any) -> Tuple[str, str]:
    text = str(target or "")
    if "_" in text:
        site_id, cell_id = text.split("_", 1)
        return site_id, cell_id
    return text, ""


def _iter_neighbor_rows(result: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    for item in result.get("results") or []:
        if not isinstance(item, dict):
            continue
        sectors = item.get("sectors")
        if not isinstance(sectors, list):
            yield item
            continue
        # 兼容旧版嵌套结构（site -> sectors -> neighbors）
        site_id = item.get("siteId")
        for sector in sectors:
            if not isinstance(sector, dict):
                continue
            for neighbor in sector.get("neighbors") or []:
                if not isinstance(neighbor, dict):
                    continue
                target_site, target_cell = _split_target(neighbor.get("targetSector"))
                yield {
                    "relationType": neighbor.get("relationType") or "LTE-LTE",
                    "sourceSiteId": site_id,
                    "sourceCellId": sector.get("sectorId"),
                    "sourceCellName": sector.get("sectorName"),
                    "sourceFrequency": sector.get("frequency") or sector.get("earfcn"),
                    "sourcePci": sector.get("pci"),
                    "targetSiteId": neighbor.get("targetSite") or target_site,
                    "targetCellId": target_cell,
                    "targetCellName": neighbor.get("targetSectorName"),
                    "targetFrequency": neighbor.get("targetFrequency"),
                    "targetPci": neighbor.get("targetPci"),
                    "distance": neighbor.get("distance"),
                    "bearing": neighbor.get("bearing"),
                }


def _iter_tac_rows(result: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    for item in result.get("results") or []:
        if isinstance(item, dict):
            yield item


def iter_result_rows(task_type: str, result: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    if task_type == "neighbor":
        yield from _iter_neighbor_rows(result)
    elif task_type in ("tac", "tac_planning"):
        yield from _iter_tac_rows(result)


def _base_mapping(task_id: str, seq: int, row: Dict[str, Any]) -> Dict[str, Any]:
    payload = json.dumps(row, ensure_ascii=False, default=str).encode("utf-8")
    return {
        "task_id": task_id,
        "seq": seq,
        "record_blob": zlib.compress(payload, 1),
    }


def _neighbor_mapping(task_id: str, seq: int, row: Dict[str, Any]) -> Dict[str, Any]:
    # 邻区行字段都能落到列上，不再重复存 record_blob（省磁盘、省索引 CPU）
    mapping = {
        "task_id": task_id,
        "seq": seq,
        "record_blob": b"",
    }
    mapping.update({
        "relation_type": _text(row.get("relationType")),
        "source_site": _text(row.get("sourceSiteId")),
        "source_cell": _text(row.get("sourceCellId")),
        "source_name": _text(row.get("sourceCellName")),
        "source_pci": _text(row.get("sourcePci")),
        "source_freq": _text(row.get("sourceFrequency")),
        "target_site": _text(row.get("targetSiteId")),
        "target_cell": _text(row.get("targetCellId")),
        "target_name": _text(row.get("targetCellName")),
        "target_pci": _text(row.get("targetPci")),
        "target_freq": _text(row.get("targetFrequency")),
        "distance": _text(row.get("distance")),
    })
    return mapping


def _normalize_tac(value: Any) -> str:
    text = str(value).strip()
    return text.lstrip("0") or "0"


def _tac_mapping(task_id: str, seq: int, row: Dict[str, Any]) -> Dict[str, Any]:
    mapping = _base_mapping(task_id, seq, row)
    tac = _text(row.get("tac"))
    existing_tac = _text(row.get("existingTac"))
    has_tac_pair = bool(tac) and bool(existing_tac) and existing_tac != "-"
    mapping.update({
        "first_group": _text(row.get("firstGroup")),
        "site_id": _text(row.get("siteId")),
        "site_name": _text(row.get("siteName")),
        "sector_id": _text(row.get("sectorId")),
        "sector_name": _text(row.get("sectorName")),
        "network_type": _text(row.get("networkType")),
        "longitude": _text(row.get("longitude")),
        "latitude": _text(row.get("latitude")),
        "tac": tac,
        "existing_tac": existing_tac,
        # 搜索列按界面展示文案存储（是/否、已匹配/未匹配），与用户输入一致
        "tac_consistent": (
            "是" if has_tac_pair and _normalize_tac(tac) == _normalize_tac(existing_tac)
            else "否" if has_tac_pair else "-"
        ),
        "is_singularity": (
            "是" if has_tac_pair and bool(row.get("isSingularity"))
            else "否" if has_tac_pair else "-"
        ),
        "suggested_tac": _text(row.get("suggestedTac")),
        "matched": "已匹配" if row.get("matched") else "未匹配",
    })
    return mapping


def _row_mapping(task_id: str, task_type: str, seq: int, row: Dict[str, Any]) -> Dict[str, Any]:
    if task_type == "neighbor":
        return _neighbor_mapping(task_id, seq, row)
    return _tac_mapping(task_id, seq, row)


def _mark_ready(db, task_id: str, ready: bool) -> None:
    db.query(TaskResult).filter(TaskResult.task_id == task_id).update(
        {TaskResult.rows_ready: 1 if ready else 0}, synchronize_session=False
    )
    db.commit()


def index_task_result(task_id: str, task_type: str, result: Dict[str, Any]) -> int:
    """同步建立明细索引；失败时保持 rows_ready=0，下次访问可重试。"""
    if task_type not in INDEXED_TASK_TYPES or not isinstance(result, dict):
        return 0
    db = _new_session()
    total = 0
    try:
        _mark_ready(db, task_id, False)
        db.query(TaskResultRow).filter(TaskResultRow.task_id == task_id).delete(
            synchronize_session=False
        )
        db.query(TaskResultSourceGroup).filter(
            TaskResultSourceGroup.task_id == task_id
        ).delete(synchronize_session=False)
        db.commit()

        batch: List[Dict[str, Any]] = []
        groups: List[Dict[str, Any]] = []
        current_key: Optional[Tuple[Any, Any]] = None
        current_group: Optional[Dict[str, Any]] = None
        for seq, row in enumerate(iter_result_rows(task_type, result)):
            mapping = _row_mapping(task_id, task_type, seq, row)
            if task_type == "neighbor":
                key = (mapping.get("source_site"), mapping.get("source_cell"))
                if key != current_key:
                    if current_group is not None:
                        groups.append(current_group)
                    current_key = key
                    current_group = {
                        "task_id": task_id,
                        "seq": len(groups),
                        "source_site": mapping.get("source_site"),
                        "source_cell": mapping.get("source_cell"),
                        "source_name": mapping.get("source_name"),
                        "source_pci": mapping.get("source_pci"),
                        "source_freq": mapping.get("source_freq"),
                        "relation_type": mapping.get("relation_type"),
                        "row_count": 0,
                        "first_seq": seq,
                    }
                current_group["row_count"] += 1
            batch.append(mapping)
            if len(batch) >= BATCH_SIZE:
                db.execute(insert(TaskResultRow), batch)
                db.commit()
                total += len(batch)
                batch = []
        if batch:
            db.execute(insert(TaskResultRow), batch)
            db.commit()
            total += len(batch)
        if current_group is not None:
            groups.append(current_group)
        for start in range(0, len(groups), BATCH_SIZE):
            db.execute(insert(TaskResultSourceGroup), groups[start:start + BATCH_SIZE])
            db.commit()
        try:
            _update_result_metadata(task_id, task_type, result)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[TaskResultIndex] 更新任务元数据失败（非致命）: %s", exc)
        _mark_ready(db, task_id, True)
        logger.info("[TaskResultIndex] 任务 %s 明细索引完成：%d 行 / %d 源小区",
                    task_id[:8], total, len(groups))
        return total
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("[TaskResultIndex] 任务 %s 明细索引失败: %s", task_id[:8], exc)
        return 0
    finally:
        db.close()


def _load_result(task_id: str, task_type: str) -> Optional[Dict[str, Any]]:
    from app.services.task_manager import task_manager

    task = task_manager.tasks.get(task_id)
    if task is not None and task.result is not None:
        task_type = getattr(task.task_type, "value", task_type)
    return task_manager.get_task_result(task_id)


def schedule_index(task_id: str, task_type: str, result: Optional[Dict[str, Any]] = None) -> bool:
    """后台建索引；同一任务只跑一份。result 为空时从任务管理器加载。"""
    if task_type not in INDEXED_TASK_TYPES:
        return False
    with _scheduled_lock:
        if task_id in _scheduled:
            return False
        _scheduled.add(task_id)

    def _run() -> None:
        try:
            payload = result if result is not None else _load_result(task_id, task_type)
            if payload is not None:
                index_task_result(task_id, task_type, payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[TaskResultIndex] 后台索引任务 %s 失败: %s", task_id[:8], exc)
        finally:
            with _scheduled_lock:
                _scheduled.discard(task_id)

    threading.Thread(target=_run, daemon=True, name=f"npt-result-index-{task_id[:8]}").start()
    return True


def get_task_meta(task_id: str) -> Optional[Dict[str, Any]]:
    """轻量元数据：摘要 + 明细索引状态（不读 result_json）。"""
    db = _new_session()
    try:
        row = (
            db.query(
                TaskResult.task_id,
                TaskResult.task_type,
                TaskResult.status,
                TaskResult.summary_json,
                TaskResult.cell_count,
                TaskResult.rows_ready,
            )
            .filter(TaskResult.task_id == task_id)
            .first()
        )
        if row is None:
            return None
        summary = None
        if row.summary_json:
            try:
                summary = json.loads(row.summary_json)
            except Exception:  # noqa: BLE001
                summary = None
        if summary is None and (row.cell_count or 0) > 0:
            summary = {"cellCount": int(row.cell_count)}
        row_count = db.query(func.count(TaskResultRow.id)).filter(
            TaskResultRow.task_id == task_id
        ).scalar() or 0
        return {
            "taskId": row.task_id,
            "taskType": row.task_type,
            "status": row.status,
            "summary": summary,
            "rowsReady": bool(row.rows_ready),
            "rowCount": int(row_count),
        }
    finally:
        db.close()


def is_ready(task_id: str) -> bool:
    db = _new_session()
    try:
        ready = (
            db.query(TaskResult.rows_ready)
            .filter(TaskResult.task_id == task_id)
            .scalar()
        )
        return bool(ready)
    finally:
        db.close()


def get_row_state(task_id: str) -> Tuple[bool, int]:
    db = _new_session()
    try:
        ready = (
            db.query(TaskResult.rows_ready)
            .filter(TaskResult.task_id == task_id)
            .scalar()
        )
        count = db.query(func.count(TaskResultRow.id)).filter(
            TaskResultRow.task_id == task_id
        ).scalar() or 0
        return bool(ready), int(count)
    finally:
        db.close()


def ensure_indexed(task_id: str, task_type: str) -> bool:
    """已建好返回 True；未建好则安排后台索引并返回 False。"""
    if task_type not in INDEXED_TASK_TYPES:
        return False
    if is_ready(task_id):
        return True
    schedule_index(task_id, task_type)
    return False


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


_NEIGHBOR_FILTERS = {
    "relationType": TaskResultRow.relation_type,
    "sourceSiteId": TaskResultRow.source_site,
    "sourceCellId": TaskResultRow.source_cell,
    "sourceCellName": TaskResultRow.source_name,
    "sourceFrequency": TaskResultRow.source_freq,
    "sourcePci": TaskResultRow.source_pci,
    "targetSiteId": TaskResultRow.target_site,
    "targetCellId": TaskResultRow.target_cell,
    "targetCellName": TaskResultRow.target_name,
    "targetFrequency": TaskResultRow.target_freq,
    "targetPci": TaskResultRow.target_pci,
    "distance": TaskResultRow.distance,
}

_NEIGHBOR_GROUP_FILTERS = {
    "relationType": TaskResultSourceGroup.relation_type,
    "sourceSiteId": TaskResultSourceGroup.source_site,
    "sourceCellId": TaskResultSourceGroup.source_cell,
    "sourceCellName": TaskResultSourceGroup.source_name,
    "sourceFrequency": TaskResultSourceGroup.source_freq,
    "sourcePci": TaskResultSourceGroup.source_pci,
}

_TAC_FILTERS = {
    "firstGroup": TaskResultRow.first_group,
    "siteId": TaskResultRow.site_id,
    "siteName": TaskResultRow.site_name,
    "sectorId": TaskResultRow.sector_id,
    "sectorName": TaskResultRow.sector_name,
    "networkType": TaskResultRow.network_type,
    "longitude": TaskResultRow.longitude,
    "latitude": TaskResultRow.latitude,
    "tac": TaskResultRow.tac,
    "existingTac": TaskResultRow.existing_tac,
    "tacConsistent": TaskResultRow.tac_consistent,
    "isSingularity": TaskResultRow.is_singularity,
    "suggestedTac": TaskResultRow.suggested_tac,
    "matched": TaskResultRow.matched,
}


def _filter_conditions(task_type: str, filters: Dict[str, str]):
    mapping = _NEIGHBOR_FILTERS if task_type == "neighbor" else _TAC_FILTERS
    conditions = []
    for key, value in (filters or {}).items():
        column = mapping.get(key)
        text = str(value or "").strip()
        if column is None or not text:
            continue
        conditions.append(column.like(_like(text), escape="\\"))
    return conditions


def _decode_record(blob: bytes) -> Dict[str, Any]:
    if not blob:
        return {}
    try:
        return json.loads(zlib.decompress(blob).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _to_number(value: Optional[str]) -> Any:
    if value is None or value == "":
        return None
    try:
        return float(value) if "." in value else int(value)
    except (TypeError, ValueError):
        return value


def _decode_row(task_type: str, row: TaskResultRow) -> Dict[str, Any]:
    if task_type != "neighbor":
        return _decode_record(row.record_blob)
    return {
        "relationType": row.relation_type,
        "sourceSiteId": row.source_site,
        "sourceCellId": row.source_cell,
        "sourceCellName": row.source_name,
        "sourceFrequency": _to_number(row.source_freq),
        "sourcePci": _to_number(row.source_pci),
        "targetSiteId": row.target_site,
        "targetCellId": row.target_cell,
        "targetCellName": row.target_name,
        "targetFrequency": _to_number(row.target_freq),
        "targetPci": _to_number(row.target_pci),
        "distance": _to_number(row.distance),
    }


def query_rows(
    task_id: str,
    task_type: str,
    page: int = 1,
    page_size: int = 200,
    filters: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    safe_page = max(1, int(page))
    safe_size = max(1, min(1000, int(page_size)))
    db = _new_session()
    try:
        query = db.query(TaskResultRow).filter(TaskResultRow.task_id == task_id)
        conditions = _filter_conditions(task_type, filters or {})
        if conditions:
            query = query.filter(*conditions)
        total = query.count()
        rows = (
            query.order_by(TaskResultRow.seq)
            .offset((safe_page - 1) * safe_size)
            .limit(safe_size)
            .all()
        )
        return {
            "rows": [_decode_row(task_type, row) for row in rows],
            "total": int(total),
            "page": safe_page,
            "page_size": safe_size,
        }
    finally:
        db.close()


def query_neighbor_sources(
    task_id: str,
    page: int = 1,
    page_size: int = 50,
    filters: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """按源小区分组分页：页面大小以「源小区数」计，保证表格分组不跨页断裂。"""
    safe_page = max(1, int(page))
    safe_size = max(1, min(500, int(page_size)))
    db = _new_session()
    try:
        active_filters = {
            key: value for key, value in (filters or {}).items()
            if str(value or "").strip()
        }
        source_only = bool(active_filters) and set(active_filters).issubset(
            _NEIGHBOR_GROUP_FILTERS
        )
        if not active_filters or source_only:
            # 默认/仅源小区条件：分组已单独索引，18k 组的分页查询是毫秒级
            group_query = db.query(TaskResultSourceGroup).filter(
                TaskResultSourceGroup.task_id == task_id
            )
            for key, value in active_filters.items():
                group_query = group_query.filter(
                    _NEIGHBOR_GROUP_FILTERS[key].like(_like(str(value).strip()), escape="\\")
                )
            total = group_query.count()
            groups = (
                group_query.order_by(TaskResultSourceGroup.seq)
                .offset((safe_page - 1) * safe_size)
                .limit(safe_size)
                .all()
            )
            if not groups:
                return {"sources": [], "total": int(total), "page": safe_page, "page_size": safe_size}
            # 行在索引时按源小区连续写入：用 seq 区间取数，避免 OR 条件退化为全表扫描
            range_conditions = [
                and_(
                    TaskResultRow.seq >= group.first_seq,
                    TaskResultRow.seq < group.first_seq + group.row_count,
                )
                for group in groups
            ]
            rows = (
                db.query(TaskResultRow)
                .filter(TaskResultRow.task_id == task_id, or_(*range_conditions))
                .order_by(TaskResultRow.seq)
                .all()
            )
            by_source: Dict[Tuple[Optional[str], Optional[str]], List[TaskResultRow]] = {}
            for row in rows:
                by_source.setdefault((row.source_site, row.source_cell), []).append(row)
            sources = []
            for group in groups:
                group_rows = by_source.get((group.source_site, group.source_cell), [])
                sources.append({
                    "sourceSiteId": group.source_site,
                    "sourceCellId": group.source_cell,
                    "sourceCellName": group.source_name,
                    "sourceFrequency": _to_number(group.source_freq),
                    "sourcePci": _to_number(group.source_pci),
                    "relationType": group.relation_type,
                    "targets": [_decode_row("neighbor", row) for row in group_rows],
                })
            return {
                "sources": sources,
                "total": int(total),
                "page": safe_page,
                "page_size": safe_size,
            }

        # 带条件的搜索：先按条件过滤行再分组（数据量受条件约束，通常远小于全量）
        conditions = _filter_conditions("neighbor", filters or {})
        base = db.query(TaskResultRow).filter(TaskResultRow.task_id == task_id)
        if conditions:
            base = base.filter(*conditions)

        grouped = (
            base.with_entities(
                TaskResultRow.source_site,
                TaskResultRow.source_cell,
                func.min(TaskResultRow.seq).label("first_seq"),
                func.count().label("row_count"),
            )
            .group_by(TaskResultRow.source_site, TaskResultRow.source_cell)
            .order_by("first_seq")
        )
        group_sub = grouped.subquery()
        total = db.query(func.count()).select_from(group_sub).scalar() or 0
        groups = (
            grouped.offset((safe_page - 1) * safe_size)
            .limit(safe_size)
            .all()
        )
        if not groups:
            return {"sources": [], "total": int(total), "page": safe_page, "page_size": safe_size}

        pair_conditions = [
            and_(
                TaskResultRow.source_site == group.source_site,
                TaskResultRow.source_cell == group.source_cell,
            )
            for group in groups
        ]
        rows = (
            base.filter(or_(*pair_conditions))
            .order_by(TaskResultRow.seq)
            .all()
        )
        by_source: Dict[Tuple[Optional[str], Optional[str]], List[Dict[str, Any]]] = {}
        for row in rows:
            by_source.setdefault((row.source_site, row.source_cell), []).append(
                _decode_row("neighbor", row)
            )

        sources = []
        for group in groups:
            targets = by_source.get((group.source_site, group.source_cell), [])
            first = targets[0] if targets else {}
            sources.append({
                "sourceSiteId": first.get("sourceSiteId", group.source_site),
                "sourceCellId": first.get("sourceCellId", group.source_cell),
                "sourceCellName": first.get("sourceCellName"),
                "sourceFrequency": first.get("sourceFrequency"),
                "sourcePci": first.get("sourcePci"),
                "relationType": first.get("relationType"),
                "targets": targets,
            })
        return {
            "sources": sources,
            "total": int(total),
            "page": safe_page,
            "page_size": safe_size,
        }
    finally:
        db.close()


def query_neighbor_relations(
    task_id: str, source_site: str, source_cell: str
) -> List[Dict[str, Any]]:
    db = _new_session()
    try:
        rows = (
            db.query(TaskResultRow)
            .filter(
                TaskResultRow.task_id == task_id,
                TaskResultRow.source_site == source_site,
                TaskResultRow.source_cell == source_cell,
            )
            .order_by(TaskResultRow.seq)
            .all()
        )
        return [_decode_row("neighbor", row) for row in rows]
    finally:
        db.close()


def query_map_rows(task_id: str, task_type: str) -> List[Dict[str, Any]]:
    """地图只需要着色/定位字段，裁掉表格用的长文本再下发。"""
    map_fields = (
        "siteId", "sectorId", "tac", "existingTac", "suggestedTac",
        "isSingularity", "singularityDetails", "networkType", "matched",
    )
    db = _new_session()
    try:
        rows = (
            db.query(TaskResultRow.record_blob)
            .filter(TaskResultRow.task_id == task_id)
            .order_by(TaskResultRow.seq)
            .all()
        )
        result = []
        for (blob,) in rows:
            record = _decode_record(blob)
            if task_type == "neighbor":
                result.append(record)
            else:
                result.append({key: record[key] for key in map_fields if key in record})
        return result
    finally:
        db.close()


def delete_task_rows(task_id: str) -> None:
    db = _new_session()
    try:
        db.query(TaskResultRow).filter(TaskResultRow.task_id == task_id).delete(
            synchronize_session=False
        )
        db.query(TaskResultSourceGroup).filter(
            TaskResultSourceGroup.task_id == task_id
        ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _update_result_metadata(task_id: str, task_type: str, result: Dict[str, Any]) -> None:
    from app.services.task_manager import task_manager

    summary, applied_values = task_manager._result_metadata(result, task_type)
    db = _new_session()
    try:
        db.query(TaskResult).filter(TaskResult.task_id == task_id).update({
            TaskResult.summary_json: task_manager._dump_meta_json(summary),
            TaskResult.applied_values_json: task_manager._dump_meta_json(applied_values),
        }, synchronize_session=False)
        db.commit()
    finally:
        db.close()


def backfill_pending(limit: int = 5) -> int:
    """按时间倒序为旧任务补建元数据与明细索引（启动后台任务调用）。

    一次只解析一份结果，避免启动期同时把多份 200MB JSON 读进内存。
    """
    db = _new_session()
    try:
        pending = (
            db.query(TaskResult.task_id, TaskResult.task_type)
            .filter(
                TaskResult.status == "completed",
                TaskResult.result_json.isnot(None),
                or_(
                    TaskResult.summary_json.is_(None),
                    and_(
                        TaskResult.task_type.in_(INDEXED_TASK_TYPES),
                        TaskResult.rows_ready == 0,
                    ),
                ),
            )
            .order_by(TaskResult.created_at.desc())
            .limit(max(1, int(limit)))
            .all()
        )
    finally:
        db.close()

    processed = 0
    for task_id, task_type in pending:
        db = _new_session()
        try:
            raw = db.query(TaskResult.result_json).filter(
                TaskResult.task_id == task_id
            ).scalar()
        finally:
            db.close()
        try:
            result = json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001
            result = None
        if result is None:
            continue
        _update_result_metadata(task_id, task_type, result)
        if task_type in INDEXED_TASK_TYPES:
            index_task_result(task_id, task_type, result)
        processed += 1
    return processed
