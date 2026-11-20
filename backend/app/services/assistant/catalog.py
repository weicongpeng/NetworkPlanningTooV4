"""数据目录（catalog）

"智能搜索"的召回层：把**真实存在**的指标、字段、时间覆盖、粒度一次性告诉模型，
让它按目录选字段，而不是猜列名。目录同样受数据组隔离约束——组外数据不出现。

catalog 里同时给出 QueryPlan 的字段白名单，模型据此生成计划，编译器再按同一份白名单校验。
"""
import json
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import func

from app.core.database import SessionLocal
from app.models.database import (
    Sector, Site, StationMetricRow, StationParamRow, Workbook,
)
from app.services.data_group import group_sql_filter

from .ingest_service import METRIC_TYPE, PARAM_TYPE
from .semantic import field_catalog, metric_registry

_MAX_METRIC_NAMES = 60
_MAX_PARAM_KEYS = 40


def _group(model, user):
    return group_sql_filter(model.city, model.operator, user)


def available_metric_ids(user=None) -> Set[str]:
    """数据里真实存在的 metric_id 集合（用于比率分子分母可用性判断）。"""
    with SessionLocal() as db:
        q = db.query(StationMetricRow.metric_id).filter(
            StationMetricRow.metric_id.isnot(None)).distinct()
        f = _group(StationMetricRow, user)
        if f is not None:
            q = q.filter(f)
        return {row[0] for row in q.all() if row[0]}


def _metric_scope(user) -> Dict[str, Any]:
    with SessionLocal() as db:
        q = db.query(
            func.count(StationMetricRow.id),
            func.min(StationMetricRow.metric_time),
            func.max(StationMetricRow.metric_time),
            func.count(func.distinct(StationMetricRow.cell_name)),
        )
        f = _group(StationMetricRow, user)
        if f is not None:
            q = q.filter(f)
        total, tmin, tmax, cells = q.one()

        gq = db.query(StationMetricRow.granularity).distinct()
        if f is not None:
            gq = gq.filter(f)
        granularities = sorted({r[0] for r in gq.all() if r[0]})

        # 过滤必须在 limit 之前（SQLAlchemy 不允许对已加 LIMIT 的 Query 再 filter）
        nq = db.query(StationMetricRow.metric_name)
        if f is not None:
            nq = nq.filter(f)
        names = sorted(r[0] for r in nq.distinct().limit(_MAX_METRIC_NAMES).all() if r[0])

    return {
        "row_count": int(total or 0),
        "cell_count": int(cells or 0),
        "time_range": [str(tmin) if tmin else None, str(tmax) if tmax else None],
        "granularities": granularities,
        "column_names": names,
    }


def _sector_scope(user) -> Dict[str, Any]:
    with SessionLocal() as db:
        f = _group(Sector, user)
        q = db.query(func.count(Sector.id))
        if f is not None:
            q = q.filter(f)
        total = q.scalar() or 0

        # 制式在 sites 表上（sectors 无该列）
        sf = group_sql_filter(Site.city, Site.operator, user)
        nq = db.query(Site.network_type)
        if sf is not None:
            nq = nq.filter(sf)
        nets = sorted({r[0] for r in nq.distinct().all() if r[0]})

        freq_q = db.query(func.min(Sector.frequency), func.max(Sector.frequency))
        tac_q = db.query(func.count(func.distinct(Sector.tac)))
        if f is not None:
            freq_q = freq_q.filter(f)
            tac_q = tac_q.filter(f)
        fmin, fmax = freq_q.one()
        tac_count = tac_q.scalar() or 0

    return {
        "cell_count": int(total),
        "network_types": nets,
        "frequency_range": [fmin, fmax],
        "tac_count": int(tac_count),
    }


def _param_scope(user) -> Dict[str, Any]:
    """参数数据集：从 Workbook.metadata_json 的列画像里取动态参数键。"""
    with SessionLocal() as db:
        q = db.query(Workbook).filter(Workbook.file_type == PARAM_TYPE)
        f = _group(Workbook, user)
        if f is not None:
            q = q.filter(f)
        workbooks = q.all()
        row_q = db.query(func.count(StationParamRow.id))
        rf = _group(StationParamRow, user)
        if rf is not None:
            row_q = row_q.filter(rf)
        total = row_q.scalar() or 0

    keys: List[str] = []
    for wb in workbooks:
        try:
            meta = json.loads(wb.metadata_json or "{}")
        except Exception:
            continue
        for col, spec in (meta.get("columns") or {}).items():
            if col.startswith("_") or not isinstance(spec, dict):
                continue
            if spec.get("role") == "metric" and col not in keys:
                keys.append(col)
    return {"row_count": int(total), "dataset_count": len(workbooks),
            "param_keys": keys[:_MAX_PARAM_KEYS]}


def build_catalog(user=None) -> Dict[str, Any]:
    metrics = _metric_scope(user)
    ids = available_metric_ids(user)
    metrics["resolved_metric_ids"] = sorted(ids)
    metrics["definitions"] = [d for d in metric_registry.describe()
                              if not ids or d["metric_id"] in ids or d["aggregation"] == "ratio"]
    return {
        "metrics": metrics,
        "sectors": _sector_scope(user),
        "params": _param_scope(user),
        "fields": {ds: field_catalog.fields_of(ds) for ds in field_catalog.DATASETS},
    }


def render_prompt(cat: Dict[str, Any]) -> str:
    """把目录压成提示词片段（控长度：字段 30 个、指标列名 40 个）。"""
    lines: List[str] = []
    sec = cat.get("sectors") or {}
    lines.append(
        f"【全量工参】扇区 {sec.get('cell_count', 0)} 行，制式 {sec.get('network_types') or '无'}，"
        f"TAC 数 {sec.get('tac_count', 0)}，频点范围 {sec.get('frequency_range')}")

    met = cat.get("metrics") or {}
    tr = met.get("time_range") or [None, None]
    lines.append(
        f"【性能指标】{met.get('row_count', 0)} 行，{met.get('cell_count', 0)} 个小区，"
        f"时间 {tr[0] or '无'} ~ {tr[1] or '无'}，粒度 {met.get('granularities') or '无'}")

    defs = met.get("definitions") or []
    if defs:
        lines.append("【已定义口径】" + "；".join(
            f"{d['name']}({d['metric_id']},{d['aggregation']})" for d in defs[:20]))
    names = met.get("column_names") or []
    if names:
        lines.append("【指标列名】" + "、".join(names[:40]))

    par = cat.get("params") or {}
    if par.get("row_count"):
        lines.append(f"【无线参数】{par.get('row_count')} 行，"
                     f"参数项 {par.get('param_keys') or '无'}")

    fields = cat.get("fields") or {}
    for ds in ("metrics", "sectors"):
        names = [f["name"] for f in fields.get(ds) or []]
        if names:
            lines.append(f"【{ds} 可用字段】" + "、".join(names[:30]))
    return "\n".join(lines)
