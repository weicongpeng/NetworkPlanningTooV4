"""指标口径注册表

为什么需要它：比率类指标（掉线率、接通率）的跨行聚合必须"分子分母分别汇总再相除"，
直接 avg(比率) 是错的；累计量（次数、流量）必须 sum。没有口径元数据，任何聚合都只能猜。

口径来源优先级：data/metric_registry.json（用户覆盖） > 内置 builtin_metrics.json。
每条口径字段：
    metric_id / name / aliases / unit / direction
    aggregation: ratio | sum | avg | max | last
    numerator / denominator: 仅 ratio 使用，形如 {"metric_id": "..."} 或 {"match": ["列名片段"]}
    granularities / source
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings

_BUILTIN_PATH = Path(__file__).with_name("builtin_metrics.json")
_OVERRIDE_PATH = settings.DATA_DIR / "metric_registry.json"

# (builtin_mtime, override_mtime, merged)
_cache: Optional[Tuple[float, float, Dict[str, Dict[str, Any]]]] = None

AGGREGATIONS = ("ratio", "sum", "avg", "max", "last")


def _read_metrics(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(raw, dict):
        raw = raw.get("metrics") or []
    out = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict) and item.get("metric_id"):
            out.append(item)
    return out


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def load_all() -> Dict[str, Dict[str, Any]]:
    """全部口径（内置 + 用户覆盖），按 metric_id 索引。"""
    global _cache
    bm, om = _mtime(_BUILTIN_PATH), _mtime(_OVERRIDE_PATH)
    if _cache and _cache[0] == bm and _cache[1] == om:
        return _cache[2]
    merged: Dict[str, Dict[str, Any]] = {}
    for item in _read_metrics(_BUILTIN_PATH):
        merged[item["metric_id"]] = item
    for item in _read_metrics(_OVERRIDE_PATH):
        base = dict(merged.get(item["metric_id"], {}))
        base.update(item)
        merged[item["metric_id"]] = base
    _cache = (bm, om, merged)
    return merged


def get(metric_id: str) -> Optional[Dict[str, Any]]:
    return load_all().get(metric_id)


def aggregation_of(metric_id: str) -> str:
    item = get(metric_id) or {}
    agg = item.get("aggregation") or "avg"
    return agg if agg in AGGREGATIONS else "avg"


def components(metric_id: str) -> Tuple[Optional[str], Optional[str]]:
    """比率类返回 (分子 metric_id, 分母 metric_id)；非比率返回 (None, None)。"""
    item = get(metric_id) or {}
    if item.get("aggregation") != "ratio":
        return (None, None)
    num = (item.get("numerator") or {}).get("metric_id")
    den = (item.get("denominator") or {}).get("metric_id")
    return (num, den)


def _alias_index() -> List[Tuple[str, str]]:
    """(alias小写, metric_id)，按别名长度倒序，保证"最具体的先命中"。"""
    pairs: List[Tuple[str, str]] = []
    for mid, item in load_all().items():
        for alias in [item.get("name") or "", mid, *(item.get("aliases") or [])]:
            a = str(alias).strip().lower()
            if a:
                pairs.append((a, mid))
    pairs.sort(key=lambda p: len(p[0]), reverse=True)
    return pairs


def resolve_column(column_name: str) -> Optional[str]:
    """把 Excel 原始列名（如"掉线率(%)"）解析到 metric_id，解析不出返回 None。"""
    col = str(column_name or "").strip().lower()
    if not col:
        return None
    for alias, mid in _alias_index():
        if alias in col:
            return mid
    return None


def resolve_query(keyword: str) -> List[str]:
    """把用户问法里的指标关键词解析为候选 metric_id 列表（精确优先）。"""
    kw = str(keyword or "").strip().lower()
    if not kw:
        return []
    exact, fuzzy = [], []
    for alias, mid in _alias_index():
        if alias == kw:
            exact.append(mid)
        elif alias in kw or kw in alias:
            fuzzy.append(mid)
    ordered: List[str] = []
    for mid in exact + fuzzy:
        if mid not in ordered:
            ordered.append(mid)
    return ordered


def ratio_pair_in_data(metric_id: str, available_ids: set) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """在"数据里实际存在的指标"中解析比率的分子分母。

    返回 (num_id, den_id, reason)。reason 非空表示无法精确聚合的原因。
    """
    num, den = components(metric_id)
    if not num or not den:
        return (None, None, f"口径 {metric_id} 未定义分子/分母")
    if num not in available_ids or den not in available_ids:
        missing = [m for m in (num, den) if m not in available_ids]
        return (None, None,
                f"数据中缺少口径所需的指标：{'、'.join(missing)}，无法精确聚合")
    return (num, den, "")


def describe() -> List[Dict[str, Any]]:
    """给 catalog / 提示词用的精简口径清单。"""
    out = []
    for mid, item in sorted(load_all().items()):
        out.append({
            "metric_id": mid,
            "name": item.get("name") or mid,
            "aggregation": item.get("aggregation") or "avg",
            "unit": item.get("unit") or "",
            "direction": item.get("direction") or "none",
        })
    return out
