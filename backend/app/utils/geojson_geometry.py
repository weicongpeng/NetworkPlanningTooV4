"""
GeoJSON 几何批量构建（含坐标系转换）

把前端编辑工作集的几何批量转成 shapely 几何：
- 坐标结构走 numpy 数组化（C 层），不做逐点 Python 递归
- 整层所有坐标点一次性向量化转换（逐要素调用 numpy 每次都有固定开销，大图层慢 5-10 倍）
- 标准几何类型走数组构造器（shapely.geometry.shape 的 _is_coordinates_empty 逐点递归，
  86 万节点图层约需 3 秒）
- 含 z 值 / 未知类型 / 结构异常回退通用递归路径；无法解析的返回 None 由调用方跳过

坐标约定：from_wgs84=False 表示 GCJ02 → WGS84（编辑保存逆转换），True 为 WGS84 → GCJ02。
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from shapely.geometry import (LineString, MultiLineString, MultiPoint, MultiPolygon,
                              Point, Polygon, shape)
from shapely.geometry.base import BaseGeometry

from app.utils.coordinate_transformer import CoordinateTransformer

# 走数组快路径的几何类型（小写，其余走通用递归回退）
_ARRAY_GEOM_TYPES = ("point", "multipoint", "linestring",
                     "multilinestring", "polygon", "multipolygon")

# 解析结果：(小写几何类型, 数组树)
_ArrayTree = Tuple[str, Any]


def _as_arrays(coords: Any) -> np.ndarray:
    """坐标 → (n, 2) float64 数组；含 z 值或结构异常（ragged/非数值）抛异常由调用方回退。"""
    arr = np.asarray(coords, dtype=float)
    if arr.ndim != 2 or arr.shape[1] != 2 or arr.shape[0] == 0:
        raise ValueError("坐标不是非空二维点列")
    return arr


def _array_tree(geom: Dict[str, Any]) -> _ArrayTree:
    """GeoJSON 几何 → 数组树：点/线为 (n,2)，多线/面为 [(n,2)]，多面为 [[(n,2)]]。"""
    geom_type = str(geom.get("type", "")).lower()
    coords = geom.get("coordinates")
    if not coords or geom_type not in _ARRAY_GEOM_TYPES:
        raise ValueError(f"不支持数组化的几何: {geom_type or '空类型'}")
    if geom_type == "point":
        return geom_type, _as_arrays([coords])
    if geom_type in ("multipoint", "linestring"):
        return geom_type, _as_arrays(coords)
    if geom_type in ("polygon", "multilinestring"):
        return geom_type, [_as_arrays(part) for part in coords]
    return geom_type, [[_as_arrays(ring) for ring in poly] for poly in coords]


def _flatten(tree: Any, out: List[np.ndarray]) -> None:
    """按前序遍历收集数组树中的点列（顺序须与 _reassign 一致）。"""
    if isinstance(tree, np.ndarray):
        out.append(tree)
        return
    for child in tree:
        _flatten(child, out)


def _reassign(tree: Any, pieces) -> Any:
    """按同一前序把转换后的点列写回数组树结构。"""
    if isinstance(tree, np.ndarray):
        return next(pieces)
    return [_reassign(child, pieces) for child in tree]


def _build_geometry(geom_type: str, tree: Any) -> BaseGeometry:
    """数组树 → shapely 几何（数组化构造，不做逐点 Python 处理）。"""
    if geom_type == "point":
        return Point(tree[0])
    if geom_type == "multipoint":
        return MultiPoint(tree)
    if geom_type == "linestring":
        return LineString(tree)
    if geom_type == "multilinestring":
        return MultiLineString(tree)
    if geom_type == "polygon":
        return Polygon(tree[0], tree[1:])
    return MultiPolygon([[rings[0], rings[1:]] for rings in tree])


def _generic_build(geom: Dict[str, Any], from_wgs84: bool) -> Optional[BaseGeometry]:
    """回退路径：逐点递归坐标转换 + shapely.shape（兼容 z 值与未知几何类型）。"""
    coords = CoordinateTransformer.transform_geojson_coordinates_batch(
        geom.get("coordinates"), from_wgs84=from_wgs84
    )
    return shape({"type": geom.get("type"), "coordinates": coords})


def _as_leaf_arrays(node: Any) -> Any:
    """嵌套坐标 → 叶子数组树。叶子为 (n,2)/(n,3) 数组（单点为 (1,2)/(1,3)）。

    叶子判定不看几何类型而是看结构：元素本身是数值点，或子元素全是数值点。
    结构异常（空/非数值/维度不符）抛异常，由调用方按要素回退。
    """
    if not isinstance(node, (list, tuple)) or len(node) == 0:
        raise ValueError("空坐标")
    first = node[0]
    if isinstance(first, (int, float)):
        # 单个点：[x, y(, z)] 保持一维，重建时仍为扁平 list
        arr = np.asarray(node, dtype=float)
        if arr.ndim == 1 and arr.shape[0] in (2, 3):
            return arr
        raise ValueError("坐标维度不支持")
    if isinstance(first, (list, tuple)) and len(first) > 0 and isinstance(first[0], (int, float)):
        # 点列：[(x,y), ...] → (n, 2|3)
        arr = np.asarray(node, dtype=float)
        if arr.ndim == 2 and arr.shape[0] > 0 and arr.shape[1] in (2, 3):
            return arr
        raise ValueError("坐标结构不支持")
    return [_as_leaf_arrays(child) for child in node]


def _collect_leaf_arrays(tree: Any) -> List[np.ndarray]:
    """按前序收集叶子数组（顺序须与 _reassign_leaf_values 一致）。"""
    if isinstance(tree, np.ndarray):
        return [tree]
    out: List[np.ndarray] = []
    for child in tree:
        out.extend(_collect_leaf_arrays(child))
    return out


def _reassign_leaf_values(tree: Any, pieces) -> Any:
    """按同一前序把已转成 list 的叶子写回结构。"""
    if isinstance(tree, np.ndarray):
        return next(pieces)
    return [_reassign_leaf_values(child, pieces) for child in tree]


def transform_coordinate_lists(coordinates: Sequence[Any], *,
                               from_wgs84: bool = True) -> List[Any]:
    """批量转换嵌套坐标（GeoJSON coordinates 结构，如整层要素坐标）。

    与逐点递归实现结果一致（保留 z 值、统一输出 list），但坐标以 numpy 数组为中间态：
    数组化 + 整层一次向量化转换 + `tolist()`，避免逐点 Python 递归（86 万节点图层省数秒）。

    Args:
        coordinates: 坐标结构序列（每个元素为 Point/Line/Polygon/Multi* 的嵌套坐标）。
        from_wgs84: True 为 WGS84→GCJ02，False 为 GCJ02→WGS84。

    Returns:
        与输入等长列表；无法数组化的元素回退逐点递归后返回。
    """
    trees: List[Any] = [None] * len(coordinates)
    leaves: List[np.ndarray] = []
    fast_idx: List[int] = []
    out: List[Any] = [None] * len(coordinates)

    for i, coords in enumerate(coordinates):
        try:
            tree = _as_leaf_arrays(coords)
        except Exception:
            continue
        trees[i] = tree
        fast_idx.append(i)
        leaves.extend(_collect_leaf_arrays(tree))

    if leaves:
        flat = np.concatenate([(p if p.ndim == 2 else p.reshape(1, -1))[:, :2] for p in leaves])
        transform = (CoordinateTransformer.wgs84_to_gcj02_batch if from_wgs84
                     else CoordinateTransformer.gcj02_to_wgs84_batch)
        lats, lngs = transform(flat[:, 1], flat[:, 0])
        xy = np.column_stack((lngs, lats))
        values: List[Any] = []
        offset = 0
        for part in leaves:
            n = 1 if part.ndim == 1 else part.shape[0]
            piece = xy[offset:offset + n]
            offset += n
            if part.shape[-1] == 3:  # 保留 z 值
                piece = np.column_stack((piece, part[2:3] if part.ndim == 1 else part[:, 2]))
            values.append(piece[0].tolist() if part.ndim == 1 else piece.tolist())
        pieces = iter(values)
        for i in fast_idx:
            out[i] = _reassign_leaf_values(trees[i], pieces)

    for i, coords in enumerate(coordinates):
        if trees[i] is None:
            out[i] = CoordinateTransformer.transform_geojson_coordinates_batch(
                coords, from_wgs84=from_wgs84
            )
    return out


def build_geometries(geometries: Sequence[Optional[Dict[str, Any]]], *,
                     from_wgs84: bool = True) -> List[Optional[BaseGeometry]]:
    """批量构建 shapely 几何（含坐标转换）。

    Args:
        geometries: GeoJSON 几何字典序列（可为 None / 缺 coordinates）。
        from_wgs84: True 为 WGS84→GCJ02，False 为 GCJ02→WGS84。

    Returns:
        与输入等长的列表；无法解析或为空的几何为 None（调用方按原逻辑跳过）。
    """
    result: List[Optional[BaseGeometry]] = [None] * len(geometries)
    trees: List[Optional[_ArrayTree]] = [None] * len(geometries)
    parts: List[np.ndarray] = []
    fast_idx: List[int] = []
    slow_idx: List[int] = []

    for i, geom in enumerate(geometries):
        if not geom:
            continue
        try:
            tree = _array_tree(geom)
        except Exception:
            slow_idx.append(i)
            continue
        trees[i] = tree
        fast_idx.append(i)
        _flatten(tree[1], parts)

    if parts:
        flat = np.concatenate(parts)
        transform = (CoordinateTransformer.wgs84_to_gcj02_batch if from_wgs84
                     else CoordinateTransformer.gcj02_to_wgs84_batch)
        lats, lngs = transform(flat[:, 1], flat[:, 0])
        pieces = iter(np.split(np.column_stack((lngs, lats)),
                               np.cumsum([p.shape[0] for p in parts])[:-1]))
        for i in fast_idx:
            geom_type, tree = trees[i]
            try:
                result[i] = _build_geometry(geom_type, _reassign(tree, pieces))
            except Exception as e:
                print(f"[GeoJSON] 跳过无效要素几何: {e}")

    for i in slow_idx:
        try:
            result[i] = _generic_build(geometries[i], from_wgs84)
        except Exception as e:
            print(f"[GeoJSON] 跳过无效要素几何: {e}")

    for i, geom in enumerate(result):
        if geom is not None and geom.is_empty:
            result[i] = None
    return result
