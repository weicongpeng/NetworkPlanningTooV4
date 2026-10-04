"""
条件选择（图层属性空间连接）服务

把图层1（工参扇区 / 图层文件 / 地理化数据）的要素按"锚点"判定是否落在图层2
（TAC、县界等面图层）边界内；命中则把图层2的属性列追加，结果导出为单个工作表的 Excel。

坐标一律统一到 WGS84：
- 工参扇区 / 地理化点：直接取 WGS84 经纬度；
- MapInfo 面：geopandas 直接读源文件（源数据即 WGS84）；
- 地理化多边形：落库 path 为 GCJ02，批量反算为 WGS84。

本模块为纯同步代码，由 task_manager 经 asyncio.to_thread 调用，避免阻塞事件循环。
"""
import json
import math
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pandas as pd
from shapely.geometry import Point, Polygon, MultiPolygon
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from app.core.config import settings

# 归属关系列与取值（单工作表）
RELATION_COL = "归属关系"
RELATION_IN = "在边界内"
RELATION_OUT = "不在边界内"
RELATION_DANGLING = "无归属要素"
RELATION_SKIP = "经纬度缺失，已跳过"

# 缺失经纬度的要素被跳过的原因 key（明细里 reason 字段，展示时再翻译）
REASON_MISSING_COORD = "missing_coordinates"


@dataclass
class JoinFeature:
    """统一内部要素表示。geom=None + reason 非空 = 被跳过的缺失要素。"""
    fid: str
    props: Dict[str, Any]
    geom: Optional[BaseGeometry] = None
    reason: Optional[str] = None


def valid_lonlat(lon: Any, lat: Any) -> bool:
    """表格类数据（工参/地理化）经纬度有效性：有限实数、全球范围内、且非缺失默认值 (0,0)。

    缺失经纬度在落库时被填成 (0,0)，会把要素错误定位到几内亚湾，故 (0,0) 一律视为无效。
    """
    try:
        lon_f = float(lon)
        lat_f = float(lat)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(lon_f) and math.isfinite(lat_f)):
        return False
    if lon_f == 0.0 and lat_f == 0.0:
        return False
    return -180.0 < lon_f < 180.0 and -90.0 < lat_f < 90.0


def _noop_progress(p: float, msg: str = "") -> None:
    pass


def _clean_scalar(v: Any) -> Any:
    """把属性值转为 openpyxl 可写入的标量（NaN→None、时间→字符串、容器→JSON 字符串）"""
    if v is None:
        return None
    if isinstance(v, float):
        return None if math.isnan(v) else v
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    if isinstance(v, (dict, list, tuple, set)):
        try:
            return json.dumps(v, ensure_ascii=False, default=str)
        except Exception:
            return str(v)
    return v


def _clean_props(props: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in (props or {}).items():
        if k is None:
            continue
        cv = _clean_scalar(v)
        if cv is None:
            continue
        out[str(k)] = cv
    return out


# ============================ 图层加载 ============================

def _resolve_source_file(data_id: str, layer_id: str) -> Optional[Path]:
    """定位 MapInfo 图层源文件（优先 layers.json 记录的 metadata.source_file）"""
    data_dir = settings.DATA_DIR / data_id
    layers_file = data_dir / "layers.json"
    if layers_file.exists():
        try:
            layers = json.loads(layers_file.read_text(encoding="utf-8"))
            for layer in layers:
                if layer.get("id") != layer_id:
                    continue
                sf = layer.get("metadata", {}).get("source_file")
                if sf and Path(sf).exists():
                    return Path(sf)
                name = layer.get("name")
                if name:
                    for ext in (".tab", ".mif", ".kml"):
                        cand = data_dir / f"{name}{ext}"
                        if cand.exists():
                            return cand
        except Exception as e:
            print(f"[AttributeJoin] 读 layers.json 失败: {e}")
    # 兜底：在数据目录内按 layer_id/名称模糊查找
    for ext in (".tab", ".mif", ".kml"):
        for cand in data_dir.rglob(f"*{ext}"):
            if layer_id in cand.stem or cand.stem in layer_id:
                return cand
    return None


def _load_mapinfo(data_id: str, layer_id: str) -> Tuple[List[JoinFeature], List[JoinFeature]]:
    """直接用 geopandas 读取源文件，保留完整 shapely 几何（parse_file 会把 MultiPolygon 降级为单 polygon）。

    返回 (有效要素, 空几何被跳过的要素)。文件中几何坐标以源文件为准（(0,0) 也是真实几何，不排除）。
    """
    import geopandas as gpd

    src = _resolve_source_file(data_id, layer_id)
    if src is None:
        raise ValueError(f"未找到图层源文件: {layer_id}")
    try:
        gdf = gpd.read_file(str(src), encoding="gbk")
    except Exception:
        gdf = gpd.read_file(str(src))

    records = gdf.to_dict("records")
    geoms = list(gdf.geometry)
    feats: List[JoinFeature] = []
    skipped: List[JoinFeature] = []
    for i, (rec, geom) in enumerate(zip(records, geoms)):
        props = _clean_props({k: v for k, v in rec.items() if k != "geometry"})
        if geom is None or geom.is_empty:
            skipped.append(JoinFeature(
                fid=f"{data_id}:{layer_id}:{i}", props=props,
                geom=None, reason=REASON_MISSING_COORD,
            ))
            continue
        feats.append(JoinFeature(
            fid=f"{data_id}:{layer_id}:{i}", props=props, geom=geom,
        ))
    return feats, skipped


def _load_sector(network_type: Optional[str] = None,
                 group: Optional[Tuple[str, str]] = None
                 ) -> Tuple[List[JoinFeature], List[JoinFeature]]:
    """加载工参扇区（按组隔离）。

    只认扇区自身经纬度：缺失（NULL/(0,0)/越界，落库时缺失被填成 (0,0)）即跳过该要素，
    不再回退站点经纬度，避免把无坐标要素错误定位。返回 (有效要素, 跳过要素)。
    """
    from types import SimpleNamespace
    from app.services.data_service import data_service
    from app.api.v1.endpoints.map import _load_map_data_from_files

    user = SimpleNamespace(city=group[0], operator=group[1]) if group else None
    cached = _load_map_data_from_files(data_service, user)

    nt = (network_type or "all").lower()
    feats: List[JoinFeature] = []
    skipped: List[JoinFeature] = []

    def _build_props(site, sec, lon, lat) -> Dict[str, Any]:
        return _clean_props({
            "网络类型": (site.get("networkType") or "").upper(),
            "站点ID": site.get("id"),
            "站点名称": site.get("name"),
            "扇区ID": sec.get("id"),
            "扇区名称": sec.get("name"),
            "经度": lon,   # 无效要素传 None，经纬度列留空
            "纬度": lat,
            "方位角": sec.get("azimuth"),
            "波宽": sec.get("beamwidth"),
            "挂高": sec.get("height"),
            "PCI": sec.get("pci"),
            "TAC": sec.get("tac"),
            "频点": sec.get("frequency"),
            "MCC": sec.get("mcc"),
            "MNC": sec.get("mnc"),
        })

    for site in cached.get("sites", []):
        snt = (site.get("networkType") or "").upper()
        if nt in ("lte", "nr") and snt != nt.upper():
            continue
        for sec in site.get("sectors", []):
            raw_lat = sec.get("latitude")
            raw_lon = sec.get("longitude")
            fid = f"{site.get('id')}_{sec.get('id')}"
            if not valid_lonlat(raw_lon, raw_lat):
                skipped.append(JoinFeature(
                    fid=fid, props=_build_props(site, sec, None, None),
                    geom=None, reason=REASON_MISSING_COORD,
                ))
                continue
            lon, lat = float(raw_lon), float(raw_lat)
            feats.append(JoinFeature(
                fid=fid, props=_build_props(site, sec, lon, lat),
                geom=Point(lon, lat),
            ))
    return feats, skipped


def _load_geodata(data_id: str) -> Tuple[List[JoinFeature], List[JoinFeature]]:
    """加载地理化数据（点/扇区用 WGS84 经纬度；多边形 path 为 GCJ02，批量反算 WGS84）。

    经纬度缺失/无效的点、顶点不足/构造失败的多边形都跳过。返回 (有效要素, 跳过要素)。
    """
    from app.services.data_service import data_service

    data = data_service.get_data(data_id)
    if data is None:
        raise ValueError("地理化数据不存在")
    items = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), list) else data
    if not isinstance(items, list):
        raise ValueError("地理化数据格式无法识别")

    feats: List[JoinFeature] = []
    skipped: List[JoinFeature] = []
    poly_items: List[Dict[str, Any]] = []
    for n, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if item.get("path"):
            poly_items.append(item)
            continue
        lon, lat = item.get("longitude"), item.get("latitude")
        props = _clean_props(item.get("properties", {}))
        if not valid_lonlat(lon, lat):
            skipped.append(JoinFeature(
                fid=f"{data_id}:{n}", props=props,
                geom=None, reason=REASON_MISSING_COORD,
            ))
            continue
        feats.append(JoinFeature(
            fid=f"{data_id}:{n}", props=props,
            geom=Point(float(lon), float(lat)),
        ))

    if poly_items:
        from app.utils.coordinate_transformer import CoordinateTransformer

        ranges: List[Tuple[int, int]] = []
        flat_lats: List[float] = []
        flat_lngs: List[float] = []
        for item in poly_items:
            path = item["path"]
            a = len(flat_lats)
            for p in path:
                flat_lats.append(float(p[0]))
                flat_lngs.append(float(p[1]))
            ranges.append((a, len(flat_lats)))

        w_lats, w_lngs = CoordinateTransformer.gcj02_to_wgs84_batch(flat_lats, flat_lngs)
        w_lats, w_lngs = list(w_lats), list(w_lngs)
        for j, item in enumerate(poly_items):
            a, b = ranges[j]
            ring = list(zip(w_lngs[a:b], w_lats[a:b]))
            props = _clean_props(item.get("properties", {}))
            if len(ring) < 3 or not all(math.isfinite(x) and math.isfinite(y) for x, y in ring):
                skipped.append(JoinFeature(
                    fid=f"{data_id}:p{j}", props=props,
                    geom=None, reason=REASON_MISSING_COORD,
                ))
                continue
            try:
                geom = Polygon(ring)
            except Exception:
                skipped.append(JoinFeature(
                    fid=f"{data_id}:p{j}", props=props,
                    geom=None, reason=REASON_MISSING_COORD,
                ))
                continue
            feats.append(JoinFeature(
                fid=f"{data_id}:p{j}", props=props, geom=geom,
            ))
    return feats, skipped


def load_layer_features(ref: Dict[str, Any],
                        group: Optional[Tuple[str, str]] = None
                        ) -> Tuple[List[JoinFeature], List[JoinFeature]]:
    """按 layer_ref.kind 分派加载，返回 (WGS84 有效要素, 缺失被跳过的要素)"""
    kind = ref.get("kind")
    if kind == "sector":
        return _load_sector(ref.get("networkType"), group)
    if kind == "mapinfo":
        return _load_mapinfo(ref.get("dataId"), ref.get("layerId"))
    if kind == "geodata":
        return _load_geodata(ref.get("dataId"))
    raise ValueError(f"未知图层类型: {kind}")


# ============================ 空间匹配 ============================

def _anchor(geom: BaseGeometry) -> Point:
    """要素锚点：Point 用自身；线/面用包围盒中心（口径同前端 geometryAnchor）"""
    if isinstance(geom, Point):
        return geom
    minx, miny, maxx, maxy = geom.bounds
    return Point((minx + maxx) / 2, (miny + maxy) / 2)


def _spatial_match(
    f1: List[JoinFeature], f2: List[JoinFeature], progress_cb: Callable[[float, str], None]
) -> Tuple[List[Optional[int]], List[int], int]:
    """返回 (f1→f2 索引映射, f2 归属计数, 匹配数)。命中第一个即止，归属唯一。"""
    polys = [f.geom for f in f2]
    tree = STRtree(polys)
    matches2: List[Optional[int]] = [None] * len(f1)
    counts2 = [0] * len(f2)
    matched = 0
    step = max(1, len(f1) // 50)

    for i, feat in enumerate(f1):
        if feat.geom is not None:
            anchor = _anchor(feat.geom)
            for j in tree.query(anchor):
                j = int(j)
                if polys[j].covers(anchor):
                    matches2[i] = j
                    counts2[j] += 1
                    matched += 1
                    break
        if i % step == 0:
            progress_cb(35 + 50 * i / max(1, len(f1)), "空间匹配中...")
    return matches2, counts2, matched


# ============================ Excel 导出 ============================

def _cleanup_old(out_dir: Path, keep: int = 10) -> None:
    """清理历史结果，仅保留最近 keep 份"""
    try:
        files = sorted(out_dir.glob("attr_join_*.xlsx"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[keep:]:
            p.unlink(missing_ok=True)
    except Exception:
        pass


def build_rows_and_export(
    f1: List[JoinFeature], f2: List[JoinFeature],
    matches2: List[Optional[int]], counts2: List[int],
    f1_skip: Optional[List[JoinFeature]] = None,
) -> str:
    """构造单工作表行并写出 xlsx，返回文件路径。f1_skip = 图层1经纬度缺失被跳过的要素。"""
    # 列并集（按首次出现顺序；被跳过要素的属性列也纳入，保证其信息能落表）
    cols1: List[str] = []
    seen1 = set()
    for f in list(f1) + list(f1_skip or []):
        for k in f.props:
            if k not in seen1:
                seen1.add(k)
                cols1.append(k)
    cols2_raw: List[str] = []
    seen2 = set()
    for f in f2:
        for k in f.props:
            if k not in seen2:
                seen2.add(k)
                cols2_raw.append(k)

    # 图层2列与图层1/关系列同名时加 L2_ 前缀
    rename: Dict[str, str] = {}
    used = set(cols1) | {RELATION_COL}
    for k in cols2_raw:
        if k in used:
            base, n = f"L2_{k}", 1
            while base in used:
                base = f"L2_{k}_{n}"
                n += 1
            rename[k] = base
            used.add(base)
        else:
            rename[k] = k
            used.add(k)
    cols2 = [rename[k] for k in cols2_raw]
    header = cols1 + cols2 + [RELATION_COL]

    rows: List[Dict[str, Any]] = []
    for i, f in enumerate(f1):
        row = {c: None for c in cols1}
        row.update({k: v for k, v in f.props.items() if k in seen1})
        row2 = {c: None for c in cols2}
        j = matches2[i]
        if j is not None:
            row2.update({rename[k]: v for k, v in f2[j].props.items() if k in rename})
        rows.append({**row, **row2, RELATION_COL: RELATION_IN if j is not None else RELATION_OUT})

    # 图层1经纬度缺失被跳过的要素：图层2列空，关系列标注缺失
    for f in (f1_skip or []):
        row = {c: None for c in cols1}
        row.update({k: v for k, v in f.props.items() if k in seen1})
        rows.append({**row, **{c: None for c in cols2}, RELATION_COL: RELATION_SKIP})

    # 图层2中零归属的边界追加行（图层1列留空）
    for j, f in enumerate(f2):
        if counts2[j] != 0:
            continue
        row = {c: None for c in cols1}
        row2 = {rename[k]: v for k, v in f.props.items() if k in rename}
        for c in cols2:
            row2.setdefault(c, None)
        rows.append({**row, **row2, RELATION_COL: RELATION_DANGLING})

    df = pd.DataFrame(rows, columns=header)
    out_dir = settings.EXPORT_DIR / "attribute_join"
    out_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_old(out_dir)
    path = out_dir / f"attr_join_{uuid.uuid4().hex[:8]}.xlsx"
    df.to_excel(path, index=False, engine="openpyxl")
    return str(path)


# ============================ 主流程 ============================

def run_attribute_join(
    cfg: Dict[str, Any],
    group: Optional[Tuple[str, str]] = None,
    progress_cb: Callable[[float, str], None] = _noop_progress,
) -> Dict[str, Any]:
    """条件选择主流程（同步）。无包含关系 / 空数据时抛 ValueError。"""
    progress_cb(5, "加载图层1...")
    f1, f1_skip = load_layer_features(cfg.get("layer1", {}), group)

    progress_cb(20, "加载图层2...")
    f2_all, _f2_skip = load_layer_features(cfg.get("layer2", {}), group)
    f2 = [f for f in f2_all if isinstance(f.geom, (Polygon, MultiPolygon))]

    if not f1:
        if f1_skip:
            raise ValueError("图层1所有要素均缺失有效经纬度，无法执行条件选择，请先补全坐标")
        raise ValueError("图层1无有效要素")
    if not f2:
        raise ValueError("图层2无有效面状要素（条件选择需要面图层作为边界）")

    # bbox 预判：图层1锚点总体范围与任一边界 bbox 均不相交 → 快速失败
    anchors = [_anchor(f.geom) for f in f1 if f.geom is not None]
    aminx = min(p.x for p in anchors)
    amaxx = max(p.x for p in anchors)
    aminy = min(p.y for p in anchors)
    amaxy = max(p.y for p in anchors)

    def _bbox_intersects(bounds) -> bool:
        bminx, bminy, bmaxx, bmaxy = bounds
        return not (amaxx < bminx or aminx > bmaxx or amaxy < bminy or aminy > bmaxy)

    if not any(_bbox_intersects(f.geom.bounds) for f in f2):
        raise ValueError("所选两个图层不存在包含关系，图层1的要素均不在图层2边界内")

    progress_cb(35, "空间匹配...")
    matches2, counts2, matched = _spatial_match(f1, f2, progress_cb)
    if matched == 0:
        raise ValueError("所选两个图层不存在包含关系，图层1的要素均不在图层2边界内")

    progress_cb(90, "生成 Excel...")
    export_path = build_rows_and_export(f1, f2, matches2, counts2, f1_skip)
    progress_cb(100, "完成")

    return {
        "total1": len(f1),
        "total2": len(f2),
        "matched": matched,
        "unmatched": len(f1) - matched,
        "dangling2": sum(1 for c in counts2 if c == 0),
        "skipped1": len(f1_skip),
        "skipped1Details": [_feature_display(f) for f in f1_skip],
        "exportPath": export_path,
    }


def _feature_display(f: JoinFeature) -> Dict[str, Any]:
    """从要素属性中提取可辨识信息（名称/标识），用于缺失明细提示。"""
    p = f.props or {}
    name_keys = ("扇区名称", "站点名称", "名称", "name", "NAME", "Name")
    id_keys = ("扇区ID", "站点ID", "ID", "id")

    def _first(keys):
        for k in keys:
            v = p.get(k)
            if v not in (None, ""):
                return str(v)
        return ""

    return {
        "id": _first(id_keys) or f.fid,
        "name": _first(name_keys),
        "reason": f.reason or REASON_MISSING_COORD,
    }
