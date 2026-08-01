"""
图层制作 API 端点测试
"""
import pandas as pd
import tempfile
import os
from fastapi.testclient import TestClient

from app.api import create_app
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
