"""指标口径注册表测试

守住的核心事实：比率类指标必须按"分子分母分别汇总"聚合，绝不能 avg(比率)。
"""
import json

import pytest


def test_resolve_column_maps_excel_header_to_metric_id():
    from app.services.assistant.semantic import metric_registry

    assert metric_registry.resolve_column("掉线率(%)") == "call_drop_rate"
    assert metric_registry.resolve_column("RRC异常释放次数") == "rrc_abnormal_release_times"
    assert metric_registry.resolve_column("随便一个维度列") is None


def test_ratio_metric_has_numerator_and_denominator():
    from app.services.assistant.semantic import metric_registry

    assert metric_registry.aggregation_of("call_drop_rate") == "ratio"
    num, den = metric_registry.components("call_drop_rate")
    assert num == "rrc_abnormal_release_times"
    assert den == "rrc_conn_setup_success"
    # 非比率口径没有分子分母
    assert metric_registry.components("traffic_volume") == (None, None)


def test_sum_metrics_are_not_ratios():
    from app.services.assistant.semantic import metric_registry

    assert metric_registry.aggregation_of("traffic_volume") == "sum"
    assert metric_registry.aggregation_of("rrc_abnormal_release_times") == "sum"


def test_resolve_query_prefers_exact_alias():
    from app.services.assistant.semantic import metric_registry

    assert metric_registry.resolve_query("掉线率")[0] == "call_drop_rate"
    assert "call_drop_rate" in metric_registry.resolve_query("帮我看看掉线率")


def test_ratio_pair_in_data_reports_missing_components():
    from app.services.assistant.semantic import metric_registry

    num, den, reason = metric_registry.ratio_pair_in_data("call_drop_rate", {"call_drop_rate"})
    assert num is None and den is None
    assert "缺少" in reason

    num, den, reason = metric_registry.ratio_pair_in_data(
        "call_drop_rate", {"rrc_abnormal_release_times", "rrc_conn_setup_success"})
    assert (num, den, reason) == ("rrc_abnormal_release_times", "rrc_conn_setup_success", "")


def test_user_override_file_wins(tmp_path, monkeypatch):
    from app.services.assistant.semantic import metric_registry

    override = tmp_path / "metric_registry.json"
    override.write_text(json.dumps({"metrics": [{
        "metric_id": "call_drop_rate", "name": "掉线率", "aggregation": "ratio",
        "numerator": {"metric_id": "custom_num"},
        "denominator": {"metric_id": "custom_den"},
        "source": "本地口径",
    }]}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(metric_registry, "_OVERRIDE_PATH", override)
    monkeypatch.setattr(metric_registry, "_cache", None)
    try:
        assert metric_registry.components("call_drop_rate") == ("custom_num", "custom_den")
    finally:
        monkeypatch.setattr(metric_registry, "_cache", None)


def test_builtin_registry_entries_are_well_formed():
    from app.services.assistant.semantic import metric_registry

    for mid, item in metric_registry.load_all().items():
        assert item.get("aggregation") in ("ratio", "sum", "avg", "max"), mid
        assert item.get("source"), f"{mid} 缺少口径出处"
        if item["aggregation"] == "ratio":
            num, den = metric_registry.components(mid)
            assert num and den, f"{mid} 比率口径缺分子/分母"
