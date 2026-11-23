"""图表规格（声明式、受控）

模型只能选图型（或交给 auto）；**数据点全部来自 SQL 结果**，图上的数字与前端明细表
逐格同源。前端用 ECharts 渲染，加载失败降级到内联 SVG。

规格结构（CHART_SCHEMA 即文档，同时被前端做形状校验）：
    {"type", "title", "x": {"label", "categories"}, "y": {"label", "unit"},
     "series": [{"name", "data"}],          # line/bar/stacked_bar
     "values": [{"x", "y", "v"}],           # heatmap
     "value", "label", "unit",              # big_number
     "note"}                                # 口径降级/数据说明
"""
from typing import Any, Dict, List, Optional, Sequence

CHART_SCHEMA: Dict[str, Any] = {
    "type": "enum(line|bar|stacked_bar|heatmap|big_number|scatter)",
    "title": "string",
    "x": {"label": "string", "categories": "[string]"},
    "y": {"label": "string", "unit": "string"},
    "series": "[{name: string, data: [number|null]}]",
    "values": "[{x, y, v}]",
    "value": "number",
    "note": "string",
}

_MAX_SERIES = 20
_MAX_CATEGORIES = 200


def _round(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if abs(f) >= 1000:
        return round(f, 2)
    if abs(f) >= 1:
        return round(f, 4)
    return round(f, 6)


def _is_time_label(label: str, is_time_dim: bool) -> bool:
    return is_time_dim or label.startswith("时间")


def build_charts(rows: List[Dict[str, Any]], dim_labels: Sequence[str],
                 metric_labels: Sequence[str], units: Sequence[str],
                 is_time_dim: bool = False, requested: str = "auto",
                 note: str = "") -> List[Dict[str, Any]]:
    """按结果形状与请求图型生成 0-2 个图表规格（rows 的键必须是 dim_labels+metric_labels）。"""
    if not rows:
        return []
    dims = list(dim_labels)
    metrics = list(metric_labels)
    title = _title(dims, metrics)
    base: Dict[str, Any] = {"title": title}
    if note:
        base["note"] = note

    if requested == "table":
        return []

    # 无维度：单值卡片 / 多指标对比柱
    if not dims:
        if len(metrics) == 1:
            return [{**base, "type": "big_number", "label": metrics[0],
                     "unit": units[0] if units else "",
                     "value": _round(rows[0].get(metrics[0]))}]
        return [{**base, "type": "bar",
                 "x": {"label": "指标", "categories": metrics},
                 "y": {"label": "值", "unit": ""},
                 "series": [{"name": "值", "data": [_round(rows[0].get(m)) for m in metrics]}]}]

    # 一维：时间 → 折线；类别 → 柱
    if len(dims) == 1:
        d0 = dims[0]
        values = rows[:_MAX_CATEGORIES]
        categories = [str(r.get(d0)) for r in values]
        series = [{"name": m, "data": [_round(r.get(m)) for r in values]} for m in metrics]
        default_type = "line" if _is_time_label(d0, is_time_dim) else "bar"
        chart_type = requested if requested in ("line", "bar", "stacked_bar") else default_type
        return [{**base, "type": chart_type,
                 "x": {"label": d0, "categories": categories},
                 "y": {"label": metrics[0], "unit": units[0] if units else ""},
                 "series": series[:_MAX_SERIES]}]

    d0, d1 = dims[0], dims[1]
    if requested == "heatmap":
        return [{**base, "type": "heatmap",
                 "x": {"label": d0}, "y": {"label": d1},
                 "values": [{"x": str(r.get(d0)), "y": str(r.get(d1)),
                             "v": _round(r.get(metrics[0]))} for r in rows[:_MAX_CATEGORIES * 20]]}]

    if _is_time_label(d0, is_time_dim):
        categories = sorted({str(r.get(d0)) for r in rows})[:_MAX_CATEGORIES]
        index = {c: i for i, c in enumerate(categories)}
        series_map: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            name = str(r.get(d1))
            entry = series_map.setdefault(name, {"name": name,
                                                 "data": [None] * len(categories)})
            pos = index.get(str(r.get(d0)))
            if pos is not None:
                entry["data"][pos] = _round(r.get(metrics[0]))
        return [{**base, "type": "line" if requested == "auto" else requested,
                 "x": {"label": d0, "categories": categories},
                 "y": {"label": metrics[0], "unit": units[0] if units else ""},
                 "series": list(series_map.values())[:_MAX_SERIES]}]

    # 两个类别维度：柱状对比（每个 d1 一组）
    categories = sorted({str(r.get(d0)) for r in rows})[:_MAX_CATEGORIES]
    index = {c: i for i, c in enumerate(categories)}
    series_map = {}
    for r in rows:
        name = str(r.get(d1))
        entry = series_map.setdefault(name, {"name": name, "data": [None] * len(categories)})
        pos = index.get(str(r.get(d0)))
        if pos is not None:
            entry["data"][pos] = _round(r.get(metrics[0]))
    return [{**base, "type": "stacked_bar" if requested == "stacked_bar" else "bar",
             "x": {"label": d0, "categories": categories},
             "y": {"label": metrics[0], "unit": units[0] if units else ""},
             "series": list(series_map.values())[:_MAX_SERIES]}]


def _title(dims: List[str], metrics: List[str]) -> str:
    m = "、".join(metrics) if metrics else "统计"
    if not dims:
        return m
    return f"{m} 按 {'、'.join(dims)}"
