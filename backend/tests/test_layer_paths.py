"""图层源文件路径解析：跨机器 / 跨数据根同步后的路径自愈。"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from app.services.layer_paths import (
    layer_source_suffix,
    rebase_layer_entries,
    resolve_layer_source_path,
)


def _write_layers(data_dir: Path, entries):
    (data_dir / "layers.json").write_text(
        json.dumps(entries, ensure_ascii=False), encoding="utf-8"
    )


def test_resolve_foreign_windows_path_falls_back_to_local_file(tmp_path: Path):
    """记录 Windows 绝对路径、文件实际在当前 data_dir → 按文件名回退命中。"""
    data_dir = tmp_path / "data" / "abc"
    data_dir.mkdir(parents=True)
    local = data_dir / "图层_point.tab"
    local.write_bytes(b"fake-tab")

    entry = {
        "id": "layer-1",
        "name": "图层_point",
        "metadata": {
            "source_file": r"C:\Users\weico\AppData\Roaming\NetworkPlanningTool\data\abc\图层_point.tab"
        },
    }
    assert resolve_layer_source_path(data_dir, entry) == local
    assert layer_source_suffix(entry) == ".tab"


def test_resolve_foreign_posix_path_and_nested_dir(tmp_path: Path):
    """记录 POSIX 绝对路径、文件在 zip 解压出的子目录 → 递归按文件名命中。"""
    data_dir = tmp_path / "data" / "abc"
    nested = data_dir / "sub"
    nested.mkdir(parents=True)
    local = nested / "road.shp"
    local.write_bytes(b"fake-shp")

    entry = {
        "id": "layer-2",
        "name": "road",
        "metadata": {"source_file": "/home/pwc/NetworkPlanningTooV3/data/abc/road.shp"},
    }
    assert resolve_layer_source_path(data_dir, entry) == local


def test_resolve_by_layer_name_when_source_missing(tmp_path: Path):
    """metadata 没有 source_file（旧索引/恢复条目）→ 按图层名找源文件。"""
    data_dir = tmp_path / "data" / "abc"
    data_dir.mkdir(parents=True)
    local = data_dir / "区域.geojson"
    local.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")

    entry = {"id": "layer-3", "name": "区域"}
    assert resolve_layer_source_path(data_dir, entry) == local


def test_rebase_layer_entries_rewrites_and_persists(tmp_path: Path):
    """校正后的绝对路径写回 layers.json，供后续各服务直接使用。"""
    data_dir = tmp_path / "data" / "abc"
    data_dir.mkdir(parents=True)
    local = data_dir / "a.tab"
    local.write_bytes(b"fake-tab")
    stale = r"D:\old-machine\data\abc\a.tab"
    _write_layers(data_dir, [{"id": "l1", "name": "a", "metadata": {"source_file": stale}}])

    layers, changed = rebase_layer_entries(data_dir)

    assert changed is True
    assert layers[0]["metadata"]["source_file"] == str(local)
    persisted = json.loads((data_dir / "layers.json").read_text(encoding="utf-8"))
    assert persisted[0]["metadata"]["source_file"] == str(local)


def test_install_package_rebases_layer_paths(tmp_path: Path, monkeypatch):
    """共享模式装包：包内 layers.json 的打包端绝对路径必须改成本机路径。"""
    from app.core.config import settings
    from app.services import desktop_dataset_packager as packager
    from app.services.data_service import data_service

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir()
    upload_dir.mkdir()
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(data_service, "index", {})
    monkeypatch.setattr(data_service, "data_index_file", data_dir / "index.json")
    monkeypatch.setattr(
        "app.services.dataset_revision_service.bump", lambda *a, **kw: None
    )

    data_id = "map-sync-1"
    stale = rf"C:\Users\weico\AppData\Roaming\NetworkPlanningTool\data\{data_id}\电联图层.tab"
    entry = {
        "id": data_id,
        "name": "电联图层.tab",
        "type": "map",
        "subType": "mapinfo",
        "fileType": "tac_layer",
        "status": "ready",
        "user_id": 1,
        "city": "广州",
        "operator": "移动",
        "metadata": {
            "layerCount": 1,
            "layers": [{
                "id": "layer-1",
                "name": "电联图层",
                "type": "point",
                "feature_count": 0,
                "metadata": {"source_file": stale, "feature_count": 0},
            }],
        },
    }

    package = tmp_path / "pkg.zip"
    with zipfile.ZipFile(package, "w") as zf:
        zf.writestr("meta.json", json.dumps(
            {"version": packager.PACKAGE_VERSION, "data_id": data_id, "entry": entry},
            ensure_ascii=False,
        ))
        zf.writestr("电联图层.tab", b"fake-tab")
        zf.writestr("layers.json", json.dumps(entry["metadata"]["layers"], ensure_ascii=False))

    packager.install_package(package, user_id=1, city="广州", operator="移动")

    local_tab = data_dir / data_id / "电联图层.tab"
    assert local_tab.exists()
    layers = json.loads((data_dir / data_id / "layers.json").read_text(encoding="utf-8"))
    assert layers[0]["metadata"]["source_file"] == str(local_tab)
    idx_layers = data_service.index[data_id]["metadata"]["layers"]
    assert idx_layers[0]["metadata"]["source_file"] == str(local_tab)
