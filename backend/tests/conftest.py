"""
测试配置

注入缺省依赖的 mock（geopandas/fiona/pyogrio/shapely），让单元测试在最小依赖环境下可运行。
被真实依赖 mock 阻碍的测试（如需要真实 GDAL 解析的）应单独跳过。

注意：仅当对应库未安装时创建 mock，避免覆盖已安装的真实实现。

另外提供**全局数据根隔离**：任何测试都不得读写仓库的生产 data/ 目录。
（历史事故：测试把索引条目写进生产 data/index.json，覆盖了用户正常数据。）
"""
import sys
from types import ModuleType

import pytest


def _ensure_mock_module(name: str, **attrs) -> ModuleType:
    """仅当未安装时创建 mock 模块；已安装则直接返回（不覆盖真实实现）。"""
    if name in sys.modules:
        return sys.modules[name]
    try:
        __import__(name)
        return sys.modules[name]
    except ImportError:
        mod = ModuleType(name)
        for k, v in attrs.items():
            setattr(mod, k, v)
        sys.modules[name] = mod
        return mod


# shapely（必须存在 Point/Polygon 否则 layer_service 无法 import）
_ensure_mock_module("shapely")
_ensure_mock_module("shapely.geometry",
                    Point=type("Point", (), {}),
                    Polygon=type("Polygon", (), {}),
                    LineString=type("LineString", (), {}),
                    MultiPoint=type("MultiPoint", (), {}),
                    MultiLineString=type("MultiLineString", (), {}),
                    MultiPolygon=type("MultiPolygon", (), {}))

# geopandas（必须存在 gpd.GeoDataFrame 否则 layer_service 无法 import）
class _MockGDF:
    def __init__(self, *a, **kw): pass
    @property
    def empty(self): return True
    @property
    def columns(self): return []
    def __bool__(self): return False

class _MockGPD:
    GeoDataFrame = _MockGDF
    def read_file(self, *a, **kw): raise NotImplementedError("geopandas 未安装")
    def read_dataframe(self, *a, **kw): raise NotImplementedError("geopandas 未安装")
_ensure_mock_module("geopandas", GeoDataFrame=_MockGDF, read_file=_MockGPD().read_file, GeoSeries=type("GeoSeries", (), {}))

# fiona / pyogrio
_ensure_mock_module("fiona")
_ensure_mock_module("pyogrio", read_info=lambda *a, **kw: {"features": 0}, read_dataframe=lambda *a, **kw: _MockGDF())


@pytest.fixture(autouse=True)
def _isolate_data_root(tmp_path, monkeypatch):
    """全局隔离可写数据根：测试默认落 tmp，绝不碰仓库生产 data/。

    data_service 是进程级单例且构造时缓存索引路径，历史上多个测试只 patch 了
    部分路径，导致索引/文件写进生产目录。这里统一把常见数据根与索引路径都指向
    tmp_path；需要自定义目录的测试在其 fixture 里再覆盖即可（后设置者生效）。
    """
    from app.core.config import settings
    from app.services import data_service as data_service_module

    root = tmp_path / "npt-test-root"
    path_map = {
        "DATA_ROOT": root,
        "DATA_DIR": root / "data",
        "UPLOAD_DIR": root / "uploads",
        "OUTPUT_DIR": root / "outputs",
        "EXPORT_DIR": root / "exports",
        "LICENSE_DIR": root / "licenses",
        "APKS_DIR": root / "apks",
        "DESKTOP_RELEASES_DIR": root / "desktop_releases",
    }
    for name, path in path_map.items():
        if hasattr(settings, name):
            monkeypatch.setattr(settings, name, path, raising=False)
    for path in path_map.values():
        path.mkdir(parents=True, exist_ok=True)
    # 服务运行期会用到的子目录（缺目录时接口会 404，例如图层生成的 layers 输出）
    for sub in ("layers", "layer_tmp", "distance_tmp", "chunks"):
        (path_map["UPLOAD_DIR"] / sub).mkdir(parents=True, exist_ok=True)

    service = data_service_module.data_service
    monkeypatch.setattr(service, "_bound_data_dir", root / "data")
    monkeypatch.setattr(service, "data_index_file", root / "data" / "index.json")
    monkeypatch.setattr(service, "index", {})

    # 端点层在导入时就实例化的单例，其输出目录同样固化在生产路径 → 一并重定向
    try:
        from app.api.v1.endpoints import layer as layer_endpoint

        monkeypatch.setattr(
            layer_endpoint.layer_service, "output_dir", path_map["UPLOAD_DIR"] / "layers"
        )
    except Exception:  # noqa: BLE001
        pass
    yield

