"""
MapInfo 文件解析服务

支持格式:
- .tab: MapInfo TAB 格式 (包含表头定义和数据)
- .mif: MapInfo Interchange Format (交换格式)
- .dat: 数据文件
"""
import os
import time
import uuid
import json
from typing import List, Dict, Any, Optional
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass
from enum import Enum

from app.utils.coordinate_transformer import CoordinateTransformer
from app.core.database import SessionLocal
from app.models.database import Layer

# MapInfo 图层数据缓存（避免每次请求都重新解析文件）
_layer_cache: Dict[str, Dict] = {}
_layer_cache_mtime: Dict[str, float] = {}
_layer_cache_ttl: int = 600  # 缓存10分钟


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
        if ext in ['.tab', '.mif', '.dat']:
            return ext[1:]  # 返回不带点的扩展名
        return None

    @staticmethod
    def _extract_mapinfo_style(row: Any, columns: Any, geom_type: GeometryType) -> Optional[Dict[str, Any]]:
        """
        提取 MapInfo 样式信息

        MapInfo 样式通常存储在特殊列中，如：
        - MAPINFO_pen, PEN: 线样式 (宽度、颜色、模式)
        - MAPINFO_brush, BRUSH: 填充样式 (前景色、背景色、模式)
        - MAPINFO_symbol, SYMBOL: 点符号
        - MAPINFO_font, FONT: 字体样式
        - MI_Style, MI_Styles: MapInfo 内部样式
        """
        import re
        style = {}

        # 样式相关的列名模式（更全面的匹配）
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

        # 首先检查常见的样式列
        for col in columns:
            if col == 'geometry':
                continue

            col_lower = str(col).lower()
            # 检查是否是样式列
            is_style_col = any(re.search(pattern, col, re.IGNORECASE) for pattern in style_patterns)

            if is_style_col and col in row.index:
                value = row[col]
                if value is not None and value != '' and value != 0:
                    # 提取样式值的各个部分
                    parsed_style = MapInfoParser._parse_style_value(str(col), value)
                    if parsed_style:
                        style.update(parsed_style)

        # 如果没有找到样式，尝试从属性中推断样式
        # 例如：道路类型、区域类型等
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

            # 解析 PEN (线样式)
            if 'pen' in style_type_lower:
                parts = value_str.split(',')
                if len(parts) >= 2:
                    try:
                        result['stroke'] = True
                        result['strokeWidth'] = float(parts[0]) if parts[0] else 1
                        # MapInfo 颜色通常是 RGB 或 BGR
                        if len(parts) >= 4:
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
                parts = value_str.split(',')
                if len(parts) >= 2:
                    try:
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
                parts = value_str.split(',')
                if len(parts) >= 1:
                    try:
                        result['markerType'] = 'symbol'
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
        从属性值推断样式

        许多 MapInfo 文件使用属性列来表示要素类型，
        我们可以根据这些属性值推断适当的样式。
        """
        import re
        properties = {}
        style = {}

        # 提取所有属性值
        for key in row.index:
            if key != 'geometry':
                value = row[key]
                if value is not None and value != '':
                    properties[str(key).lower()] = str(value).lower()

        # 将所有属性值连接成一个字符串用于搜索
        all_values = ' '.join(properties.values())

        if geom_type == GeometryType.LINE:
            # 道路类型推断
            if any(keyword in all_values for keyword in ['高速', '高速', '高速', 'gao su', 'expressway', 'express']):
                style = {
                    'stroke': True,
                    'strokeWidth': 4,
                    'strokeColor': '#ef4444',  # 红色
                    'strokeDasharray': ''
                }
            elif any(keyword in all_values for keyword in ['国道', '国道', 'guo dao', 'national', 'g']):
                style = {
                    'stroke': True,
                    'strokeWidth': 3,
                    'strokeColor': '#f59e0b',  # 橙色
                    'strokeDasharray': '15,5'
                }
            elif any(keyword in all_values for keyword in ['省道', '省道', 'sheng dao', 'provincial', 's', '省']):
                style = {
                    'stroke': True,
                    'strokeWidth': 2.5,
                    'strokeColor': '#3b82f6',  # 蓝色
                    'strokeDasharray': '10,5'
                }
            elif any(keyword in all_values for keyword in ['县道', '县道', 'xian dao', 'county', 'x', '县']):
                style = {
                    'stroke': True,
                    'strokeWidth': 2,
                    'strokeColor': '#10b981',  # 绿色
                    'strokeDasharray': '5,5'
                }
            elif any(keyword in all_values for keyword in ['乡道', '乡道', 'xiang dao', 'township', 'y', '乡']):
                style = {
                    'stroke': True,
                    'strokeWidth': 1.5,
                    'strokeColor': '#6b7280',  # 灰色
                    'strokeDasharray': '5,5'
                }
            elif any(keyword in all_values for keyword in ['铁路', '铁路', 'tie lu', 'railway', 'rail']):
                style = {
                    'stroke': True,
                    'strokeWidth': 2,
                    'strokeColor': '#1f2937',  # 深灰色
                    'strokeDasharray': '10,10,2,10'
                }
            elif any(keyword in all_values for keyword in ['地铁', '地铁', 'di tie', 'subway', 'metro']):
                style = {
                    'stroke': True,
                    'strokeWidth': 2.5,
                    'strokeColor': '#7c3aed',  # 紫色
                    'strokeDasharray': '5,5'
                }
            else:
                # 默认道路样式
                style = {
                    'stroke': True,
                    'strokeWidth': 2,
                    'strokeColor': '#8b5cf6',  # 默认紫色
                    'strokeDasharray': '5,10'
                }

        elif geom_type == GeometryType.POLYGON:
            # 区域类型推断
            if any(keyword in all_values for keyword in ['水', '水域', '水系', 'water', 'river', 'lake']):
                style = {
                    'fill': True,
                    'fillColor': '#3b82f6',
                    'fillOpacity': 0.4,
                    'stroke': True,
                    'strokeColor': '#2563eb',
                    'strokeWidth': 1
                }
            elif any(keyword in all_values for keyword in ['绿地', '绿化', '植被', 'green', 'vegetation', 'park']):
                style = {
                    'fill': True,
                    'fillColor': '#10b981',
                    'fillOpacity': 0.3,
                    'stroke': True,
                    'strokeColor': '#059669',
                    'strokeWidth': 1
                }
            elif any(keyword in all_values for keyword in ['建筑', 'building', '建筑物']):
                style = {
                    'fill': True,
                    'fillColor': '#f97316',
                    'fillOpacity': 0.4,
                    'stroke': True,
                    'strokeColor': '#ea580c',
                    'strokeWidth': 1.5
                }
            elif any(keyword in all_values for keyword in ['居民', '住宅', 'residential']):
                style = {
                    'fill': True,
                    'fillColor': '#fbbf24',
                    'fillOpacity': 0.3,
                    'stroke': True,
                    'strokeColor': '#f59e0b',
                    'strokeWidth': 1
                }
            elif any(keyword in all_values for keyword in ['商业', 'commercial']):
                style = {
                    'fill': True,
                    'fillColor': '#ec4899',
                    'fillOpacity': 0.3,
                    'stroke': True,
                    'strokeColor': '#db2777',
                    'strokeWidth': 1.5
                }
            elif any(keyword in all_values for keyword in ['工业', 'industrial']):
                style = {
                    'fill': True,
                    'fillColor': '#6366f1',
                    'fillOpacity': 0.3,
                    'stroke': True,
                    'strokeColor': '#4f46e5',
                    'strokeWidth': 1.5
                }
            else:
                # 默认区域样式
                style = {
                    'fill': True,
                    'fillColor': '#d1d5db',
                    'fillOpacity': 0.3,
                    'stroke': True,
                    'strokeColor': '#9ca3af',
                    'strokeWidth': 1
                }

        elif geom_type == GeometryType.POINT:
            # 点类型推断
            if any(keyword in all_values for keyword in ['学校', 'school']):
                style = {
                    'markerColor': '#3b82f6',
                    'markerSize': 8
                }
            elif any(keyword in all_values for keyword in ['医院', 'hospital']):
                style = {
                    'markerColor': '#ef4444',
                    'markerSize': 8
                }
            elif any(keyword in all_values for keyword in ['银行', 'bank']):
                style = {
                    'markerColor': '#10b981',
                    'markerSize': 6
                }
            else:
                # 默认点样式
                style = {
                    'markerColor': '#f59e0b',
                    'markerSize': 6
                }

        return style if style else None

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
            # 根据几何类型返回默认样式
            if geom_type == GeometryType.POINT:
                style = {'type': 'circle', 'color': '#3b82f6', 'radius': 6}
            elif geom_type == GeometryType.LINE:
                style = {'type': 'polyline', 'color': '#10b981', 'weight': 2}
            elif geom_type == GeometryType.POLYGON:
                style = {'type': 'polygon', 'color': '#f59e0b', 'fillColor': '#f59e0b', 'fillOpacity': 0.3}

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

            # 使用 Geopandas 读取文件
            try:
                gdf = gpd.read_file(path_str, encoding='gbk')
            except Exception as e1:
                try:
                    gdf = gpd.read_file(path_str)
                except Exception as e2:
                    raise e2

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

            # 调试：输出所有列名

            # 遍历要素
            for idx, row in gdf.iterrows():
                geom = row.geometry
                if geom is None:
                    continue

                # 提取属性 (排除 geometry 列)
                properties = row.drop('geometry').to_dict()
                # 处理可能的时间戳等非JSON序列化类型
                for k, v in properties.items():
                    if hasattr(v, 'isoformat'):
                        properties[k] = v.isoformat()

                # 提取 MapInfo 样式信息
                style_info = MapInfoParser._extract_mapinfo_style(row, gdf.columns, layer_type)

                # 如果没有样式信息，使用图层默认样式
                if not style_info and layer_default_style:
                    style_info = layer_default_style.copy()

                if style_info:
                    properties['_style'] = style_info

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
                break
            except Exception as e:
                print(f"[MapInfoParser] 解析 TAB 文件失败 {tab_file.name}: {e}")
                import traceback
                traceback.print_exc()

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
                break
            except Exception as e:
                print(f"[MapInfoParser] 解析 MIF 文件失败 {mif_file.name}: {e}")
                import traceback
                traceback.print_exc()

        print(f"[MapInfoParser] 目录解析完成，共解析 {len(layers)} 个图层")
        return layers


def parse_mapinfo_files(upload_path: Path, user_id: int = 1, parent_id: str = None) -> List[Dict[str, Any]]:
    """
    解析上传的 MapInfo 文件

    Args:
        upload_path: 文件或目录路径
        user_id: 用户ID
        parent_id: 可选的父级 data_id（与 API 层 data_id 一致，避免写入时生成新 UUID）

    返回图层元数据列表
    """
    layers = []

    if upload_path.is_file():
        # 单个文件
        try:
            layer = MapInfoParser.parse_file(upload_path)
            layers.append({
                "id": layer.id,
                "name": layer.name,
                "type": layer.type.value,
                "feature_count": len(layer.features),
                "metadata": layer.metadata
            })
            _save_layer_metadata(
                user_id=user_id,
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
                "metadata": layer.metadata
            })
            # 使用 parent_id；多个图层时追加序号
            _layer_id = parent_id if idx == 0 and parent_id else (f"{parent_id}_{idx}" if parent_id else None)
            _save_layer_metadata(
                user_id=user_id,
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
):
    """保存图层文件元数据到 SQLite"""
    db = SessionLocal()
    try:
        layer = Layer(
            id=layer_id or str(uuid.uuid4()),
            user_id=user_id,
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
                for ext in ['.tab', '.mif']:
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

    # 4. 缓存未命中，解析文件
    result = None

    if target_layer_info and source_path:
        try:
            layer = MapInfoParser.parse_file(source_path)
            layer.id = layer_id
            result = _convert_to_geojson(layer)
        except Exception as e:
            print(f"[MapInfo] 解析源文件失败 {source_path}: {e}")

    # 5. 回退：遍历目录
    if result is None:
        print(f"[MapInfo] 未在 layers.json 中找到图层 {layer_id}，尝试遍历目录")
        for file_path in list(data_dir.rglob('*.tab')) + list(data_dir.rglob('*.mif')):
            try:
                layer = MapInfoParser.parse_file(file_path)
                result = _convert_to_geojson(layer)
                break
            except Exception as e:
                print(f"[MapInfo] 解析失败 {file_path}: {e}")
                continue

    # 6. 写入缓存
    if result is not None and source_path:
        try:
            _layer_cache[cache_key] = result
            _layer_cache_mtime[cache_key] = source_path.stat().st_mtime
        except Exception:
            pass

    return result


def _convert_to_geojson(layer: MapInfoLayer, transform_coords: bool = False) -> Dict:
    """
    将 MapInfo 图层转换为 GeoJSON 格式

    注意：坐标转换在前端进行，以保证与扇区图的纠偏算法一致

    Args:
        layer: MapInfo 图层
        transform_coords: 是否转换坐标（默认false，由前端处理）

    Returns:
        GeoJSON FeatureCollection
    """
    features = []

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
