"""桌面端共享模式同步：地理化数据（geo_data）必须保真跨端。

回归点（用户报告：同组其它端同步后「已导入数据」不标注扇区、地图只渲染一个
扇区方向且属性不对）：

- 打包必须包含 `data/<id>/default.json`（地理化数据真身），不能只打包源 Excel
- 解包必须**原样落地条目**（`fileType=geo_data` / `geometryType` / `metadata` 保留），
  不得走工参 Excel 管线——`_process_upload_sync` 会用解析结果覆盖 `fileType`
  （data_service.py 的 `self.index[data_id].update({"fileType": file_type, ...})`），
  接收端于是认不出「扇区数据」，地图回退成工参扇区渲染
- 解包必须补 `geo_files` 元数据行：启动对账以「geo_files 有行 或 default.json 存在」
  为有效依据，缺行会让条目在下次重启被当无效索引删除
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

GEO_ID = "geo-sector-1"


@pytest.fixture()
def geo_env(tmp_path, monkeypatch):
    """隔离 DATA_DIR / UPLOAD_DIR / 索引，构造一个「已上传的扇区地理化数据集」。"""
    from app.core.config import settings
    from app.services.data_service import data_service

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    (data_dir / GEO_ID).mkdir(parents=True)
    upload_dir.mkdir(parents=True)

    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(settings, "OUTPUT_DIR", tmp_path / "outputs")

    # data_service 是单例：index 与 index.json 路径在 __init__ 时已固定，需一并替换
    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")

    # 修订号会写生产库的 dataset_revisions 表，测试里无意义
    monkeypatch.setattr(
        "app.services.dataset_revision_service.bump", lambda *a, **kw: None
    )

    # geo_data 上传链路把源文件留在 uploads/<id>.xlsx（不落 data/<id>/original.xlsx）
    (upload_dir / f"{GEO_ID}.xlsx").write_bytes(b"PK\x03\x04 fake-xlsx")

    # 数据真身：default.json
    (data_dir / GEO_ID / "default.json").write_text(
        json.dumps([{"name": "cell-1", "lat": 23.1, "lng": 113.2, "azimuth": 30}],
                   ensure_ascii=False),
        encoding="utf-8",
    )

    entry = {
        "id": GEO_ID,
        "name": "扇区地理化数据.xlsx",
        "type": "excel",            # 注意：geo_data 条目的 type 也是 excel
        "fileType": "geo_data",
        "geometryType": "sector",
        "sourceType": "excel",
        "size": 123,
        "uploadDate": "2026-10-07T09:00:00",
        "status": "ready",
        "user_id": 1,
        "city": "广州",
        "operator": "移动",
        "metadata": {"pointCount": 1},
    }
    data_service.index[GEO_ID] = dict(entry)

    captured: dict = {}
    monkeypatch.setattr(
        "app.services.geo_data_service._save_geo_file_metadata",
        lambda **kw: captured.update(kw),
    )

    return {
        "data_dir": data_dir,
        "upload_dir": upload_dir,
        "entry": entry,
        "captured": captured,
        "data_service": data_service,
    }


def _pack(geo_env) -> Path:
    from app.services.desktop_dataset_packager import build_package

    package = build_package(GEO_ID)
    return Path(package["path"])


def test_package_includes_geo_payload_and_source(geo_env):
    """default.json（真身）与源文件都必须入包。"""
    zip_path = _pack(geo_env)
    names = zipfile.ZipFile(zip_path).namelist()

    assert "default.json" in names
    assert "meta.json" in names
    assert any(n.startswith("source.") for n in names), names


def test_install_keeps_geo_entry_intact(geo_env, monkeypatch):
    """解包后条目仍是 geo_data + geometryType=sector，且不经工参 Excel 管线。"""
    from app.services import desktop_dataset_packager as packager
    from app.services.data_service import data_service

    def _must_not_run(*_a, **_kw):  # pragma: no cover - 只在回归时触发
        raise AssertionError("geo_data 不得走工参 Excel 管线（_process_upload_sync）")

    monkeypatch.setattr(data_service, "_process_upload_sync", _must_not_run)

    zip_path = _pack(geo_env)
    result = packager.install_package(
        zip_path, user_id=7, city="深圳", operator="联通", username="tester"
    )

    assert result == {"data_id": GEO_ID, "type": "excel"}

    entry = data_service.index[GEO_ID]
    assert entry["fileType"] == "geo_data"
    assert entry["geometryType"] == "sector"
    assert entry["metadata"] == {"pointCount": 1}
    assert entry["status"] == "ready"
    # 接收方组强制盖章
    assert (entry["city"], entry["operator"]) == ("深圳", "联通")
    assert entry["user_id"] == 7


def test_install_restores_files(geo_env):
    """default.json 落到接收端；源文件回 uploads/ 以便反向 push 再次打包。"""
    from app.services.desktop_dataset_packager import install_package

    zip_path = _pack(geo_env)
    install_package(zip_path, user_id=7, city="深圳", operator="联通")

    data_dir = geo_env["data_dir"] / GEO_ID
    assert (data_dir / "default.json").is_file()
    # 包内的 source.* 已搬回 uploads/，不再残留在数据目录
    assert not list(data_dir.glob("source.*"))
    assert (geo_env["upload_dir"] / f"{GEO_ID}.xlsx").is_file()


def test_install_writes_geo_file_metadata(geo_env):
    """必须补 geo_files 行，否则启动对账会把条目当无效索引删除。"""
    from app.services.desktop_dataset_packager import install_package

    zip_path = _pack(geo_env)
    install_package(zip_path, user_id=7, city="深圳", operator="联通", username="tester")

    captured = geo_env["captured"]
    assert captured, "未调用 geo 元数据写入"
    assert captured["geo_id"] == GEO_ID
    assert captured["geometry_type"] == "sector"
    assert captured["point_count"] == 1
    assert captured["filename"] == "扇区地理化数据.xlsx"
    assert (captured["city"], captured["operator"]) == ("深圳", "联通")
    assert captured["user_id"] == 7
    assert captured["file_path"].endswith("default.json")
