"""
绘制缓冲区服务

把参考图层（工参扇区 / 图层文件 / 地理化数据，点线面任意几何）按米制半径生成
缓冲多边形，直接保存到装饰图层（前端 localStorage）或已有 MapInfo TAB 图层。

两种缓冲方式：
- each：每个输入要素各自缓冲，输出多个 Polygon；
- dissolve：所有缓冲真融合，重叠区域合并为一体（无重叠线），输出为 Polygon
  或 MultiPolygon（互不相连的部分）——"边界选择"一次点击即可命中整个缓冲范围。

测地线口径（不创建逐要素投影，避免 pyproj 管道初始化的巨大开销）：
- 点：pyproj.Geod 批量测地线终点，一次生成全部圆（严格测地线）；
- 线/面：局部切平面（等距近似，与局部 AEQD 误差同级）内平面 buffer。

本模块为纯同步代码，由 task_manager 经 asyncio.to_thread 调用，避免阻塞事件循环。
"""
import math
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from shapely.geometry import (
    Point, Polygon, MultiPoint, MultiPolygon, GeometryCollection, mapping,
)
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shapely_transform, unary_union

from app.services.attribute_join_service import (
    load_layer_features, _feature_display, _noop_progress,
)
from app.services.layer_edit_service import (
    _layer_fmt, _resolve_layer_target, _read_tab_gdf, layer_version,
)
from app.services.layer_patch_service import apply_layer_patch, LayerVersionConflict
from app.utils.coordinate_transformer import CoordinateTransformer
from app.utils.geojson_geometry import build_geometries

# 参数上下限
MAX_RADIUS_M = 2_000_000          # 2000 km，防畸形输入
MIN_SEGMENTS, MAX_SEGMENTS = 4, 360
MAX_OUTPUT_FEATURES = 20000       # 与 layer_patch_service._MAX_CHANGES 对齐

# 地球平均半径（切平面近似）
_EARTH_R = 6_371_000.0


# ============================ 点缓冲（批量测地线） ============================

def _buffer_points(
    lonlats: List[Tuple[float, float]], radius_m: float, segments: int,
) -> List[Polygon]:
    """点批量缓冲：pyproj.Geod.fwd 一次生成全部圆（严格椭球测地线）。

    Geod 方位角从正北顺时针；输出每点一个正 segments 边形 Polygon。
    """
    try:
        from pyproj import Geod
    except ImportError as e:
        raise ValueError("缓冲区功能依赖 pyproj，请确认后端依赖完整") from e

    n = len(lonlats)
    lons = np.fromiter((ll[0] for ll in lonlats), dtype=float, count=n)
    lats = np.fromiter((ll[1] for ll in lonlats), dtype=float, count=n)
    azimuths = np.linspace(0.0, 360.0, segments, endpoint=False)

    # 排列：每点连续 segments 个终点
    src_lon = np.repeat(lons, segments)
    src_lat = np.repeat(lats, segments)
    src_az = np.tile(azimuths, n)
    src_dist = np.full(n * segments, radius_m)

    end_lon, end_lat, _ = Geod(ellps="WGS84").fwd(
        src_lon, src_lat, src_az, src_dist
    )
    end_lon = end_lon.reshape(n, segments)
    end_lat = end_lat.reshape(n, segments)

    rings = np.stack([end_lon, end_lat], axis=2)
    return [Polygon(rings[i]) for i in range(n)]


# ============================ 线/面缓冲（局部切平面） ============================

def _buffer_other(geom: BaseGeometry, radius_m: float, segments: int) -> BaseGeometry:
    """线/面缓冲：以代表性内点为中心构造局部切平面，平面 round buffer 后投回。

    切平面径向误差 O((r/R)²)，r=100km 级时约 0.004%；零投影管道初始化开销。
    """
    center = geom.representative_point()
    lat0, lon0 = center.y, center.x
    kx = _EARTH_R * math.cos(math.radians(lat0)) * math.pi / 180.0
    ky = _EARTH_R * math.pi / 180.0

    def _to_plane(x, y, z=None):
        return (x - lon0) * kx, (y - lat0) * ky

    def _from_plane(x, y, z=None):
        return x / kx + lon0, y / ky + lat0

    planar = shapely_transform(_to_plane, geom)
    # quad_segs 是每四分之一圆弧段数；"每圈段数"÷4 映射（12 → 3）
    buffered = planar.buffer(
        radius_m,
        quad_segs=max(1, round(segments / 4)),
        join_style=1,  # round：圆头拐角/端帽
    )
    return shapely_transform(_from_plane, buffered)


def explode_polygons(geom: BaseGeometry) -> List[Polygon]:
    """把缓冲结果拆成单个 Polygon：保留 interior rings（孔洞不填平）。"""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return [g for g in geom.geoms if not g.is_empty]
    if isinstance(geom, GeometryCollection):
        out: List[Polygon] = []
        for g in geom.geoms:
            out.extend(explode_polygons(g))
        return out
    return []


def _extract_points(geom: BaseGeometry) -> Optional[List[Tuple[float, float]]]:
    """点类几何 → 经纬度列表；非点类返回 None。"""
    if isinstance(geom, Point):
        return [(geom.x, geom.y)]
    if isinstance(geom, MultiPoint):
        return [(g.x, g.y) for g in geom.geoms]
    return None


# ============================ 坐标转换（直接出 GeoJSON） ============================

def _polys_to_gcj_features(polys: List[Polygon]) -> List[Dict[str, Any]]:
    """WGS84 Polygon 列表 → GCJ02 GeoJSON Feature 列表（一批完成）。

    直接重组坐标数组、输出 dict，不重建 shapely 几何（重建上万 Polygon 的
    Python 开销约 5~6s，是该环节的主要瓶颈）。
    """
    flat_lat: List[float] = []
    flat_lon: List[float] = []
    ring_ranges_per_poly: List[List[Tuple[int, int]]] = []

    for poly in polys:
        rings = [poly.exterior] + list(poly.interiors)
        ranges: List[Tuple[int, int]] = []
        for ring in rings:
            start = len(flat_lat)
            coords = ring.coords
            flat_lat.extend(c[1] for c in coords)
            flat_lon.extend(c[0] for c in coords)
            ranges.append((start, len(flat_lat)))
        ring_ranges_per_poly.append(ranges)

    gcj_lat, gcj_lon = CoordinateTransformer.wgs84_to_gcj02_batch(
        np.asarray(flat_lat), np.asarray(flat_lon)
    )
    gcj_lat, gcj_lon = list(gcj_lat), list(gcj_lon)

    features: List[Dict[str, Any]] = []
    for ring_ranges in ring_ranges_per_poly:
        coordinates = []
        for start, end in ring_ranges:
            coordinates.append(
                [[gcj_lon[i], gcj_lat[i]] for i in range(start, end)]
            )
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": coordinates},
            "properties": {},
        })
    return features


# ============================ 主流程 ============================

def run_buffer(cfg: Dict[str, Any],
               group: Optional[Tuple[str, str]] = None,
               progress_cb: Callable[[float, str], None] = _noop_progress
               ) -> Dict[str, Any]:
    """执行缓冲区生成并直接保存。返回完成统计 dict（失败抛异常）。"""
    source = cfg.get("source") or {}
    target = cfg.get("target") or {}
    try:
        radius = float(cfg.get("radius"))
    except (TypeError, ValueError):
        raise ValueError("缓冲半径必须是数字")
    try:
        segments = int(cfg.get("segments", 12))
    except (TypeError, ValueError):
        raise ValueError("平滑度（每圈段数）必须是整数")
    mode = str(cfg.get("mode") or "")

    if not (0.0 < radius <= MAX_RADIUS_M):
        raise ValueError(f"缓冲半径必须在 0 ~ {MAX_RADIUS_M // 1000} 千米之间")
    if not (MIN_SEGMENTS <= segments <= MAX_SEGMENTS):
        raise ValueError(f"每圈段数必须在 {MIN_SEGMENTS} ~ {MAX_SEGMENTS} 之间")
    if mode not in ("each", "dissolve"):
        raise ValueError("缓冲方式非法（应为每要素缓冲或合并缓冲）")
    target_kind = target.get("kind")
    if target_kind not in ("decoration", "mapinfo"):
        raise ValueError("保存目标图层类型非法")
    if target_kind == "mapinfo" and not (target.get("dataId") and target.get("layerId")):
        raise ValueError("保存目标图层信息不完整")

    progress_cb(5, "加载参考图层...")
    feats, skipped = load_layer_features(source, group)
    if not feats:
        if not skipped:
            raise ValueError("参考图层无有效要素")
        raise ValueError("参考图层所有要素均缺少有效几何或经纬度，无法生成缓冲区")

    # 分类为点单元（批量）与线/面单元（逐个切平面）
    point_units: List[Tuple[float, float]] = []
    other_geoms: List[BaseGeometry] = []
    for feat in feats:
        pts = _extract_points(feat.geom)
        if pts is not None:
            point_units.extend(pts)
        else:
            other_geoms.append(feat.geom)

    progress_cb(15, "缓冲计算中...")
    output_polys: List[Polygon] = []
    if point_units:
        output_polys.extend(_buffer_points(point_units, radius, segments))
    progress_cb(70, "缓冲计算中...")
    for i, geom in enumerate(other_geoms):
        buffered = _buffer_other(geom, radius, segments)
        output_polys.extend(explode_polygons(buffered))
        if other_geoms and i % max(1, len(other_geoms) // 10) == 0:
            progress_cb(70 + 20 * i / max(1, len(other_geoms)), "线面要素缓冲中...")

    progress_cb(90, "整理缓冲结果...")
    if not output_polys:
        raise ValueError("缓冲结果为空，请检查参考图层几何")
    if len(output_polys) > MAX_OUTPUT_FEATURES:
        raise ValueError(
            f"缓冲结果要素过多（{len(output_polys)}），请缩小参考图层范围"
        )

    if mode == "dissolve":
        # 真融合：重叠区域合并为一体（消除重叠线/重叠镂空）。结果是单个图层要素：
        # 全部相连 → Polygon；存在互不相连的部分 → MultiPolygon（各部分同属一个要素），
        # "边界选择"点一次即可命中整个缓冲范围
        progress_cb(92, "融合重叠缓冲区...")
        merged = unary_union(output_polys)
        if merged.is_empty:
            raise ValueError("缓冲融合结果为空")
        # 融合后仅单个（顶点可能较多的）几何：build_geometries 内部 numpy 批处理更快
        progress_cb(95, "坐标转换中...")
        gcj_built = build_geometries([mapping(merged)], from_wgs84=True)
        gcj_geom = next((g for g in gcj_built if g is not None and not g.is_empty), None)
        if gcj_geom is None:
            raise ValueError("缓冲结果坐标转换失败")
        features = [
            {"type": "Feature", "geometry": mapping(gcj_geom), "properties": {}}
        ]
    else:
        # each：上万小多边形直接组装 GeoJSON（跳过重建 shapely 的 Python 级开销）
        progress_cb(95, "坐标转换中...")
        features = _polys_to_gcj_features(output_polys)
        if not features:
            raise ValueError("缓冲结果坐标转换失败")

    skipped_details = [_feature_display(f) for f in skipped]

    # ----- 保存 -----
    progress_cb(97, "保存缓冲图形...")
    if target_kind == "decoration":
        progress_cb(100, "完成")
        return {
            "savedTo": "decoration",
            "features": features,
            "inputCount": len(feats),
            "resultCount": len(features),
            "skippedCount": len(skipped),
            "skippedDetails": skipped_details,
        }

    data_id, layer_id = target["dataId"], target["layerId"]
    _, _, tab_path, _ = _resolve_layer_target(data_id, layer_id)
    # 缓冲区写入走增量保存，而增量保存只支持 TAB（SHP/GeoJSON 的样式在 .qml）。
    # 这里显式拒绝，避免被 apply_layer_patch 的版本冲突兜成"图层刚被修改，请重试"
    # 这种误导性提示（用户重试多少次都不会成功）。
    if _layer_fmt(tab_path) != "tab":
        raise ValueError("缓冲区目前只支持写入 MapInfo TAB 图层")
    base_gdf = _read_tab_gdf(tab_path)
    # 空 TAB（新建无要素）读回可能没有 geometry 列，此时有效行数为 0
    if "geometry" in base_gdf.columns:
        base_count = int((base_gdf.geometry.notna() & ~base_gdf.geometry.is_empty).sum())
    else:
        base_count = 0
    patch = {
        "base": {"count": base_count, "version": layer_version(tab_path, layer_id)},
        "upserts": [
            {"row": None, "geometry": f["geometry"], "properties": {}}
            for f in features
        ],
        "deletes": [],
    }
    try:
        apply_layer_patch(data_id, layer_id, patch)
    except LayerVersionConflict as e:
        raise ValueError("目标图层刚被其它操作修改，请重试") from e

    from app.api.v1.endpoints.map import invalidate_map_data_cache
    invalidate_map_data_cache()

    progress_cb(100, "完成")
    return {
        "savedTo": "mapinfo",
        "dataId": data_id,
        "layerId": layer_id,
        "inputCount": len(feats),
        "resultCount": len(features),
        "skippedCount": len(skipped),
        "skippedDetails": skipped_details,
    }
