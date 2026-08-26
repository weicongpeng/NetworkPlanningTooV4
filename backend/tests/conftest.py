"""
测试配置

注入缺省依赖的 mock（geopandas/fiona/pyogrio/shapely），让单元测试在最小依赖环境下可运行。
被真实依赖 mock 阻碍的测试（如需要真实 GDAL 解析的）应单独跳过。

注意：仅当对应库未安装时创建 mock，避免覆盖已安装的真实实现。
"""
import sys
from types import ModuleType


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

