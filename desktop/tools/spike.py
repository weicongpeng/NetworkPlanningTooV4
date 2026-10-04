"""M0 风险验证：GDAL 栈 / 后端 / SPA 在源码或 PyInstaller 冻结环境中的可用性。

用法：
- 源码环境：python desktop/tools/spike.py      （本地检查，不起服务）
- 冻结环境：NPT.exe --selftest                  （launcher 起服务后调用 run_spike）

全部通过打印 "SPIKE OK" 并返回 0；任一失败打印 JSON 报告与 "SPIKE FAIL" 并返回 1。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]


def _ensure_backend_on_path() -> None:
    backend = REPO_ROOT / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def _check_stack() -> Dict[str, Any]:
    import geopandas
    import numpy
    import pandas
    import pyogrio
    import pyproj
    import shapely

    try:
        import sklearn

        sklearn_version = sklearn.__version__
    except Exception as exc:  # noqa: BLE001 - 记录后继续，由后续检查判定
        sklearn_version = f"导入失败: {exc}"

    return {
        "python": sys.version.split()[0],
        "frozen": bool(getattr(sys, "frozen", False)),
        "gdal": getattr(pyogrio, "__gdal_version_string__", "?"),
        "pyogrio": pyogrio.__version__,
        "geopandas": geopandas.__version__,
        "shapely": shapely.__version__,
        "pyproj": pyproj.__version__,
        "pandas": pandas.__version__,
        "numpy": numpy.__version__,
        "sklearn": sklearn_version,
    }


def _check_webview() -> Dict[str, Any]:
    """校验 pywebview 及其 Windows 后端可导入（冻结包必须成功）。"""
    try:
        import webview
    except Exception as exc:  # noqa: BLE001
        if getattr(sys, "frozen", False):
            raise AssertionError(f"冻结包内 webview 导入失败: {exc}") from exc
        return {"webview": f"未安装（源码环境跳过）: {exc}"}

    info: Dict[str, Any] = {"webview": getattr(webview, "__version__", "?")}
    if os.name == "nt":
        from webview.platforms import winforms  # noqa: F401

        info["winforms_backend"] = "ok"
    return info


def _check_tab_roundtrip() -> Dict[str, Any]:
    """自产自读一个 TAB，验证 MapInfo 驱动与几何读写链路。"""
    import geopandas as gpd
    from shapely.geometry import Point

    tmp_dir = Path(tempfile.mkdtemp(prefix="npt_spike_"))
    tab_path = tmp_dir / "spike.tab"
    gdf = gpd.GeoDataFrame(
        {"name": ["a", "b"]},
        geometry=[Point(113.65, 34.75), Point(113.75, 34.85)],
        crs="EPSG:4326",
    )
    gdf.to_file(tab_path, driver="MapInfo File", encoding="utf-8")
    back = gpd.read_file(tab_path)
    assert len(back) == 2, f"TAB 读回要素数 {len(back)} != 2"
    return {"features": len(back), "path": str(tab_path)}


def _check_libgdal_and_styles(tab_path: str) -> Dict[str, Any]:
    """验证 ctypes 定位/加载自带的 libgdal，并走通逐要素样式读取链路。"""
    import ctypes

    from app.services.ogr_style_reader import find_libgdal, read_feature_style_strings

    lib_path = find_libgdal()
    assert lib_path, "find_libgdal() 未找到 GDAL 动态库"
    lib = ctypes.CDLL(lib_path)
    lib.GDALVersionInfo.restype = ctypes.c_char_p
    lib.GDALVersionInfo.argtypes = [ctypes.c_char_p]
    version = (lib.GDALVersionInfo(b"--version") or b"").decode("utf-8", "replace")

    styles = read_feature_style_strings(tab_path)
    assert styles is not None and len(styles) == 2, f"样式读取链路返回 {styles!r}"
    return {
        "libgdal": lib_path,
        "gdal_version_info": version.split(",")[0],
        "styles_read": len(styles),
    }


def _http_get(url: str, timeout: float = 5.0) -> tuple:
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - 本机回环地址
        return resp.status, resp.read()


def _check_server(base_url: str) -> Dict[str, Any]:
    status, _ = _http_get(f"{base_url}/api/v1/system/status")
    assert status == 200, f"GET /api/v1/system/status -> {status}"

    status, body = _http_get(f"{base_url}/")
    assert status == 200, f"GET / -> {status}"
    html = body.decode("utf-8", "replace")
    assert 'id="root"' in html, "首页不是前端 SPA（frontend/dist-renderer 未正确打包？）"

    status, _ = _http_get(f"{base_url}/api/v1/license/status")
    assert status == 200, f"GET /api/v1/license/status -> {status}（数据库初始化异常？）"

    return {"system": "ok", "spa": "ok", "license_api": "ok"}


def _emit(report: Dict[str, Any]) -> None:
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


def run_spike(base_url: Optional[str] = None) -> int:
    _ensure_backend_on_path()
    report: Dict[str, Any] = {}
    try:
        report["stack"] = _check_stack()
        report["webview"] = _check_webview()
        tab = _check_tab_roundtrip()
        report["tab"] = {"features": tab["features"]}
        report["gdal"] = _check_libgdal_and_styles(tab["path"])
        if base_url:
            report["server"] = _check_server(base_url)
    except Exception as exc:  # noqa: BLE001 - CI 需要完整报告
        report["error"] = str(exc)
        report["traceback"] = traceback.format_exc()
        _emit(report)
        print("SPIKE FAIL")
        return 1
    _emit(report)
    print("SPIKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(run_spike())
