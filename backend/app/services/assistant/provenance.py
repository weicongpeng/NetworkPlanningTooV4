"""取数配方（provenance）

每个回答都要能回溯：用了哪些数据集、什么时间窗、什么过滤、按什么口径聚合、
命中多少行、耗时多少、有没有降级。前端可展开成"取数配方"面板，也是回归证据。
"""
from typing import Any, Dict, List

from .compiler import CompiledQuery
from .query_plan import QueryPlan

DATASET_LABELS = {
    "metrics": "性能指标（station_metric_rows）",
    "sectors": "全量工参（sectors/sites）",
    "params": "基站无线参数（station_param_rows）",
}

_OP_LABELS = {
    "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤",
    "in": "属于", "not_in": "不属于", "like": "包含", "between": "介于",
    "is_null": "为空", "is_not_null": "非空",
}


def build(plan: QueryPlan, compiled: CompiledQuery, *,
          row_count: int, elapsed_ms: int) -> Dict[str, Any]:
    return {
        "dataset": plan.dataset,
        "dataset_label": DATASET_LABELS.get(plan.dataset, plan.dataset),
        "metrics": compiled.metric_meta,
        "dimensions": [d["label"] for d in compiled.dimension_meta],
        "filters": [{"field": f.field, "op": _OP_LABELS.get(f.op, f.op), "value": f.value}
                    for f in plan.filters],
        "time_range": {"start": plan.time_start, "end": plan.time_end},
        "granularity": plan.granularity,
        "limit": plan.limit,
        "row_count": row_count,
        "elapsed_ms": elapsed_ms,
        "degraded": compiled.degraded,
    }


def describe(prov: Dict[str, Any]) -> str:
    """一句话取数配方（回灌模型，也用于回答末尾引用）。"""
    parts: List[str] = [prov.get("dataset_label") or prov.get("dataset", "")]
    tr = prov.get("time_range") or {}
    if tr.get("start") or tr.get("end"):
        parts.append(f"时间 {tr.get('start') or '起'}~{tr.get('end') or '今'}")
    if prov.get("granularity"):
        parts.append(f"粒度 {prov['granularity']}")
    for f in prov.get("filters") or []:
        parts.append(f"{f['field']} {f['op']} {f['value']}")
    if prov.get("dimensions"):
        parts.append("按 " + "、".join(prov["dimensions"]) + " 分组")
    aggs = [f"{m['metric']}={m['aggregation']}" for m in prov.get("metrics") or []]
    if aggs:
        parts.append("聚合 " + "、".join(aggs))
    parts.append(f"命中 {prov.get('row_count', 0)} 行 / {prov.get('elapsed_ms', 0)}ms")
    if prov.get("degraded"):
        parts.append("口径降级：" + "；".join(prov["degraded"]))
    return "；".join(p for p in parts if p)
