"""图层保存端点：gzip 压缩请求体 / 明文 JSON 兼容 / 保存后属性写回。

覆盖点：
- 请求体 gzip（Content-Encoding: gzip，前端大图层保存默认）与明文 JSON 均可保存
- 保存返回成功且 TAB 属性按 payload 更新（读回校验，确认非空 schema 与 dtype 读取正确）
"""
import gzip
import json
from types import SimpleNamespace

import geopandas as gpd
import pytest
from shapely.geometry import Point

from app.core.config import settings
from app.core.security import require_data_update
from app.services.tab_io import write_mapinfo_tab


@pytest.fixture()
def layer_env(tmp_path, monkeypatch):
    """临时 DATA_DIR + 单个可编辑 TAB 图层（点，含 name/等级 列）。"""
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    # 不写 SQLite layers 表（测试环境无需元数据行）
    monkeypatch.setattr(
        "app.services.layer_edit_service._upsert_layer_metadata",
        lambda **kw: None,
    )

    data_id = "test-data-id"
    layer_id = "layer-1"
    data_dir = tmp_path / data_id
    data_dir.mkdir(parents=True)
    tab_path = data_dir / "编辑测试.tab"
    gdf = gpd.GeoDataFrame(
        {"name": ["A", "B"], "等级": ["1", "2"]},
        geometry=[Point(114.0, 23.0), Point(114.01, 23.01)],
        crs="EPSG:4326",
    )
    write_mapinfo_tab(gdf, tab_path, geometry_type="Point")
    (data_dir / "layers.json").write_text(
        json.dumps([{
            "id": layer_id, "name": "编辑测试", "type": "point",
            "metadata": {"source_file": str(tab_path), "editable": True},
        }], ensure_ascii=False),
        encoding="utf-8",
    )
    return {"data_id": data_id, "layer_id": layer_id, "tab": tab_path}


def _client():
    from fastapi.testclient import TestClient
    from app.api import create_app

    app = create_app()
    # 跳过鉴权（本用例只验证保存链路）：权限依赖与数据组门禁一并覆盖
    app.dependency_overrides[require_data_update] = lambda: SimpleNamespace(id=1)
    from app.core.data_access import require_data_group_access
    app.dependency_overrides[require_data_group_access] = lambda: SimpleNamespace(id=1, city=None, operator=None, is_admin=True)
    return TestClient(app)


def _payload():
    return {
        "geojson": {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "properties": {"name": "A2", "等级": "9"},
                 "geometry": {"type": "Point", "coordinates": [114.0, 23.0]}},
                {"type": "Feature", "properties": {"name": "B", "等级": "2"},
                 "geometry": {"type": "Point", "coordinates": [114.01, 23.01]}},
            ],
        }
    }


def _read_names(tab_path):
    g = gpd.read_file(tab_path)
    return sorted(str(v) for v in g["name"].tolist()), sorted(str(v) for v in g["等级"].tolist())


def test_save_layer_plain_json(layer_env):
    """明文 JSON 请求体兼容（回退路径）"""
    client = _client()
    url = f"/api/v1/data/{layer_env['data_id']}/layers/{layer_env['layer_id']}/data"
    resp = client.put(url, json=_payload())
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    assert resp.json()["data"]["feature_count"] == 2
    names, levels = _read_names(layer_env["tab"])
    assert names == ["A2", "B"]
    assert levels == ["2", "9"]


def test_save_layer_gzip_body(layer_env):
    """gzip 压缩请求体（Content-Encoding: gzip）：解压后保存，属性写回生效"""
    client = _client()
    url = f"/api/v1/data/{layer_env['data_id']}/layers/{layer_env['layer_id']}/data"
    raw = json.dumps(_payload(), ensure_ascii=False).encode("utf-8")
    resp = client.put(
        url,
        content=gzip.compress(raw),
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["feature_count"] == 2
    names, levels = _read_names(layer_env["tab"])
    assert names == ["A2", "B"]
    assert levels == ["2", "9"]


def _patch_payload(env, value="9"):
    from app.services.layer_edit_service import layer_version
    return {
        "patch": {
            "base": {"count": 2, "version": layer_version(env["tab"], env["layer_id"])},
            "upserts": [{"row": 0, "properties": {"name": "A3", "等级": value}}],
        }
    }


def test_patch_save_uses_incremental_path(layer_env):
    """patch 请求体走增量路径：只改目标行，返回 mode=patch"""
    client = _client()
    url = f"/api/v1/data/{layer_env['data_id']}/layers/{layer_env['layer_id']}/data"
    resp = client.put(url, json=_patch_payload(layer_env))
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["mode"] == "patch"
    names, levels = _read_names(layer_env["tab"])
    assert names == ["A3", "B"]
    assert levels == ["2", "9"]


def test_patch_save_conflict_returns_409(layer_env):
    """基底版本/行数不一致 → 409（前端据此回退整层保存）"""
    client = _client()
    url = f"/api/v1/data/{layer_env['data_id']}/layers/{layer_env['layer_id']}/data"
    payload = _patch_payload(layer_env)
    payload["patch"]["base"]["version"] = '"layer-1-1.0"'
    resp = client.put(url, json=payload)
    assert resp.status_code == 409, resp.text
    # 冲突时不得改动文件
    names, _ = _read_names(layer_env["tab"])
    assert names == ["A", "B"]


def test_patch_save_version_chaining_matches_data_etag(layer_env):
    """版本指纹链路：保存返回的 version 必须等于图层数据端点 ETag，否则前端第二次保存会一直被 409 打回。"""
    client = _client()
    url = f"/api/v1/data/{layer_env['data_id']}/layers/{layer_env['layer_id']}/data"

    # 1) 首次拿到的 ETag 与保存时上报的基底版本一致
    first = client.get(url)
    assert first.status_code == 200
    etag = first.headers.get("ETag")
    assert etag, first.headers

    # 2) 增量保存：只改一行
    from app.services.layer_edit_service import layer_version
    assert etag == layer_version(layer_env["tab"], layer_env["layer_id"])
    patch_body = {"patch": {"base": {"count": 2, "version": etag},
                            "upserts": [{"row": 1, "properties": {"name": "B9"}}]}}
    saved = client.put(url, json=patch_body)
    assert saved.status_code == 200, saved.text
    new_version = saved.json()["data"]["version"]

    # 3) 保存后数据端点 ETag 应更新为同一个值
    after = client.get(url)
    assert after.headers.get("ETag") == new_version
    assert new_version != etag

    # 4) 用新版本再增量保存一次成功；用旧版本应被拒（409）
    ok = client.put(url, json={"patch": {"base": {"count": 2, "version": new_version},
                                        "upserts": [{"row": 0, "properties": {"name": "A7"}}]}})
    assert ok.status_code == 200, ok.text
    stale = client.put(url, json={"patch": {"base": {"count": 2, "version": etag},
                                           "upserts": [{"row": 0, "properties": {"name": "X"}}]}})
    assert stale.status_code == 409, stale.text
