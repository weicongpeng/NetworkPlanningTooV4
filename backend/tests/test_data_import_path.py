# backend/tests/test_data_import_path.py
"""数据导入路径（map_layer 图层文件 / current_params 现网工参）标记测试"""
import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import create_app
from app.core.security import require_data_import


def _make_client():
    app = create_app()
    # upload_map 会用到 current_user.id / city / operator，这里给一个最小用户对象
    app.dependency_overrides[require_data_import] = lambda: SimpleNamespace(
        id=1, city=None, operator=None
    )
    return TestClient(app)


def test_upload_map_endpoint_forwards_import_path(monkeypatch):
    """上传地图文件时把用户导入路径（file_type）透传给服务层"""
    from app.services import data_service as ds_mod

    captured = {}

    async def fake_upload_map(file, original_path=None, files=None, user_id=1,
                              city=None, operator=None, file_type=None):
        captured["file_type"] = file_type
        return {"id": "x", "name": "a.zip", "status": "ready"}

    monkeypatch.setattr(ds_mod.data_service, "upload_map", fake_upload_map)
    client = _make_client()
    resp = client.post(
        "/api/v1/data/upload/map",
        data={"file_type": "current_params"},
        files={"file": ("a.zip", b"PK\x03\x04fake", "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    assert captured["file_type"] == "current_params"


def test_upload_map_endpoint_without_import_path(monkeypatch):
    """未带导入路径时保持 None（兼容旧前端）"""
    from app.services import data_service as ds_mod

    captured = {}

    async def fake_upload_map(file, original_path=None, files=None, user_id=1,
                              city=None, operator=None, file_type=None):
        captured["file_type"] = file_type
        return {"id": "x", "name": "a.zip", "status": "ready"}

    monkeypatch.setattr(ds_mod.data_service, "upload_map", fake_upload_map)
    client = _make_client()
    resp = client.post(
        "/api/v1/data/upload/map",
        files={"file": ("a.zip", b"PK\x03\x04fake", "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    assert captured["file_type"] is None


def test_mark_map_import_paths_distinguishes_current_params(tmp_path, monkeypatch):
    """历史 map 条目：含网管 CellInfo CSV → 现网工参，否则 → 图层文件"""
    from app.services import data_service as ds_mod

    svc = ds_mod.data_service
    monkeypatch.setattr(ds_mod.settings, "DATA_DIR", tmp_path)

    current_dir = tmp_path / "current_entry"
    current_dir.mkdir()
    (current_dir / "LTE_SDR_CellInfo_20261111.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    layer_dir = tmp_path / "layer_entry"
    layer_dir.mkdir()
    (layer_dir / "sector.tab").write_text("x", encoding="utf-8")

    original_index = dict(svc.index)
    try:
        svc.index.clear()
        svc.index["current_entry"] = {"id": "current_entry", "type": "map"}
        svc.index["layer_entry"] = {"id": "layer_entry", "type": "map"}
        svc.index["already"] = {"id": "already", "type": "map", "fileType": "map_layer"}
        svc._mark_map_import_paths()
        assert svc.index["current_entry"]["fileType"] == "current_params"
        assert svc.index["layer_entry"]["fileType"] == "map_layer"
        # 已有 fileType 的条目不被覆盖
        assert svc.index["already"]["fileType"] == "map_layer"
    finally:
        svc.index.clear()
        svc.index.update(original_index)


def test_downloadable_file_rejects_directories_and_unknown_suffixes(tmp_path):
    """下载候选必须是普通文件且后缀受支持：同名目录/损坏索引条目不得变成 500。"""
    from app.api.v1.endpoints.data import _DOWNLOAD_SUFFIXES, _downloadable_file

    for suffix in (".xlsx", ".xls", ".zip", ".csv", ".txt"):
        p = tmp_path / f"f{suffix}"
        p.write_text("x", encoding="utf-8")
        assert _downloadable_file(p) is True

    assert _downloadable_file(tmp_path / "missing.xlsx") is False
    (tmp_path / "as_dir.xlsx").mkdir()
    assert _downloadable_file(tmp_path / "as_dir.xlsx") is False
    (tmp_path / "a.tab").write_text("x", encoding="utf-8")
    assert _downloadable_file(tmp_path / "a.tab") is False
    assert ".csv" in _DOWNLOAD_SUFFIXES and ".txt" in _DOWNLOAD_SUFFIXES


def test_upload_map_marks_index_entry(tmp_path, monkeypatch):
    """服务层：带导入路径上传后，索引条目记录该 fileType"""
    from app.services import data_service as ds_mod

    svc = ds_mod.data_service
    monkeypatch.setattr(ds_mod.settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(ds_mod.settings, "UPLOAD_DIR", tmp_path / "uploads")
    (tmp_path / "uploads").mkdir(parents=True, exist_ok=True)

    # 普通（非图层/非 ZIP）文件 → upload_map 兜底分支，无需 GDAL 解析
    src = tmp_path / "plain.map"
    src.write_text("dummy", encoding="utf-8")

    original_index = dict(svc.index)
    try:
        svc.index.clear()
        asyncio.run(svc.upload_map(None, str(src), file_type="map_layer"))
        assert len(svc.index) == 1
        entry = next(iter(svc.index.values()))
        assert entry["fileType"] == "map_layer"
    finally:
        svc.index.clear()
        svc.index.update(original_index)
