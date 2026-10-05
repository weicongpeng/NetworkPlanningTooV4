"""
图层编辑服务：新建空 TAB 图层 + 绘制要素保存（整层重写）

- create_empty_tab_layer：创建带默认 name 列的 0 要素 TAB，注册到 layers.json / index.json / SQLite
- save_layer_geojson：把前端编辑工作集（GCJ02）逆转换为 WGS84 后整层重写 TAB，
  保留旧属性表 schema，并刷新元数据与缓存

坐标约定：后端下发图层 GeoJSON 时已 WGS84→GCJ02；前端绘制/编辑坐标为 GCJ02，
保存时必须整体逆转换回 WGS84（EPSG:4326）再写 TAB。
"""
import json
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import geopandas as gpd
import pandas as pd
import pyogrio
from shapely import wkb

from app.core.config import settings
from app.services.tab_io import (
    write_mapinfo_tab, verify_tab_readable, remove_tab_stem,
    build_field_data, _postprocess_tab,
)
from app.services.layer_service import (
    _truncate_bytes, _sanitize_field_name, _dedupe_field_names,
    hex_to_mapinfo_color, is_no_color, tab_opacity_brush_pattern,
)
from app.services.mapinfo_service import (
    FIELD_MAP_TAIL,
    GeometryType,
    MapInfoParser,
    _save_layer_metadata,
    clear_layer_cache,
    field_map_path,
    layer_cache_dir,
    read_field_map,
    write_field_map,
)
from app.services.ogr_style_reader import read_feature_style_strings
from app.services.tab_style_writer import convert_mif_to_tab
from app.utils.geojson_geometry import build_geometries

# 前端几何类型 → (pyogrio geometry_type, GeometryType 枚举)
# mixed=混合图层（同一图层可同时绘制点/线/面），MapInfo TAB 用 GDAL "Unknown" 几何类型写入
_GEOM_MAP = {
    "point": ("Point", GeometryType.POINT),
    "line": ("LineString", GeometryType.LINE),
    "polygon": ("Polygon", GeometryType.POLYGON),
    "mixed": ("Unknown", GeometryType.UNKNOWN),
}

# 文件名非法字符（Windows + MapInfo）
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# 新建空图层的默认属性列（MapInfo .dat 至少需 1 个字段，否则无法读回）
_DEFAULT_ATTR_COLUMN = "name"


# ESRI Shapefile 的 DBF 字段名上限。超限本身不报错，但截断到多字节字符中间会写坏
# 整个 .dbf（读回直接 UnicodeDecodeError），故必须按 UTF-8 边界截断。
_DBF_FIELD_NAME_MAX_BYTES = 10


def _dbf_safe_name(name: str, index: int = 0) -> str:
    """DBF 字段名净化：MapInfo 清洗（非法字符/数字开头）后按 UTF-8 字节截断到 ≤10。

    中文一字 3 字节，故最多 3 字；已合规的名字原样返回，保证导入的 Shapefile 往返不变。
    """
    return _truncate_bytes(_sanitize_field_name(name, index), _DBF_FIELD_NAME_MAX_BYTES)


# ---------------------------------------------------------------- 图层格式

# 可编辑保存的图层格式（后缀 → 格式名）。MapInfo TAB 之外的格式在保存链路上
# 只差"读旧 schema / 写盘 / 打包"三步，其余（坐标逆转换、属性对齐、元数据刷新、
# 缓存失效）完全复用。
_LAYER_FMT_BY_SUFFIX = {
    ".tab": "tab",
    ".shp": "shp",
    ".geojson": "geojson",
    ".json": "geojson",
}

# 各格式同 stem 的图层文件后缀（备份/回滚/打包用；均不含前导点，按小写比较）
_LAYER_STEM_SUFFIXES = {
    "tab": ("tab", "dat", "id", "map", "ind"),
    "shp": ("shp", "shx", "dbf", "prj", "cpg", "qml"),
}

# 字段名映射 sidecar 的完整后缀（DBF 字段名转写后记录原名，重新导入时还原显示名）
_FIELD_MAP_TAIL = "nptfields.json"


def _layer_fmt(path: Path) -> Optional[str]:
    """源文件路径 → 图层格式名；不支持编辑保存的格式返回 None。"""
    return _LAYER_FMT_BY_SUFFIX.get(path.suffix.lower())


def _layer_stem_suffixes(source_path: Path, fmt: str) -> tuple:
    """同 stem 需一起管理的后缀（覆写删除 / 备份回滚 / 打包）。

    GeoJSON 按源文件自身后缀取（.geojson 与 .json 并存时不能互相牵连），
    Shapefile 则必须整套 .shp/.shx/.dbf/.prj/.cpg 一起换，残留旧 .dbf 会导致
    新几何配旧属性。
    """
    if fmt == "geojson":
        return (source_path.suffix.lower().lstrip("."), "qml")
    return _LAYER_STEM_SUFFIXES.get(fmt, ())


def _layer_stem_files(source_path: Path, fmt: str) -> List[Path]:
    """收集与 source_path 同 stem 的图层文件（数据文件 + 配套 + 样式 + sidecar）。

    按 `{stem}.` 前缀匹配而非 Path.stem：sidecar 名形如 `a.nptfields.json`，
    其 stem 是 `a.nptfields`，用 stem 相等会漏掉。大小写不敏感，兼容大写后缀。
    """
    suffix_set = _layer_stem_suffixes(source_path, fmt)
    prefix = source_path.stem.lower() + "."
    results: List[Path] = []
    try:
        for f in source_path.parent.iterdir():
            if not f.is_file():
                continue
            name = f.name.lower()
            if not name.startswith(prefix):
                continue
            tail = name[len(prefix):]
            if tail in suffix_set or tail == FIELD_MAP_TAIL:
                results.append(f)
    except OSError:
        pass
    return results


def _sanitize_layer_name(name: str) -> str:
    """清洗图层文件名：去非法字符、空白收敛、按 UTF-8 字节截断 ≤100。"""
    name = (name or "").strip()
    name = _INVALID_FILENAME.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    if not name:
        name = "新建图层"
    return _truncate_bytes(name, 100)


def _dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.glob("*") if f.is_file())


def create_empty_layer(name: str, geometry_type: str = "mixed", fmt: str = "tab",
                       user_id: int = 1, city: Optional[str] = None,
                       operator: Optional[str] = None) -> Dict[str, Any]:
    """创建一个 0 要素的图层并注册到索引（MapInfo TAB / ESRI Shapefile / GeoJSON）。

    geometry_type: 'mixed'（同一图层可绘制点/线/面）或 'point'/'line'/'polygon'。
      Shapefile 单文件只能存一种几何类型，故 fmt='shp' 时不允许 'mixed'。
    fmt: 'tab'（默认）/ 'shp' / 'geojson'。
    city/operator: 数据所属组（地市+运营商）归属快照，取自创建者。
    Returns:
        {"data_id", "layer_id", "name"}
    """
    safe_name = _sanitize_layer_name(name)
    geom_key = (geometry_type or "mixed").lower().strip()
    if geom_key not in _GEOM_MAP:
        raise ValueError(f"不支持的几何类型: {geometry_type}（应为 mixed/point/line/polygon）")
    if fmt not in ("tab", "shp", "geojson"):
        raise ValueError(f"不支持的图层格式: {fmt}（应为 tab/shp/geojson）")
    if fmt == "shp" and geom_key == "mixed":
        raise ValueError("Shapefile 单文件只支持一种几何类型，请选择点/线/面之一")
    ogr_geom_type, geom_enum = _GEOM_MAP[geom_key]

    data_id = str(uuid.uuid4())
    data_dir = settings.DATA_DIR / data_id
    data_dir.mkdir(parents=True, exist_ok=True)
    source_path = data_dir / f"{safe_name}.{'geojson' if fmt == 'geojson' else fmt}"

    # 0 要素 + 默认 name 属性列（.dat/.dbf 至少需 1 个字段，否则无法读回），
    # 显式几何类型（TAB 的 mixed=Unknown，支持后续写入点/线/面）
    empty_gdf = gpd.GeoDataFrame(
        {_DEFAULT_ATTR_COLUMN: pd.Series([], dtype="object")},
        geometry=gpd.GeoSeries([], crs="EPSG:4326"),
    )
    if fmt == "tab":
        write_mapinfo_tab(empty_gdf, source_path, geometry_type=ogr_geom_type)
    elif fmt == "shp":
        empty_gdf.to_file(source_path, driver="ESRI Shapefile", encoding="utf-8")
    else:
        empty_gdf.to_file(source_path, driver="GeoJSON")
    verify_tab_readable(source_path, 0, label=fmt.upper())

    layer_id = data_id  # 单图层约定：layer_id 与 data_id 一致（同 parse_mapinfo_files 单文件）
    # 混合图层无单一几何默认样式（编辑绘制时按点/线/面分别取 drawStyle）；单一几何给推断样式
    default_style = None if geom_key == "mixed" else MapInfoParser._get_layer_default_style(safe_name, geom_enum)
    entry = {
        "id": layer_id,
        "name": safe_name,
        "type": geom_key,  # 'mixed' / 'point' / 'line' / 'polygon'
        "feature_count": 0,
        "metadata": {
            "source_file": str(source_path),
            "feature_count": 0,
            "editable": True,  # 标记为工具内新建、可编辑的图层
        },
        "defaultStyle": default_style,
    }

    with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
        json.dump([entry], f, ensure_ascii=False, indent=2)

    total_size = _dir_size(data_dir)

    # 注册到 data_service 内存索引 + index.json（延迟导入避免循环依赖）
    from app.services.data_service import data_service
    data_service.index[data_id] = {
        "id": data_id,
        "name": source_path.name,
        "type": "map",
        "subType": "mapinfo",
        "user_id": user_id,
        "city": city,
        "operator": operator,
        "size": total_size,
        "uploadDate": pd.Timestamp.now().isoformat(),
        "status": "ready",
        "metadata": {
            "fileCount": len([f for f in data_dir.glob("*") if f.is_file()]),
            "layerCount": 1,
            "layers": [entry],
        },
    }
    data_service._save_index()

    # SQLite Layer 行
    _save_layer_metadata(
        user_id=user_id,
        city=city,
        operator=operator,
        name=safe_name,
        file_path=str(source_path),
        layer_type=geom_key,
        geometry_type=geom_key,
        feature_count=0,
        file_size=total_size,
        layer_id=layer_id,
    )

    clear_layer_cache(data_id)
    # geometry_type/format 一并返回：前端据此初始化编辑工作集的几何类型，
    # 否则新建的点/线/面 Shapefile 会被当成混合图层（绘制出异类几何后必然保存失败）
    return {"data_id": data_id, "layer_id": layer_id, "name": safe_name,
            "geometry_type": geom_key, "format": fmt}


def create_empty_tab_layer(name: str, geometry_type: str = "mixed",
                           user_id: int = 1, city: Optional[str] = None,
                           operator: Optional[str] = None) -> Dict[str, Any]:
    """新建 MapInfo TAB 图层（create_empty_layer 的 TAB 快捷方式，保留既有调用方）。"""
    return create_empty_layer(name, geometry_type, "tab", user_id, city, operator)


# 图层类型 → OGR geometry_type（保存重写用；mixed=混合几何用 Unknown）
_OGR_GEOM_BY_ENTRY = {"point": "Point", "line": "LineString", "polygon": "Polygon", "mixed": "Unknown"}

# MapInfo 全套关联文件（zip 打包用；.ind 可选）
_TAB_BUNDLE_SUFFIXES = (".tab", ".dat", ".id", ".map", ".ind")


# MapInfo 全套关联文件（zip 打包用；.ind 可选）+ MIF 配套
_LAYER_BUNDLE_SUFFIXES = (".tab", ".dat", ".id", ".map", ".ind", ".mif", ".mid", ".kml")

# 数据条目原始上传件在数据目录中的候选名
_DATA_ORIGINAL_NAMES = ("original.xlsx", "original.zip")


def build_data_layers_zip(data_id: str) -> tuple:
    """把数据条目下所有图层的**当前文件**打包为 zip（方案B：数据管理"下载"返回最新图层）。

    与 build_layer_zip（单图层）不同：一个 map 数据条目可能含多个图层
    （zip 导入多文件），这里遍历 layers.json 逐图层收集同 stem 配套文件
    （大小写不敏感）。编辑保存整层重写的就是这些源文件，故打包结果
    始终是最新状态，替代 original.zip 上传快照。

    Returns:
        (zip_bytes, layer_count)；无图层或全部源文件缺失时返回 (b"", 0)
    """
    import io as _io
    import zipfile as _zipfile

    data_dir = settings.DATA_DIR / data_id
    layers_file = data_dir / "layers.json"
    if not layers_file.exists():
        return b"", 0
    try:
        layers = json.loads(layers_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[LayerEdit] build_data_layers_zip 读取 layers.json 失败: {e}")
        return b"", 0

    buf = _io.BytesIO()
    count = 0
    used_names: set = set()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        for entry in layers:
            src = (entry.get("metadata", {}) or {}).get("source_file")
            src_path = Path(src) if src else None
            if src_path is None or not src_path.exists():
                # 兜底：按图层名在数据目录找同名源文件
                name = entry.get("name") or ""
                src_path = None
                for ext in (".tab", ".TAB", ".mif", ".kml"):
                    cand = data_dir / f"{name}{ext}"
                    if cand.exists():
                        src_path = cand
                        break
            if src_path is None:
                continue
            stem = src_path.stem.lower()
            # 同 stem 配套文件（大小写不敏感，避免用户上传大写 .TAB/.DAT 漏打包）
            try:
                it = data_dir.rglob("*")
            except OSError:
                it = []
            for f in it:
                if f.is_file() and f.stem.lower() == stem \
                        and f.suffix.lower() in _LAYER_BUNDLE_SUFFIXES \
                        and f.name not in used_names:
                    zf.write(f, arcname=f.name)
                    used_names.add(f.name)
                    count += 1
    if count == 0:
        return b"", 0
    return buf.getvalue(), count


def build_layer_zip(data_id: str, layer_id: str) -> tuple:
    """把图层全套文件打包为 zip（TAB 五件套 / Shapefile 六件套 / GeoJSON 双件）。

    各格式都带上同 stem 的 .qml 样式与字段名映射 sidecar，重新导入才能还原配色与列名。

    Returns:
        (zip_bytes, download_filename)  # 下载名 {图层名}.{格式}.zip
    """
    import io as _io
    import zipfile as _zipfile

    data_dir = settings.DATA_DIR / data_id
    if not data_dir.exists():
        raise FileNotFoundError(f"数据目录不存在: {data_id}")
    entry = _find_layer_entry(data_dir, layer_id)
    if entry is None:
        raise ValueError(f"未找到图层: {layer_id}")
    source_file = entry.get("metadata", {}).get("source_file")
    source_path = Path(source_file) if source_file else None
    fmt = _layer_fmt(source_path) if source_path else None
    if source_path is None or fmt is None or not source_path.exists():
        raise FileNotFoundError(f"图层源文件不存在: {source_path}")

    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as zf:
        # 大小写不敏感收集同 stem 的配套文件与 sidecar（用户上传常见大写后缀）
        for f in _layer_stem_files(source_path, fmt):
            if f.exists() and f.is_file():
                zf.write(f, arcname=f.name)
    safe_name = _sanitize_layer_name(entry.get("name") or source_path.stem)
    return buf.getvalue(), f"{safe_name}.{source_path.suffix.lstrip('.').lower()}.zip"


def _resolve_effective_type(declared_type: str, geoms: List[Any]) -> str:
    """根据实际要素几何推断保存类型：空/单类保留声明；多类或与声明不符升级为实际单类/mixed。"""
    if not geoms:
        return declared_type if declared_type in _OGR_GEOM_BY_ENTRY else "mixed"
    from shapely.geometry import (Point, LineString, Polygon,
                                  MultiPoint, MultiLineString, MultiPolygon)
    kinds = set()
    for g in geoms:
        if isinstance(g, (Point, MultiPoint)):
            kinds.add("point")
        elif isinstance(g, (LineString, MultiLineString)):
            kinds.add("line")
        elif isinstance(g, (Polygon, MultiPolygon)):
            kinds.add("polygon")
    if len(kinds) > 1:
        return "mixed"
    actual = kinds.pop()
    if actual == declared_type:
        return declared_type
    return actual

# 不写入 TAB 的前端内部字段
_INTERNAL_FIELDS = {"_editId", "_style", "_nptSelectionId"}

# 前端编辑样式持久化列：整层重写时把 _editStyle / _shape / _ellipse 序列化为 JSON 字符串
# 写入 TAB 属性表，刷新/重新加载后由 mapinfo_service 还原为内部字段。
# 列名刻意避开样式列正则（*style*/*pen*/*brush* 等），否则读取时会被吞进 _style。
_STYLE_PERSIST_COL = "NPT_FEATSYM"    # _editStyle（要素级绘制样式）
_META_PERSIST_COL = "NPT_FEATMETA"    # {_shape, _ellipse}（圆/椭圆元数据）
# Shapefile 用的短列名（DBF 字段名上限 10 字节，12 字节的 NPT_FEATMETA 放不下）。
# 圆/椭圆元数据不是样式、.qml 表达不了，只能落属性列，故保留这一处 DBF 例外。
_META_PERSIST_COL_DBF = "NPT_FMETA"

# 绘制样式输入键：这些键是前端绘制样式的载体（经 NPT_FEATSYM 持久化），
# 不作为普通属性列扩展进 TAB schema
_STYLE_INPUT_KEYS = {
    "markerColor", "markerSize", "markerSymbol", "markerRadius", "markerIconPx",
    "borderColor", "borderWidth", "borderDash",
    "fillColor", "fillOpacity",
    "color", "weight", "opacity", "dashArray", "shape",
}


def _read_tab_gdf(tab_path: Path, rows: Optional[int] = None) -> gpd.GeoDataFrame:
    """读取图层源文件为 GeoDataFrame（TAB / Shapefile / GeoJSON 通用）。

    默认编码优先（GDAL 按 .tab 声明的 charset 解码）：项目写入的 TAB，.dat 实为 UTF-8
    而 .tab 声明 WindowsSimpChinese，显式传 encoding='gbk' 会把 UTF-8 字节静默解成乱码
    中文列名（如“等级”→‘绛夌骇’），保存时按乱码列名对齐会把属性写进垃圾列。
    默认编码失败时（部分 Neutral/纯 GBK 上传件）才回退 GBK。
    rows: 仅读取前 N 行（取 schema 用；不传则读全量）。
    """
    kwargs = {"rows": rows} if rows is not None else {}
    try:
        gdf = gpd.read_file(tab_path, **kwargs)
    except Exception:
        gdf = gpd.read_file(tab_path, encoding="gbk", **kwargs)
    # Shapefile 的 DBF 字段名被转写过（≤10 字节），读回时还原为显示名，
    # 否则保存按存储名对齐、属性框也会显示 F_3 这类转写名
    return _apply_display_names(gdf, tab_path)


def _apply_display_names(gdf: gpd.GeoDataFrame, source_path: Path) -> gpd.GeoDataFrame:
    """按字段名映射 sidecar 把 DBF 存储名还原为显示名（无映射时原样返回）。"""
    mapping = read_field_map(source_path)
    if not mapping:
        return gdf
    reverse = {v: k for k, v in mapping.items()}
    rename = {c: reverse[c] for c in gdf.columns if c in reverse}
    return gdf.rename(columns=rename) if rename else gdf


def _find_layer_entry(data_dir: Path, layer_id: str) -> Optional[Dict[str, Any]]:
    layers_file = data_dir / "layers.json"
    if not layers_file.exists():
        return None
    try:
        layers = json.loads(layers_file.read_text(encoding="utf-8"))
        for entry in layers:
            if entry.get("id") == layer_id:
                return entry
    except Exception as e:
        print(f"[LayerEdit] 读取 layers.json 失败: {e}")
    return None


def _scalarize(v: Any) -> Any:
    """属性值归一为可写入 TAB 的标量（基站扇区等来源含 attributes 等嵌套对象）。

    非标量一律 JSON 序列化为字符串，避免 pyogrio/MapInfo 字段写入报错导致整层保存失败。
    """
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


def _geom_kind(g: Any) -> str:
    """单个几何 → point/line/polygon（无法识别返回空串）。"""
    from shapely.geometry import (Point, LineString, Polygon,
                                  MultiPoint, MultiLineString, MultiPolygon)
    if isinstance(g, (Point, MultiPoint)):
        return "point"
    if isinstance(g, (LineString, MultiLineString)):
        return "line"
    if isinstance(g, (Polygon, MultiPolygon)):
        return "polygon"
    return ""


def _dominant_kind(geoms: List[Any]) -> str:
    """占比最高的几何类型（混合几何降级写入时用）。"""
    counts: Dict[str, int] = {}
    for g in geoms:
        k = _geom_kind(g)
        if k:
            counts[k] = counts.get(k, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _backup_stem(source_path: Path, fmt: str) -> Optional[Path]:
    """备份同 stem 的图层文件到临时目录，失败回滚用（大小写不敏感扫描）。"""
    import tempfile
    backup_dir = Path(tempfile.mkdtemp(prefix="layer_edit_"))
    for f in _layer_stem_files(source_path, fmt):
        if f.exists():
            shutil.copy2(f, backup_dir / f.name)
    return backup_dir


def _restore_stem(backup_dir: Optional[Path], source_path: Path, fmt: str) -> None:
    if not backup_dir or not backup_dir.exists():
        return
    for f in _layer_stem_files(source_path, fmt):
        try:
            f.unlink(missing_ok=True)
        except OSError as e:
            print(f"[LayerEdit] 回滚删除失败 {f}: {e}")
    for f in backup_dir.iterdir():
        shutil.copy2(f, source_path.parent / f.name)
    shutil.rmtree(backup_dir, ignore_errors=True)


def _upsert_layer_metadata(layer_id: str, name: str, file_path: str,
                           geom_value: str, feature_count: int,
                           file_size: Optional[int], user_id: int,
                           city: Optional[str] = None,
                           operator: Optional[str] = None) -> None:
    """更新（或插入）SQLite layers 表中该图层的元数据。"""
    from app.core.database import SessionLocal
    from app.models.database import Layer
    from datetime import datetime
    db = SessionLocal()
    try:
        row = db.query(Layer).filter(Layer.id == layer_id).first()
        if row:
            row.name = name
            row.file_path = file_path
            row.geometry_type = geom_value
            row.layer_type = geom_value
            row.feature_count = feature_count
            row.file_size = file_size
            db.commit()
        else:
            db.add(Layer(
                id=layer_id, user_id=user_id, city=city, operator=operator,
                name=name, file_path=file_path,
                layer_type=geom_value, geometry_type=geom_value,
                feature_count=feature_count, file_size=file_size,
                created_at=datetime.now().isoformat(),
            ))
            db.commit()
    except Exception as e:
        db.rollback()
        print(f"[LayerEdit] 图层元数据更新失败（非致命）: {e}")
    finally:
        db.close()


def _remove_disk_cache(data_dir: Path, layer_id: str) -> None:
    cache_dir = layer_cache_dir(data_dir)
    for pat in (f"{layer_id}.geojson", f"{layer_id}.geojson.gz",
                f"{layer_id}.geojson.gz.tmp", f"{layer_id}.mtime"):
        p = cache_dir / pat
        if p.exists():
            p.unlink(missing_ok=True)


def _resolve_layer_target(data_id: str, layer_id: str) -> tuple:
    """解析图层保存目标：(data_dir, entry, source_path, entry_type)。

    支持 MapInfo TAB 与 ESRI Shapefile / GeoJSON（MIF/KML 不支持编辑保存）。
    校验失败抛 ValueError/FileNotFoundError。
    """
    data_dir = settings.DATA_DIR / data_id
    if not data_dir.exists():
        raise FileNotFoundError(f"数据目录不存在: {data_id}")

    entry = _find_layer_entry(data_dir, layer_id)
    if entry is None:
        raise ValueError(f"未找到图层: {layer_id}")

    source_file = entry.get("metadata", {}).get("source_file")
    source_path = Path(source_file) if source_file else None
    if source_path is None or _layer_fmt(source_path) is None:
        raise ValueError("仅支持保存 MapInfo TAB / ESRI Shapefile / GeoJSON 图层（MIF/KML 暂不支持编辑保存）")
    if not source_path.exists():
        raise FileNotFoundError(f"图层源文件不存在: {source_path}")

    entry_type = entry.get("type", "point")
    if not _OGR_GEOM_BY_ENTRY.get(entry_type):
        raise ValueError(f"未知图层几何类型: {entry_type}")
    return data_dir, entry, source_path, entry_type


def layer_version(source_path: Path, layer_id: str) -> str:
    """图层版本指纹（与图层数据端点 ETag 同构）："<layer_id>-<源文件 mtime>"。"""
    return f'"{layer_id}-{source_path.stat().st_mtime}"'


def _coerce_column(series: pd.Series, old_dtype: Any) -> pd.Series:
    """数值列按旧 dtype 收敛（旧列为整型→缺值填 0；浮点→NaN），其余列保持原样。"""
    if pd.api.types.is_integer_dtype(old_dtype):
        return pd.to_numeric(series, errors="coerce").fillna(0).astype("int64")
    if pd.api.types.is_float_dtype(old_dtype):
        return pd.to_numeric(series, errors="coerce").astype("float64")
    return series


# ---------------------------------------------------------------------------
# 逐要素样式：_editStyle（要素样式弹窗/绘制样式）合并 _style（TAB 原生配色）
# → 带样式 MIF → GDAL 转换为 TAB（样式进 .map 定义表）
# ---------------------------------------------------------------------------

def _first_not_none(*vals: Any) -> Any:
    for v in vals:
        if v is not None:
            return v
    return None


def _g(d: Optional[Dict[str, Any]], key: str) -> Any:
    """dict 安全取值：d 不是 dict（如 None/{} 短路场景）时返回 None。"""
    return d.get(key) if isinstance(d, dict) else None


def _dasharray_to_pen_pattern(dash: Any) -> int:
    """strokeDasharray → MapInfo Pen pattern：2 实线 / 3 虚线 / 4 点线。"""
    if not dash or not isinstance(dash, str) or dash.strip().lower() in ("", "none"):
        return 2
    nums = re.findall(r"[\d.]+", dash)
    if not nums:
        return 2
    return 4 if float(nums[0]) <= 2 else 3


def _resolve_feature_style(kind: str, es: Optional[Dict[str, Any]] = None,
                           ns: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """合并要素的编辑样式（优先）与原生样式，输出统一结构；两者皆无返回 None。

    es: properties._editStyle（可能按几何分段存储 {point/line/polygon: {...}}）
    ns: properties._style（MapInfo/KML 原生样式，键 strokeColor/fillColor/markerColor 等）
    输出键（按几何类型取用）：
      point  → markerColor, markerSize
      line   → strokeColor, strokeWidth, strokeDash, strokeOff
      polygon → 上述 + fillColor, fillOpacity, fillOff
    """
    if isinstance(es, dict):
        seg = es.get(kind)
        if isinstance(seg, dict):
            es = seg
    else:
        es = None
    if not isinstance(ns, dict):
        ns = None

    out: Dict[str, Any] = {"kind": kind}
    if kind == "point":
        out["markerColor"] = _first_not_none(_g(es, "markerColor"),
                                             _g(ns, "markerColor"),
                                             _g(ns, "fillColor"))
        out["markerSize"] = _first_not_none(_g(es, "markerSize"),
                                            _g(ns, "markerSize"),
                                            _g(ns, "radius"))
    elif kind == "line":
        out["strokeColor"] = _first_not_none(_g(es, "color"),
                                             _g(ns, "strokeColor"),
                                             _g(ns, "color"))
        out["strokeWidth"] = _first_not_none(_g(es, "weight"),
                                             _g(ns, "strokeWidth"))
        out["strokeDash"] = _first_not_none(_g(es, "dashArray"),
                                            _g(ns, "strokeDasharray"))
        out["strokeOff"] = _g(ns, "stroke") is False or None
    else:
        out["strokeColor"] = _first_not_none(_g(es, "borderColor"),
                                             _g(ns, "strokeColor"))
        out["strokeWidth"] = _first_not_none(_g(es, "borderWidth"),
                                             _g(ns, "strokeWidth"))
        out["strokeDash"] = _first_not_none(_g(es, "borderDash"),
                                            _g(ns, "strokeDasharray"))
        out["strokeOff"] = _g(ns, "stroke") is False or None
        out["fillColor"] = _first_not_none(_g(es, "fillColor"),
                                           _g(ns, "fillColor"))
        out["fillOpacity"] = _first_not_none(_g(es, "fillOpacity"),
                                             _g(ns, "fillOpacity"))
        # 原生 Brush 图案号（斜线/网格等，仅 _style 有；_editStyle 不表达图案）
        out["fillPattern"] = _g(ns, "fillPattern")
        out["fillOff"] = _g(ns, "fill") is False or None

    # 去掉 None 值后判定（kind 不算有效样式信息）
    if not any(v is not None for k, v in out.items() if k != "kind"):
        return None
    return out


def _mif_pen_row(st: Dict[str, Any]) -> str:
    """统一样式 → MIF Pen 行（边框/线）。"""
    color = st.get("strokeColor")
    if st.get("strokeOff") or is_no_color(color):
        return "Pen (1,1,0)"  # pattern 1 = 无边框
    width = st.get("strokeWidth")
    try:
        width = max(1, min(7, int(round(float(width))))) if width is not None else 1
    except (TypeError, ValueError):
        width = 1
    pattern = _dasharray_to_pen_pattern(st.get("strokeDash"))
    mif_color = hex_to_mapinfo_color(color) if color else None
    # 非法 hex 返回 None → 回退黑色 0，避免把 "None" 写进 MIF
    return f"Pen ({width},{pattern},{mif_color if mif_color is not None else 0})"


def _feature_mif_rows(st: Dict[str, Any]) -> List[str]:
    """统一样式 → MIF 样式行（点→Symbol；线→Pen；面→Pen+Brush）。"""
    kind = st["kind"]
    if kind == "point":
        color = st.get("markerColor")
        mif_color = hex_to_mapinfo_color(color) if color and not is_no_color(color) else None
        if mif_color is None:
            # 不写 Symbol；注意 GDAL 会对无 Symbol 的点补默认黑符号（TAB 无法表达"不绘制点"）
            return []
        size = st.get("markerSize")
        try:
            size = max(3, min(48, int(round(float(size))))) if size is not None else 12
        except (TypeError, ValueError):
            size = 12
        return [f"Symbol (34,{mif_color},{size})"]  # 34 = 实心圆

    rows = [_mif_pen_row(st)]
    if kind == "polygon":
        fill = st.get("fillColor")
        if st.get("fillOff") or is_no_color(fill):
            rows.append("Brush (1,0)")  # 无填充
        else:
            mif_fill = hex_to_mapinfo_color(fill)
            if mif_fill is not None:
                pattern = st.get("fillPattern")
                if isinstance(pattern, int) and pattern > 2:
                    # 原生图案填充（斜线/网格等）：原样写回图案号，GDAL 转换忠实保留
                    rows.append(f"Brush ({pattern},{mif_fill})")
                elif pattern == 2:
                    rows.append(f"Brush (2,{mif_fill},16777215)")
                else:
                    # _editStyle 来源（无图案）：TAB 无 alpha，fillOpacity（CSS 语义，
                    # 越大越不透明）→ 透明度两档
                    opacity = st.get("fillOpacity")
                    transparency = 1.0 - float(opacity) if opacity is not None else None
                    two_level = tab_opacity_brush_pattern(transparency)
                    if two_level == 2:
                        rows.append(f"Brush (2,{mif_fill},16777215)")
                    else:
                        rows.append(f"Brush (1,{mif_fill})")
    return rows


# MIF 几何对象起始行（样式行紧跟其坐标数据之后）
_MIF_GEOM_RE = re.compile(
    r'^\s*(?:Multiple\s+)?'
    r'(Point|Line|MultiPoint|MultiLineString|Pline|Region|Arc|Ellipse|Rect|RoundedRect|Collection)\b',
    re.IGNORECASE,
)
_MIF_STYLE_LINE_RE = re.compile(r'^\s*(Pen|Brush|Symbol)\s*\(', re.IGNORECASE)


def _inject_mif_styles(text: str, feature_styles: List[Optional[Dict[str, Any]]]) -> str:
    """把 MIF 中逐要素的默认 Pen/Brush/Symbol 行替换为指定样式（按几何块顺序对应）。

    feature_styles 元素为 None 的要素保留原行；几何块数与样式数不一致时按索引对齐。
    """
    lines = text.splitlines()
    data_idx = next((i for i, ln in enumerate(lines) if ln.strip().lower() == "data"), -1)
    if data_idx < 0:
        return text
    body = lines[data_idx + 1:]

    # 几何块行范围 [start, end)
    blocks: List[List[int]] = []
    for i, ln in enumerate(body):
        if _MIF_GEOM_RE.match(ln):
            if blocks:
                blocks[-1][1] = i
            blocks.append([i, len(body)])

    # MultiPoint / GeometryCollection 会被展开成多个几何块，按块对齐会整体错位：
    # 显式抛异常让调用方回退普通写入，而不是写出错位文件再等行数校验拦截
    if len(blocks) != len(feature_styles):
        raise ValueError(
            f"MIF 几何块数（{len(blocks)}）与要素样式数（{len(feature_styles)}）不一致，"
            "疑似 MultiPoint/GeometryCollection 展开，跳过带样式写入")

    # 从后向前替换避免位移
    for bi in range(len(blocks) - 1, -1, -1):
        st = feature_styles[bi] if bi < len(feature_styles) else None
        if st is None:
            continue
        s, e = blocks[bi]
        non_style = [ln for ln in body[s:e] if not _MIF_STYLE_LINE_RE.match(ln)]
        body[s:e] = non_style + ["    " + r for r in _feature_mif_rows(st)]

    return "\n".join(lines[:data_idx + 1] + body) + "\n"


def _write_tmp_mapinfo_mif(gdf: gpd.GeoDataFrame, path: Path, ogr_geom: str) -> None:
    """写临时 MIF（GBK、f0..fN 占位列名，不做列名恢复），供带样式转换用。"""
    geom_name = gdf.geometry.name
    attr_cols = [c for c in gdf.columns if c != geom_name]
    field_names = [f"f{i}" for i in range(len(attr_cols))]
    field_data = build_field_data(gdf, attr_cols)
    geoms_wkb = [wkb.dumps(g) for g in gdf.geometry]
    pyogrio.raw.write(
        str(path),
        geometry=geoms_wkb,
        field_data=field_data,
        fields=field_names,
        geometry_type=ogr_geom,
        crs="EPSG:4326",
        driver="MapInfo File",
        encoding="GBK",
    )


def _write_styled_layer_tab(gdf: gpd.GeoDataFrame, feature_styles: List[Optional[Dict[str, Any]]],
                            tab_path: Path, ogr_geom: str) -> None:
    """带逐要素样式写 TAB：临时 MIF（注入 Pen/Brush/Symbol）→ GDAL 转换 → 修 charset/列名。

    任一步失败抛异常，调用方回退无样式普通写入。
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="npt_edit_style_"))
    try:
        tmp_mif = tmp_dir / f"{tab_path.stem}.mif"
        _write_tmp_mapinfo_mif(gdf, tmp_mif, ogr_geom)
        text = tmp_mif.read_text(encoding="gbk", errors="replace")
        # pyogrio 写 MIF 固定声明 Charset "Neutral"（无视 encoding 参数），GDAL 会按
        # UTF-8 解码实际的 GBK 字节，中文属性在转换时损坏 → 改声明为 WindowsSimpChinese。
        text = re.sub(r'(?im)^Charset "Neutral"',
                       'Charset "WindowsSimpChinese"', text, count=1)
        text = _inject_mif_styles(text, feature_styles)
        tmp_mif.write_text(text, encoding="gbk", errors="replace")

        remove_tab_stem(tab_path)
        convert_mif_to_tab(tmp_mif, tab_path)

        geom_name = gdf.geometry.name
        attr_cols = [c for c in gdf.columns if c != geom_name]
        sanitized = _dedupe_field_names(
            [_sanitize_field_name(str(c), i) for i, c in enumerate(attr_cols)]
        )
        _postprocess_tab(tab_path, sanitized)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def read_tab_native_styles(tab_path: Path) -> List[Optional[Dict[str, Any]]]:
    """读取 TAB 逐要素原生样式（旧行序，无样式要素为 None）；读取失败返回空列表。"""
    raws = read_feature_style_strings(tab_path)
    if not raws:
        return []
    return [MapInfoParser._parse_ogr_style_string(s) if s else None for s in raws]


# DBF 文本字段的字符数上限，超出会被驱动静默丢弃
_DBF_MAX_TEXT_CHARS = 254


def _dbf_text(v: Any) -> Any:
    """DBF 文本值截断到 254 字符（DBF 字段宽度上限）。"""
    return v[:_DBF_MAX_TEXT_CHARS] if isinstance(v, str) and len(v) > _DBF_MAX_TEXT_CHARS else v


def _remove_stem_for_write(source_path: Path, fmt: str) -> None:
    """覆写前删除同 stem 的旧图层文件，避免残留配套文件与新数据不一致。"""
    for f in _layer_stem_files(source_path, fmt):
        try:
            f.unlink(missing_ok=True)
        except OSError as e:
            print(f"[LayerEdit] 删除旧图层文件失败 {f}: {e}")


def _write_shapefile(gdf: gpd.GeoDataFrame, source_path: Path, kind: str,
                     feature_styles: Optional[List[Optional[Dict[str, Any]]]]) -> None:
    """写 ESRI Shapefile：字段名净化 + DBF 文本截断 + 同 stem .qml 样式。

    DBF 字段名上限 10 字节，且截断到多字节字符中间会写坏整个 .dbf（读回
    UnicodeDecodeError），故超限名转写为安全名并登记映射，读回时还原显示名。
    """
    from app.services.qml_style_writer import write_layer_qml

    display_cols = [str(c) for c in gdf.columns if c != "geometry"]
    storage_cols = _dedupe_field_names(
        [_dbf_safe_name(c, i) for i, c in enumerate(display_cols)]
    )
    mapping = {d: s for d, s in zip(display_cols, storage_cols) if d != s}
    gdf = gdf.rename(columns=dict(zip(display_cols, storage_cols)))

    for c in storage_cols:
        if gdf[c].dtype == object:
            gdf[c] = gdf[c].map(_dbf_text)

    _remove_stem_for_write(source_path, "shp")
    gdf.to_file(source_path, driver="ESRI Shapefile", encoding="utf-8")
    write_layer_qml(source_path.with_suffix(".qml"), kind, feature_styles or [])
    write_field_map(source_path, mapping)


def _write_geojson(gdf: gpd.GeoDataFrame, source_path: Path, kind: str,
                   feature_styles: Optional[List[Optional[Dict[str, Any]]]]) -> None:
    """写 GeoJSON：无字段名/几何类型限制，样式写同 stem .qml（QGIS 打开即见配色）。"""
    from app.services.qml_style_writer import write_layer_qml

    _remove_stem_for_write(source_path, "geojson")
    gdf.to_file(source_path, driver="GeoJSON")
    write_layer_qml(source_path.with_suffix(".qml"), kind, feature_styles or [])


def _write_layer_gdf(*, data_id: str, data_dir: Path, tab_path: Path, layer_id: str,
                     entry: Dict[str, Any], entry_type: str,
                     gdf: gpd.GeoDataFrame, geoms: List[Any],
                     user_id: int,
                     feature_styles: Optional[List[Optional[Dict[str, Any]]]] = None,
                     fmt: str = "tab") -> Dict[str, Any]:
    """整层重写图层文件（原子写 + 混合几何降级）+ 校验 + 元数据刷新 + 缓存失效。

    fmt: tab / shp / geojson（默认 tab，向后兼容既有调用）。
    整层保存与增量保存共用此收尾：调用方负责把要素集成为 gdf。
    """
    # 实际几何类型：混合（含多种几何）或与图层声明类型不符时，用实际类型写并升级类型
    entry_type = _resolve_effective_type(entry_type, geoms)
    ogr_geom = _OGR_GEOM_BY_ENTRY.get(entry_type, "Unknown")
    entry["type"] = entry_type

    skipped = 0
    total_in = len(geoms)
    cur_styles = feature_styles

    # Shapefile 单文件只能存一种几何类型（混写直接报错）。这里不做 TAB 那种"写失败再
    # 降级"——SHP 必然失败，提前按声明类型（mixed 时取占比最高）过滤并明确报告跳过数，
    # 避免把要素静默写丢。
    if fmt == "shp":
        target = entry_type if entry_type != "mixed" else _dominant_kind(geoms)
        if target:
            keep_idx = [i for i, g in enumerate(geoms) if _geom_kind(g) == target]
            if len(keep_idx) != len(geoms):
                skipped = len(geoms) - len(keep_idx)
                gdf = gdf.iloc[keep_idx].copy()
                geoms = [geoms[i] for i in keep_idx]
                cur_styles = [cur_styles[i] if cur_styles else None for i in keep_idx]
            entry_type = target
            ogr_geom = _OGR_GEOM_BY_ENTRY.get(target, "Unknown")
            entry["type"] = target

    # 原子写（先备份，失败回滚）
    # GDAL 驱动按小写后缀落盘：源文件为大写 .TAB/.SHP 时改写为小写路径，
    # 避免"写到 .TAB / 读到 .tab"的路径漂移（保存后读回 404）。
    if tab_path.suffix != f".{fmt}" and fmt != "geojson":
        tab_path = tab_path.with_suffix(f".{fmt}")
    backup = _backup_stem(tab_path, fmt)

    def _do_write(cur_gdf: gpd.GeoDataFrame, cur_ogr: str,
                  styles: Optional[List[Optional[Dict[str, Any]]]]) -> None:
        if fmt == "shp":
            _write_shapefile(cur_gdf, tab_path, entry_type, styles)
            return
        if fmt == "geojson":
            _write_geojson(cur_gdf, tab_path, entry_type, styles)
            return
        # 有任一样式信息时走带样式 MIF 中转；转换失败回退普通 pyogrio 写入（数据不丢）
        if styles and any(s is not None for s in styles):
            try:
                _write_styled_layer_tab(cur_gdf, styles, tab_path, cur_ogr)
                return
            except Exception as style_err:  # noqa: BLE001 — 样式是增强项
                print(f"[LayerEdit] 带样式写入失败，回退普通 TAB 写入: {style_err}")
                remove_tab_stem(tab_path)
        write_mapinfo_tab(cur_gdf, tab_path, geometry_type=cur_ogr)

    try:
        try:
            _do_write(gdf, ogr_geom, cur_styles)
            verify_tab_readable(tab_path, len(geoms), label=fmt.upper())
        except Exception as first_err:
            # MapInfo TAB 不支持混合几何（如把基站点粘贴到面图层）。此时按占比最高的
            # 几何类型重写并跳过不匹配的要素，避免整层保存失败导致粘贴结果丢失。
            if fmt != "tab" or entry_type != "mixed":
                raise
            dom = _dominant_kind(geoms)
            if not dom:
                raise
            keep_idx = [i for i, g in enumerate(geoms) if _geom_kind(g) == dom]
            if not keep_idx:
                raise
            print(f"[LayerEdit] 混合几何写入失败（{first_err}），降级为 {dom}，跳过 {len(geoms)-len(keep_idx)} 个不匹配要素")
            gdf = gdf.iloc[keep_idx].copy()
            geoms = [geoms[i] for i in keep_idx]
            cur_styles = [cur_styles[i] if cur_styles else None for i in keep_idx]
            entry_type = dom
            entry["type"] = dom
            _do_write(gdf, _OGR_GEOM_BY_ENTRY.get(dom, "Unknown"), cur_styles)
            verify_tab_readable(tab_path, len(geoms), label=fmt.upper())
            skipped = total_in - len(geoms)
    except Exception:
        _restore_stem(backup, tab_path, fmt)
        raise
    finally:
        if backup and backup.exists():
            shutil.rmtree(backup, ignore_errors=True)

    # 更新元数据（layers.json / index.json / SQLite）
    feature_count = len(geoms)
    total_size = sum(f.stat().st_size for f in data_dir.glob("*") if f.is_file())
    entry["feature_count"] = feature_count
    entry.setdefault("metadata", {})["feature_count"] = feature_count
    entry["metadata"]["source_file"] = str(tab_path)

    layers = []
    layers_file = data_dir / "layers.json"
    if layers_file.exists():
        layers = json.loads(layers_file.read_text(encoding="utf-8"))
    for i, lyr in enumerate(layers):
        if lyr.get("id") == layer_id:
            layers[i] = entry
            break
    else:
        layers.append(entry)
    layers_file.write_text(json.dumps(layers, ensure_ascii=False, indent=2), encoding="utf-8")

    from app.services.data_service import data_service
    idx = data_service.index.get(data_id)
    if idx is not None:
        idx["size"] = total_size
        # 图层已更新：同步刷新数据管理列表的"上传时间"时间戳（方案B 语义下
        # 该条目下载返回的就是最新图层文件，时间戳应反映最后一次保存）
        idx["uploadDate"] = pd.Timestamp.now().isoformat()
        idx.setdefault("metadata", {})["layers"] = layers
        idx["metadata"]["layerCount"] = len(layers)
        data_service._save_index()

    _upsert_layer_metadata(
        layer_id=layer_id, name=entry.get("name", tab_path.stem),
        file_path=str(tab_path), geom_value=entry_type,
        feature_count=feature_count, file_size=total_size, user_id=user_id,
        # 组归属继承所属数据条目（图层归数据所在的组所有）
        city=(idx or {}).get("city"), operator=(idx or {}).get("operator"),
    )

    # 失效缓存（内存 + 落盘；落盘按源文件 mtime 也会自动失效）
    clear_layer_cache(data_id)
    _remove_disk_cache(data_dir, layer_id)

    result = {"success": True, "feature_count": feature_count,
              # 保存后新的版本指纹（源文件 mtime）：前端据此发起下一次增量保存，无需重新拉取图层数据
              "version": layer_version(tab_path, layer_id)}
    if skipped > 0:
        result["skipped"] = skipped
        result["warning"] = f"图层不支持混合几何，已跳过 {skipped} 个几何类型不符的要素"
    return result


def save_layer_geojson(data_id: str, layer_id: str, geojson: Dict[str, Any],
                       user_id: int = 1) -> Dict[str, Any]:
    """把前端编辑工作集整层重写回 TAB（GCJ02→WGS84，保留旧属性表 schema）。

    Returns:
        {"success": True, "feature_count": N}
    """
    data_dir, entry, tab_path, entry_type = _resolve_layer_target(data_id, layer_id)
    fmt = _layer_fmt(tab_path) or "tab"
    # Shapefile / GeoJSON 的样式落在同 stem .qml，不写 NPT_FEATSYM 列（DBF 字段名上限
    # 也放不下 12 字节的列名）；圆的元数据 .qml 表达不了，仍走属性列但用 ≤10 字节名。
    style_col = None if fmt != "tab" else _STYLE_PERSIST_COL
    meta_col = _META_PERSIST_COL if fmt == "tab" else _META_PERSIST_COL_DBF

    # 1. 读旧 schema（权威）：属性列与 dtype（GBK 失败回退默认编码）。
    # 只取首行即可（GDAL 按列类型给 dtype），避免大图层保存时整表读取的额外耗时。
    old = _read_tab_gdf(tab_path, rows=1)
    attr_cols: List[str] = [c for c in old.columns if c != "geometry"]
    old_dtypes = {c: old[c].dtype for c in attr_cols}
    for internal in _INTERNAL_FIELDS:
        if internal in attr_cols:
            attr_cols.remove(internal)
    # 样式持久化列不走通用属性对齐（前端属性里是还原后的内部字段），单独序列化
    for c in (_STYLE_PERSIST_COL, _META_PERSIST_COL, _META_PERSIST_COL_DBF):
        if c in attr_cols:
            attr_cols.remove(c)

    # 1.5 扩展粘贴/新要素带来的新属性键（旧 schema 之外的列自动追加）：
    # 使"基站圈选→粘贴到其他图层"等跨源粘贴的属性不丢失（否则扇区 pci/azimuth 等
    # 在目标图层旧列中不存在，粘贴后属性全空）。
    # 绘制样式键不扩展（绘制样式经 NPT_FEATSYM 持久化，写入属性列只会产生垃圾列）。
    features = geojson.get("features", []) if isinstance(geojson, dict) else []
    new_cols: List[str] = []
    seen_cols = set(attr_cols)
    reserved = (set(_INTERNAL_FIELDS)
                | {_STYLE_PERSIST_COL, _META_PERSIST_COL, _META_PERSIST_COL_DBF}
                | _STYLE_INPUT_KEYS)
    for f in features:
        props = f.get("properties") or {}
        for k in props.keys():
            if k in seen_cols or k in reserved or k.startswith("_"):
                continue
            if len(new_cols) >= 200:
                break
            seen_cols.add(k)
            new_cols.append(k)
    for c in new_cols:
        attr_cols.append(c)
        old_dtypes[c] = None

    # 2. 解析要素：GCJ02 → WGS84，几何 + 按列对齐属性
    # 坐标逆转换与几何构建整层一次批量完成（逐要素调用 numpy / shapely.shape 在大图层下
    # 开销显著，慢 5-10 倍）；无法数组化的几何（z 值/未知类型）在内部回退通用递归路径，
    # 解析失败的要素按原逻辑跳过。
    geom_items: List[Any] = []
    for f in features:
        geom = f.get("geometry")
        if geom and geom.get("coordinates"):
            geom_items.append((f, geom))
    built = build_geometries([g for _, g in geom_items], from_wgs84=False)

    geoms = []
    feature_styles: List[Optional[Dict[str, Any]]] = []
    col_values: Dict[str, list] = {c: [] for c in attr_cols}
    sym_vals: List[str] = []
    meta_vals: List[str] = []
    for (f, _), g in zip(geom_items, built):
        if g is None or g.is_empty:
            continue
        props = f.get("properties") or {}
        # 逐要素样式：编辑样式（_editStyle）优先，原生配色（_style）兜底
        feature_styles.append(_resolve_feature_style(
            _geom_kind(g), es=props.get("_editStyle"), ns=props.get("_style")))
        for c in attr_cols:
            col_values[c].append(
                _scalarize(props.get(c)) if (c in props and c not in _INTERNAL_FIELDS) else None
            )
        # 序列化编辑样式/圆元数据（无则空串占位）
        es = props.get("_editStyle")
        sym_vals.append(json.dumps(es, ensure_ascii=False) if isinstance(es, dict) else "")
        meta = {k: props[k] for k in ("_shape", "_ellipse") if props.get(k) is not None}
        meta_vals.append(json.dumps(meta, ensure_ascii=False) if meta else "")
        geoms.append(g)

    # 3. 建新 gdf（列序与旧表一致；数值列按旧 dtype 收敛）
    data: Dict[str, Any] = {}
    for c in attr_cols:
        data[c] = _coerce_column(pd.Series(col_values[c]), old_dtypes.get(c))
    if not attr_cols:  # 极端兜底：0 列时补默认列（.dat 至少 1 字段）
        data[_DEFAULT_ATTR_COLUMN] = pd.Series([""] * len(geoms), dtype="object")
        attr_cols = [_DEFAULT_ATTR_COLUMN]

    # 编辑样式持久化列：任一要素携带时才新增列（旧图层无样式列不受影响）
    # 非 TAB 格式不写 _STYLE_PERSIST_COL：样式已由同 stem .qml 承载，重复落列只会
    # 在 DBF 里挤进一个被截断的列名并与 .qml 形成两份真相。
    if any(sym_vals) and style_col:
        data[style_col] = pd.Series(sym_vals, dtype="object")
    if any(meta_vals):
        data[meta_col] = pd.Series(meta_vals, dtype="object")

    geometry = gpd.GeoSeries(geoms, crs="EPSG:4326") if geoms else gpd.GeoSeries([], crs="EPSG:4326")
    gdf = gpd.GeoDataFrame(data, geometry=geometry, crs="EPSG:4326")

    result = _write_layer_gdf(
        data_id=data_id, data_dir=data_dir, tab_path=tab_path, layer_id=layer_id,
        entry=entry, entry_type=entry_type, gdf=gdf, geoms=geoms, user_id=user_id,
        feature_styles=feature_styles, fmt=fmt,
    )
    result["mode"] = "full"
    return result
