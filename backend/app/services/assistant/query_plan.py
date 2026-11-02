"""QueryPlan：模型唯一被允许产出的"查询语言"

设计原则：模型不写 SQL。它只产出这份结构化计划，服务端校验字段白名单后编译成
参数化 SQL。这样才可能同时保证：数据组隔离、口径正确、防注入、可审计、可回归。

为什么手写校验而不是引 jsonschema：部署环境是既有 venv（systemd / 桌面打包），
不为一个校验器加新依赖；PLAN_SCHEMA 仍作为唯一结构说明（进提示词 + 文档），
validate_plan() 与之逐条对应。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .semantic import field_catalog

DATASETS = ("metrics", "sectors", "params")
AGGREGATIONS = ("ratio", "sum", "avg", "max")
FILTER_OPS = ("=", "!=", "in", "not_in", ">", ">=", "<", "<=", "like", "between",
              "is_null", "is_not_null")
BUCKETS = ("hour", "day", "month")
GRANULARITIES = ("hour", "day", "month", "busy_hour")
CHART_TYPES = ("auto", "line", "bar", "stacked_bar", "heatmap", "big_number", "table")
MAX_LIMIT = 5000
DEFAULT_LIMIT = 200

# 进提示词的 schema 说明（同时也是本文件校验规则的文档）
PLAN_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "required": ["dataset"],
    "properties": {
        "dataset": {"enum": list(DATASETS)},
        "metrics": {"type": "array", "maxItems": 6, "items": {
            "metric": "string（指标名/口径名，如 掉线率）",
            "agg": f"可选，enum{list(AGGREGATIONS)}，缺省按口径注册表",
            "label": "可选，展示名",
        }},
        "dimensions": {"type": "array", "maxItems": 3, "items": {
            "field": "string（字段名或中文别名，须在字段目录内）",
            "bucket": f"可选，仅时间字段可用，enum{list(BUCKETS)}",
        }},
        "filters": {"type": "array", "maxItems": 10, "items": {
            "field": "string",
            "op": f"enum{list(FILTER_OPS)}",
            "value": "任意；in/not_in 传数组，between 传 [起, 止]，is_null 可不传",
        }},
        "time_range": {"type": "object", "properties": {
            "start": "YYYY-MM-DD",
            "end": "YYYY-MM-DD",
            "granularity": f"enum{list(GRANULARITIES)}",
        }},
        "order_by": {"type": "array", "maxItems": 2, "items": {
            "field": "维度名或指标名",
            "dir": "asc|desc",
        }},
        "limit": f"integer 1..{MAX_LIMIT}",
        "chart": f"可选，enum{list(CHART_TYPES)}；auto=按结果自动选型",
    },
}


class PlanError(ValueError):
    """计划不合法（字段不在白名单、结构错误等），消息直接回灌给模型。"""


@dataclass
class MetricSpec:
    keyword: str
    agg: Optional[str] = None
    label: Optional[str] = None


@dataclass
class DimensionSpec:
    field: str
    bucket: Optional[str] = None


@dataclass
class FilterSpec:
    field: str
    op: str
    value: Any = None


@dataclass
class QueryPlan:
    dataset: str
    metrics: List[MetricSpec] = field(default_factory=list)
    dimensions: List[DimensionSpec] = field(default_factory=list)
    filters: List[FilterSpec] = field(default_factory=list)
    time_start: Optional[str] = None
    time_end: Optional[str] = None
    granularity: Optional[str] = None
    order_by: List[Dict[str, str]] = field(default_factory=list)
    limit: int = DEFAULT_LIMIT
    chart: str = "auto"


def _as_str(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f"{what} 必须是非空字符串")
    return value.strip()


def validate_plan(raw: Any) -> QueryPlan:
    """把模型给的计划解析为 QueryPlan；任何不合法都抛 PlanError（附中文原因）。"""
    if not isinstance(raw, dict):
        raise PlanError("查询计划必须是 JSON 对象")

    dataset = raw.get("dataset")
    if dataset not in DATASETS:
        raise PlanError(f"dataset 必须是 {list(DATASETS)} 之一")

    metrics: List[MetricSpec] = []
    raw_metrics = raw.get("metrics") or []
    if not isinstance(raw_metrics, list):
        raise PlanError("metrics 必须是数组")
    if len(raw_metrics) > 6:
        raise PlanError("metrics 最多 6 个")
    for item in raw_metrics:
        if isinstance(item, str):
            item = {"metric": item}
        if not isinstance(item, dict):
            raise PlanError("metrics 每项必须是对象或字符串")
        keyword = _as_str(item.get("metric") or item.get("name") or item.get("field"),
                          "metrics[].metric")
        agg = item.get("agg")
        if agg is not None and agg not in AGGREGATIONS:
            raise PlanError(f"agg 必须是 {list(AGGREGATIONS)} 之一")
        metrics.append(MetricSpec(keyword=keyword, agg=agg, label=item.get("label")))

    dimensions: List[DimensionSpec] = []
    raw_dims = raw.get("dimensions") or []
    if not isinstance(raw_dims, list):
        raise PlanError("dimensions 必须是数组")
    if len(raw_dims) > 3:
        raise PlanError("dimensions 最多 3 个")
    for item in raw_dims:
        if isinstance(item, str):
            item = {"field": item}
        if not isinstance(item, dict):
            raise PlanError("dimensions 每项必须是对象或字符串")
        name = _as_str(item.get("field") or item.get("name"), "dimensions[].field")
        bucket = item.get("bucket")
        if bucket is not None and bucket not in BUCKETS:
            raise PlanError(f"bucket 必须是 {list(BUCKETS)} 之一")
        dimensions.append(DimensionSpec(field=name, bucket=bucket))

    filters: List[FilterSpec] = []
    raw_filters = raw.get("filters") or []
    if not isinstance(raw_filters, list):
        raise PlanError("filters 必须是数组")
    if len(raw_filters) > 10:
        raise PlanError("filters 最多 10 个")
    for item in raw_filters:
        if not isinstance(item, dict):
            raise PlanError("filters 每项必须是对象")
        name = _as_str(item.get("field"), "filters[].field")
        op = item.get("op") or "="
        if op not in FILTER_OPS:
            raise PlanError(f"filters[].op 必须是 {list(FILTER_OPS)} 之一")
        value = item.get("value")
        if op in ("in", "not_in") and not isinstance(value, (list, tuple)):
            raise PlanError("in/not_in 的 value 必须是数组")
        if op == "between" and (not isinstance(value, (list, tuple)) or len(value) != 2):
            raise PlanError("between 的 value 必须是 [起, 止]")
        filters.append(FilterSpec(field=name, op=op, value=value))

    time_range = raw.get("time_range") or {}
    if not isinstance(time_range, dict):
        raise PlanError("time_range 必须是对象")
    granularity = time_range.get("granularity")
    if granularity is not None and granularity not in GRANULARITIES:
        raise PlanError(f"granularity 必须是 {list(GRANULARITIES)} 之一")

    order_by = raw.get("order_by") or []
    if not isinstance(order_by, list):
        raise PlanError("order_by 必须是数组")
    orders: List[Dict[str, str]] = []
    for item in order_by[:2]:
        if isinstance(item, str):
            orders.append({"field": item, "dir": "desc"})
            continue
        if not isinstance(item, dict):
            raise PlanError("order_by 每项必须是对象")
        direction = (item.get("dir") or "desc").lower()
        if direction not in ("asc", "desc"):
            raise PlanError("order_by[].dir 必须是 asc/desc")
        orders.append({"field": _as_str(item.get("field"), "order_by[].field"), "dir": direction})

    limit = raw.get("limit", DEFAULT_LIMIT)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise PlanError("limit 必须是整数")
    limit = max(1, min(limit, MAX_LIMIT))

    chart = raw.get("chart") or "auto"
    if chart not in CHART_TYPES:
        raise PlanError(f"chart 必须是 {list(CHART_TYPES)} 之一")

    if dataset == "metrics" and not metrics:
        raise PlanError("dataset=metrics 时必须给出 metrics（要分析哪个指标）")

    plan = QueryPlan(
        dataset=dataset, metrics=metrics, dimensions=dimensions, filters=filters,
        time_start=time_range.get("start"), time_end=time_range.get("end"),
        granularity=granularity, order_by=orders, limit=limit, chart=chart,
    )
    # 字段白名单：维度/过滤/排序字段必须能在字段目录里解析出来
    for dim in plan.dimensions:
        if field_catalog.resolve_field(dataset, dim.field) is None and not _is_metric_alias(dim.field):
            raise PlanError(
                f"字段「{dim.field}」不在 {dataset} 可用字段内。可用字段："
                f"{', '.join(f['name'] for f in field_catalog.fields_of(dataset))}")
    for flt in plan.filters:
        if field_catalog.resolve_field(dataset, flt.field) is None and not _is_metric_alias(flt.field):
            raise PlanError(
                f"过滤字段「{flt.field}」不在 {dataset} 可用字段内。可用字段："
                f"{', '.join(f['name'] for f in field_catalog.fields_of(dataset))}")
    return plan


def _is_metric_alias(name: str) -> bool:
    """指标名也可以作为过滤条件（如按 metric_name 过滤），由编译器再做具体判断。"""
    from .semantic import metric_registry

    return bool(metric_registry.resolve_query(name))
