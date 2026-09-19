"""
图层制作 API 端点测试
"""
from types import SimpleNamespace

import pandas as pd
import tempfile
import os
import re
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
    """创建 TestClient 并绕过权限校验（require_data_import → 通过；组门禁同步跳过）"""
    app = create_app()
    app.dependency_overrides[require_data_import] = lambda: SimpleNamespace(id=1)
    from app.core.data_access import require_data_group_access
    app.dependency_overrides[require_data_group_access] = lambda: SimpleNamespace(id=1, city=None, operator=None, is_admin=True)
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
        filename = body["data"]["filename"]
        assert filename == "sample_LTE_point_tab.zip"
        download_url = body["data"]["download_url"]
        assert download_url == "/layer-files/sample_LTE_point_tab.zip"
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
        assert filename == "sample_LTE_sector_mif.zip"
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


def test_sector_point_distinct_output_names():
    """同源文件分别生成扇区/点图 → 输出文件名不同（_sector/_point），互不覆盖"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            r_s = client.post(
                "/api/v1/layer/sector",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "azimuth_col": "AZIMUTH", "radius_m": "3000", "beamwidth": "40",
                    "attributes": '["NAME"]', "output_formats": "kml",
                },
            )
        assert r_s.status_code == 200
        fname_s = r_s.json()["data"]["filename"]
        assert fname_s.endswith(".kml")
        assert "_sector.kml" in fname_s

        with open(path, "rb") as f:
            r_p = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "kml",
                },
            )
        assert r_p.status_code == 200
        fname_p = r_p.json()["data"]["filename"]
        assert fname_p.endswith(".kml")
        assert "_point.kml" in fname_p

        assert fname_s != fname_p
        # 两个文件都各自存在且内容不同（一个 Polygon，一个 Point）
        s = client.get(r_s.json()["data"]["download_url"]).content.decode("utf-8", errors="replace")
        p = client.get(r_p.json()["data"]["download_url"]).content.decode("utf-8", errors="replace")
        assert "<Polygon>" in s
        assert "<Point>" in p
    finally:
        os.remove(path)


def test_sector_endpoint_with_border_fill_opacity():
    """扇区图层 + border_color/fill_color/opacity → MIF Pen=边框色、Brush=填充色"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/sector",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "azimuth_col": "AZIMUTH", "radius_m": "3000", "beamwidth": "40",
                    "attributes": '["NAME"]', "output_format": "mif",
                    "border_color": "#000000", "fill_color": "#FF0000", "opacity": "0.5",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            mif_names = [n for n in zf.namelist() if n.endswith(".mif")]
            assert mif_names
            text = zf.read(mif_names[0]).decode("gbk", errors="replace")
        assert "Pen (2,2,0)" in text        # 黑色边框：线宽默认 2 进 width 位、pattern 保留 GDAL 2、颜色进 color 位
        # opacity=0.5 → 稀疏 pattern 省略 backcolor（官方规范透明填充：Brush(pattern, fg)）
        assert re.search(r'Brush \((\d+),16711680\)', text), f"应省略 backcolor，实际: {text[-200:]}"
    finally:
        os.remove(path)


def test_point_endpoint_with_border_opacity_kml():
    """点图层 KML + border_color/opacity → IconStyle color 带 alpha"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_format": "kml",
                    "border_color": "#FF0000", "opacity": "0.5",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        text = dl.content.decode("utf-8", errors="replace")
        assert "<IconStyle><color>800000ff</color>" in text
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


def test_point_endpoint_with_shape_and_size():
    """点图层 + point_shape/point_size → KML 含 SVG 图标和 scale"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_format": "kml",
                    "border_color": "#FF0000",
                    "point_shape": "square", "point_size": "12",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        text = dl.content.decode("utf-8", errors="replace")
        assert "data:image/svg+xml," in text
        assert "<Icon><href>" in text
        assert "<scale>0.90</scale>" in text  # 12/8*0.6=0.9
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
    """不支持的文件扩展名上传 → 400（txt/csv 已支持，用 pdf 测试）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/excel-info",
                files={"file": ("sample.pdf", f, "application/pdf")},
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

        # 断言 uploads 根目录的重组文件已被移走（不残留，避免被 scan 迁入索引）
        assert not (settings.UPLOAD_DIR / f"{data_id}.xlsx").exists()
    finally:
        os.remove(path)


def test_chunked_upload_layer_returns_source_filename():
    """分块上传 + file_type='layer' 应返回 source_filename（原始文件名，非 src_ 重命名）"""
    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({"NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9]}).to_excel(path, sheet_name="S", index=False)
    file_size = os.path.getsize(path)

    client = _make_client()

    try:
        # start（文件名带中文，验证 safe_filename 原样返回）
        r = client.post("/api/v1/data/upload/start",
            data={"filename": "工参2026.xlsx", "total_chunks": "1", "total_size": str(file_size)})
        assert r.status_code == 200
        data_id = r.json()["data"]["id"]

        with open(path, "rb") as f:
            r2 = client.post(f"/api/v1/data/upload/{data_id}/chunk",
                data={"chunk_index": "0"},
                files={"file": ("chunk", f, "application/octet-stream")})
        assert r2.status_code == 200

        r3 = client.post(f"/api/v1/data/upload/{data_id}/complete",
            data={"filename": "工参2026.xlsx", "file_type": "layer"})
        assert r3.status_code == 200
        body = r3.json()
        assert body["success"] is True
        assert body["data"]["source_filename"] == "工参2026.xlsx"
        # 路径仍是重命名后的 src_ 副本，但原始名单独携带
        assert "src_" in Path(body["data"]["file_path"]).name
    finally:
        os.remove(path)


def test_layer_point_endpoint_uses_source_filename_in_download_name():
    """端点传 source_filename → 下载文件名以原始源文件名开头（而非 src_ 副本名）"""
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
                    "source_filename": "工参2026.xlsx",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        # 命名 = 源文件名 + sheet 名 + 格式后缀（去 uuid，冲突加序号）
        assert filename == "工参2026_LTE_point_tab.zip"
    finally:
        os.remove(path)


def test_layer_endpoints_accept_file_path():
    """图层端点应接受 file_path（分块上传后的本地路径）而非必须 multipart file。

    - 同一 file_path 可被 excel-info 和 sector 连续复用（上传一次复用 N 次）
    - 端点只复制副本，不删除客户端传入的原始 file_path（原文件仍存在）
    """
    tmp_dir = _tmp_dir()
    tmp_dir.mkdir(parents=True, exist_ok=True)
    path = tmp_dir / f"chunked_{os.getpid()}.xlsx"
    # 含方位角（非零）供 sector 测试
    pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9], "AZIMUTH": [120.0],
    }).to_excel(path, sheet_name="S", index=False)

    client = _make_client()
    try:
        # excel-info 传 file_path
        r = client.post("/api/v1/layer/excel-info", data={"file_path": str(path)})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["success"] is True
        assert "S" in body["data"]["sheets"]

        # sector 复用同一 file_path（上传只发生一次，可多次消费）
        r2 = client.post("/api/v1/layer/sector",
            data={"file_path": str(path), "sheet_name": "S", "name_col": "NAME",
                  "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                  "azimuth_col": "AZIMUTH", "attributes": '["NAME"]',
                  "output_format": "kml"})
        assert r2.status_code == 200, r2.text
        body2 = r2.json()
        assert body2["success"] is True
        assert body2["data"]["filename"].endswith(".kml")

        # 端点不应删除客户端传入的原始 file_path（由 TTL 清扫统一管理）
        assert path.exists(), f"端点误删原始 file_path: {path}"
    finally:
        if path.exists():
            os.remove(path)


def test_point_endpoint_multi_format_zip():
    """output_formats=tab,mif → 一次生成两格式打包 zip，返回 stats"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["data"]["filename"].endswith(".zip")
        assert "stats" in body["data"]
        assert body["data"]["stats"]["total"] == 2
        assert body["data"]["stats"]["success"] == 2
        dl = client.get(body["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        assert any(n.endswith(".tab") for n in names)
        assert any(n.endswith(".mif") for n in names)
    finally:
        os.remove(path)


def test_point_endpoint_stats_with_failures():
    """含无效行 → 端点返回 stats.failed>0，文件仍生成"""
    import tempfile
    path = tempfile.mktemp(suffix=".xlsx")
    pd.DataFrame({
        "NAME": ["A", "B"], "LONGITUDE": [116.3, None], "LATITUDE": [39.9, 40.0],
    }).to_excel(path, sheet_name="S", index=False)
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("s.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={"sheet_name": "S", "name_col": "NAME",
                      "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                      "attributes": '["NAME"]', "output_formats": "kml"},
            )
        assert resp.status_code == 200
        stats = resp.json()["data"]["stats"]
        assert stats["total"] == 2
        assert stats["success"] == 1
        assert stats["failed"] == 1
        assert stats["failures"]["missing_coord"] == 1
    finally:
        os.remove(path)


def test_layer_file_path_reuse_generates_no_leak():
    """同一 file_path 多次复用后，layer_tmp 不残留端点生成的 src_* 副本（副本由 finally 删除），
    且原始 file_path 仍保留供复用"""
    tmp_dir = _tmp_dir()
    tmp_dir.mkdir(parents=True, exist_ok=True)
    before = set(_tmp_leaks())
    path = tmp_dir / f"reuse_{os.getpid()}.xlsx"
    pd.DataFrame({
        "NAME": ["A"], "LONGITUDE": [116.3], "LATITUDE": [39.9], "AZIMUTH": [120.0],
    }).to_excel(path, sheet_name="S", index=False)

    client = _make_client()
    try:
        for _ in range(3):
            r = client.post("/api/v1/layer/excel-info", data={"file_path": str(path)})
            assert r.status_code == 200, r.text
        # 端点生成的副本应被 finally 删除，不留残留
        assert set(_tmp_leaks()) == before, f"副本残留: {set(_tmp_leaks()) - before}"
        # 原始 file_path 仍存在
        assert path.exists()
    finally:
        if path.exists():
            os.remove(path)


def test_point_endpoint_multi_format_zip_includes_tab_companions():
    """output_formats=tab,mif → zip 含 TAB 全部配套文件（.tab/.dat/.id/.map）和 MIF（.mif/.mid）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        assert dl.status_code == 200
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        suffixes = {Path(n).suffix for n in names}
        # TAB 4 文件 + MIF 2 文件
        assert {".tab", ".dat", ".id", ".map", ".mif", ".mid"}.issubset(suffixes)
    finally:
        os.remove(path)


def test_multi_format_zip_no_duplicate_names():
    """多格式 zip 无重复文件名（tab/mif 共享 stem 时去重）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        assert dl.status_code == 200
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        # 无重复文件名
        assert len(names) == len(set(names)), f"zip 内容重复: {names}"
        # 仍含全部配套文件
        suffixes = {Path(n).suffix for n in names}
        assert {".tab", ".dat", ".id", ".map", ".mif", ".mid"}.issubset(suffixes)
    finally:
        os.remove(path)


def test_multi_format_zip_name_includes_formats():
    """output_formats=tab,mif,kml → zip 文件名含格式组合后缀 _tab-mif-kml（隔离浏览器缓存）"""
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("sample.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,mif,kml",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        filename = body["data"]["filename"]
        assert filename == "sample_LTE_point_tab-mif-kml.zip"
        assert body["data"]["download_url"] == "/layer-files/sample_LTE_point_tab-mif-kml.zip"
        # zip 内含 tab/kml 两格式（kml 也打包进多格式 zip）
        import zipfile, io
        dl = client.get(body["data"]["download_url"])
        assert dl.status_code == 200
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        suffixes = {Path(n).suffix for n in names}
        assert {".tab", ".mif", ".kml"}.issubset(suffixes)
    finally:
        os.remove(path)


def test_repeat_generate_via_endpoint_keeps_latest_only():
    """端点二次生成同源文件 → 产出同名（不追加 -1），历史文件被清理"""
    path = _make_excel()
    client = _make_client()
    try:
        for _ in range(2):
            with open(path, "rb") as f:
                resp = client.post(
                    "/api/v1/layer/point",
                    files={"file": ("工参.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    data={
                        "sheet_name": "LTE", "name_col": "NAME",
                        "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                        "attributes": '["NAME"]', "output_formats": "tab",
                        "source_filename": "工参.xlsx",
                    },
                )
            assert resp.status_code == 200
            filename = resp.json()["data"]["filename"]
            # 两次都应是同名（无 -1 后缀，含格式后缀）
            assert filename == "工参_LTE_point_tab.zip"
        # 输出目录只含最新同名文件，无 -1 历史
        layers_dir = settings.UPLOAD_DIR / "layers"
        names = [p.name for p in layers_dir.glob("工参_LTE_point*")]
        assert not any("-1" in n for n in names), f"存在历史残留: {names}"
    finally:
        os.remove(path)


def test_multi_format_zip_excludes_historical_suffixed_files():
    """预置 -1.kml/-2.kml 历史残留 → 新生成多格式 zip 不含它们（精确配套收集）"""
    layers_dir = settings.UPLOAD_DIR / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    # 预置历史残留（模拟之前清理失败留下的）
    hist = layers_dir / "残留_LTE_point-1.kml"
    hist.write_text("x")
    path = _make_excel()
    client = _make_client()
    try:
        with open(path, "rb") as f:
            resp = client.post(
                "/api/v1/layer/point",
                files={"file": ("残留.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                data={
                    "sheet_name": "LTE", "name_col": "NAME",
                    "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                    "attributes": '["NAME"]', "output_formats": "tab,kml",
                    "source_filename": "残留.xlsx",
                },
            )
        assert resp.status_code == 200
        dl = client.get(resp.json()["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        # 不含历史序号文件
        assert not any("-1." in n or "-2." in n for n in names), f"历史残留进zip: {names}"
        # 含本次 tab+kml
        suffixes = {Path(n).suffix for n in names}
        assert {".tab", ".kml"}.issubset(suffixes)
    finally:
        os.remove(path)
        if hist.exists():
            hist.unlink()


def test_repeat_generate_kml_no_suffixed_duplicate():
    """同一源文件二次生成 tab+kml → 第二次 zip 不含 -1 序号 kml，且磁盘无 -1 残留（真正的根因场景）"""
    path = _make_excel()
    client = _make_client()
    try:
        for _ in range(2):
            with open(path, "rb") as f:
                resp = client.post(
                    "/api/v1/layer/point",
                    files={"file": ("重复.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    data={
                        "sheet_name": "LTE", "name_col": "NAME",
                        "lon_col": "LONGITUDE", "lat_col": "LATITUDE",
                        "attributes": '["NAME"]', "output_formats": "tab,kml",
                        "source_filename": "重复.xlsx",
                    },
                )
            assert resp.status_code == 200
        # 第二次生成的 zip
        dl = client.get(resp.json()["data"]["download_url"])
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(dl.content)) as zf:
            names = zf.namelist()
        kmls = [n for n in names if n.endswith(".kml")]
        # 只能有 1 份 kml，无 -1 序号
        assert len(kmls) == 1, f"kml 重复: {kmls}"
        assert not any("-1." in n for n in names), f"序号残留进zip: {names}"
        # 磁盘无 -1 残留
        layers_dir = settings.UPLOAD_DIR / "layers"
        suffixed = [p.name for p in layers_dir.glob("重复_LTE_point*") if "-1." in p.name]
        assert not suffixed, f"磁盘残留: {suffixed}"
    finally:
        os.remove(path)


def test_companion_files_collects_exact_stem_only(tmp_path):
    """_companion_files 精确配套收集：TAB 收 .tab/.dat/.id/.map，KML 单文件，-1/-2 历史序号文件不入"""
    from app.api.v1.endpoints.layer import _companion_files
    # TAB 配套 + 历史序号残留（不同 stem）
    (tmp_path / "源_LTE.tab").write_text("x")
    (tmp_path / "源_LTE.dat").write_text("x")
    (tmp_path / "源_LTE.id").write_text("x")
    (tmp_path / "源_LTE.map").write_text("x")
    (tmp_path / "源_LTE-1.kml").write_text("x")   # 历史残留，非配套
    files = _companion_files(tmp_path / "源_LTE.tab")
    assert {f.name for f in files} == {"源_LTE.tab", "源_LTE.dat", "源_LTE.id", "源_LTE.map"}
    # KML 单文件
    (tmp_path / "源_LTE.kml").write_text("x")
    files = _companion_files(tmp_path / "源_LTE.kml")
    assert [f.name for f in files] == ["源_LTE.kml"]
    # MIF 收 .mif/.mid
    (tmp_path / "源_LTE.mif").write_text("x")
    (tmp_path / "源_LTE.mid").write_text("x")
    files = _companion_files(tmp_path / "源_LTE.mif")
    assert {f.name for f in files} == {"源_LTE.mif", "源_LTE.mid"}
    # 缺失的配套不收集（.map 不存在时）
    (tmp_path / "只tab.tab").write_text("x")
    files = _companion_files(tmp_path / "只tab.tab")
    assert {f.name for f in files} == {"只tab.tab"}
