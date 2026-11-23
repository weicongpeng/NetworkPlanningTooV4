"""分析链路集成测试（独立 SQLite）

守住的核心事实：
1. 数值正确：比率按分子分母汇总，与 pandas/Decimal 双实现逐值一致；
2. 组隔离：跨组 0 命中，组信息缺失直接拒绝；
3. 出图与明细同源，图上的数字 = 明细表里的数字。
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.models.database import Sector, Site, StationMetricRow, User, Workbook

CITY, OPERATOR = "河源", "移动"

# (小区, TAC, 制式, 日, 异常释放次数, 建立成功次数)
ROWS = [
    ("A1", 1, "LTE", "2026-08-01", 2, 100),
    ("A1", 1, "LTE", "2026-08-02", 2, 100),
    ("A2", 1, "LTE", "2026-08-01", 4, 100),
    ("A2", 1, "LTE", "2026-08-02", 4, 100),
    ("B1", 2, "NR", "2026-08-01", 10, 200),
    ("B1", 2, "NR", "2026-08-02", 10, 200),
]


class FakeUser:
    def __init__(self, city=CITY, operator=OPERATOR, uid=1):
        self.id = uid
        self.username = "tester"
        self.is_admin = False
        self.city = city
        self.operator = operator


@pytest.fixture()
def seeded(assistant_db):
    session = assistant_db["session"]
    db = session()
    db.add(User(id=1, username="tester", password_hash="x", is_admin=False,
                city=CITY, operator=OPERATOR, can_assistant=True))
    db.add(Workbook(id="w1", user_id=1, city=CITY, operator=OPERATOR, name="指标.xlsx",
                    file_type="station_metrics", status="ready",
                    created_at="2026-08-01T00:00:00"))
    db.commit()

    site_lte = Site(workbook_id="w1", user_id=1, city=CITY, operator=OPERATOR,
                    site_id="S1", name="站点A", longitude=114.0, latitude=23.0,
                    network_type="LTE")
    site_nr = Site(workbook_id="w1", user_id=1, city=CITY, operator=OPERATOR,
                   site_id="S2", name="站点B", longitude=114.05, latitude=23.05,
                   network_type="NR")
    db.add_all([site_lte, site_nr])
    db.commit()
    site_by_net = {"LTE": site_lte.id, "NR": site_nr.id}
    for i, (name, tac, net, *_rest) in enumerate(ROWS[::2]):
        db.add(Sector(workbook_id="w1", user_id=1, city=CITY, operator=OPERATOR,
                      site_id_fk=site_by_net[net], sector_id=f"s{i}", name=name,
                      longitude=114.0 + i * 0.01, latitude=23.0 + i * 0.01,
                      tac=tac, pci=100 + i, frequency=1800.0 if net == "LTE" else 3500.0))
    db.commit()

    metric_rows = []
    for cell, _tac, _net, day, num, den in ROWS:
        base = dict(workbook_id="w1", user_id=1, city=CITY, operator=OPERATOR,
                    cell_name=cell, granularity="day",
                    metric_time=datetime.strptime(day, "%Y-%m-%d"),
                    created_at="2026-08-03T00:00:00")
        metric_rows.append({**base, "metric_name": "RRC异常释放次数",
                            "metric_id": "rrc_abnormal_release_times", "metric_value": num})
        metric_rows.append({**base, "metric_name": "RRC连接建立成功次数",
                            "metric_id": "rrc_conn_setup_success", "metric_value": den})
    db.bulk_insert_mappings(StationMetricRow, metric_rows)
    db.commit()
    db.close()
    yield assistant_db


def _analyze(plan, user=None):
    from app.services.assistant import query_service

    return query_service.analyze(plan, user=user or FakeUser())


# ------------------------------------------------------------------ 数值正确性

def test_drop_rate_by_tac_aggregates_components(seeded):
    """TAC1: (2+2+4+4)/(100*4)=3%；TAC2: (10+10)/(200*2)=5%"""
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "tac"}],
                    "order_by": [{"field": "掉线率", "dir": "desc"}]})
    assert res["ok"], res
    assert res["rows"] == [{"tac": 2, "掉线率": pytest.approx(5.0)},
                           {"tac": 1, "掉线率": pytest.approx(3.0)}]


def test_ratio_matches_independent_decimal_recomputation(seeded):
    """双实现交叉验证：SQL 结果 vs 纯 Python Decimal 复算（容差 1e-9）。"""
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "cell_name"}]})
    assert res["ok"], res
    by_cell = {}
    for cell, _tac, _net, _day, num, den in ROWS:
        agg = by_cell.setdefault(cell, [0, 0])
        agg[0] += num
        agg[1] += den
    expected = {cell: Decimal(num) * 100 / Decimal(den) for cell, (num, den) in by_cell.items()}
    for row in res["rows"]:
        assert abs(Decimal(str(row["掉线率"])) - expected[row["cell_name"]]) < Decimal("1e-9")


def test_trend_is_time_ordered(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "metric_time", "bucket": "day"}],
                    "filters": [{"field": "cell_name", "op": "=", "value": "A1"}]})
    assert res["ok"], res
    assert [r["时间(日)"] for r in res["rows"]] == ["2026-08-01", "2026-08-02"]
    assert all(r["掉线率"] == pytest.approx(2.0) for r in res["rows"])


def test_topn_respects_order_and_limit(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "cell_name"}],
                    "order_by": [{"field": "掉线率", "dir": "desc"}], "limit": 2})
    assert [r["cell_name"] for r in res["rows"]] == ["B1", "A2"]


def test_cross_table_compare_by_network_type(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "network_type"}]})
    values = {r["network_type"]: r["掉线率"] for r in res["rows"]}
    assert values["LTE"] == pytest.approx(3.0)
    assert values["NR"] == pytest.approx(5.0)


def test_sectors_dataset_counts_cells(seeded):
    res = _analyze({"dataset": "sectors", "dimensions": [{"field": "network_type"}]})
    assert {r["network_type"]: r["小区数"] for r in res["rows"]} == {"LTE": 2, "NR": 1}


# ------------------------------------------------------------------ 出图与配方

def test_chart_matches_table_numbers(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "tac"}], "chart": "bar"})
    chart = res["artifacts"]["charts"][0]
    table = res["artifacts"]["table"]
    assert chart["type"] == "bar"
    assert chart["series"][0]["data"] == [row["掉线率"] for row in table["rows"]]


def test_provenance_records_scope_and_aggregation(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "tac"}],
                    "time_range": {"start": "2026-08-01", "end": "2026-08-01"}})
    prov = res["artifacts"]["provenance"]
    assert prov["dataset"] == "metrics"
    assert prov["metrics"][0]["aggregation"] == "ratio"
    assert prov["time_range"] == {"start": "2026-08-01", "end": "2026-08-01"}
    assert prov["row_count"] == len(res["rows"])
    assert "掉线率=ratio" in res["recipe"]


# ------------------------------------------------------------------ 组隔离与安全

def test_other_group_sees_nothing(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "tac"}]},
                   user=FakeUser(city="深圳"))
    assert res["ok"], res
    assert res["rows"] == [] and res["row_count"] == 0


def test_user_without_group_is_rejected(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}]},
                   user=FakeUser(city=None))
    assert res["ok"] is False
    assert "地市/运营商" in res["error"]


def test_illegal_field_is_rejected_before_sql(seeded):
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
                    "dimensions": [{"field": "tac) OR (1=1"}]})
    assert res["ok"] is False
    assert "可用字段" in res["error"]


def test_unknown_metric_is_reported_not_silently_null(seeded):
    """未知指标不能静默返回一串 NULL，必须显式报错并引导查 catalog。"""
    res = _analyze({"dataset": "metrics", "metrics": [{"metric": "不存在的指标"}],
                    "dimensions": [{"field": "tac"}]})
    assert res["ok"] is False
    assert "catalog" in res["hint"]


# ------------------------------------------------------------------ golden 回归集

GOLDEN_CASES = [
    (
        "按 TAC 掉线率排名",
        {"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
         "dimensions": [{"field": "tac"}],
         "order_by": [{"field": "掉线率", "dir": "desc"}]},
        [{"tac": 2, "掉线率": 5.0}, {"tac": 1, "掉线率": 3.0}],
    ),
    (
        "最差两个小区",
        {"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
         "dimensions": [{"field": "cell_name"}],
         "order_by": [{"field": "掉线率", "dir": "desc"}], "limit": 2},
        [{"cell_name": "B1", "掉线率": 5.0}, {"cell_name": "A2", "掉线率": 4.0}],
    ),
    (
        "异常释放次数按小区汇总（累计量用 sum，不是平均）",
        {"dataset": "metrics", "metrics": [{"metric": "掉线次数"}],
         "dimensions": [{"field": "cell_name"}],
         "order_by": [{"field": "掉线次数", "dir": "desc"}]},
        [{"cell_name": "B1", "掉线次数": 20.0}, {"cell_name": "A2", "掉线次数": 8.0},
         {"cell_name": "A1", "掉线次数": 4.0}],
    ),
    (
        "制式对比",
        {"dataset": "metrics", "metrics": [{"metric": "掉线率"}],
         "dimensions": [{"field": "network_type"}],
         "order_by": [{"field": "network_type", "dir": "asc"}]},
        [{"network_type": "LTE", "掉线率": 3.0}, {"network_type": "NR", "掉线率": 5.0}],
    ),
    (
        "工参按制式计数",
        {"dataset": "sectors", "dimensions": [{"field": "network_type"}],
         "order_by": [{"field": "network_type", "dir": "asc"}]},
        [{"network_type": "LTE", "小区数": 2}, {"network_type": "NR", "小区数": 1}],
    ),
]


@pytest.mark.parametrize("name,plan,expected", GOLDEN_CASES, ids=[c[0] for c in GOLDEN_CASES])
def test_golden_cases(seeded, name, plan, expected):
    res = _analyze(plan)
    assert res["ok"], f"{name}: {res}"
    rows = res["rows"]
    assert len(rows) == len(expected), f"{name}: 行数不符 {rows}"
    for got, want in zip(rows, expected):
        assert set(want) <= set(got), f"{name}: 列缺失 {got}"
        for key, value in want.items():
            assert got[key] == pytest.approx(value), f"{name}: {key} 期望 {value} 实际 {got[key]}"


# ------------------------------------------------------------------ 小区级工具回归

def test_get_cell_workparams_reports_network_type(seeded):
    """制式在 sites 表上：曾经直接取 Sector.network_type 抛 AttributeError。"""
    from app.services.assistant import query_service

    res = query_service.get_cell_workparams("A1", user=FakeUser())
    assert res["found"] is True
    assert res["network_type"] == "LTE"
    assert res["tac"] == 1


def test_find_nearby_sites_filters_by_network_type(seeded):
    from app.services.assistant import query_service

    res = query_service.find_nearby_sites("A1", radius_km=50, user=FakeUser())
    assert res["found"] is True
    assert res["count"] >= 3
    assert all(s["network_type"] for s in res["sites"])

    only_lte = query_service.find_nearby_sites("A1", radius_km=50, network_type="LTE",
                                               user=FakeUser())
    assert only_lte["sites"] and all(s["network_type"] == "LTE" for s in only_lte["sites"])


def test_search_cells_ranks_exact_match_first(seeded):
    from app.services.assistant import query_service

    assert query_service.search_cells("A1", user=FakeUser())["cells"][0] == "A1"
