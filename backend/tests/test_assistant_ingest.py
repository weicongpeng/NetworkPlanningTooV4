"""助手数据集入库测试：口径 ID 解析、列画像、数据目录、组隔离删除。"""
import pytest

CSV = (
    "小区名称,统计时间,RRC异常释放次数,RRC连接建立成功次数,掉线率(%)\n"
    "A1,2026-08-01,2,100,2.0\n"
    "A2,2026-08-01,4,100,4.0\n"
    "A1,2026-08-02,2,100,2.0\n"
)


class FakeUser:
    def __init__(self, city="河源", operator="移动", uid=1):
        self.id = uid
        self.city = city
        self.operator = operator
        self.is_admin = False


@pytest.fixture()
def ingested(assistant_db):
    from app.models.database import User

    session = assistant_db["session"]
    db = session()
    db.add(User(id=1, username="tester", password_hash="x", city="河源",
                operator="移动", can_assistant=True))
    db.commit()
    db.close()

    path = assistant_db["tmp"] / "metrics.csv"
    path.write_text(CSV, encoding="utf-8")
    source = assistant_db["tmp"] / "upload.csv"
    source.write_text(CSV, encoding="utf-8")

    from app.services.assistant import ingest_service

    summary = ingest_service.ingest_file(str(source), "metrics.csv", 1, "河源", "移动")
    return {**assistant_db, "summary": summary}


def test_metric_columns_get_metric_id(ingested):
    from app.models.database import StationMetricRow

    session = ingested["session"]
    db = session()
    ids = {row[0] for row in db.query(StationMetricRow.metric_id).distinct().all()}
    db.close()
    assert "rrc_abnormal_release_times" in ids
    assert "rrc_conn_setup_success" in ids
    assert "call_drop_rate" in ids


def test_workbook_metadata_records_metric_ids_and_profile(ingested):
    meta = ingested["summary"]
    assert meta["fileType"] == "station_metrics"
    assert "call_drop_rate" in meta["metricIds"]
    columns = meta["columns"]
    assert columns["RRC异常释放次数"]["role"] == "metric"
    assert columns["RRC异常释放次数"]["type"] == "number"
    assert columns["小区名称"]["distinct"] >= 1


def test_catalog_lists_real_metrics(ingested):
    from app.services.assistant import catalog

    cat = catalog.build_catalog(FakeUser())
    assert cat["metrics"]["row_count"] == 9  # 3 行 × 3 指标列
    assert cat["metrics"]["cell_count"] == 2
    assert "call_drop_rate" in cat["metrics"]["resolved_metric_ids"]
    rendered = catalog.render_prompt(cat)
    assert "掉线率" in rendered or "call_drop_rate" in rendered


def test_delete_dataset_is_group_scoped(ingested):
    from app.services.assistant import ingest_service

    dataset_id = ingested["summary"]["id"]
    # 跨组删除应被拒绝
    assert ingest_service.delete_dataset(dataset_id, FakeUser(city="深圳")) is False
    # 同组可删
    assert ingest_service.delete_dataset(dataset_id, FakeUser()) is True


def test_ratio_trend_from_ingested_file(ingested):
    """入库 → 分析全链路：掉线率按天应为 3%（(2+4)/(100+100)）。"""
    from app.services.assistant import query_service

    res = query_service.analyze({
        "dataset": "metrics",
        "metrics": [{"metric": "掉线率"}],
        "dimensions": [{"field": "metric_time", "bucket": "day"}],
        "time_range": {"start": "2026-08-01", "end": "2026-08-01"},
    }, user=FakeUser())
    assert res["ok"], res
    assert res["rows"][0]["掉线率"] == pytest.approx(3.0)
