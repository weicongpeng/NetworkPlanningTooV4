"""QueryPlan 校验与 SQL 编译测试（不连数据库）

守住的核心事实：
1. 未在白名单里的字段/非法图型/非法算子一律拒绝（防注入、防猜测）；
2. 编译结果强制含数据组条件与 LIMIT；
3. 比率走分子分母，缺分母时显式降级并给出原因，绝不静默 avg。
"""
import pytest

from app.services.assistant.query_plan import PlanError, QueryPlan, validate_plan


class FakeUser:
    def __init__(self, city="河源", operator="移动", is_admin=False):
        self.city = city
        self.operator = operator
        self.is_admin = is_admin


def _plan(**kwargs):
    base = {"dataset": "metrics", "metrics": [{"metric": "掉线率"}]}
    base.update(kwargs)
    return validate_plan(base)


# ------------------------------------------------------------------ 校验

def test_unknown_dimension_field_rejected():
    with pytest.raises(PlanError) as exc:
        validate_plan({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                       "dimensions": [{"field": "1; DROP TABLE sectors"}]})
    assert "可用字段" in str(exc.value)


def test_metrics_dataset_requires_metric():
    with pytest.raises(PlanError):
        validate_plan({"dataset": "metrics"})


def test_bad_operator_and_bucket_rejected():
    with pytest.raises(PlanError):
        validate_plan({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                       "filters": [{"field": "tac", "op": "DROP"}]})
    with pytest.raises(PlanError):
        validate_plan({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                       "dimensions": [{"field": "metric_time", "bucket": "week"}]})


def test_limit_is_clamped():
    plan = validate_plan({"dataset": "sectors", "limit": 10 ** 9})
    assert plan.limit == 5000


def test_chinese_alias_resolves_to_field():
    plan = _plan(dimensions=[{"field": "方位角"}])
    assert plan.dimensions[0].field == "方位角"  # 校验通过即可，解析在编译器里做


# ------------------------------------------------------------------ 编译

def test_compiler_injects_group_filter_and_limit():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(dimensions=[{"field": "tac"}], limit=50), FakeUser())
    assert "m.city = :" in compiled.sql and "m.operator = :" in compiled.sql
    assert compiled.sql.endswith("LIMIT 50")
    assert "河源" in compiled.params.values() and "移动" in compiled.params.values()


def test_compiler_rejects_user_without_group():
    from app.services.assistant.compiler import compile_plan

    with pytest.raises(PlanError):
        compile_plan(_plan(dimensions=[{"field": "tac"}]), FakeUser(city=None))


def test_ratio_compiled_from_components_not_average():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(dimensions=[{"field": "tac"}]), FakeUser(),
                            available_metric_ids={
                                "rrc_abnormal_release_times", "rrc_conn_setup_success"})
    assert "NULLIF(SUM(CASE WHEN" in compiled.sql
    assert "AVG(" not in compiled.sql
    assert compiled.degraded == []
    assert compiled.metric_meta[0]["components"]["numerator"] == "rrc_abnormal_release_times"


def test_ratio_degrades_with_reason_when_components_missing():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(dimensions=[{"field": "tac"}]), FakeUser(),
                            available_metric_ids={"call_drop_rate"})
    assert "AVG(" in compiled.sql
    assert compiled.degraded and "分子/分母" in compiled.degraded[0]


def test_values_are_parameterized_not_interpolated():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(filters=[{"field": "cell_name", "op": "=",
                                            "value": "A1' OR 1=1 --"}]), FakeUser())
    assert "OR 1=1" not in compiled.sql
    assert "A1' OR 1=1 --" in compiled.params.values()


def test_time_dimension_defaults_to_ascending_order():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(dimensions=[{"field": "metric_time",
                                               "bucket": "day"}]), FakeUser())
    assert compiled.sql.endswith("LIMIT 200")
    assert "ORDER BY d0 ASC" in compiled.sql


def test_metric_dataset_joins_sectors_for_workparam_dimensions():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(_plan(dimensions=[{"field": "tac"}]), FakeUser())
    assert "LEFT JOIN" in compiled.sql and "sec.name = m.cell_name" in compiled.sql


def test_sectors_dataset_counts_rows_by_default():
    from app.services.assistant.compiler import compile_plan

    compiled = compile_plan(validate_plan({"dataset": "sectors",
                                           "dimensions": [{"field": "network_type"}]}),
                            FakeUser())
    assert "COUNT(*)" in compiled.sql
    assert compiled.metric_meta[0]["metric"] == "小区数"
