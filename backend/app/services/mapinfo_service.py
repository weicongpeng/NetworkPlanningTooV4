"""
MapInfo 文件解析服务

支持格式:
- .tab: MapInfo TAB 格式 (包含表头定义和数据)
- .mif: MapInfo Interchange Format (交换格式)
- .dat: 数据文件
"""
import os
import re
import time
import uuid
import json
import gzip
import zlib
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass
from enum import Enum

from app.utils.coordinate_transformer import CoordinateTransformer
from app.utils.geojson_geometry import transform_coordinate_lists
from app.core.database import SessionLocal
from app.models.database import Layer

# MapInfo 图层数据缓存（避免每次请求都重新解析文件）
_layer_cache: Dict[str, Dict] = {}
_layer_cache_mtime: Dict[str, float] = {}
_layer_cache_ttl: int = 600  # 缓存10分钟

# 当前进程最后一次 parse_mapinfo_files 调用的解析错误清单
# 每次调用入口处清空，parse_directory 内部 append。
# 供 data_service 把每个失败文件的具体原因写入 index.json metadata，
# 避免 len(layers)==0 静默返回上层。
_LAST_PARSE_ERRORS: List[Dict[str, str]] = []

# 图层默认配色板：文件无自带样式（MIF/TAB 无 Pen/Brush/Symbol、KML 无 <Style>）时，
# 按图层名哈希取色，保证不同图层初次导入即有不同的默认颜色（同名图层颜色稳定）。
_LAYER_PALETTE = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
    '#9a6324', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075',
    '#008080', '#a9a9a9',
]


def _palette_color(layer_name: str) -> str:
    """按图层名稳定取色（crc32 与进程/PYTHONHASHSEED 无关，跨重启一致）。
    正反两次 crc32 异或提高相邻名称（layer_0/layer_1...）的取色分布。"""
    n = (layer_name or '').encode('utf-8')
    h = zlib.crc32(n) ^ zlib.crc32(n[::-1])
    return _LAYER_PALETTE[h % len(_LAYER_PALETTE)]

# 信号强度分级着色（还原 MapInfo 按 RSRP 主题渲染的默认效果）：
# 图层含 SSRSRP/RSRP/电平/信号强度 字段且无文件自带样式时，按标准 RSRP 色阶
# （绿→黄绿→黄→橙→红）逐要素分级上色。
_RSRP_COLOR_RANGES = [
    (-90, '#00c853'),      # ≥-90  优良 绿
    (-100, '#aeea00'),     # ≥-100 良好 黄绿
    (-110, '#ffd600'),     # ≥-110 一般 黄
    (-120, '#ff6d00'),     # ≥-120 较差 橙
    (float('-inf'), '#d50000'),  # <-120 差 红
]

_RSRP_FIELD_KEYWORDS = ('ssrsrp', 'ss_rsrp', 'ss-rsrp', 'rsrp', '电平', '信号强度')


def _rsrp_color(value: float) -> str:
    for threshold, color in _RSRP_COLOR_RANGES:
        if value >= threshold:
            return color
    return '#d50000'


def _detect_rsrp_column(columns) -> Optional[str]:
    """从列名中检测 RSRP 类信号强度字段（排除 RSRQ/SINR，值域不适用 RSRP 色阶）。"""
    for col in columns:
        if col == 'geometry':
            continue
        name = str(col).lower()
        if any(kw in name for kw in _RSRP_FIELD_KEYWORDS):
            if 'rsrq' in name or 'sinr' in name:
                continue
            return col
    return None


class GeometryType(Enum):
    """几何类型"""
    POINT = "point"
    LINE = "line"
    POLYGON = "polygon"
    UNKNOWN = "unknown"


@dataclass
class MapInfoFeature:
    """MapInfo 要素"""
    id: str
    type: GeometryType
    coordinates: List[Any]  # Point: [x, y], Line: [[x, y], ...], Polygon: [[[x, y], ...], ...]
    properties: Dict[str, Any]


@dataclass
class MapInfoLayer:
    """MapInfo 图层"""
    id: str
    name: str
    type: GeometryType
    features: List[MapInfoFeature]
    metadata: Dict[str, Any]


class MapInfoParser:
    """MapInfo 文件解析器"""

    @staticmethod
    def detect_file_type(filename: str) -> Optional[str]:
        """检测文件类型"""
        ext = os.path.splitext(filename)[1].lower()
        if ext in ['.tab', '.mif', '.dat', '.kml']:
            return ext[1:]  # 返回不带点的扩展名
        return None

    @staticmethod
    def _extract_mapinfo_style(row: Any, columns: Any, geom_type: GeometryType,
                               style_cols: Optional[set] = None) -> Optional[Dict[str, Any]]:
        """
        提取 MapInfo 样式信息

        MapInfo 样式通常存储在特殊列中，如：
        - MAPINFO_pen, PEN: 线样式 (宽度、颜色、模式)
        - MAPINFO_brush, BRUSH: 填充样式 (前景色、背景色、模式)
        - MAPINFO_symbol, SYMBOL: 点符号
        - MAPINFO_font, FONT: 字体样式
        - MI_Style, MI_Styles: MapInfo 内部样式

        Args:
            row: 单行属性（dict 或 pandas Series）
            columns: 全部列名
            geom_type: 几何类型
            style_cols: 预计算的样式列集合（列名固定，只判断一次，避免逐行 re.search）
        """
        style = {}

        # 若未预计算，则现算一次（列名固定，正则只需执行一遍）
        if style_cols is None:
            import re
            style_patterns = [
                r'MAPINFO_pen', r'MAPINFO_brush', r'MAPINFO_symbol', r'MAPINFO_font',
                r'MAPINFO_Pen', r'MAPINFO_Brush', r'MAPINFO_Symbol', r'MAPINFO_Font',
                r'^pen$', r'^brush$', r'^symbol$', r'^font$',
                r'_pen$', r'_brush$', r'_symbol$', r'_font$',
                r' Pen$', r' Brush$', r' Symbol$', r' Font$',
                r'MI_Style', r'MI_Styles', r'MI_StyleDef',
                r'style', r'styles', r'Style', r'Styles',
                r'linewidth', r'linetype', r'linecolor',
                r'fillcolor', r'fillpattern', r'filltype',
                r'markertype', r'markersize', r'markercolor',
            ]
            style_cols = {
                str(col) for col in columns
                if col != 'geometry' and any(re.search(p, str(col), re.IGNORECASE) for p in style_patterns)
            }

        # 检查样式列
        for col in style_cols:
            value = row.get(col) if isinstance(row, dict) else row[col]
            if value is not None and value != '' and value != 0:
                parsed_style = MapInfoParser._parse_style_value(col, value)
                if parsed_style:
                    style.update(parsed_style)

        # 如果没有找到样式，尝试从属性中推断样式（已废弃，返回 None）
        if not style:
            style = MapInfoParser._infer_style_from_properties(row, geom_type)

        return style if style else None

    @staticmethod
    def _parse_style_value(style_type: str, value: Any) -> Optional[Dict[str, Any]]:
        """
        解析 MapInfo 样式值

        MapInfo 样式格式：
        - Pen: "width,color,pattern" (如 "2,255,0,0,2" 表示 2px 宽, 红色, 实线)
        - Brush: "fg_color,bg_color,pattern" (如 "255,255,0,255,255,255,1" 表示 黄色填充, 白色背景, 斜线)
        - Symbol: "shape,size,color,rotation" (如 "35,12,255,0,0,0" 表示 符号35, 12pt, 黑色, 0度)
        """
        if value is None or value == '':
            return None

        style_type_lower = style_type.lower()
        result = {}

        try:
            value_str = str(value).strip()

            # 如果是字典（可能来自某些解析器）
            if isinstance(value, dict):
                return value

            # 剥离 GDAL 输出前缀：'Pen (2, 2, 16711680)' → '2, 2, 16711680'
            # GDAL 读外部 MIF 时样式列值形如 'Pen (width, pattern, color)'
            _stripped = value_str
            for _kw in ('pen', 'brush', 'symbol', 'font'):
                _low = _stripped.lower()
                if _low.startswith(_kw + '(') or _low.startswith(_kw + ' ('):
                    _stripped = _stripped[len(_kw):].strip()
                    _stripped = _stripped.strip('()').strip()
                    break

            # 统一拆分（去除 GDAL 逗号后空格）
            parts = [p.strip() for p in _stripped.split(',')]

            # 解析 PEN (线样式)
            if 'pen' in style_type_lower:
                if len(parts) >= 2:
                    try:
                        result['stroke'] = True
                        result['strokeWidth'] = float(parts[0]) if parts[0] else 1
                        # MapInfo 颜色规范: Color = R + G*256 + B*65536（R 最低字节）
                        # 两种格式：
                        #  1) width,pattern,color_int  (GDAL/MIF 三段，color 为 24-bit 整数)
                        #  2) width,r,g,b,pattern      (多段 RGB)
                        if len(parts) == 3:
                            color_int = int(parts[2])
                            r = color_int & 255
                            g = (color_int >> 8) & 255
                            b = (color_int >> 16) & 255
                            result['strokeColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            # 三段格式的 pattern 在 parts[1]
                            if parts[1].isdigit():
                                result['strokeDasharray'] = MapInfoParser._get_dash_pattern(int(parts[1]))
                        elif len(parts) >= 4:
                            r = int(parts[1])
                            g = int(parts[2])
                            b = int(parts[3])
                            result['strokeColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            # 线型模式
                            if len(parts) >= 5:
                                result['strokeDasharray'] = MapInfoParser._get_dash_pattern(int(parts[4]) if parts[4].isdigit() else 1)
                    except (ValueError, IndexError):
                        pass

            # 解析 BRUSH (填充样式)
            elif 'brush' in style_type_lower:
                if len(parts) >= 2:
                    try:
                        # 单整数格式: pattern,forecolor,[backcolor]（2-3 段，颜色为 24-bit 整数，
                        # 可为 0=黑色——不能靠 >255 判定，否则 Brush (2,0,16777215) 被误判为 RGB）
                        if len(parts) <= 3:
                            result['fill'] = True
                            result['fillPattern'] = int(parts[0]) if parts[0].isdigit() else 1
                            color_int = int(parts[1])
                            r = color_int & 255
                            g = (color_int >> 8) & 255
                            b = (color_int >> 16) & 255
                            result['fillColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            if len(parts) >= 3 and parts[2] and parts[2] != '0':
                                bg_int = int(parts[2])
                                r2 = bg_int & 255
                                g2 = (bg_int >> 8) & 255
                                b2 = (bg_int >> 16) & 255
                                result['fillBgColor'] = f'#{r2:02x}{g2:02x}{b2:02x}'
                        else:
                            result['fill'] = True
                            # 前景色
                            if len(parts) >= 3:
                                r = int(parts[0])
                                g = int(parts[1])
                                b = int(parts[2])
                                result['fillColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            # 背景色
                            if len(parts) >= 6:
                                r = int(parts[3])
                                g = int(parts[4])
                                b = int(parts[5])
                                result['fillBgColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            # 填充模式
                            if len(parts) >= 7 and parts[6].isdigit():
                                pattern = int(parts[6])
                                result['fillPattern'] = pattern
                                result['fillOpacity'] = 0.5 if pattern > 1 else 0.8
                    except (ValueError, IndexError):
                        result['fillColor'] = '#10b981'
                        result['fillOpacity'] = 0.3

            # 解析 SYMBOL (点符号)
            elif 'symbol' in style_type_lower:
                if len(parts) >= 1:
                    try:
                        result['markerType'] = 'symbol'
                        # 单整数格式: shape,color,[size,[rotation]]（颜色为 24-bit 整数）
                        # 2-4 段一律按单整数颜色解析——颜色可为 0（黑色），不能靠 >255 判定，
                        # 否则 Symbol (34,0,12) 会被误判为多段 RGB 导致 markerSize=0/颜色缺失
                        if 2 <= len(parts) <= 4:
                            result['markerSymbol'] = int(parts[0]) if parts[0].isdigit() else 'circle'
                            color_int = int(parts[1])
                            r = color_int & 255
                            g = (color_int >> 8) & 255
                            b = (color_int >> 16) & 255
                            result['markerColor'] = f'#{r:02x}{g:02x}{b:02x}'
                            if len(parts) >= 3 and parts[2].replace('.', '').isdigit():
                                result['markerSize'] = float(parts[2])
                        else:
                            # >=5 段多段 RGB 变体: shape,size,r,g,b
                            result['markerSymbol'] = int(parts[0]) if parts[0].isdigit() else 'circle'
                            if len(parts) >= 2:
                                result['markerSize'] = float(parts[1])
                            if len(parts) >= 5:
                                r = int(parts[2])
                                g = int(parts[3])
                                b = int(parts[4])
                                result['markerColor'] = f'#{r:02x}{g:02x}{b:02x}'
                    except (ValueError, IndexError):
                        result['markerColor'] = '#f59e0b'
                        result['markerSize'] = 8

            # 解析 FONT (文本样式)
            elif 'font' in style_type_lower:
                result['font'] = value_str

        except Exception as e:
            # 解析失败时返回 None
            pass

        return result if result else None

    @staticmethod
    def _get_dash_pattern(pattern_code: int) -> str:
        """
        MapInfo 线型模式代码转 SVG dasharray

        MapInfo 线型代码：
        1 = 实线, 2 = 长虚线, 3 = 短虚线, 4 = 点线, 5 = 点划线, etc.
        """
        patterns = {
            1: '',           # 实线
            2: '10,5',       # 长虚线
            3: '5,5',        # 短虚线
            4: '2,3',        # 点线
            5: '10,5,2,5',   # 点划线
            6: '15,5,2,5',   # 长点划线
            7: '15,3,3,3',   # 双点划线
            8: '20,5',       # 超长虚线
            9: '1,3',        # 稀疏点线
            10: '5,2,2,2',   # 密集点划线
        }
        return patterns.get(pattern_code, '5,5')

    @staticmethod
    def _infer_style_from_properties(row: Any, geom_type: GeometryType) -> Optional[Dict[str, Any]]:
        """
        从属性值推断样式（已废弃按属性关键词分色）

        统一由前端 DEFAULT_STYLES 着色，保证同一图层内颜色一致。
        保留函数签名以兼容调用方，直接返回 None。
        """
        return None

    @staticmethod
    def _kml_abgr_to_hex(kml_color: str) -> Optional[str]:
        """KML aabbggrr → '#rrggbb'（忽略 alpha），非法输入返回 None。"""
        if not kml_color or len(kml_color) != 8:
            return None
        try:
            int(kml_color, 16)
        except ValueError:
            return None
        return f"#{kml_color[6:8]}{kml_color[4:6]}{kml_color[2:4]}"

    @staticmethod
    def _kml_style_element_to_dict(style_el: Any) -> Dict[str, Any]:
        """把 KML <Style> 元素转换为 _style dict（LineStyle/PolyStyle/IconStyle）。"""
        sd: Dict[str, Any] = {}
        ls = style_el.find("{*}LineStyle")
        if ls is not None:
            color = ls.findtext("{*}color", default="")
            hexc = MapInfoParser._kml_abgr_to_hex(color)
            if hexc:
                sd["strokeColor"] = hexc
                try:
                    sd["strokeOpacity"] = round(int(color[0:2], 16) / 255, 2)
                except ValueError:
                    pass
            width = ls.findtext("{*}width", default="")
            if width:
                try:
                    sd["strokeWidth"] = float(width)
                except ValueError:
                    pass
        ps = style_el.find("{*}PolyStyle")
        if ps is not None:
            color = ps.findtext("{*}color", default="")
            hexc = MapInfoParser._kml_abgr_to_hex(color)
            if hexc:
                sd["fillColor"] = hexc
                try:
                    sd["fillOpacity"] = round(int(color[0:2], 16) / 255, 2)
                except ValueError:
                    pass
            if ps.findtext("{*}fill", default="1").strip() == "0":
                sd["fill"] = False
        ic = style_el.find("{*}IconStyle")
        if ic is not None:
            color = ic.findtext("{*}color", default="")
            hexc = MapInfoParser._kml_abgr_to_hex(color)
            if hexc:
                sd["markerColor"] = hexc
            scale = ic.findtext("{*}scale", default="")
            if scale:
                try:
                    # scale 为图标缩放倍数（基准图标约 32px），换算为像素半径
                    sd["markerSize"] = max(4, min(24, round(float(scale) * 8, 1)))
                except ValueError:
                    pass
        return sd

    @staticmethod
    def _parse_kml_styles(kml_file: Path) -> Optional[List[Optional[Dict[str, Any]]]]:
        """解析 KML 每个 Placemark 的默认样式，返回按文档顺序的样式列表（与 gpd 行序一致）。

        覆盖：LineStyle(color/width)、PolyStyle(color/fill/outline)、IconStyle(color/scale)。
        支持内联 <Style> 与 <styleUrl>（Document 级共享 <Style id>，含 StyleMap 的 normal 映射）。
        解析失败返回 None（调用方回退默认样式）。
        """
        import xml.etree.ElementTree as ET

        try:
            text = kml_file.read_text(encoding="utf-8", errors="replace")
            root = ET.fromstring(text)
        except Exception:
            return None

        # 收集 Document 级共享样式
        shared: Dict[str, Any] = {}
        for style in root.findall(".//{*}Style"):
            sid = style.get("id")
            if sid:
                shared[sid] = style
        # StyleMap → normal 样式引用
        stylemap_normal: Dict[str, str] = {}
        for sm in root.findall(".//{*}StyleMap"):
            sid = sm.get("id")
            if not sid:
                continue
            for pair in sm.findall("{*}Pair"):
                key = pair.findtext("{*}key", default="")
                url = pair.findtext("{*}styleUrl", default="")
                if key == "normal" and url.startswith("#"):
                    stylemap_normal[sid] = url[1:]

        results: List[Optional[Dict[str, Any]]] = []
        for pm in root.findall(".//{*}Placemark"):
            style_el = pm.find("{*}Style")
            if style_el is None:
                url = pm.findtext("{*}styleUrl", default="")
                ref = url[1:] if url.startswith("#") else ""
                if ref and ref in stylemap_normal:
                    ref = stylemap_normal[ref]
                style_el = shared.get(ref)
            sd = MapInfoParser._kml_style_element_to_dict(style_el) if style_el is not None else {}
            results.append(sd if sd else None)
        return results

    @staticmethod
    def _parse_kml_direct(kml_file: Path) -> Optional["MapInfoLayer"]:
        """自研 KML 解析（ElementTree），完整保留混合几何类型与样式。

        GDAL KML 驱动默认只读取首个几何类型的图层，混合几何（点+线+面）会丢要素，
        且对大数据量解析慢。故对 .kml 直接 XML 解析：
          - 遍历全部 <Placemark>（含 MultiGeometry 子级），提取 Point/LineString/Polygon
          - 提取属性（name/description/ExtendedData）
          - 提取样式（内联 <Style> 或 <styleUrl> → 共享 <Style>/<StyleMap>）
        解析失败返回 None（调用方回退 gpd.read_file）。
        """
        import xml.etree.ElementTree as ET

        if not kml_file or not kml_file.exists():
            return None
        try:
            text = kml_file.read_text(encoding="utf-8", errors="replace")
            root = ET.fromstring(text)
        except Exception:
            return None

        # 共享样式
        shared: Dict[str, Any] = {}
        for style in root.findall(".//{*}Style"):
            sid = style.get("id")
            if sid:
                shared[sid] = style
        stylemap_normal: Dict[str, str] = {}
        for sm in root.findall(".//{*}StyleMap"):
            sid = sm.get("id")
            if not sid:
                continue
            for pair in sm.findall("{*}Pair"):
                if pair.findtext("{*}key", default="") == "normal":
                    url = pair.findtext("{*}styleUrl", default="")
                    if url.startswith("#"):
                        stylemap_normal[sid] = url[1:]

        def _resolve_style(pm: Any) -> Dict[str, Any]:
            el = pm.find("{*}Style")
            if el is None:
                url = pm.findtext("{*}styleUrl", default="")
                ref = url[1:] if url.startswith("#") else ""
                if ref in stylemap_normal:
                    ref = stylemap_normal[ref]
                el = shared.get(ref)
            return MapInfoParser._kml_style_element_to_dict(el) if el is not None else {}

        def _coords_list(coords_el: Any) -> List[Any]:
            """<coordinates>lng,lat[,alt] lng,lat[,alt]</coordinates> → [[x, y], ...]"""
            if coords_el is None or not coords_el.text:
                return []
            pts = []
            for tok in coords_el.text.strip().split():
                parts = tok.split(",")
                if len(parts) >= 2:
                    try:
                        pts.append([float(parts[0]), float(parts[1])])
                    except ValueError:
                        continue
            return pts

        def _build_features(geom_el: Any, properties: Dict[str, Any]) -> List["MapInfoFeature"]:
            """从几何元素提取要素（Point/LineString/Polygon 及 MultiGeometry 子级）。"""
            out: List[MapInfoFeature] = []
            tag = geom_el.tag.rsplit("}", 1)[-1] if "}" in geom_el.tag else geom_el.tag
            if tag == "Point":
                coords = _coords_list(geom_el.find("{*}coordinates"))
                if coords:
                    out.append(MapInfoFeature(str(uuid.uuid4()), GeometryType.POINT,
                                              [coords[0][0], coords[0][1]], dict(properties)))
            elif tag == "LineString":
                coords = _coords_list(geom_el.find("{*}coordinates"))
                if coords:
                    out.append(MapInfoFeature(str(uuid.uuid4()), GeometryType.LINE,
                                              coords, dict(properties)))
            elif tag == "Polygon":
                rings = []
                ob = geom_el.find("{*}outerBoundaryIs")
                if ob is not None:
                    ring = _coords_list(ob.find(".//{*}coordinates"))
                    if ring:
                        rings.append(ring)
                for ib in geom_el.findall("{*}innerBoundaryIs"):
                    ring = _coords_list(ib.find(".//{*}coordinates"))
                    if ring:
                        rings.append(ring)
                if rings:
                    out.append(MapInfoFeature(str(uuid.uuid4()), GeometryType.POLYGON,
                                              rings, dict(properties)))
            elif tag == "MultiGeometry":
                for child in list(geom_el):
                    out.extend(_build_features(child, properties))
            return out

        features: List[MapInfoFeature] = []
        for pm in root.findall(".//{*}Placemark"):
            style_dict = _resolve_style(pm)
            name = (pm.findtext("{*}name", default="") or "").strip()
            desc = (pm.findtext("{*}description", default="") or "").strip()
            props: Dict[str, Any] = {}
            if name:
                props["name"] = name
            if desc:
                props["description"] = desc
            for data_el in pm.findall(".//{*}ExtendedData/{*}Data"):
                key = data_el.get("name")
                val = (data_el.findtext("{*}value", default="") or "").strip()
                if key:
                    props[key] = val
            if style_dict:
                props["_style"] = style_dict
            geom_el = (pm.find("{*}Point") or pm.find("{*}LineString")
                       or pm.find("{*}Polygon") or pm.find("{*}MultiGeometry"))
            if geom_el is not None:
                for _f in _build_features(geom_el, props):
                    # KML 无 <Style>/<styleUrl> 的要素：按要素几何类型注入图层默认样式，
                    # 避免无样式 KML 统一回退前端 DEFAULT_STYLES（各图层颜色不同）
                    if "_style" not in _f.properties:
                        _d = MapInfoParser._get_layer_default_style(kml_file.stem, _f.type)
                        if _d:
                            _f.properties["_style"] = _d
                    features.append(_f)

        if not features:
            return None

        return MapInfoLayer(
            id=str(uuid.uuid4()),
            name=kml_file.stem,
            type=features[0].type,
            features=features,
            metadata={'source_file': str(kml_file), 'feature_count': len(features)},
        )

    @staticmethod
    def _extract_tab_map_styles(map_file: Path) -> Optional[List[Optional[Dict[str, Any]]]]:
        """解析 MapInfo .map 文件的每要素样式（Pen/Brush/Symbol），返回按要素顺序的样式列表。

        .map 中每个对象恰好一组样式行（Pen/Brush/Symbol/Line/Region/Text…），
        与 .dat 数据行一一对应。复杂对象（Line/Region）样式行后跟缩进坐标续行（忽略）。
        以 Pen/Symbol/Line/Region/Text 等对象定义行作为新要素边界，Brush 行并入当前要素。
        解析失败返回 None（调用方回退图层默认样式）。
        """
        if not map_file or not map_file.exists():
            return None
        try:
            text = map_file.read_text(encoding="gbk", errors="replace")
        except Exception:
            return None

        object_kw = ("pen", "symbol", "line", "region", "arc", "rect", "ellipse",
                     "text", "roundedrect", "shape", "multiline", "point")
        object_re = re.compile(r"^\s*([A-Za-z]+)\s*\(")

        styles: List[Optional[Dict[str, Any]]] = []
        cur: Optional[Dict[str, Any]] = None  # None = 尚未开始要素；空 dict = 无样式占位
        for line in text.splitlines():
            m = object_re.match(line)
            if m:
                kw = m.group(1).lower()
                if kw in object_kw:
                    # 新要素开始：push 上一组（空样式也占位，保证与 .dat 行序对齐）
                    if cur is not None:
                        styles.append(cur)
                    parsed = MapInfoParser._parse_style_value(kw, line)
                    cur = parsed if parsed else {}
                elif kw == "brush" and cur is not None:
                    parsed = MapInfoParser._parse_style_value("brush", line)
                    if parsed:
                        cur.update(parsed)
                continue
            # 非样式行（坐标续行/元数据）忽略
        if cur is not None:
            styles.append(cur)
        return [s if s else None for s in styles] if styles else None

    @staticmethod
    def _extract_mif_styles(mif_file: Path) -> Optional[List[Optional[Dict[str, Any]]]]:
        """解析 MIF 文件每要素的 Pen/Brush/Symbol 样式，返回按要素顺序的样式列表。

        GDAL MIF 驱动默认不把样式暴露为属性列，因此需主动解析 .mif 文本：
        样式行（Pen/Brush/Symbol/Rotation）出现在几何对象行（Point/Line/…）之前，
        同一要素的样式先解析到 pending，遇到几何行时绑定为当前要素并开启下一要素。
        解析失败返回 None（调用方回退图层默认样式）。
        """
        if not mif_file or not mif_file.exists():
            return None
        try:
            text = mif_file.read_text(encoding="gbk", errors="replace")
        except Exception:
            return None

        geom_kw = re.compile(
            r"^\s*(Point|Line|Polyline|Region|Arc|Ellipse|Rect|RoundedRect|Text|MultiPoint|MultiLine|Font)\s*",
            re.IGNORECASE,
        )
        style_re = re.compile(r"^\s*(Pen|Brush|Symbol)\s*\(", re.IGNORECASE)

        styles: List[Optional[Dict[str, Any]]] = []
        pending: Optional[Dict[str, Any]] = None
        in_data = False
        for line in text.splitlines():
            stripped = line.strip()
            if not in_data:
                if stripped.upper().startswith("DATA"):
                    in_data = True
                continue
            sm = style_re.match(line)
            if sm:
                kw = sm.group(1).lower()
                parsed = MapInfoParser._parse_style_value(kw, line)
                if pending is None:
                    pending = {}
                if parsed:
                    pending.update(parsed)
                continue
            if geom_kw.match(line):
                # 几何对象行：绑定当前样式为要素，开启下一要素
                styles.append(pending if pending else None)
                pending = None
                continue
            # 坐标续行/注释忽略
        if pending is not None:
            styles.append(pending if pending else None)
        return styles if styles else None

    @staticmethod
    def _normalize_tab_charset(tab_file: Optional[Path]) -> None:
        """规范化 .tab 文件的 charset 声明为 WindowsSimpChinese。

        外部上传的 MapInfo TAB 文件 charset 可能为 Neutral（MapInfo Pro 7.0 之前的
        常见默认值），但 .dat 实际数据为 GBK 编码。fiona 打开 TAB 时优先使用
        .tab 中声明的 charset（不信任 encoding 参数），Neutral 会被解释为
        WindowsANSI/Latin1，导致：
          - 中文字段名/属性值被错位解码
          - gpd.read_file 抛异常，layer 被静默丢弃

        关键约束：必须做**字节级替换**，不能 read_text() 重新编码。
        .tab 的字段名部分通常是 GBK 编码（如 "是否共享"、"厂家"、"站高"），
        read_text(encoding="utf-8") 会把部分 GBK 字节误读为拉丁/西里尔字符，
        errors="ignore" 会把非合法 UTF-8 的 GBK 字节直接丢弃，
        导致字段名变空、Definition Table 结构被破坏、fiona 报
        "Failed to parse field definition"。

        因为 "Neutral" / "WindowsSimpChinese" / "!charset" / "Charset" / 引号
        等关键字都是纯 ASCII，所以直接做 b"Neutral" → b"WindowsSimpChinese"
        字节替换即可，不动其他字节。
        """
        if not tab_file or not tab_file.exists():
            return
        try:
            raw = tab_file.read_bytes()
        except Exception:
            return
        # 已是 WindowsSimpChinese 且无 Neutral 残留 → 跳过（幂等）
        if b"WindowsSimpChinese" in raw and b"Neutral" not in raw:
            return
        if b"Neutral" not in raw:
            return
        new_raw = raw.replace(b"Neutral", b"WindowsSimpChinese")
        if new_raw != raw:
            tab_file.write_bytes(new_raw)
            print(f"[MapInfoParser] 规范化 {tab_file.name} charset: Neutral → WindowsSimpChinese")

    @staticmethod
    def _read_tab_metadata(tab_file: Path) -> Dict[str, Any]:
        """
        读取 .TAB 文件的元数据信息

        .TAB 文件是文本文件，包含：
        - 表结构定义
        - 字段信息
        - 坐标系信息
        - 图层名称等
        """
        metadata = {
            'name': tab_file.stem,  # 默认使用文件名
            'coord_sys': 'unknown',
            'fields': [],
            'description': ''
        }

        try:
            # 尝试多种编码读取 .TAB 文件
            encodings = ['utf-8', 'gbk', 'gb2312', 'latin1']
            content = None
            used_encoding = None

            for encoding in encodings:
                try:
                    with open(tab_file, 'r', encoding=encoding, errors='ignore') as f:
                        content = f.read()
                    used_encoding = encoding
                    break
                except Exception as e:
                    continue

            if not content:
                try:
                    with open(tab_file, 'rb') as f:
                        content = f.read().decode('utf-8', errors='ignore')
                        used_encoding = 'utf-8-fallback'
                except:
                    pass

            if not content:
                return metadata

            # 解析 TAB 文件内容
            lines = content.split('\n')

            # 打印前几行用于调试
            for i, line in enumerate(lines[:5]):
                pass  # 已移除调试日志

            # 查找图层名称
            found_name = False
            for line in lines:
                line_upper = line.upper().strip()
                # 查找 "Table" 或 "File" 定义
                if line_upper.startswith('FILE') or line_upper.startswith('TABLE'):
                    parts = line.split()
                    if len(parts) >= 2:
                        # 提取引号中的名称
                        import re
                        # 使用正则表达式提取引号内容
                        quoted_names = re.findall(r'"([^"]+)"', line)
                        if quoted_names:
                            metadata['name'] = quoted_names[0].strip()
                            found_name = True
                            break

            if not found_name:
                # 尝试从文件名提取
                if 'file' in metadata:
                    import os
                    metadata['name'] = os.path.basename(metadata.get('file', ''))

            # 查找坐标系定义
            for line in lines:
                line_upper = line.upper().strip()
                if 'COORDSYS' in line_upper:
                    metadata['coord_sys'] = line.strip()
                    # 判断坐标系类型
                    if 'Earth Projection' in line or 'GAUSS-KRUGER' in line.upper():
                        metadata['coord_sys_type'] = 'projected'
                    elif 'LongLat' in line or 'WGS84' in line.upper() or 'GCJ02' in line.upper():
                        metadata['coord_sys_type'] = 'geographic'
                    break

            # 查找字段定义
            for line in lines:
                line_upper = line.upper().strip()
                if line_upper.count('"') >= 2:
                    # 提取字段名
                    import re
                    matches = re.findall(r'"([^"]+)"', line)
                    for match in matches:
                        if match and match not in metadata['fields']:
                            # 排除一些非字段关键词
                            if match.upper() not in ['CHAR', 'INTEGER', 'DECIMAL', 'DATE', 'LOGICAL']:
                                metadata['fields'].append(match)


        except Exception as e:
            # 解析失败时返回空元数据
            pass

        return metadata

    @staticmethod
    def _get_layer_default_style(layer_name: str, geom_type: GeometryType) -> Optional[Dict[str, Any]]:
        """
        根据图层名称和几何类型推断默认样式

        基于常见的 MapInfo 图层命名约定：
        - 道路图层：road, road_, 道路, 路, highway, street
        - 水域图层：water, river, lake, 河流, 湖泊, 水域
        - 区域/行政区划图层：region, area, boundary, district, 区, 区域, 边界
        - 建筑物图层：building, 建筑, 楼, house
        - 绿地图层：green, park, grass, 森林, greenbelt, 绿地, 公园
        """
        import re
        name_lower = layer_name.lower()

        # 先打印调试信息

        style = None

        if geom_type == GeometryType.LINE:
            # 线状图层样式推断
            if any(kw in name_lower for kw in ['road', 'road_', '道路', '路', 'highway', 'street', '公路', '高速', 'street_', 'hw_']):
                style = {
                    'strokeColor': '#ff6b6b',  # 红色道路
                    'strokeWidth': 2,
                    'opacity': 0.9
                }
            elif any(kw in name_lower for kw in ['river', '水系', '河流', '溪', 'stream', 'stream_', 'water_']):
                style = {
                    'strokeColor': '#4dabf7',  # 蓝色河流
                    'strokeWidth': 2,
                    'opacity': 0.8
                }
            elif any(kw in name_lower for kw in ['boundary', 'border', '边界', 'border_', '区界', 'bound_', 'bdry']):
                style = {
                    'strokeColor': '#868e96',  # 灰色边界
                    'strokeWidth': 1,
                    'opacity': 0.7,
                    'strokeDasharray': '5,5'  # 边界使用虚线
                }
            elif any(kw in name_lower for kw in ['railway', 'rail', '铁路', '轨道', 'rail_']):
                style = {
                    'strokeColor': '#495057',  # 深灰色铁路
                    'strokeWidth': 2,
                    'opacity': 0.9,
                    'strokeDasharray': '10,10'  # 铁路使用虚线
                }

        elif geom_type == GeometryType.POLYGON:
            # 面状图层样式推断
            if any(kw in name_lower for kw in ['water', 'river', 'lake', '水域', '河流', '湖泊', '水库', 'water_', 'hydro_']):
                style = {
                    'fillColor': '#4dabf7',  # 蓝色水域
                    'strokeColor': '#228be6',
                    'strokeWidth': 1,
                    'fillOpacity': 0.5
                }
            elif any(kw in name_lower for kw in ['green', 'park', 'forest', '绿地', '公园', '森林', '植被', 'grass', 'greenbelt', 'green_']):
                style = {
                    'fillColor': '#51cf66',  # 绿色植被
                    'strokeColor': '#37b24d',
                    'strokeWidth': 1,
                    'fillOpacity': 0.4
                }
            elif any(kw in name_lower for kw in ['building', '建筑', '楼', 'house', 'construct', 'build_', 'bldg']):
                style = {
                    'fillColor': '#adb5bd',  # 灰色建筑
                    'strokeColor': '#868e96',
                    'strokeWidth': 1,
                    'fillOpacity': 0.6
                }
            elif any(kw in name_lower for kw in ['region', 'area', 'district', '区', '区域', 'zone', 'polygon', 'poly_']):
                style = {
                    'fillColor': '#f8f9fa',  # 浅灰色区域
                    'strokeColor': '#dee2e6',
                    'strokeWidth': 2,
                    'fillOpacity': 0.3
                }

        elif geom_type == GeometryType.POINT:
            # 点状图层样式推断
            if any(kw in name_lower for kw in ['poi', 'point', '点', 'marker', 'pt_', 'poi_']):
                style = {
                    'markerColor': '#ff6b6b',
                    'markerSize': 8
                }

        if not style:
            # 无命名规则命中：按图层名取稳定配色，不同图层初次导入即有各自的
            # 默认颜色/透明度/大小（不再全部回退同一组颜色）
            c = _palette_color(layer_name)
            if geom_type == GeometryType.POINT:
                style = {'markerColor': c, 'color': c, 'markerSize': 8}
            elif geom_type == GeometryType.LINE:
                style = {'strokeColor': c, 'strokeWidth': 2, 'opacity': 0.9}
            elif geom_type == GeometryType.POLYGON:
                style = {'fillColor': c, 'strokeColor': c, 'strokeWidth': 1.5, 'fillOpacity': 0.35}

        return style

    @staticmethod
    def parse_file(file_path: Path) -> MapInfoLayer:
        """解析 MapInfo 文件 (使用 Geopandas)"""
        try:
            import geopandas as gpd
            from shapely.geometry import Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
        except ImportError as e:
            raise ImportError(
                "缺少必要的地理数据处理库！\n"
                "请运行以下命令安装依赖：\n"
                "  pip install geopandas shapely\n\n"
                "注意：geopandas 依赖 GDAL，Windows 用户可能需要先安装 GDAL。\n"
                "推荐使用 conda 安装：\n"
                "  conda install -c conda-forge geopandas\n\n"
                f"详细错误: {e}"
            )

        try:
            # 确保路径为字符串
            path_str = str(file_path)

            if not file_path.exists():
                raise FileNotFoundError(f"文件不存在: {path_str}")

            # 读取 .TAB 文件元数据（不区分大小写）
            tab_file = file_path if file_path.suffix.lower() == '.tab' else None
            if tab_file is None:
                # 尝试不同大小写的 .tab 扩展名
                for ext in ['.tab', '.TAB', '.Tab']:
                    candidate = file_path.with_suffix(ext)
                    if candidate.exists():
                        tab_file = candidate
                        break
            tab_metadata = MapInfoParser._read_tab_metadata(tab_file) if tab_file and tab_file.exists() else {}
            layer_name = tab_metadata.get('name', file_path.stem)

            # 读取前规范化 .tab charset（外部上传的 TAB 可能是 Neutral 声明）
            if tab_file and tab_file.exists():
                MapInfoParser._normalize_tab_charset(tab_file)

            # 使用 Geopandas 读取文件
            try:
                gdf = gpd.read_file(path_str, encoding='gbk')
            except Exception as e1:
                try:
                    gdf = gpd.read_file(path_str)
                except Exception as e2:
                    raise e2

            # 解析文件自带的默认样式（按 gdf 行序对齐）：
            #   TAB → 同名 .map 文件；KML → <Style>/<styleUrl>；MIF → GDAL MAPINFO_* 列或 .mif 文本
            ext_lower = file_path.suffix.lower()
            # KML：优先自研 XML 解析（完整保留混合几何 + 样式，比 GDAL 驱动快且不丢要素）
            if ext_lower == '.kml':
                direct = MapInfoParser._parse_kml_direct(file_path)
                if direct is not None:
                    return direct
            file_styles = None  # List[Optional[Dict]]，索引 = gdf 行号
            if ext_lower == '.kml':
                file_styles = MapInfoParser._parse_kml_styles(file_path)
            elif ext_lower == '.tab' and tab_file and tab_file.exists():
                map_file = tab_file.with_suffix('.map')
                file_styles = MapInfoParser._extract_tab_map_styles(map_file)
            elif ext_lower == '.mif':
                file_styles = MapInfoParser._extract_mif_styles(file_path)

            features = []
            layer_type = GeometryType.UNKNOWN

            if gdf.empty:
                return MapInfoLayer(
                    id=str(uuid.uuid4()),
                    name=layer_name,
                    type=GeometryType.UNKNOWN,
                    features=[],
                    metadata={'source_file': path_str, 'feature_count': 0, **tab_metadata}
                )

            # 判断主要几何类型
            first_geom = gdf.geometry.iloc[0]
            if isinstance(first_geom, (Point, MultiPoint)):
                layer_type = GeometryType.POINT
            elif isinstance(first_geom, (LineString, MultiLineString)):
                layer_type = GeometryType.LINE
            elif isinstance(first_geom, (Polygon, MultiPolygon)):
                layer_type = GeometryType.POLYGON


            # 获取图层级别的默认样式
            layer_default_style = MapInfoParser._get_layer_default_style(layer_name, layer_type)

            # 检测 RSRP 类信号强度字段（SSRSRP/RSRP/电平/信号强度）：无文件自带样式时
            # 按标准 RSRP 色阶逐要素分级上色（还原 MapInfo 按字段值主题渲染的效果）

            # 调试：输出所有列名

            # 遍历要素
            # 用 to_dict('records') 一次取出所有属性，替代 iterrows 逐行构造 Series——
            # iterrows 18000 行时开销 ~2.4s，to_dict 仅 ~0.01s
            records = gdf.to_dict('records')
            geoms = gdf.geometry
            columns = gdf.columns
            signal_col = _detect_rsrp_column(columns)

            # 预计算样式列集合（列名固定，正则只执行一遍，避免逐 feature re.search）
            import re as _re
            _style_patterns = [
                r'MAPINFO_pen', r'MAPINFO_brush', r'MAPINFO_symbol', r'MAPINFO_font',
                r'MAPINFO_Pen', r'MAPINFO_Brush', r'MAPINFO_Symbol', r'MAPINFO_Font',
                r'^pen$', r'^brush$', r'^symbol$', r'^font$',
                r'_pen$', r'_brush$', r'_symbol$', r'_font$',
                r' Pen$', r' Brush$', r' Symbol$', r' Font$',
                r'MI_Style', r'MI_Styles', r'MI_StyleDef',
                r'style', r'styles', r'Style', r'Styles',
                r'linewidth', r'linetype', r'linecolor',
                r'fillcolor', r'fillpattern', r'filltype',
                r'markertype', r'markersize', r'markercolor',
            ]
            style_cols = {
                str(col) for col in columns
                if col != 'geometry' and any(_re.search(p, str(col), _re.IGNORECASE) for p in _style_patterns)
            }

            for idx, geom in enumerate(geoms):
                if geom is None:
                    continue

                # 提取属性 (排除 geometry 列)
                properties = records[idx]
                properties.pop('geometry', None)
                # 处理可能的时间戳等非JSON序列化类型
                for k, v in properties.items():
                    if hasattr(v, 'isoformat'):
                        properties[k] = v.isoformat()

                # 提取 MapInfo 样式信息（传入预计算样式列，MIF 的 GDAL MAPINFO_* 列走这里）
                style_info = MapInfoParser._extract_mapinfo_style(properties, columns, layer_type, style_cols)

                # 文件自带样式（TAB .map / KML <Style>）优先于 GDAL 列推断，按 gdf 行序对齐
                if not style_info and file_styles and idx < len(file_styles) and file_styles[idx]:
                    style_info = dict(file_styles[idx])

                # 信号强度分级着色（无文件自带样式时）：按 SSRSRP/RSRP 值取色
                if not style_info and signal_col is not None:
                    _sv = properties.get(signal_col)
                    try:
                        _sv_f = float(_sv)
                    except (TypeError, ValueError):
                        _sv_f = None
                    if _sv_f is not None:
                        _c = _rsrp_color(_sv_f)
                        if layer_type == GeometryType.POINT:
                            style_info = {'markerColor': _c, 'color': _c}
                        elif layer_type == GeometryType.LINE:
                            style_info = {'strokeColor': _c}
                        else:
                            style_info = {'fillColor': _c, 'strokeColor': _c, 'fillOpacity': 0.5}

                # 如果没有样式信息，使用图层默认样式
                if not style_info and layer_default_style:
                    style_info = layer_default_style.copy()

                if style_info:
                    properties['_style'] = style_info

                # 前端编辑样式持久化列（save_layer_geojson 写入）：
                # 还原为内部字段（_editStyle / _shape / _ellipse）并从属性表中剔除，
                # 保证"方形点/自定义样式/圆"等保存刷新后不回退为默认渲染。
                _sym = properties.pop('NPT_FEATSYM', None)
                if isinstance(_sym, str) and _sym:
                    try:
                        _es = json.loads(_sym)
                        if isinstance(_es, dict):
                            properties['_editStyle'] = _es
                    except Exception:
                        pass
                _meta = properties.pop('NPT_FEATMETA', None)
                if isinstance(_meta, str) and _meta:
                    try:
                        _m = json.loads(_meta)
                        if isinstance(_m, dict):
                            if _m.get('_shape') is not None:
                                properties['_shape'] = _m['_shape']
                            if _m.get('_ellipse') is not None:
                                properties['_ellipse'] = _m['_ellipse']
                    except Exception:
                        pass

                # 提取坐标
                coords = []
                geom_type = GeometryType.UNKNOWN

                if isinstance(geom, Point):
                    geom_type = GeometryType.POINT
                    coords = [geom.x, geom.y]
                elif isinstance(geom, LineString):
                    geom_type = GeometryType.LINE
                    coords = list(geom.coords)
                elif isinstance(geom, Polygon):
                    geom_type = GeometryType.POLYGON
                    # Polygon coordinates: [exterior, interior_1, interior_2, ...]
                    # Exterior is list of [x, y]
                    coords = [list(geom.exterior.coords)]
                    for interior in geom.interiors:
                        coords.append(list(interior.coords))
                elif isinstance(geom, MultiPoint):
                    geom_type = GeometryType.POINT
                    coords = [geom.centroid.x, geom.centroid.y]
                elif isinstance(geom, MultiLineString):
                    geom_type = GeometryType.LINE
                    if geom.geoms:
                        coords = list(geom.geoms[0].coords)
                elif isinstance(geom, MultiPolygon):
                    geom_type = GeometryType.POLYGON
                    if geom.geoms:
                        poly = geom.geoms[0]
                        coords = [list(poly.exterior.coords)]
                        for interior in poly.interiors:
                            coords.append(list(interior.coords))

                if coords:
                    features.append(MapInfoFeature(
                        id=str(uuid.uuid4()),
                        type=geom_type,
                        coordinates=coords,
                        properties=properties
                    ))

            return MapInfoLayer(
                id=str(uuid.uuid4()),
                name=layer_name,
                type=layer_type,
                features=features,
                metadata={
                    'source_file': path_str,
                    'feature_count': len(features),
                    **tab_metadata
                }
            )

        except Exception as e:
            import traceback
            traceback.print_exc()
            raise ValueError(f"Geopandas 解析失败: {e}")

    # 移除旧的 _parse_mif 和 _parse_tab 方法，因为现在统一由 geopandas 处理
    
    @staticmethod
    def parse_directory(dir_path: Path) -> List[MapInfoLayer]:
        """
        解析目录中的所有 MapInfo 文件

        支持的文件格式：
        - .tab 文件（MapInfo TAB 格式）
        - .mif 文件（MapInfo MIF 格式）
        - .kml 文件（Keyhole Markup Language，自包含无需配套）

        使用 geopandas 统一解析所有格式
        """
        layers = []
        processed_files = set()  # 跟踪已处理的文件（避免重复）

        # 首先查找所有 .tab 文件（递归搜索子目录，不区分大小写）
        tab_files = sorted([f for f in dir_path.rglob("*") if f.suffix.lower() == '.tab' and f.is_file()])
        for tab_file in tab_files:
            try:
                print(f"[MapInfoParser] 解析 TAB 文件: {tab_file.name}")
                layer = MapInfoParser.parse_file(tab_file)
                layers.append(layer)
                processed_files.add(tab_file.stem.lower())  # 记录文件名（不含扩展名，小写用于去重）
            except ImportError as e:
                # ImportError 表示缺少 geopandas 库
                print(f"[MapInfoParser] ❌ 缺少必要的库: {e}")
                print(f"[MapInfoParser] 提示: 请运行 'pip install geopandas shapely' 安装依赖")
                # 不继续解析其他文件，因为都会失败
                _LAST_PARSE_ERRORS.append({
                    "file": tab_file.name,
                    "error": f"缺少依赖: {str(e)[:200]}",
                })
                break
            except Exception as e:
                print(f"[MapInfoParser] 解析 TAB 文件失败 {tab_file.name}: {e}")
                import traceback
                traceback.print_exc()
                # 把失败原因暴露到模块级列表，data_service 可读取并写入 index.json metadata
                _LAST_PARSE_ERRORS.append({
                    "file": tab_file.name,
                    "error": f"{type(e).__name__}: {str(e)[:300]}",
                })

        # 然后查找 .mif 文件（不区分大小写，递归搜索子目录，只处理没有对应 .tab 文件的）
        mif_files = sorted([f for f in dir_path.rglob("*") if f.suffix.lower() == '.mif' and f.is_file()])
        for mif_file in mif_files:
            # 检查是否已经处理过同名的 .tab 文件
            if mif_file.stem.lower() in processed_files:
                print(f"[MapInfoParser] 跳过 {mif_file.name}（已存在同名 TAB 文件）")
                continue

            try:
                print(f"[MapInfoParser] 解析 MIF 文件: {mif_file.name}")
                layer = MapInfoParser.parse_file(mif_file)
                layers.append(layer)
            except ImportError as e:
                # ImportError 表示缺少 geopandas 库
                print(f"[MapInfoParser] ❌ 缺少必要的库: {e}")
                print(f"[MapInfoParser] 提示: 请运行 'pip install geopandas shapely' 安装依赖")
                _LAST_PARSE_ERRORS.append({
                    "file": mif_file.name,
                    "error": f"缺少依赖: {str(e)[:200]}",
                })
                break
            except Exception as e:
                print(f"[MapInfoParser] 解析 MIF 文件失败 {mif_file.name}: {e}")
                import traceback
                traceback.print_exc()
                _LAST_PARSE_ERRORS.append({
                    "file": mif_file.name,
                    "error": f"{type(e).__name__}: {str(e)[:300]}",
                })

        # 最后查找 .kml 文件（自包含，无需去重/配套检查）
        kml_files = sorted([f for f in dir_path.rglob("*") if f.suffix.lower() == '.kml' and f.is_file()])
        for kml_file in kml_files:
            if kml_file.stem.lower() in processed_files:
                continue
            try:
                print(f"[MapInfoParser] 解析 KML 文件: {kml_file.name}")
                layer = MapInfoParser.parse_file(kml_file)
                layers.append(layer)
                processed_files.add(kml_file.stem.lower())
            except ImportError as e:
                print(f"[MapInfoParser] ❌ 缺少必要的库: {e}")
                print(f"[MapInfoParser] 提示: 请运行 'pip install geopandas shapely' 安装依赖")
                _LAST_PARSE_ERRORS.append({
                    "file": kml_file.name,
                    "error": f"缺少依赖: {str(e)[:200]}",
                })
                break
            except Exception as e:
                print(f"[MapInfoParser] 解析 KML 文件失败 {kml_file.name}: {e}")
                import traceback
                traceback.print_exc()
                _LAST_PARSE_ERRORS.append({
                    "file": kml_file.name,
                    "error": f"{type(e).__name__}: {str(e)[:300]}",
                })

        print(f"[MapInfoParser] 目录解析完成，共解析 {len(layers)} 个图层")
        return layers


def get_last_parse_errors() -> List[Dict[str, str]]:
    """获取最近一次 parse_mapinfo_files 调用的解析错误列表（深拷贝）。

    返回值形如 [{"file": "xxx.tab", "error": "ValueError: ..."}, ...]
    供 data_service 写入 index.json metadata，便于前端诊断。
    """
    return list(_LAST_PARSE_ERRORS)


def parse_mapinfo_files(upload_path: Path, user_id: int = 1, parent_id: str = None,
                        city: Optional[str] = None, operator: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    解析上传的 MapInfo 文件

    Args:
        upload_path: 文件或目录路径
        user_id: 用户ID
        parent_id: 可选的父级 data_id（与 API 层 data_id 一致，避免写入时生成新 UUID）
        city/operator: 数据所属组（地市+运营商）归属快照

    返回图层元数据列表。每个文件失败原因记录在模块级 _LAST_PARSE_ERRORS，
    调用方可通过 get_last_parse_errors() 读取并写入 index.json metadata。
    """
    # 每次新调用入口清空错误列表，避免跨调用累积
    _LAST_PARSE_ERRORS.clear()

    layers = []

    def _default_style(layer: MapInfoLayer) -> Optional[Dict[str, Any]]:
        """图层默认样式：取首要素的文件自带样式（_style），否则按图层名+几何类型推断。"""
        for f in layer.features:
            st = f.properties.get('_style')
            if st:
                return dict(st)
        return MapInfoParser._get_layer_default_style(layer.name, layer.type)

    if upload_path.is_file():
        # 单个文件
        try:
            layer = MapInfoParser.parse_file(upload_path)
            layers.append({
                "id": layer.id,
                "name": layer.name,
                "type": layer.type.value,
                "feature_count": len(layer.features),
                "metadata": layer.metadata,
                "defaultStyle": _default_style(layer),
            })
            _save_layer_metadata(
                user_id=user_id,
                city=city,
                operator=operator,
                name=layer.name,
                file_path=str(upload_path),
                layer_type=layer.type.value,
                geometry_type=layer.type.value,
                feature_count=len(layer.features),
                file_size=upload_path.stat().st_size if upload_path.exists() else None,
                layer_id=parent_id,
            )
        except Exception as e:
            print(f"[MapInfo] 解析文件失败 {upload_path}: {e}")

    elif upload_path.is_dir():
        # 目录，查找所有 MapInfo 文件
        mapinfo_layers = MapInfoParser.parse_directory(upload_path)
        for idx, layer in enumerate(mapinfo_layers):
            layers.append({
                "id": layer.id,
                "name": layer.name,
                "type": layer.type.value,
                "feature_count": len(layer.features),
                "metadata": layer.metadata,
                "defaultStyle": _default_style(layer),
            })
            # 使用 parent_id；多个图层时追加序号
            _layer_id = parent_id if idx == 0 and parent_id else (f"{parent_id}_{idx}" if parent_id else None)
            _save_layer_metadata(
                user_id=user_id,
                city=city,
                operator=operator,
                name=layer.name,
                file_path=str(upload_path / layer.name) if hasattr(layer, 'name') else str(upload_path),
                layer_type=layer.type.value,
                geometry_type=layer.type.value,
                feature_count=len(layer.features),
                file_size=None,
                layer_id=_layer_id,
            )

    return layers


def _save_layer_metadata(
    user_id: int,
    name: str,
    file_path: str,
    layer_type: str,
    geometry_type: str,
    feature_count: int,
    bbox: Optional[List[float]] = None,
    file_size: Optional[int] = None,
    layer_id: Optional[str] = None,
    city: Optional[str] = None,
    operator: Optional[str] = None,
):
    """保存图层文件元数据到 SQLite"""
    db = SessionLocal()
    try:
        layer = Layer(
            id=layer_id or str(uuid.uuid4()),
            user_id=user_id,
            city=city,
            operator=operator,
            name=name,
            file_path=file_path,
            layer_type=layer_type,
            geometry_type=geometry_type,
            feature_count=feature_count,
            bbox=json.dumps(bbox) if bbox else None,
            file_size=file_size,
            created_at=datetime.now().isoformat(),
        )
        db.add(layer)
        db.commit()
        print(f"[MapInfoService] 图层元数据已入库: id={layer.id}")
    except Exception as e:
        db.rollback()
        print(f"[MapInfoService] 图层元数据入库失败 (非致命): {e}")
    finally:
        db.close()


def clear_layer_cache(data_id: Optional[str] = None):
    """清除图层数据缓存

    Args:
        data_id: 如果指定，只清除该数据ID的缓存；否则清除全部
    """
    global _layer_cache, _layer_cache_mtime
    if data_id:
        prefix = f"{data_id}:"
        keys_to_remove = [k for k in _layer_cache if k.startswith(prefix)]
        for key in keys_to_remove:
            _layer_cache.pop(key, None)
            _layer_cache_mtime.pop(key, None)
        print(f"[MapInfo] 已清除 {len(keys_to_remove)} 个图层缓存 (data_id={data_id})")
    else:
        count = len(_layer_cache)
        _layer_cache.clear()
        _layer_cache_mtime.clear()
        print(f"[MapInfo] 已清除全部 {count} 个图层缓存")


def _dump_geojson_bytes(result: Dict[str, Any]) -> bytes:
    """GeoJSON 响应体编码为 UTF-8 字节。

    必须用 json.dumps（而非 json.dump）：json.dump 传 ensure_ascii=False 时会回退到
    纯 Python 编码器，40MB 图层由 ~30s 降到 ~2s（C 编码器）。
    """
    return json.dumps(result, ensure_ascii=False).encode("utf-8")


def _write_gz_cache(gz_path: Path, geojson_bytes: bytes) -> None:
    """原子写预压缩缓存（内容为包装后的响应体，与常规路径同形状）。

    直接字节拼接包裹层，避免为压缩再序列化一份 40MB JSON；gzip 一次调用比流式
    多次 compress 快一个量级。
    """
    gz_tmp = gz_path.with_suffix(gz_path.suffix + ".tmp")
    gz_tmp.write_bytes(gzip.compress(b'{"success":true,"data":' + geojson_bytes + b'}',
                                      compresslevel=6))
    gz_tmp.replace(gz_path)  # 原子替换，读者不会读到半成品


def get_layer_data(data_id: str, layer_id: str, data_dir: Path) -> Optional[Dict]:
    """
    获取图层数据

    返回 GeoJSON 格式的数据。包含缓存层，基于源文件 mtime 验证。
    """
    import json

    cache_key = f"{data_id}:{layer_id}"

    # 1. 尝试从 layers.json 中查找图层信息
    layers_file = data_dir / "layers.json"
    target_layer_info = None

    if layers_file.exists():
        try:
            with open(layers_file, 'r', encoding='utf-8') as f:
                layers = json.load(f)
                for layer in layers:
                    if layer.get('id') == layer_id:
                        target_layer_info = layer
                        break
        except Exception as e:
            print(f"[MapInfo] 读取 layers.json 失败: {e}")

    # 2. 确定源文件路径（用于缓存 mtime 验证）
    source_path = None
    if target_layer_info:
        source_file = target_layer_info.get('metadata', {}).get('source_file')
        if source_file:
            candidate = Path(source_file)
            if candidate.exists():
                source_path = candidate
        if source_path is None:
            name = target_layer_info.get('name')
            if name:
                for ext in ['.tab', '.mif', '.kml']:
                    candidate = data_dir / f"{name}{ext}"
                    if candidate.exists():
                        source_path = candidate
                        break

    # 3. 检查缓存（基于源文件 mtime）
    if source_path and cache_key in _layer_cache:
        try:
            current_mtime = source_path.stat().st_mtime
            if _layer_cache_mtime.get(cache_key) == current_mtime:
                print(f"[MapInfo] 使用图层缓存: {cache_key}")
                return _layer_cache[cache_key]
        except Exception:
            pass

    # 3.5 落盘 GeoJSON 缓存（data_dir/.cache/{layer_id}.geojson）
    # 避免每次请求都重新 parse+convert（18000 polygon 需 ~20s，会触发 Cloudflare 524 / axios 超时）
    disk_cache = None
    if source_path:
        disk_cache_path = layer_cache_dir(data_dir) / f"{layer_id}.geojson"
        try:
            current_mtime = source_path.stat().st_mtime
            if disk_cache_path.exists():
                cache_mtime = disk_cache_path.stat().st_mtime
                # 源文件 mtime 和缓存 mtime 都记录在文件名后缀：{layer_id}.geojson.{mtime}
                disk_cache_mtime_file = layer_cache_dir(data_dir) / f"{layer_id}.mtime"
                if disk_cache_mtime_file.exists():
                    saved_mtime = float(disk_cache_mtime_file.read_text().strip())
                    if saved_mtime == current_mtime:
                        _t_disk = time.time()
                        with open(disk_cache_path, 'r', encoding='utf-8') as f:
                            disk_cache = json.load(f)
                        print(f"[MapInfo] 使用落盘缓存: {disk_cache_path} (读取耗时 {time.time()-_t_disk:.2f}s)")
        except Exception as e:
            print(f"[MapInfo] 读落盘缓存失败 {disk_cache_path}: {e}")

    if disk_cache is not None:
        _layer_cache[cache_key] = disk_cache
        _layer_cache_mtime[cache_key] = source_path.stat().st_mtime
        # 🔧 幂等补齐 gz 预压缩缓存：磁盘缓存命中路径不重建 gz 的话，
        # 一次 gz 写失败会永久回退常规路径（性能优化失效），这里检测缺失即生成
        try:
            gz_path = layer_cache_dir(data_dir) / f"{layer_id}.geojson.gz"
            if not gz_path.exists():
                _write_gz_cache(gz_path, _dump_geojson_bytes(disk_cache))
        except Exception as e:
            print(f"[MapInfo] 补写 gz 缓存失败: {e}")
        except Exception as e:
            print(f"[MapInfo] 补写 gz 缓存失败: {e}")
        return disk_cache

    # 4. 缓存未命中，解析文件
    result = None
    _t_parse = time.time()

    if target_layer_info and source_path:
        try:
            layer = MapInfoParser.parse_file(source_path)
            layer.id = layer_id
            result = _convert_to_geojson(layer)
            print(f"[MapInfo] 图层 {cache_key} parse+convert 耗时 {time.time()-_t_parse:.1f}s")
        except Exception as e:
            print(f"[MapInfo] 解析源文件失败 {source_path}: {e}")

    # 5. 回退：遍历目录
    if result is None:
        print(f"[MapInfo] 未在 layers.json 中找到图层 {layer_id}，尝试遍历目录")
        for file_path in list(data_dir.rglob('*.tab')) + list(data_dir.rglob('*.mif')) + list(data_dir.rglob('*.kml')):
            try:
                layer = MapInfoParser.parse_file(file_path)
                result = _convert_to_geojson(layer)
                break
            except Exception as e:
                print(f"[MapInfo] 解析失败 {file_path}: {e}")
                continue

    # 6. 写入缓存（内存 + 落盘）
    if result is not None and source_path:
        try:
            _layer_cache[cache_key] = result
            _layer_cache_mtime[cache_key] = source_path.stat().st_mtime

            # 落盘缓存：后续请求直接读文件，避免重复 parse+convert
            try:
                cache_dir = layer_cache_dir(data_dir)
                cache_dir.mkdir(parents=True, exist_ok=True)
                disk_cache_path = cache_dir / f"{layer_id}.geojson"
                geojson_bytes = _dump_geojson_bytes(result)
                disk_cache_path.write_bytes(geojson_bytes)
                # 🔧 预压缩缓存：先原子写完 .geojson.gz，最后才写 .mtime（mtime 是
                # "提交标记"——并发请求只有看到 mtime 才会用 gz，先写 gz 保证不会
                # 读到半成品；且必须压缩【包装后的 dict】{"success": True, "data": geojson}，
                # 与常规路径响应同形状，否则前端 response.success 判定失败导致图层无法加载。
                try:
                    _write_gz_cache(cache_dir / f"{layer_id}.geojson.gz", geojson_bytes)
                except Exception as e:
                    print(f"[MapInfo] 写 gz 缓存失败: {e}")
                with open(cache_dir / f"{layer_id}.mtime", 'w', encoding='utf-8') as f:
                    f.write(str(source_path.stat().st_mtime))
            except Exception as e:
                print(f"[MapInfo] 写落盘缓存失败: {e}")
        except Exception:
            pass

    return result


def get_layer_data_gz_bytes(data_id: str, layer_id: str, data_dir: Path) -> Optional[bytes]:
    """获取图层数据的预压缩 gzip 字节（供端点直出，跳过每请求 json.dumps + gzip）。

    基于源文件 mtime 校验 gz 缓存有效性；无效时回退调用 get_layer_data 重建
    （其内部会重写 .geojson/.geojson.gz 缓存），再读取 gz 返回。若数据不存在返回 None。

    Returns:
        预压缩的 gzip 字节；数据不存在或 gz 生成失败时返回 None。
    """
    # 解析源文件路径（与 get_layer_data 逻辑一致，用于 mtime 校验）
    source_path = None
    layers_file = data_dir / "layers.json"
    if layers_file.exists():
        try:
            import json as _json
            with open(layers_file, 'r', encoding='utf-8') as f:
                for layer in _json.load(f):
                    if layer.get('id') == layer_id:
                        source_file = layer.get('metadata', {}).get('source_file')
                        if source_file:
                            candidate = Path(source_file)
                            if candidate.exists():
                                source_path = candidate
                        if source_path is None:
                            name = layer.get('name')
                            if name:
                                for ext in ['.tab', '.mif', '.kml']:
                                    candidate = data_dir / f"{name}{ext}"
                                    if candidate.exists():
                                        source_path = candidate
                                        break
                        break
        except Exception:
            pass

    cache_dir = layer_cache_dir(data_dir)
    gz_path = cache_dir / f"{layer_id}.geojson.gz"
    mtime_file = cache_dir / f"{layer_id}.mtime"

    # gz 缓存有效（mtime 匹配）则直接读取
    if source_path and gz_path.exists():
        try:
            if mtime_file.exists() and float(mtime_file.read_text().strip()) == source_path.stat().st_mtime:
                with open(gz_path, 'rb') as f:
                    return f.read()
        except Exception:
            pass

    # gz 缓存缺失/失效：重建（get_layer_data 会重写 .geojson/.gz），再读 gz
    result = get_layer_data(data_id, layer_id, data_dir)
    if result is None:
        return None
    # 数据已就绪但 gz 文件仍缺失（并发请求抢在预热写 gz 完成前命中内存缓存时，
    # get_layer_data 内存命中早退不会落盘）：现场压缩补写，避免回退到 42.8MB
    # 原始 JSON 走 Cloudflare 慢速链路导致前端 600s 超时。
    if not gz_path.exists():
        try:
            _write_gz_cache(gz_path, _dump_geojson_bytes(result))
        except Exception as e:
            print(f"[MapInfo] 现场补写 gz 缓存失败: {e}")
    try:
        if gz_path.exists():
            with open(gz_path, 'rb') as f:
                return f.read()
    except Exception:
        pass
    return None


def prebuild_layer_geojson_cache(data_id: str, data_dir: Path, layers: List[Dict]) -> None:
    """上传后预热图层 GeoJSON 缓存，避免首次勾选时等待 parse + 坐标转换。

    复用 get_layer_data 的缓存写入逻辑（内存 _layer_cache + 磁盘 .cache/{layer_id}.geojson），
    只做幂等预热：任一层失败仅记录日志，不影响上传主流程。

    Args:
        data_id: 数据ID（缓存 key 前缀）
        data_dir: 该数据的目录（settings.DATA_DIR / data_id）
        layers: layers.json 中的图层元数据列表（含 "id" 字段）
    """
    layers = layers or []
    if not layers:
        return
    started = time.time()
    warmed = 0
    for layer in layers:
        layer_id = layer.get("id")
        if not layer_id:
            continue
        try:
            data = get_layer_data(data_id, layer_id, data_dir)
            if data is not None:
                warmed += 1
        except Exception as e:
            print(f"[MapInfo] 预热图层缓存失败 {data_id}:{layer_id}: {e}")
    print(f"[MapInfo] 图层缓存预热完成: {warmed}/{len(layers)} 图层, 耗时 {time.time()-started:.1f}s")


def layer_cache_dir(data_dir: Path) -> Path:
    """图层 GeoJSON 落盘缓存目录（v2：明文 + 预压缩 gz + mtime 标记）。"""
    return data_dir / ".cache" / "v2"


def layer_version_etag(data_dir: Path, layer_id: str) -> Optional[str]:
    """图层版本指纹 ETag（"<layer_id>-<源文件 mtime>"，与保存接口返回的 version 同构）。

    以缓存目录中的 .mtime 标记为基准；标记不存在（尚未生成缓存）时返回 None，
    调用方应视为"无版本信息"（前端据此回退整层保存）。
    """
    if layer_id is None:
        return None
    try:
        mtime_file = layer_cache_dir(data_dir) / f"{layer_id}.mtime"
        if mtime_file.exists():
            return f'"{layer_id}-{mtime_file.read_text().strip()}"'
    except Exception:
        pass
    return None


def _transform_layer_coordinates(features: List[MapInfoFeature]) -> None:
    """
    图层级整体 WGS84→GCJ02 坐标转换（原地修改 feature.coordinates）。

    数值路径走 utils.geojson_geometry.transform_coordinate_lists：numpy 数组化 +
    整层一次向量化转换 + tolist()，没有逐点 Python 递归，也没有逐要素 numpy 固定开销。
    转换后坐标仍为 GeoJSON 标准 [lng, lat] list（保留 z 值）。
    """
    if not features:
        return
    transformed = transform_coordinate_lists(
        [feat.coordinates for feat in features], from_wgs84=True
    )
    for feat, coords in zip(features, transformed):
        feat.coordinates = coords


def _convert_to_geojson(layer: MapInfoLayer, transform_coords: bool = True) -> Dict:
    """
    将 MapInfo 图层转换为 GeoJSON 格式

    坐标转换统一在后端进行（transform_coords=True 默认），
    前端不再做 WGS84→GCJ02，避免双重转换导致偏移。

    Args:
        layer: MapInfo 图层
        transform_coords: 是否转换坐标（默认True，后端统一转换）

    Returns:
        GeoJSON FeatureCollection
    """
    features = []

    # 图层级整体坐标转换：一次收集所有 feature 的坐标点 → 一次 numpy batch → 写回。
    # 比逐 feature 调 batch 快 ~280x（18000 个 15 顶点 polygon：15.9s → 0.06s）
    if transform_coords and layer.features:
        _transform_layer_coordinates(layer.features)

    for feature in layer.features:
        geometry = {}
        coordinates = feature.coordinates

        if feature.type == GeometryType.POINT:
            geometry = {
                "type": "Point",
                "coordinates": coordinates
            }
        elif feature.type == GeometryType.LINE:
            geometry = {
                "type": "LineString",
                "coordinates": coordinates
            }
        elif feature.type == GeometryType.POLYGON:
            geometry = {
                "type": "Polygon",
                "coordinates": coordinates
            }

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": feature.properties
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "name": layer.name,
            "layerType": layer.type.value
        }
    }
