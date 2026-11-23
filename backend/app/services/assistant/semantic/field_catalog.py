"""字段目录（QueryPlan 的字段白名单）

一切「模型能引用的字段」都必须出现在这里：编译器只认白名单，未命中直接拒绝，
不做模糊猜测——这是防注入与防口径漂移的第一道闸。

三个数据集：
    sectors  全量工参扇区（sectors + sites）
    metrics  性能指标（station_metric_rows + 工参维度按小区名关联）
    params   基站无线参数（station_param_rows，参数列在 params_json 里动态）
"""
from typing import Any, Dict, List, Optional

# 字段定义：name(对模型暴露的名称) -> {sql, type, aliases, dataset 内是否需要工参关联}
# type: text | int | float | datetime | bool
_F = lambda sql, type_, **kw: {"sql": sql, "type": type_, **kw}  # noqa: E731

_SECTOR_FIELDS: Dict[str, Dict[str, Any]] = {
    "cell_name": _F("s.name", "text", aliases=["小区名", "小区名称", "小区", "cell name", "sector name"]),
    "sector_id": _F("s.sector_id", "text", aliases=["小区标识", "sector id"]),
    # 制式存在 sites 表（sectors 没有该列），必须关联站点
    "network_type": _F("st.network_type", "text", aliases=["制式", "网络制式", "网别", "network type"]),
    "site_id": _F("st.site_id", "text", aliases=["基站编号", "基站标识", "基站ID", "site id"]),
    "site_name": _F("st.name", "text", aliases=["站名", "基站名称", "站点名称", "site name"]),
    "pci": _F("s.pci", "int", aliases=["PCI"]),
    "tac": _F("s.tac", "int", aliases=["TAC", "跟踪区", "跟踪区码"]),
    "frequency": _F("s.frequency", "float", aliases=["频点", "频率", "中心频点"]),
    "azimuth": _F("s.azimuth", "float", aliases=["方位角"]),
    "height": _F("s.height", "float", aliases=["挂高", "天线高度", "高度"]),
    "beamwidth": _F("s.beamwidth", "float", aliases=["波宽", "水平波瓣宽度"]),
    "cell_cover_type": _F("s.cell_cover_type", "int", aliases=["覆盖类型", "小区覆盖类型"]),
    "is_shared": _F("s.is_shared", "text", aliases=["是否共享", "共享小区"]),
    "mcc": _F("s.mcc", "text", aliases=["MCC"]),
    "mnc": _F("s.mnc", "text", aliases=["MNC"]),
    "longitude": _F("s.longitude", "float", aliases=["经度", "lon", "lng"]),
    "latitude": _F("s.latitude", "float", aliases=["纬度", "lat"]),
}

# metrics 数据集里可用的工参维度（来自 deduped sectors 关联，别名跨表可用）
_METRIC_FIELDS: Dict[str, Dict[str, Any]] = {
    "cell_name": _F("m.cell_name", "text", aliases=["小区名", "小区名称", "小区"]),
    "site_id": _F("m.site_id", "text", aliases=["基站编号", "基站标识", "site id"]),
    "cell_id": _F("m.cell_id", "text", aliases=["小区标识", "cell id"]),
    "granularity": _F("m.granularity", "text", aliases=["粒度"]),
    "metric_time": _F("m.metric_time", "datetime", aliases=["时间", "统计时间"]),
}
# 工参维度换到关联别名 sec / st；小区名/基站号/小区号仍取指标表自身列，避免同名列被覆盖
for _k, _v in _SECTOR_FIELDS.items():
    if _k in ("cell_name", "site_id"):
        continue
    _METRIC_FIELDS[_k] = {**_v, "sql": _v["sql"].replace("s.", "sec.")}

_PARAM_FIELDS: Dict[str, Dict[str, Any]] = {
    "cell_name": _F("p.cell_name", "text", aliases=["小区名", "小区名称"]),
    "site_id": _F("p.site_id", "text", aliases=["基站编号", "基站标识"]),
    "cell_id": _F("p.cell_id", "text", aliases=["小区标识"]),
    "network_type": _F("p.network_type", "text", aliases=["制式", "网络制式"]),
}

DATASETS = ("metrics", "sectors", "params")

_FIELDS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "sectors": _SECTOR_FIELDS,
    "metrics": _METRIC_FIELDS,
    "params": _PARAM_FIELDS,
}

# 每个数据集需要哪些关联表
_JOINS = {
    "sectors": ("sites",),
    "metrics": ("sectors", "sites"),
    "params": (),
}


def _norm(name: str) -> str:
    return str(name or "").strip().lower().replace(" ", "")


def resolve_field(dataset: str, name: str) -> Optional[Dict[str, Any]]:
    """把模型给的字段名/中文别名解析成白名单字段。未命中返回 None（由编译器拒绝）。"""
    fields = _FIELDS.get(dataset)
    if not fields:
        return None
    key = str(name or "").strip()
    if key in fields:
        return {**fields[key], "name": key}
    low = _norm(key)
    for fname, spec in fields.items():
        if _norm(fname) == low:
            return {**spec, "name": fname}
        for alias in spec.get("aliases") or []:
            if _norm(alias) == low:
                return {**spec, "name": fname}
    return None


def fields_of(dataset: str) -> List[Dict[str, Any]]:
    """字段清单（给 catalog/提示词用）。"""
    return [{"name": n, **{k: v for k, v in spec.items() if k in ("type", "aliases")}}
            for n, spec in (_FIELDS.get(dataset) or {}).items()]


def joins_for(dataset: str) -> tuple:
    return _JOINS.get(dataset, ())


def param_key_sql(key: str) -> str:
    """params_json 动态键的取值表达式（键名做严格白名单校验后由调用方保证）。"""
    return f"json_extract(p.params_json, '$.\"{key}\"')"
