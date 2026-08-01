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
    """生成点图层返回下载 URL，且文件可通过 /layer-files/ 下载"""
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
        # 验证静态挂载可下载生成的文件
        dl = client.get(download_url)
        assert dl.status_code == 200
        assert dl.content
    finally:
        os.remove(path)


def test_sector_endpoint():
    """生成扇区图层"""
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
        assert body["data"]["filename"].endswith(".mif")
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
