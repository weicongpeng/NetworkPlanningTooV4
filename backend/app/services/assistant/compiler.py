"""QueryPlan → 参数化 SQL 编译器

四条硬约束在这里统一收口（工具层不许各写一遍）：
1. 字段白名单：未在 semantic.field_catalog 中的字段一律拒绝，值一律参数绑定；
2. 数据组隔离：强制注入 (city, operator) 条件；用户组缺失 → 直接拒绝；
3. 强制 LIMIT ≤ MAX_LIMIT；
4. 口径正确：比率类按分子分母分别汇总后再相除，缺分子分母时显式降级并记录原因。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .query_plan import MAX_LIMIT, PlanError, QueryPlan
from .semantic import field_catalog, metric_registry
from app.services.data_group import user_group


@dataclass
class CompiledQuery:
    sql: str
    params: Dict[str, Any]
    columns: List[str]
    dataset: str
    aggregated: bool
    degraded: List[str] = field(default_factory=list)
    metric_meta: List[Dict[str, Any]] = field(default_factory=list)
    dimension_meta: List[Dict[str, Any]] = field(default_factory=list)


class _Params:
    """命名参数生成器（sqlite3 named style），顺带记录绑定值。"""

    def __init__(self) -> None:
        self.values: Dict[str, Any] = {}
        self._n = 0

    def add(self, value: Any) -> str:
        self._n += 1
        key = f"p{self._n}"
        self.values[key] = value
        return f":{key}"


def _time_expr(bucket: Optional[str]) -> str:
    if bucket == "hour":
        return "strftime('%Y-%m-%d %H:00', m.metric_time)"
    if bucket == "month":
        return "strftime('%Y-%m', m.metric_time)"
    return "date(m.metric_time)"


def _metric_match(metric_id: Optional[str], keyword: str, params: _Params) -> str:
    """指标匹配条件：优先 metric_id；历史行（metric_id 为空）回退按列名匹配。"""
    if metric_id:
        mid = params.add(metric_id)
        pat = params.add(f"%{keyword}%")
        return f"(m.metric_id = {mid} OR (m.metric_id IS NULL AND m.metric_name LIKE {pat}))"
    return f"m.metric_name LIKE {params.add(f'%{keyword}%')}"


def _agg_expr(agg: str, cond: str) -> str:
    value = f"CASE WHEN {cond} THEN m.metric_value END"
    if agg == "sum":
        return f"SUM({value})"
    if agg == "max":
        return f"MAX({value})"
    return f"AVG({value})"  # avg / 缺省


def _resolve_metric(spec, available: Optional[Set[str]], params: _Params) -> Tuple[str, str, Dict[str, Any]]:
    """返回 (select 表达式, 展示标签, 元信息)。"""
    keyword = spec.keyword.strip()
    candidates = metric_registry.resolve_query(keyword)
    metric_id = candidates[0] if candidates else None
    definition = metric_registry.get(metric_id) if metric_id else None

    requested_agg = (spec.agg or "").lower()
    agg = requested_agg or (definition or {}).get("aggregation") or "avg"
    # 展示名优先用提问里的说法（用户问"掉线次数"就显示"掉线次数"），口径注册表名只作兜底
    label = spec.label or keyword or (definition or {}).get("name")
    meta: Dict[str, Any] = {
        "metric": label,
        "keyword": keyword,
        "metric_id": metric_id,
        "aggregation": agg,
        "unit": (definition or {}).get("unit", ""),
        "direction": (definition or {}).get("direction", "none"),
        "source": (definition or {}).get("source", ""),
    }
    degraded: Optional[str] = None

    if agg == "ratio":
        num, den = metric_registry.components(metric_id) if metric_id else (None, None)
        usable = bool(num and den) and (available is None or {num, den} <= available)
        if usable:
            num_cond = _metric_match(num, num, params)
            den_cond = _metric_match(den, den, params)
            # 分子分母是次数，相除得 0~1 的比率；percent 口径 ×100 输出工程习惯的百分数
            scale = 100.0 if (definition or {}).get("unit") == "percent" else 1.0
            expr = (f"({scale} * SUM(CASE WHEN {num_cond} THEN m.metric_value END)"
                    f" / NULLIF(SUM(CASE WHEN {den_cond} THEN m.metric_value END), 0))")
            meta["components"] = {"numerator": num, "denominator": den}
            return expr, label, meta
        # 缺分子分母 → 显式降级为区间均值，并记录原因（不许静默用错口径）
        degraded = ("数据中缺少该比率的分子/分母指标，已退化为区间简单平均，"
                    "仅可看趋势、不可作为准确口径引用")
        agg = "avg"
        meta["aggregation"] = "avg(degraded)"
        meta["degraded_reason"] = degraded

    expr = _agg_expr(agg, _metric_match(metric_id, keyword, params))
    if degraded:
        meta["degraded_reason"] = degraded
    return expr, label, meta


def _field_condition(dataset: str, flt, params: _Params) -> str:
    resolved = field_catalog.resolve_field(dataset, flt.field)
    if resolved is None:
        raise PlanError(f"过滤字段「{flt.field}」不在 {dataset} 可用字段内")
    col = resolved["sql"]
    op = flt.op
    if op == "is_null":
        return f"{col} IS NULL"
    if op == "is_not_null":
        return f"{col} IS NOT NULL"
    if op in ("in", "not_in"):
        values = list(flt.value or [])
        if not values:
            raise PlanError(f"{flt.field} 的 {op} 取值不能为空数组")
        holders = ", ".join(params.add(v) for v in values)
        return f"{col} {'NOT IN' if op == 'not_in' else 'IN'} ({holders})"
    if op == "between":
        low, high = flt.value
        return f"{col} BETWEEN {params.add(low)} AND {params.add(high)}"
    if op == "like":
        text = str(flt.value or "")
        pattern = text if "%" in text else f"%{text}%"
        return f"{col} LIKE {params.add(pattern)}"
    if op not in ("=", "!=", ">", ">=", "<", "<="):
        raise PlanError(f"不支持的过滤运算符：{op}")
    return f"{col} {op} {params.add(_coerce(resolved['type'], flt.value))}"


def _coerce(type_: str, value: Any) -> Any:
    if value is None:
        return None
    if type_ == "int":
        try:
            return int(value)
        except (TypeError, ValueError):
            raise PlanError(f"过滤值 {value!r} 不是整数")
    if type_ == "float":
        try:
            return float(value)
        except (TypeError, ValueError):
            raise PlanError(f"过滤值 {value!r} 不是数值")
    return str(value)


def _from_clause(dataset: str, needs_sector_join: bool, needs_site_join: bool,
                 group: Optional[Tuple[str, str]], params: _Params) -> str:
    if dataset == "metrics":
        sql = "FROM station_metric_rows m"
        if needs_sector_join:
            # 共享小区同名多行（双 PLMN）会放大 SUM，先按 name 去重成 1:1
            conds = []
            if group:
                conds.append(f"city = {params.add(group[0])} AND operator = {params.add(group[1])}")
            where = f" WHERE {' AND '.join(conds)}" if conds else ""
            sql += (
                " LEFT JOIN (SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id"
                f") AS _rn FROM sectors{where}) sec ON sec.name = m.cell_name AND sec._rn = 1"
            )
        if needs_site_join:
            sql += " LEFT JOIN sites st ON st.id = sec.site_id_fk"
        return sql
    if dataset == "sectors":
        sql = "FROM sectors s"
        if needs_site_join:
            sql += " LEFT JOIN sites st ON st.id = s.site_id_fk"
        return sql
    return "FROM station_param_rows p"


def compile_plan(plan: QueryPlan, user=None,
                 available_metric_ids: Optional[Set[str]] = None) -> CompiledQuery:
    params = _Params()
    degraded: List[str] = []

    group = user_group(user)
    if user is not None and group is None:
        raise PlanError("当前账号未配置地市/运营商，无法查询任何数据（数据按组隔离）")

    dataset = plan.dataset

    # ---- 维度 ----
    dim_sql: List[str] = []
    dim_labels: List[str] = []
    dim_meta: List[Dict[str, Any]] = []
    needs_sector_join = False
    needs_site_join = False
    for dim in plan.dimensions:
        if dataset == "metrics" and dim.field in ("metric_time", "时间", "统计时间"):
            bucket = dim.bucket or plan.granularity or "day"
            label = {"hour": "时间(小时)", "month": "时间(月)"}.get(bucket, "时间(日)")
            dim_sql.append(_time_expr(bucket))
            dim_labels.append(label)
            dim_meta.append({"field": "metric_time", "bucket": bucket, "label": label})
            continue
        resolved = field_catalog.resolve_field(dataset, dim.field)
        if resolved is None:
            raise PlanError(
                f"字段「{dim.field}」不在 {dataset} 可用字段内。可用字段："
                f"{', '.join(f['name'] for f in field_catalog.fields_of(dataset))}")
        if resolved["sql"].startswith("sec."):
            needs_sector_join = True
        if resolved["sql"].startswith("st."):
            needs_site_join = True
            needs_sector_join = needs_sector_join or dataset == "metrics"
        dim_sql.append(resolved["sql"])
        dim_labels.append(resolved["name"])
        dim_meta.append({"field": resolved["name"], "label": resolved["name"]})

    # ---- 指标 ----
    metric_sql: List[str] = []
    metric_labels: List[str] = []
    metric_meta: List[Dict[str, Any]] = []
    for spec in plan.metrics:
        if dataset != "metrics":
            raise PlanError("只有 dataset=metrics 才能做指标聚合分析")
        expr, label, meta = _resolve_metric(spec, available_metric_ids, params)
        if meta.get("degraded_reason"):
            degraded.append(meta["degraded_reason"])
        metric_sql.append(expr)
        metric_labels.append(label)
        metric_meta.append(meta)

    if dataset in ("sectors", "params") and not metric_sql:
        # 工参/参数类查询的缺省度量：小区数
        metric_sql.append("COUNT(*)")
        metric_labels.append("小区数")
        metric_meta.append({"metric": "小区数", "aggregation": "count", "unit": "个"})

    if not metric_sql and not dim_sql:
        metric_sql.append("COUNT(*)")
        metric_labels.append("记录数")
        metric_meta.append({"metric": "记录数", "aggregation": "count", "unit": "条"})

    # ---- WHERE ----
    where: List[str] = []
    group_cols = {"metrics": ("m.city", "m.operator"),
                  "sectors": ("s.city", "s.operator"),
                  "params": ("p.city", "p.operator")}[dataset]
    if group:
        where.append(f"{group_cols[0]} = {params.add(group[0])}")
        where.append(f"{group_cols[1]} = {params.add(group[1])}")

    if plan.time_start or plan.time_end or plan.granularity:
        if dataset != "metrics":
            raise PlanError("只有 dataset=metrics 支持 time_range / granularity")
        if plan.time_start:
            where.append(f"m.metric_time >= {params.add(plan.time_start + ' 00:00:00')}")
        if plan.time_end:
            where.append(f"m.metric_time <= {params.add(plan.time_end + ' 23:59:59')}")
        if plan.granularity:
            where.append(f"m.granularity = {params.add(plan.granularity)}")

    for flt in plan.filters:
        where.append(_field_condition(dataset, flt, params))

    # 过滤条件若引用工参维度，同样需要关联（否则 SQL 引用未加入的表）
    for flt in plan.filters:
        resolved_f = field_catalog.resolve_field(dataset, flt.field)
        if resolved_f is None:
            continue
        if resolved_f["sql"].startswith("sec."):
            needs_sector_join = True
        elif resolved_f["sql"].startswith("st."):
            needs_site_join = True
            needs_sector_join = needs_sector_join or dataset == "metrics"

    from_sql = _from_clause(dataset, needs_sector_join, needs_site_join, group, params)

    # ---- 组装 ----
    select_parts = [f"{expr} AS d{i}" for i, expr in enumerate(dim_sql)]
    select_parts += [f"{expr} AS m{i}" for i, expr in enumerate(metric_sql)]
    sql = f"SELECT {', '.join(select_parts)} {from_sql}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    if dim_sql:
        sql += " GROUP BY " + ", ".join(f"d{i}" for i in range(len(dim_sql)))

    if plan.order_by:
        order_parts = []
        for order in plan.order_by:
            target = _order_target(order["field"], dim_labels, metric_labels, dim_meta, metric_meta)
            if target is None:
                raise PlanError(
                    f"排序字段「{order['field']}」不在本次选择的维度/指标内："
                    f"{', '.join(dim_labels + metric_labels)}")
            order_parts.append(f"{target} {order['dir'].upper()}")
        sql += " ORDER BY " + ", ".join(order_parts)
    elif metric_sql and dim_sql:
        # 时间维度按时间正序（趋势图必须按时间读）；其余按度量值倒序（榜单习惯）
        time_idx = next((i for i, d in enumerate(dim_meta) if d.get("field") == "metric_time"),
                        None)
        sql += f" ORDER BY d{time_idx} ASC" if time_idx is not None else " ORDER BY m0 DESC"

    sql += f" LIMIT {min(plan.limit, MAX_LIMIT)}"

    return CompiledQuery(
        sql=sql, params=params.values,
        columns=dim_labels + metric_labels,
        dataset=dataset, aggregated=bool(dim_sql),
        degraded=sorted(set(degraded)),
        metric_meta=metric_meta, dimension_meta=dim_meta,
    )


def _order_target(name: str, dim_labels: Sequence[str], metric_labels: Sequence[str],
                  dim_meta: Sequence[Dict[str, Any]],
                  metric_meta: Sequence[Dict[str, Any]]) -> Optional[str]:
    if name in metric_labels:
        return f"m{list(metric_labels).index(name)}"
    if name in dim_labels:
        return f"d{list(dim_labels).index(name)}"
    for i, meta in enumerate(metric_meta):
        if name in (meta.get("metric_id"), meta.get("metric"), meta.get("keyword")):
            return f"m{i}"
    for i, meta in enumerate(dim_meta):
        if name == meta.get("field"):
            return f"d{i}"
    return None
