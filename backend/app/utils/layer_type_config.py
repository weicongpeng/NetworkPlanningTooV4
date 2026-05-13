"""
图层类型智能识别配置

通过文件名和关联文件识别图层类型并应用相应的渲染样式
"""
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum
import re
from pathlib import Path


class LayerCategory(Enum):
    """图层分类"""
    # 线状图层 - 道路
    HIGHWAY = "highway"  # 高速
    NATIONAL_ROAD = "national_road"  # 国道
    PROVINCIAL_ROAD = "provincial_road"  # 省道
    COUNTY_ROAD = "county_road"  # 县道
    TOWNSHIP_ROAD = "township_road"  # 乡道
    GENERAL_ROAD = "general_road"  # 一般市政道路
    RAILWAY = "railway"  # 铁路
    SUBWAY = "subway"  # 地铁

    # 线状图层 - 其他
    RIVER_LINE = "river_line"  # 河流（线状）
    BOUNDARY = "boundary"  # 边界

    # 面状图层 - 水域
    LAKE = "lake"  # 湖泊
    SEA = "sea"  # 大海
    RESERVOIR = "reservoir"  # 水库

    # 面状图层 - 地形
    GRASSLAND = "grassland"  # 草地
    MOUNTAIN = "mountain"  # 山体
    FOREST = "forest"  # 森林

    # 面状图层 - 其他
    BUILDING = "building"  # 建筑物
    RESIDENTIAL = "residential"  # 居民地
    COMMERCIAL = "commercial"  # 商业区
    INDUSTRIAL = "industrial"  # 工业区

    # 点状图层
    POI = "poi"  # 兴趣点
    SCHOOL = "school"  # 学校
    HOSPITAL = "hospital"  # 医院
    BANK = "bank"  # 银行

    # 未知类型
    UNKNOWN = "unknown"

    # 添加 WATER 别名（用于兼容）
    @property
    def WATER(self):
        return self.RIVER_LINE


@dataclass
class LayerStyleConfig:
    """图层样式配置"""
    # 线样式
    stroke: bool = True
    strokeColor: str = "#8b5cf6"  # 默认紫色
    strokeWidth: float = 2.0
    strokeOpacity: float = 1.0
    strokeDasharray: str = ""  # 虚线样式，如 "5,5"

    # 填充样式（面状）
    fill: bool = False
    fillColor: str = "#10b981"
    fillOpacity: float = 0.3

    # 点样式
    markerColor: str = "#f59e0b"
    markerSize: float = 6.0

    def to_dict(self) -> Dict:
        """转换为字典格式（用于后端返回）"""
        result = {}
        if self.stroke:
            result['stroke'] = True
            result['strokeColor'] = self.strokeColor
            result['strokeWidth'] = self.strokeWidth
            result['strokeOpacity'] = self.strokeOpacity
            if self.strokeDasharray:
                result['strokeDasharray'] = self.strokeDasharray

        if self.fill:
            result['fill'] = True
            result['fillColor'] = self.fillColor
            result['fillOpacity'] = self.fillOpacity

        if self.markerColor:
            result['markerColor'] = self.markerColor
        if self.markerSize:
            result['markerSize'] = self.markerSize

        return result


# 图层样式配置映射表
LAYER_STYLES: Dict[LayerCategory, LayerStyleConfig] = {
    # 线状图层 - 道路
    LayerCategory.HIGHWAY: LayerStyleConfig(
        stroke=True,
        strokeColor="#22c55e",  # 绿色
        strokeWidth=4.0,
        strokeOpacity=0.9,
        strokeDasharray=""
    ),
    LayerCategory.NATIONAL_ROAD: LayerStyleConfig(
        stroke=True,
        strokeColor="#dc2626",  # 红色
        strokeWidth=3.5,
        strokeOpacity=0.9,
        strokeDasharray=""
    ),
    LayerCategory.PROVINCIAL_ROAD: LayerStyleConfig(
        stroke=True,
        strokeColor="#a855f7",  # 紫色
        strokeWidth=3.0,
        strokeOpacity=0.9,
        strokeDasharray=""
    ),
    LayerCategory.COUNTY_ROAD: LayerStyleConfig(
        stroke=True,
        strokeColor="#f97316",  # 橙色
        strokeWidth=2.5,
        strokeOpacity=0.85,
        strokeDasharray=""
    ),
    LayerCategory.TOWNSHIP_ROAD: LayerStyleConfig(
        stroke=True,
        strokeColor="#94a3b8",  # 灰色
        strokeWidth=2.0,
        strokeOpacity=0.8,
        strokeDasharray=""
    ),
    LayerCategory.GENERAL_ROAD: LayerStyleConfig(
        stroke=True,
        strokeColor="#64748b",  # 深灰色
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray=""
    ),
    LayerCategory.RAILWAY: LayerStyleConfig(
        stroke=True,
        strokeColor="#1f2937",  # 深灰色
        strokeWidth=2.5,
        strokeOpacity=1.0,
        strokeDasharray="8,4"  # 虚线模拟枕木效果
    ),
    LayerCategory.SUBWAY: LayerStyleConfig(
        stroke=True,
        strokeColor="#7c3aed",  # 紫色
        strokeWidth=2.5,
        strokeOpacity=0.9,
        strokeDasharray="5,5"
    ),

    # 线状图层 - 其他
    LayerCategory.RIVER_LINE: LayerStyleConfig(
        stroke=True,
        strokeColor="#3b82f6",  # 蓝色
        strokeWidth=2.0,
        strokeOpacity=0.7,
        strokeDasharray=""
    ),
    LayerCategory.BOUNDARY: LayerStyleConfig(
        stroke=True,
        strokeColor="#9ca3af",  # 灰色
        strokeWidth=1.5,
        strokeOpacity=0.6,
        strokeDasharray="5,5"  # 边界使用虚线
    ),

    # 面状图层 - 水域
    LayerCategory.LAKE: LayerStyleConfig(
        stroke=True,
        strokeColor="#2563eb",  # 深蓝色边框
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray="",
        fill=True,
        fillColor="#3b82f6",  # 海蓝色填充
        fillOpacity=0.5
    ),
    LayerCategory.SEA: LayerStyleConfig(
        stroke=True,
        strokeColor="#1d4ed8",  # 更深的蓝色
        strokeWidth=2.0,
        strokeOpacity=0.9,
        strokeDasharray="",
        fill=True,
        fillColor="#2563eb",  # 海蓝色
        fillOpacity=0.6
    ),
    LayerCategory.RESERVOIR: LayerStyleConfig(
        stroke=True,
        strokeColor="#1e40af",  # 深蓝色
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray="",
        fill=True,
        fillColor="#3b82f6",
        fillOpacity=0.5
    ),

    # 面状图层 - 地形
    LayerCategory.GRASSLAND: LayerStyleConfig(
        stroke=True,
        strokeColor="#16a34a",  # 深绿色边框
        strokeWidth=1.0,
        strokeOpacity=0.6,
        strokeDasharray="",
        fill=True,
        fillColor="#22c55e",  # 绿色填充
        fillOpacity=0.4
    ),
    LayerCategory.MOUNTAIN: LayerStyleConfig(
        stroke=True,
        strokeColor="#15803d",  # 深绿色
        strokeWidth=1.5,
        strokeOpacity=0.7,
        strokeDasharray="",
        fill=True,
        fillColor="#166534",  # 深绿色
        fillOpacity=0.5
    ),
    LayerCategory.FOREST: LayerStyleConfig(
        stroke=True,
        strokeColor="#166534",  # 深绿色
        strokeWidth=1.0,
        strokeOpacity=0.6,
        strokeDasharray="",
        fill=True,
        fillColor="#15803d",
        fillOpacity=0.5
    ),

    # 面状图层 - 其他
    LayerCategory.BUILDING: LayerStyleConfig(
        stroke=True,
        strokeColor="#475569",  # 灰色边框
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray="",
        fill=True,
        fillColor="#94a3b8",  # 浅灰色
        fillOpacity=0.5
    ),
    LayerCategory.RESIDENTIAL: LayerStyleConfig(
        stroke=True,
        strokeColor="#d97706",  # 橙色边框
        strokeWidth=1.5,
        strokeOpacity=0.7,
        strokeDasharray="",
        fill=True,
        fillColor="#fbbf24",  # 黄色
        fillOpacity=0.4
    ),
    LayerCategory.COMMERCIAL: LayerStyleConfig(
        stroke=True,
        strokeColor="#db2777",  # 粉色边框
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray="",
        fill=True,
        fillColor="#ec4899",  # 粉色
        fillOpacity=0.4
    ),
    LayerCategory.INDUSTRIAL: LayerStyleConfig(
        stroke=True,
        strokeColor="#4f46e5",  # 靛蓝色边框
        strokeWidth=1.5,
        strokeOpacity=0.8,
        strokeDasharray="",
        fill=True,
        fillColor="#6366f1",  # 靛蓝色
        fillOpacity=0.4
    ),

    # 点状图层
    LayerCategory.POI: LayerStyleConfig(
        stroke=False,
        markerColor="#f59e0b",
        markerSize=6.0
    ),
    LayerCategory.SCHOOL: LayerStyleConfig(
        stroke=False,
        markerColor="#3b82f6",
        markerSize=8.0
    ),
    LayerCategory.HOSPITAL: LayerStyleConfig(
        stroke=False,
        markerColor="#ef4444",
        markerSize=8.0
    ),
    LayerCategory.BANK: LayerStyleConfig(
        stroke=False,
        markerColor="#10b981",
        markerSize=6.0
    ),
}


class LayerTypeRecognizer:
    """图层类型智能识别器"""

    # 文件名关键词映射（支持中英文）
    FILENAME_KEYWORDS: Dict[LayerCategory, List[str]] = {
        LayerCategory.HIGHWAY: [
            "高速", "highway", "expressway", "express", "hw", "gaosu", "gs",
            "g"  # G开头（如G1、G2）
        ],
        LayerCategory.NATIONAL_ROAD: [
            "国道", "national", "nationalroad", "guodao", "gd"
        ],
        LayerCategory.PROVINCIAL_ROAD: [
            "省道", "provincial", "provincialroad", "shengdao", "sd",
            "s"  # S开头
        ],
        LayerCategory.COUNTY_ROAD: [
            "县道", "county", "countyroad", "xiandao", "xd",
            "x", "y"  # X、Y开头
        ],
        LayerCategory.TOWNSHIP_ROAD: [
            "乡道", "township", "townshiproad", "xiangdao", "xd",
            "c"  # C开头（村道）
        ],
        LayerCategory.GENERAL_ROAD: [
            "道路", "road", "street", "lu", "dl", "市政", "municipal",
            "generalroad", "cityroad"
        ],
        LayerCategory.RAILWAY: [
            "铁路", "railway", "rail", "tielu", "tl", "train"
        ],
        LayerCategory.SUBWAY: [
            "地铁", "subway", "metro", "dite", "dt"
        ],
        LayerCategory.RIVER_LINE: [
            "河流", "river", "riverline", "heliu", "stream", "溪"
        ],
        LayerCategory.BOUNDARY: [
            "边界", "boundary", "border", "bianjie", "bound", "bdry",
            "县界", "县界", "countyboundary", "镇界", "zhenjie"
        ],
        LayerCategory.LAKE: [
            "湖泊", "lake", "hupo", "hp"
        ],
        LayerCategory.SEA: [
            "大海", "海", "sea", "ocean", "hai", "海域"
        ],
        LayerCategory.RESERVOIR: [
            "水库", "reservoir", "shuiku", "sk"
        ],
        LayerCategory.GRASSLAND: [
            "草地", "grass", "grassland", "caodi", "cd", "草场"
        ],
        LayerCategory.MOUNTAIN: [
            "山体", "mountain", "mount", "shanti", "山"
        ],
        LayerCategory.FOREST: [
            "森林", "forest", "senlin", "wood", "林地", " wooded"
        ],
        LayerCategory.BUILDING: [
            "建筑", "building", "jianzhu", "jz", "楼"
        ],
        LayerCategory.RESIDENTIAL: [
            "居民", "residential", "jumin", "住宅", "zhuzhai", "居住"
        ],
        LayerCategory.COMMERCIAL: [
            "商业", "commercial", "shangye", "sy", "商务"
        ],
        LayerCategory.INDUSTRIAL: [
            "工业", "industrial", "gongye", "gy", "工厂"
        ],
        LayerCategory.SCHOOL: [
            "学校", "school", "xuexiao", "xx"
        ],
        LayerCategory.HOSPITAL: [
            "医院", "hospital", "yiyuan", "yy"
        ],
        LayerCategory.BANK: [
            "银行", "bank", "yinxing", "yx"
        ],
    }

    # 关联文件（.id, .dat）内容关键词映射
    ASSOCIATED_FILE_KEYWORDS: Dict[LayerCategory, List[str]] = {
        LayerCategory.HIGHWAY: [
            "高速公路", "高速", "G系列", "Expressway"
        ],
        LayerCategory.NATIONAL_ROAD: [
            "国道", "G", "National"
        ],
        LayerCategory.PROVINCIAL_ROAD: [
            "省道", "S", "Provincial"
        ],
        LayerCategory.RAILWAY: [
            "铁路", "Rail", "Train", "轨道"
        ],
        LayerCategory.RIVER_LINE: [
            "水域", "Water", "水系", "Hydro", "河流", "River"
        ],
    }

    @classmethod
    def recognize_by_filename(cls, filename: str) -> Tuple[LayerCategory, float]:
        """
        通过文件名识别图层类型

        Args:
            filename: 文件名（不含路径和扩展名）

        Returns:
            (LayerCategory, confidence) - 图层类型和置信度（0-1）
        """
        filename_lower = filename.lower()

        # 检查G/S/X/Y/C开头加数字的模式（道路编号）
        road_pattern = r'^([gsxyc])(\d+)'
        match = re.match(road_pattern, filename_lower)
        if match:
            road_type = match.group(1)
            if road_type == 'g':
                return LayerCategory.HIGHWAY, 0.95
            elif road_type == 's':
                return LayerCategory.PROVINCIAL_ROAD, 0.95
            elif road_type == 'x':
                return LayerCategory.COUNTY_ROAD, 0.95
            elif road_type == 'y' or road_type == 'c':
                return LayerCategory.TOWNSHIP_ROAD, 0.95

        # 检查关键词
        best_match = LayerCategory.UNKNOWN
        best_confidence = 0.0

        for category, keywords in cls.FILENAME_KEYWORDS.items():
            for keyword in keywords:
                keyword_lower = keyword.lower()
                if keyword_lower in filename_lower:
                    # 置信度计算：
                    # - 完全匹配：0.9
                    # - 包含关键词：0.7
                    # - 部分匹配：0.5
                    if filename_lower == keyword_lower:
                        confidence = 0.9
                    elif filename_lower.startswith(keyword_lower):
                        confidence = 0.8
                    elif keyword_lower in filename_lower:
                        confidence = 0.7
                    else:
                        confidence = 0.5

                    if confidence > best_confidence:
                        best_match = category
                        best_confidence = confidence

        return best_match, best_confidence

    @classmethod
    def recognize_by_associated_files(
        cls,
        base_path: Path
    ) -> Tuple[LayerCategory, float]:
        """
        通过关联文件（.id, .dat）内容识别图层类型

        Args:
            base_path: 文件基础路径（不含扩展名）

        Returns:
            (LayerCategory, confidence) - 图层类型和置信度（0-1）
        """
        # 检查 .id 文件
        id_file = base_path.with_suffix('.id')
        if id_file.exists():
            try:
                content = id_file.read_text(encoding='utf-8', errors='ignore')
                return cls._analyze_content(content)
            except:
                pass

        # 检查 .dat 文件
        dat_file = base_path.with_suffix('.dat')
        if dat_file.exists():
            try:
                # 尝试多种编码
                for encoding in ['utf-8', 'gbk', 'gb2312', 'latin1']:
                    try:
                        content = dat_file.read_text(encoding=encoding, errors='ignore')
                        return cls._analyze_content(content)
                    except:
                        continue
            except:
                pass

        return LayerCategory.UNKNOWN, 0.0

    @classmethod
    def _analyze_content(cls, content: str) -> Tuple[LayerCategory, float]:
        """分析文件内容，返回图层类型和置信度"""
        content_lower = content.lower()

        best_match = LayerCategory.UNKNOWN
        best_confidence = 0.0

        for category, keywords in cls.ASSOCIATED_FILE_KEYWORDS.items():
            for keyword in keywords:
                if keyword.lower() in content_lower:
                    # 关联文件的置信度较高
                    confidence = 0.85
                    if confidence > best_confidence:
                        best_match = category
                        best_confidence = confidence

        return best_match, best_confidence

    @classmethod
    def recognize_layer(
        cls,
        file_path: Path
    ) -> Tuple[LayerCategory, LayerStyleConfig, str]:
        """
        综合识别图层类型

        Args:
            file_path: 文件路径

        Returns:
            (category, style, method) - 图层类型、样式配置、识别方法
        """
        filename = file_path.stem
        base_path = file_path.with_suffix('')

        # 方法1: 通过文件名识别
        name_category, name_confidence = cls.recognize_by_filename(filename)

        # 方法2: 通过关联文件识别
        associated_category, associated_confidence = cls.recognize_by_associated_files(base_path)

        # 综合判断：选择置信度更高的结果
        if name_confidence >= associated_confidence:
            category = name_category
            method = f"filename ({name_confidence:.2f})"
        else:
            category = associated_category
            method = f"associated_file ({associated_confidence:.2f})"

        # 获取样式配置
        if category != LayerCategory.UNKNOWN:
            style = LAYER_STYLES.get(category, LayerStyleConfig())
        else:
            # 未知类型使用默认样式
            style = LayerStyleConfig()

        return category, style, method


def get_layer_style_by_filename(filename: str, geom_type: str = "line") -> Dict:
    """
    便捷函数：通过文件名获取图层样式

    Args:
        filename: 文件名
        geom_type: 几何类型 ("point", "line", "polygon")

    Returns:
        样式字典
    """
    category, _ = LayerTypeRecognizer.recognize_by_filename(filename)

    if category == LayerCategory.UNKNOWN:
        # 根据几何类型返回默认样式
        if geom_type == "point":
            return LayerStyleConfig().to_dict()
        elif geom_type == "line":
            return LAYER_STYLES[LayerCategory.GENERAL_ROAD].to_dict()
        else:  # polygon
            return LayerStyleConfig(fill=True, fillColor="#d1d5db", fillOpacity=0.3).to_dict()

    return LAYER_STYLES[category].to_dict()


def get_layer_style_by_file_path(file_path: Path) -> Dict:
    """
    便捷函数：通过文件路径获取图层样式

    Args:
        file_path: 文件路径

    Returns:
        样式字典
    """
    category, style, method = LayerTypeRecognizer.recognize_layer(file_path)
    print(f"[LayerTypeConfig] 识别图层: {file_path.name} -> {category.value} (方法: {method})")
    return style.to_dict()
