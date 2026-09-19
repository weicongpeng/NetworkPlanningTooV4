"""网优助手查询工具（只读）

所有数值均由这里用 SQL/pandas 计算后返回，LLM 只负责组织语言，不产出数字。
- data_overview: 已导入的参数/指标数据集概览（含字段清单）
- search_cells:   模糊搜索小区（工参 + 参数表 + 指标表名称并集）
- get_cell_params:取某小区的基站无线参数（键值表）
- query_metrics:  取某小区指标时序，聚合后给文字 + 图表 spec
- find_nearby_sites:取某站点周边 R km 内指定制式小区（复用全量工参坐标）
"""
import json
import math
from typing import Any, Dict, List, Optional

from sqlalchemy import func

from app.core.database import SessionLocal
from app.models.database import (
    StationParamRow, StationMetricRow, Sector, Site, Workbook, GeoFile,
)
from app.services.data_group import group_sql_filter
from .ingest_service import PARAM_TYPE, METRIC_TYPE, list_datasets

_MAX_ROWS = 200


def data_overview(user=None) -> Dict[str, Any]:
    """汇总模型可读的全部数据：基站参数/指标 + 全量工参 + 地理化数据/图层。"""
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
        geo_q = db.query(GeoFile)
        geo_f = group_sql_filter(GeoFile.city, GeoFile.operator, user)
        if geo_f is not None:
            geo_q = geo_q.filter(geo_f)
        geo_count = geo_q.count()
    return {
        "assistant_datasets": list_datasets(user),
        "full_params": full_params,
        "geo_layer_files": geo_count,
        "hint": ("全量工参与数据集均按（地市+运营商）组隔离展示；"
                "全量工参含小区经纬度/方位角/PCI/TAC/频点等规划数据，用 get_cell_workparams 查；"
                "基站无线参数(功率/门限/切换)用 get_cell_params；指标趋势用 query_metrics；"
                "周边站点距离用 find_nearby_sites。"),
    }


def _fuzzy_cell_names(db, keyword: str, user=None) -> List[str]:
    """在参数表/指标表中模糊匹配小区名（去重，按（地市+运营商）组隔离）"""
    names = set()
    for model in (StationParamRow, StationMetricRow):
        col = model.cell_name
        q = db.query(col).filter(col.like(f"%{keyword}%"))
        f = group_sql_filter(model.city, model.operator, user)
        if f is not None:
            q = q.filter(f)
        rows = q.distinct().limit(50).all()
        names.update(r[0] for r in rows)
    # 全量工参
    q = db.query(Sector.name).filter(Sector.name.like(f"%{keyword}%"))
    f = group_sql_filter(Sector.city, Sector.operator, user)
    if f is not None:
        q = q.filter(f)
    rows = q.distinct().limit(50).all()
    names.update(r[0] for r in rows if r[0])
    return sorted(n for n in names if n)


def search_cells(keyword: str, user=None) -> Dict[str, Any]:
    """按名称片段模糊搜索小区，返回候选小区名列表。"""
    if not keyword:
        return {"cells": []}
    with SessionLocal() as db:
        names = _fuzzy_cell_names(db, keyword, user)
    return {"keyword": keyword, "cells": names[:_MAX_ROWS], "count": len(names[:_MAX_ROWS])}


def get_cell_params(cell_name: str, user=None) -> Dict[str, Any]:
    """取某小区最新一份基站参数文件中的全部无线参数（键值对）。"""
    with SessionLocal() as db:
        if db.query(StationParamRow.id).first() is None:
            return {"cell_name": cell_name, "found": False,
                    "message": "尚未导入任何基站参数数据"}
        q = (db.query(StationParamRow)
             .filter(StationParamRow.cell_name.like(f"%{cell_name}%")))
        f = group_sql_filter(StationParamRow.city, StationParamRow.operator, user)
        if f is not None:
            q = q.filter(f)
        row = (q.order_by(StationParamRow.created_at.desc())
               .first())
        if not row:
            candidates = _fuzzy_cell_names(db, cell_name, user)[:10]
            return {"cell_name": cell_name, "found": False,
                    "candidates": candidates,
                    "message": f"未找到名称含「{cell_name}」的基站参数记录"}
        params = json.loads(row.params_json or "{}")
        wb = db.query(Workbook).filter_by(id=row.workbook_id).first()
        return {
            "cell_name": row.cell_name, "found": True,
            "network_type": row.network_type,
            "source_file": wb.name if wb else None,
            "params": params, "param_count": len(params),
        }


def _resolve_metric_cols(db, cell_name: str, metric_keyword: str) -> List[str]:
    """在该小区出现过的指标名中，按关键词模糊匹配实际列名。"""
    names = (db.query(StationMetricRow.metric_name)
             .filter(StationMetricRow.cell_name.like(f"%{cell_name}%"))
             .distinct().all())
    all_names = [r[0] for r in names]
    if not metric_keyword:
        return all_names
    kw = metric_keyword.lower()
    hit = [n for n in all_names if kw in n.lower()]
    return hit or all_names


def query_metrics(cell_name: str, metric: str, start_date: str = "",
                  end_date: str = "", granularity: str = "", user=None) -> Dict[str, Any]:
    """查询某小区指标时序。按天聚合（小时/忙时数据自动按天求均值）。

    Returns: 文字用 rows + 图表用 chart。metric 用关键词模糊匹配列名。
    """
    with SessionLocal() as db:
        exact_q = (db.query(StationMetricRow.cell_name)
                 .filter(StationMetricRow.cell_name.like(f"%{cell_name}%")))
        exact_f = group_sql_filter(StationMetricRow.city, StationMetricRow.operator, user)
        if exact_f is not None:
            exact_q = exact_q.filter(exact_f)
        exact = exact_q.first()
        if not exact:
            return {"cell_name": cell_name, "found": False,
                    "candidates": _fuzzy_cell_names(db, cell_name, user)[:10],
                    "message": f"未找到名称含「{cell_name}」的指标数据"}
        resolved_cell = exact[0]
        cols = _resolve_metric_cols(db, resolved_cell, metric)
        if not cols:
            return {"cell_name": resolved_cell, "found": True, "metrics": [],
                    "message": f"该小区没有与「{metric}」匹配的指标列"}

        q = (db.query(StationMetricRow.metric_name,
                      func.date(StationMetricRow.metric_time).label("d"),
                      func.avg(StationMetricRow.metric_value))
             .filter(StationMetricRow.cell_name == resolved_cell,
                     StationMetricRow.metric_name.in_(cols)))
        if start_date:
            q = q.filter(StationMetricRow.metric_time >= f"{start_date} 00:00:00")
        if end_date:
            q = q.filter(StationMetricRow.metric_time <= f"{end_date} 23:59:59")
        if granularity:
            q = q.filter(StationMetricRow.granularity == granularity)
        records = (q.group_by(StationMetricRow.metric_name, "d")
                   .order_by("d").all())

    # 透视为 {日期: {指标: 值}}
    dates, series = [], {c: {} for c in cols}
    for name, d, val in records:
        if d not in dates:
            dates.append(d)
        series[name][d] = round(float(val), 4) if val is not None else None

    chart = {
        "type": "line",
        "title": f"{resolved_cell} · {metric or '指标'}趋势",
        "xAxis": [{"label": "日期", "categories": dates}],
        "yAxis": [{"label": metric or "值"}],
        "series": [{"name": c, "data": [series[c].get(d) for d in dates]} for c in cols],
    }
    return {
        "cell_name": resolved_cell, "found": True,
        "matched_metrics": cols, "date_count": len(dates),
        "date_range": [dates[0] if dates else None, dates[-1] if dates else None],
        "rows": [{"date": d, **{c: series[c].get(d) for c in cols}} for d in dates],
        "chart": chart,
    }


def get_cell_workparams(cell_name: str, user=None) -> Dict[str, Any]:
    """从全量工参取小区规划数据：经纬度/方位角/PCI/TAC/频点/制式（距离/定位类问题用）。"""
    with SessionLocal() as db:
        sec_q = (db.query(Sector)
               .filter(Sector.name.like(f"%{cell_name}%"))
               .filter(Sector.longitude.isnot(None)))
        sec_f = group_sql_filter(Sector.city, Sector.operator, user)
        if sec_f is not None:
            sec_q = sec_q.filter(sec_f)
        sec = sec_q.first()
        if not sec:
            return {"cell_name": cell_name, "found": False,
                    "candidates": _fuzzy_cell_names(db, cell_name, user)[:10],
                    "message": f"全量工参中未找到「{cell_name}」的规划数据"}
        site = db.query(Site).filter_by(id=sec.site_id_fk).first() if sec.site_id_fk else None
        return {
            "cell_name": sec.name, "found": True,
            "network_type": sec.network_type,
            "longitude": sec.longitude, "latitude": sec.latitude,
            "azimuth": sec.azimuth, "height": sec.height,
            "pci": sec.pci, "tac": sec.tac, "frequency": sec.frequency,
            "site_id": site.site_id if site else None,
            "site_name": site.name if site else None,
        }


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def find_nearby_sites(site_name: str, radius_km: float = 1.0,
                      network_type: str = "", user=None) -> Dict[str, Any]:
    """以某小区（取自全量工参坐标）为中心，返回周边 radius_km 内的小区清单。

    network_type 传 LTE/NR 过滤制式；距离用 haversine。查询范围与用户组隔离。
    """
    with SessionLocal() as db:
        center_q = (db.query(Sector)
                  .filter(Sector.name.like(f"%{site_name}%"))
                  .filter(Sector.longitude.isnot(None), Sector.latitude.isnot(None)))
        center_f = group_sql_filter(Sector.city, Sector.operator, user)
        if center_f is not None:
            center_q = center_q.filter(center_f)
        center = center_q.first()
        if not center:
            return {"site_name": site_name, "found": False,
                    "candidates": _fuzzy_cell_names(db, site_name, user)[:10],
                    "message": f"在全量工参中未找到「{site_name}」的坐标，无法做距离查询"}
        targets_q = db.query(Sector).filter(
            Sector.longitude.isnot(None), Sector.latitude.isnot(None))
        targets_f = group_sql_filter(Sector.city, Sector.operator, user)
        if targets_f is not None:
            targets_q = targets_q.filter(targets_f)
        targets = targets_q.all()
        net = network_type.upper()
        out = []
        for t in targets:
            if net and (t.network_type or "").upper() != net:
                continue
            dist = _haversine_km(center.longitude, center.latitude, t.longitude, t.latitude)
            if dist <= radius_km:
                out.append({
                    "cell_name": t.name, "network_type": t.network_type,
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
