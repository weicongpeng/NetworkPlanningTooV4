"""
图层制作 API 端点测试
"""
import pandas as pd
import tempfile
import os
from pathlib import Path
from fastapi.testclient import TestClient

from app.api import create_app
from app.core.config import settings
from app.core.security import require_data_import
from app.services.data_service import data_service


def _make_excel() -> str:
    """创建含经纬度/方位角的示例 Excel，返回路径"""
    tmp = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({
        "NAME": ["CellA", "CellB"],
        "LONGITUDE": [116.3, 116.4],
        "LATITUDE": [39.9, 40.0],
        "AZIMUTH": [0.0, 120.0],
    }).to_excel(tmp, sheet_name="LTE", index=False)
    return tmp


def _tmp_dir() -> Path:
    """临时文件目录（挂载树之外）"""
    return settings.UPLOAD_DIR / "layer_tmp"


def _tmp_leaks() -> list:
    """返回 layer_tmp 中残留的临时上传文件列表"""
    d = _tmp_dir()
    if not d.exists():
        return []
    return [p.name for p in d.glob("src_*")]


def _make_client():
    """创建 TestClient 并绕过权限校验（require_data_import → 通过）"""
    app = create_app()
    app.dependency_overrides[require_data_import] = lambda: None
    return TestClient(app)


def test_excel_info_endpoint():
    """excel-info 端点读取 sheet/列信息"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/excel-info",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "LTE" in body["data"]["sheets"]
        assert body["data"]["columns"]["LTE"] == ["NAME", "LONGITUDE", "LATITUDE", "AZIMUTH"]
    finally:
        os.remove(path)


def test_point_endpoint_returns_download_url():
    """生成点图层返回下载 URL（TAB 打包 zip 含 .tab/.dat/.id/.map），且可通过 /layer-files/ 下载"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "attributes": '["NAME", "LONGITUDE"]',
                    "output_format": "tab",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        download_url = body["data"]["download_url"]
        assert download_url.startswith("/layer-files/")
        assert download_url.endswith(".zip")
        # 验证 zip 包含 TAB 的 4 个配套文件
        dl = client.get(download_url)
        assert dl.status_code == 200
        assert dl.content
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            suffixes = {Path(n).suffix for n in zf.namelist()}
        assert {".tab", ".dat", ".id", ".map"}.issubset(suffixes)
    finally:
        os.remove(path)


def test_sector_endpoint():
    """生成扇区图层（MIF 打包 zip 含 .mif/.mid）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/sector",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "azimuth_col": "AZIMUTH",
                    "radius_m": "3000",
                    "beamwidth": "40",
                    "attributes": '["NAME"]',
                    "output_format": "mif",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        assert filename.endswith(".zip")
        dl = client.get(body["data"]["download_url"])
        assert dl.status_code == 200
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        assert any(n.endswith(".mif") for n in names)
        assert any(n.endswith(".mid") for n in names)
    finally:
        os.remove(path)


def test_point_endpoint_kml_no_zip():
    """KML 单文件不打包 zip"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "attributes": '["NAME"]',
                    "output_format": "kml",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        assert filename.endswith(".kml")
        assert not filename.endswith(".zip")
        dl = client.get(body["data"]["download_url"])
        assert dl.status_code == 200
    finally:
        os.remove(path)


def test_sector_endpoint_with_color():
    """扇区图层 + color 参数 → 生成成功且 MIF 颜色已注入"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/sector",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "azimuth_col": "AZIMUTH",
                    "radius_m": "3000",
                    "beamwidth": "40",
                    "attributes": '["NAME"]',
                    "output_format": "mif",
                    "color": "#4A90D9",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        assert filename.endswith(".zip")
        dl = client.get(body["data"]["download_url"])
        assert dl.status_code == 200
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            mif_names = [n for n in zf.namelist() if n.endswith(".mif")]
            assert mif_names
            text = zf.read(mif_names[0]).decode("utf-8", errors="replace")
        assert "Brush (" in text
        assert "4886745" in text
    finally:
        os.remove(path)


def test_point_endpoint_with_color_kml():
    """点图层 KML + color 参数 → IconStyle color 已注入"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "attributes": '["NAME"]',
                    "output_format": "kml",
                    "color": "#4A90D9",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        assert filename.endswith(".kml")
        dl = client.get(body["data"]["download_url"])
        assert dl.status_code == 200
        text = dl.content.decode("utf-8", errors="replace")
        assert "<color>ffd9904a</color>" in text
    finally:
        os.remove(path)


def test_no_temp_file_leak_after_generation():
    """生成成功后 layer_tmp 无残留临时文件（原始工参不落盘在挂载目录）"""
    before = set(_tmp_leaks())
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE",
                    "name_col": "NAME",
                    "lon_col": "LONGITUDE",
                    "lat_col": "LATITUDE",
                    "attributes": '["NAME"]',
                    "output_format": "tab",
                },
            )
        assert resp.status_code == 200
        assert set(_tmp_leaks()) == before, f"临时文件残留: {set(_tmp_leaks()) - before}"
        # 临时目录位于挂载树之外，不应通过 /layer-files/ 访问
        assert "/layer-files/_tmp/" not in resp.json()["data"]["download_url"]
    finally:
        os.remove(path)


def test_file_path_nonexistent_returns_400():
    """file_path 指向不存在的文件 → 400，且错误消息不泄露完整路径"""
    client = _make_client()
    resp = client.post(
        "/api/v1/layer/excel-info",
        data={"file_path": "/nonexistent/path/to/secret_file.xlsx"},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "secret_file.xlsx" in detail
    assert "/nonexistent/path/to" not in detail


def test_non_excel_extension_rejected():
    """非 Excel 扩展名上传 → 400"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/excel-info",
                files={"file": ("sample.txt", f, "text/plain")},
            )
        assert resp.status_code == 400
        assert "Excel" in resp.json()["detail"]
    finally:
        os.remove(path)


def test_chunked_upload_layer_file_type():
    """分块上传 + file_type='layer' 应重组文件返回 file_path，不建 data 索引"""
    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]}).to_excel(path, sheet_name="S", index=False)
    file_size = os.path.getsize(path)

    client = _make_client()

    try:
        # start
        r = client.post("/api/v1/data/upload/start",
            data={"filename": "test.xlsx", "total_chunks": "1", "total_size": str(file_size)})
        assert r.status_code == 200
        data_id = r.json()["data"]["id"]

        # chunk
        with open(path, "rb") as f:
            r2 = client.post(f"/api/v1/data/upload/{data_id}/chunk",
                data={"chunk_index": "0"},
                files={"file": ("chunk", f, "application/octet-stream")})
        assert r2.status_code == 200

        # complete with file_type='layer'
        r3 = client.post(f"/api/v1/data/upload/{data_id}/complete",
            data={"filename": "test.xlsx", "file_type": "layer"})
        assert r3.status_code == 200
        body = r3.json()
        assert body["success"] is True
        assert "file_path" in body["data"]
        fp = body["data"]["file_path"]
        assert "layer_tmp" in fp
        assert Path(fp).exists()

        # 断言没有创建 data 索引
        assert data_id not in data_service.index
    finally:
        os.remove(path)
