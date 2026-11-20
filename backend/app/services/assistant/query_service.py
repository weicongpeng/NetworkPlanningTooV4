"""网优助手查询工具（只读）

所有数值都由这里用 SQL 计算后返回，LLM 只负责组织语言，不产出数字。

- data_overview:   已导入数据集概览 + 数据目录（字段/口径/时间覆盖）
- catalog:         数据目录（模型据此生成查询计划）
- search_cells:    小区检索（exact > prefix > contains 分层，按组隔离）
- get_cell_params: 某小区无线参数（键值）
- get_cell_workparams: 某小区全量工参（坐标/PCI/TAC/频点/方位角）
- analyze:         QueryPlan 驱动的聚合分析（跨表、TopN、趋势、对比）→ 行 + 图 + 取数配方
- find_nearby_sites: 周边小区（bbox 预过滤 + haversine）
"""
import json
import math
from typing import Any, Dict, List, Optional, Tuple

from app.core.database import SessionLocal
from app.models.database import (
    Sector, Site, StationMetricRow, StationParamRow, Workbook,
)
from app.services.data_group import group_sql_filter

from . import catalog, chart_spec, compiler, executor, provenance
from .ingest_service import list_datasets
from .query_plan import PlanError, validate_plan

_MAX_ROWS = 200
_MAX_ROWS_FOR_MODEL = 30


# ---------------------------------------------------------------- 数据概览/目录

def data_overview(user=None) -> Dict[str, Any]:
    """汇总模型可读的全部数据：数据集 + 全量工参 + 数据目录。"""
    with SessionLocal() as db:
        q = db.query(Workbook).filter(Workbook.file_type == "full_params")
        f = group_sql_filter(Workbook.city, Workbook.operator, user)
        if f is not None:
            q = q.filter(f)
        full_wbs = q.all()
        full_params = [{
            "name": w.name, "id": w.id,
            "network_types": w.network_types,
            "site_count": db.query(Site).filter(Site.workbook_id == w.id).count(),
            "sector_count": db.query(Sector).filter(Sector.workbook_id == w.id).count(),
        } for w in full_wbs]
    cat = catalog.build_catalog(user)
    return {
        "assistant_datasets": list_datasets(user),
        "full_params": full_params,
        "catalog_summary": catalog.render_prompt(cat),
        "hint": ("全量工参与数据集均按（地市+运营商）组隔离；指标聚合/趋势/排名/TopN/跨表对比"
                 "统一用 analyze（传 QueryPlan），不要再按小区逐个猜列名。"),
    }


def get_catalog(user=None) -> Dict[str, Any]:
    cat = catalog.build_catalog(user)
    return {**cat, "rendered": catalog.render_prompt(cat)}


# ---------------------------------------------------------------- 小区检索

def _cell_candidates(db, keyword: str, user=None, limit: int = 10) -> List[str]:
    names: List[str] = []
    for model in (Sector, StationParamRow, StationMetricRow):
        col = model.name if model is Sector else model.cell_name
        q = db.query(col).filter(col.like(f"%{keyword}%"))
        f = group_sql_filter(model.city, model.operator, user)
        if f is not None:
            q = q.filter(f)
        for (name,) in q.distinct().limit(limit).all():
            if name and name not in names:
                names.append(str(name))
    return names


def _rank_names(candidates: List[str], keyword: str) -> List[str]:
    """分层：完全相等 > 前缀 > 包含。避免 "AAU3" 命中一堆远房小区时随机取第一个。"""
    key = keyword.strip().lower()

    def score(name: str) -> Tuple[int, int, str]:
        low = name.lower()
        if low == key:
            return (0, len(name), name)
        if low.startswith(key):
            return (1, len(name), name)
        return (2, len(name), name)

    return sorted(set(candidates), key=score)


def _resolve_cell_name(db, name: str, user=None) -> Tuple[Optional[str], List[str]]:
    """把用户给的小区名解析成唯一名字；解析不唯一返回 (None, 候选)。"""
    key = (name or "").strip()
    if not key:
        return (None, [])
    candidates = _cell_candidates(db, key, user)
    ranked = _rank_names(candidates, key)
    if not ranked:
        return (None, [])
    if ranked[0].lower() == key.lower():
        return (ranked[0], [])
    prefix_hits = [c for c in ranked if c.lower().startswith(key.lower())]
    if len(prefix_hits) == 1:
        return (prefix_hits[0], [])
    contains_hits = [c for c in ranked if key.lower() in c.lower()]
    if len(contains_hits) == 1:
        return (contains_hits[0], [])
    return (None, (prefix_hits or contains_hits or ranked)[:10])


def search_cells(keyword: str, user=None, network_type: str = "",
                 limit: int = 30) -> Dict[str, Any]:
    """按名称片段检索小区，返回候选（按精确度排序）。"""
    if not keyword:
        return {"cells": [], "count": 0}
    with SessionLocal() as db:
        names = _rank_names(_cell_candidates(db, keyword, user, limit=limit * 3), keyword)
    if network_type:
        with SessionLocal() as db:
            q = db.query(Sector.name).filter(
                Sector.name.in_(names[:200]),
                Sector.network_type == network_type.upper())
            f = group_sql_filter(Sector.city, Sector.operator, user)
            if f is not None:
                q = q.filter(f)
            kept = {r[0] for r in q.all()}
        names = [n for n in names if n in kept]
    return {"keyword": keyword, "cells": names[:limit], "count": len(names[:limit])}


def get_cell_params(cell_name: str, user=None) -> Dict[str, Any]:
    """取某小区最新一份基站参数文件中的全部无线参数（键值对）。"""
    with SessionLocal() as db:
        if db.query(StationParamRow.id).first() is None:
            return {"cell_name": cell_name, "found": False,
                    "message": "尚未导入任何基站参数数据"}
        resolved, candidates = _resolve_cell_name(db, cell_name, user)
        if not resolved:
            return {"cell_name": cell_name, "found": False, "candidates": candidates,
                    "message": (f"未唯一确定「{cell_name}」，请用候选中的精确名称重问"
                                if candidates else f"未找到名称含「{cell_name}」的参数记录")}
        q = db.query(StationParamRow).filter(StationParamRow.cell_name == resolved)
        f = group_sql_filter(StationParamRow.city, StationParamRow.operator, user)
        if f is not None:
            q = q.filter(f)
        row = q.order_by(StationParamRow.created_at.desc()).first()
        if not row:
            return {"cell_name": resolved, "found": False,
                    "message": f"「{resolved}」在参数数据集中不存在"}
        params = json.loads(row.params_json or "{}")
        wb = db.query(Workbook).filter_by(id=row.workbook_id).first()
        return {
            "cell_name": row.cell_name, "found": True,
            "network_type": row.network_type,
            "source_file": wb.name if wb else None,
            "params": params, "param_count": len(params),
        }


def get_cell_workparams(cell_name: str, user=None) -> Dict[str, Any]:
    """从全量工参取小区规划数据：经纬度/方位角/PCI/TAC/频点/制式。"""
    with SessionLocal() as db:
        resolved, candidates = _resolve_cell_name(db, cell_name, user)
        if not resolved:
            return {"cell_name": cell_name, "found": False, "candidates": candidates,
                    "message": (f"未唯一确定「{cell_name}」，请用候选中的精确名称重问"
                                if candidates else f"全量工参中未找到「{cell_name}」")}
        q = db.query(Sector).filter(Sector.name == resolved)
        f = group_sql_filter(Sector.city, Sector.operator, user)
        if f is not None:
            q = q.filter(f)
        sec = q.first()
        if not sec:
            return {"cell_name": resolved, "found": False,
                    "message": f"「{resolved}」在全量工参中不存在"}
        site = db.query(Site).filter_by(id=sec.site_id_fk).first() if sec.site_id_fk else None
        return {
            "cell_name": sec.name, "found": True,
            # 制式在 sites 表上，sectors 无该列
            "network_type": site.network_type if site else None,
            "longitude": sec.longitude, "latitude": sec.latitude,
            "azimuth": sec.azimuth, "height": sec.height,
            "pci": sec.pci, "tac": sec.tac, "frequency": sec.frequency,
            "site_id": site.site_id if site else None,
            "site_name": site.name if site else None,
        }


# ---------------------------------------------------------------- 分析

def analyze(plan_dict: Dict[str, Any], user=None) -> Dict[str, Any]:
    """按 QueryPlan 做聚合分析，返回可核对的数字 + 图表 + 取数配方。"""
    try:
        plan = validate_plan(plan_dict)
        available = catalog.available_metric_ids(user)
        compiled = compiler.compile_plan(plan, user, available)
        result = executor.execute(compiled.sql, compiled.params)
    except PlanError as exc:
        return {"ok": False, "error": str(exc),
                "hint": "字段/图型/聚合方式须按数据目录（catalog）给出的名称填写"}
    except executor.QueryTimeout as exc:
        return {"ok": False, "error": str(exc),
                "hint": "请缩小时间范围、减少分组维度或提高 limit"}
    except FileNotFoundError as exc:
        return {"ok": False, "error": str(exc)}

    prov = provenance.build(plan, compiled, row_count=result["row_count"],
                            elapsed_ms=result["elapsed_ms"])
    note = "；".join(compiled.degraded)

    dim_labels = _unique_labels([d["label"] for d in compiled.dimension_meta])
    metric_labels = _unique_labels([m["metric"] for m in compiled.metric_meta],
                                   reserved=dim_labels)
    rows = _rename_rows(result["rows"], dim_labels, metric_labels)
    units = [m.get("unit", "") for m in compiled.metric_meta]
    is_time_dim = any(d.get("field") == "metric_time" for d in compiled.dimension_meta)
    charts = chart_spec.build_charts(rows, dim_labels, metric_labels, units,
                                     is_time_dim=is_time_dim,
                                     requested=plan.chart, note=note)
    truncated = len(rows) > _MAX_ROWS_FOR_MODEL
    columns = dim_labels + metric_labels

    # 空结果 ≠ 0：必须区分"没有数据"与"指标值就是 0"，否则模型会把空结果说成 0
    if not rows:
        return {"ok": True, "row_count": 0, "columns": columns, "rows": [],
                "truncated": False, "recipe": provenance.describe(prov),
                "note": "未匹配到任何数据（不是 0 值），请确认指标名、过滤条件与时间范围",
                "artifacts": {"charts": [], "table": {"columns": columns, "rows": []},
                              "provenance": prov}}
    if metric_labels and all(all(row.get(m) is None for m in metric_labels) for row in rows):
        return {"ok": False, "error": "没有匹配到任何指标数据",
                "hint": "指标名可能不在口径注册表里，先用 catalog 查看真实指标列名与时间范围"}

    return {
        "ok": True,
        "row_count": result["row_count"],
        "elapsed_ms": result["elapsed_ms"],
        "columns": columns,
        "rows": rows[:_MAX_ROWS_FOR_MODEL],
        "truncated": truncated,
        "recipe": provenance.describe(prov),
        "note": note or None,
        "artifacts": {
            "charts": charts,
            "table": {"columns": columns, "rows": rows[:_MAX_ROWS]},
            "provenance": prov,
        },
    }


def _unique_labels(labels: List[str], reserved: Optional[List[str]] = None) -> List[str]:
    """同一查询里出现重复展示名时加序号，保证结果行可按名取值。"""
    seen = list(reserved or [])
    out: List[str] = []
    for label in labels:
        name = label
        i = 2
        while name in seen:
            name = f"{label} ({i})"
            i += 1
        seen.append(name)
        out.append(name)
    return out


def _rename_rows(rows: List[Dict[str, Any]], dim_labels: List[str],
                 metric_labels: List[str]) -> List[Dict[str, Any]]:
    """把 SQL 别名 d0../m0.. 换成可读列名（模型与前端都按展示名取值）。"""
    keys = [f"d{i}" for i in range(len(dim_labels))]
    keys += [f"m{j}" for j in range(len(metric_labels))]
    labels = list(dim_labels) + list(metric_labels)
    return [{label: row.get(key) for label, key in zip(labels, keys)} for row in rows]


# ---------------------------------------------------------------- 周边

def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def find_nearby_sites(site_name: str, radius_km: float = 1.0,
                      network_type: str = "", user=None) -> Dict[str, Any]:
    """以某小区为中心的周边小区清单（bbox 预过滤 + haversine 精算）。"""
    with SessionLocal() as db:
        resolved, candidates = _resolve_cell_name(db, site_name, user)
        if not resolved:
            return {"site_name": site_name, "found": False, "candidates": candidates,
                    "message": (f"未唯一确定「{site_name}」，请用候选中的精确名称重问"
                                if candidates else f"全量工参中未找到「{site_name}」的坐标")}
        cq = db.query(Sector).filter(Sector.name == resolved,
                                     Sector.longitude.isnot(None),
                                     Sector.latitude.isnot(None))
        cf = group_sql_filter(Sector.city, Sector.operator, user)
        if cf is not None:
            cq = cq.filter(cf)
        center = cq.first()
        if not center:
            return {"site_name": resolved, "found": False,
                    "message": f"「{resolved}」没有经纬度，无法做距离查询"}

        lat_delta = radius_km / 111.32
        lon_delta = radius_km / max(111.32 * math.cos(math.radians(center.latitude)), 1e-6)
        # 制式在 sites 表上（sectors 无该列），关联站点取 network_type
        tq = (db.query(Sector, Site.network_type)
              .outerjoin(Site, Site.id == Sector.site_id_fk)
              .filter(
                  Sector.longitude.isnot(None), Sector.latitude.isnot(None),
                  Sector.latitude.between(center.latitude - lat_delta,
                                          center.latitude + lat_delta),
                  Sector.longitude.between(center.longitude - lon_delta,
                                           center.longitude + lon_delta),
              ))
        tf = group_sql_filter(Sector.city, Sector.operator, user)
        if tf is not None:
            tq = tq.filter(tf)
        net = (network_type or "").upper()
        if net:
            tq = tq.filter(Site.network_type == net)
        targets = tq.all()

    out = []
    for t, cell_net in targets:
        dist = _haversine_km(center.longitude, center.latitude, t.longitude, t.latitude)
        if dist <= radius_km:
            out.append({
                "cell_name": t.name, "network_type": cell_net,
                "longitude": t.longitude, "latitude": t.latitude,
                "distance_km": round(dist, 3),
            })
    out.sort(key=lambda x: x["distance_km"])
    return {
        "site_name": center.name, "found": True,
        "center": [center.longitude, center.latitude],
        "radius_km": radius_km, "network_filter": network_type or "全部",
        "count": len(out),
        "chart": {
            "type": "scatter",
            "title": f"{center.name} 周边 {radius_km}km {network_type or ''}小区分布",
            "points": [{"name": o["cell_name"], "net": o["network_type"],
                        "value": [o["longitude"], o["latitude"]],
                        "distance_km": o["distance_km"]} for o in out],
            "center": [center.longitude, center.latitude],
        },
        "sites": out[:_MAX_ROWS],
    }
