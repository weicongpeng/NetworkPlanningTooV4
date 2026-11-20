"""地理化数据导入：经纬度为 0 的 coord_zero 非致命提醒

回归背景：源文件存在 (0,0) 行时，热力场范围会被撑到跨洲尺度，渲染出离采样区
数百公里的虚假热区。导入侧保留数据不动，但必须给出与全量工参一致的 coord_zero
提醒，让用户能定位并修正源文件。
"""
import json

import pandas as pd

from app.services import geo_data_service


def _write_csv(tmp_path, rows):
    path = tmp_path / "cells.csv"
    pd.DataFrame(rows).to_csv(path, index=False, encoding="gbk")
    return path


def test_parse_geo_data_reports_coord_zero(tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        geo_data_service, "_save_geo_file_metadata", lambda **kw: captured.update(kw)
    )

    # 两行坐标含 0（一行 (0,0)、一行纬度 0）；缺坐标行被丢弃但不计入 0 值
    path = _write_csv(tmp_path, {
        "小区名称": ["a", "b", "c", "d", "e"],
        "经度": [114.6, 0, 114.7, 114.8, None],
        "纬度": [24.1, 0, 0, 24.2, 24.3],
        "方向角": [30, 60, 90, 120, 150],
    })

    result = geo_data_service.GeoDataService().parse_geo_data(
        str(path), "cells.csv", geo_id="geo-warn-1"
    )

    assert result["pointCount"] == 4
    assert result["importWarnings"] == [{"code": "coord_zero", "count": 2}]
    assert captured["import_warnings"] == [{"code": "coord_zero", "count": 2}]


def test_parse_geo_data_clean_file_marks_checked(tmp_path, monkeypatch):
    """无问题文件也写入空列表：区别于 NULL（存量未检查），避免启动回填重复扫描。"""
    captured = {}
    monkeypatch.setattr(
        geo_data_service, "_save_geo_file_metadata", lambda **kw: captured.update(kw)
    )

    path = _write_csv(tmp_path, {
        "小区名称": ["a", "b"],
        "经度": [114.6, 114.7],
        "纬度": [24.1, 24.2],
    })

    result = geo_data_service.GeoDataService().parse_geo_data(
        str(path), "cells.csv", geo_id="geo-warn-2"
    )

    assert result["importWarnings"] == []
    assert captured["import_warnings"] == []


def test_geo_file_metadata_exposes_warnings():
    """列表/索引重建从 geo_files.import_warnings 还原提醒；坏 JSON 不影响列表。"""
    from types import SimpleNamespace

    from app.services.data_service import geo_file_metadata

    assert geo_file_metadata(SimpleNamespace(point_count=5, import_warnings=None)) == {
        "pointCount": 5
    }
    assert geo_file_metadata(SimpleNamespace(
        point_count=5,
        import_warnings='[{"code": "coord_zero", "count": 2}]',
    )) == {
        "pointCount": 5,
        "importWarnings": [{"code": "coord_zero", "count": 2}],
    }
    assert geo_file_metadata(SimpleNamespace(point_count=5, import_warnings="not-json")) == {
        "pointCount": 5
    }


def test_backfill_geo_coord_zero_warnings(tmp_path, monkeypatch):
    """存量条目（import_warnings=NULL）从 default.json 补算，且只补一次。"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    from app.models.database import GeoFile
    from app.services import data_service as mod

    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)

    data_dir = tmp_path / "data"
    payload_dir = data_dir / "geo-legacy"
    payload_dir.mkdir(parents=True)
    (payload_dir / "default.json").write_text(json.dumps([
        {"longitude": 114.6, "latitude": 24.1},
        {"longitude": 0, "latitude": 0},
        {"longitude": 114.7, "latitude": 0},
    ]), encoding="utf-8")

    db = TestSession()
    db.add(GeoFile(
        id="geo-legacy", user_id=1, filename="legacy.xlsx",
        file_path=str(payload_dir / "default.json"), geometry_type="sector",
        point_count=3, created_at="2026-10-01T00:00:00",
    ))
    db.commit()
    db.close()

    monkeypatch.setattr(mod, "SessionLocal", TestSession)
    monkeypatch.setattr(mod.data_service, "_bound_data_dir", data_dir)
    monkeypatch.setattr(mod.data_service, "index", {
        "geo-legacy": {"id": "geo-legacy", "fileType": "geo_data", "metadata": {"pointCount": 3}},
    })
    monkeypatch.setattr(mod.data_service, "_save_index", lambda: None)

    assert mod.data_service.backfill_geo_coord_zero_warnings() == 1
    assert mod.data_service.index["geo-legacy"]["metadata"]["importWarnings"] == [
        {"code": "coord_zero", "count": 2}
    ]

    db = TestSession()
    saved = db.query(GeoFile).filter(GeoFile.id == "geo-legacy").first()
    assert json.loads(saved.import_warnings) == [{"code": "coord_zero", "count": 2}]
    db.close()

    # 已检查过的条目不再重复扫描
    assert mod.data_service.backfill_geo_coord_zero_warnings() == 0

