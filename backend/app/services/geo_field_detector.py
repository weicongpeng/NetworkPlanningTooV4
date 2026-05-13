"""
地理化数据字段检测器
智能识别 Excel/CSV/TXT 文件中的经纬度、方位角等字段
"""

import re
import math
import pandas as pd
from typing import Dict, Optional, Tuple, List


class GeoFieldDetector:
    """地理化数据字段检测器"""

    # 字段匹配模式表
    FIELD_PATTERNS = {
        "longitude": [
            "经度",
            "longitude",
            "lng",
            "lon",
            "long",
            "LONGITUDE",
            "LNG",
            "LON",
            "LONG",
            "Coord_X",
            "X",
            "经度x",
            "lngx",
            "longx",
        ],
        "latitude": [
            "纬度",
            "latitude",
            "lat",
            "LATITUDE",
            "LAT",
            "Coord_Y",
            "Y",
            "纬度y",
            "laty",
            "laty",
        ],
        "azimuth": [
            "方位角",
            "azimuth",
            "azi",
            "azim",
            "AZIMUTH",
            "AZI",
            "AZIM",
            "方向角",
            "方向",
            "Angle",
            "角度",
            "azimuth_angle",
            "azimuthangle",
            "azi_angle",
            "bearing",
            "direction",
            "heading",
            "azimuthangle",
            "directionangle",
            "bearing_angle",
            "扇区方向",
            "扇区方位",
            "天线方位",
            "天线方向",
            "azimuth_",
            "azi_",
            "direction_",
            "bearing_",
        ],
        "beamwidth": [
            "波束宽度",
            "beamwidth",
            "beam_width",
            "beamwidth",
            "BEAMWIDTH",
            "BEAM_WIDTH",
            "水平波束角",
            "水平波束宽度",
            "水平波束",
            "波束角",
            "beamangle",
            "beam_angle",
            "覆盖角度",
            "覆盖角度",
            "扇区角度",
            "扇区宽度",
            "sectorwidth",
            "sector_width",
        ],
        "cell_cover_type": [
            "覆盖类型",
            "cell_cover_type",
            "cell_cover_type",
            "CELL_COVER_TYPE",
            "CELL_COVER_TYPE",
            "小区覆盖类型",
            "小区类型",
            "覆盖类型",
            "indoor",
            "outdoor",
            "is_indoor",
        ],
        "name": [
            "名称",
            "name",
            "小区名",
            "站名",
            "NAME",
            "SiteName",
            "CellName",
            "站点名称",
            "小区名称",
            "cell_name",
            "site_name",
            "小区标识",
            "站点标识",
            "cellid",
            "siteid",
        ],
        "polygon": [
            "polygon",  # 不区分大小写匹配
        ],
    }

    def detect_fields(self, df: pd.DataFrame) -> Dict[str, Optional[str]]:
        """
        检测 DataFrame 中的地理字段

        Args:
            df: 要检测的数据框

        Returns:
            包含检测结果的字典：
            {
                'longitude': '经度列名' or None,
                'latitude': '纬度列名' or None,
                'azimuth': '方位角列名' or None,
                'name': '名称列名' or None,
                'geometry_type': 'point' or 'sector'
            }
        """
        detected = {}

        # 🔴 早期调试：打印原始列名
        print(f"[GeoFieldDetector] 🔴🔴🔴 原始列名 (df.columns): {list(df.columns)}")
        print(f"[GeoFieldDetector] 🔴🔴🔴 列数量: {len(df.columns)}")

        # 检查是否有 POLYGON 列（原始名称，不区分大小写）
        has_polygon_col = any(str(col).strip().upper() == 'POLYGON' for col in df.columns)
        print(f"[GeoFieldDetector] 🔴🔴🔴 是否有 POLYGON 列 (不区分大小写): {has_polygon_col}")

        # 如果有 POLYGON 列，打印它的详细信息
        for col in df.columns:
            if str(col).strip().upper() == 'POLYGON':
                print(f"[GeoFieldDetector] 🔴🔴🔴 找到 POLYGON 列！原始名称: '{col}', 类型: {type(col)}")

        columns = [str(col).strip() for col in df.columns]

        print(f"[GeoFieldDetector] 🔍 检测列名: {columns}")
        print(f"[GeoFieldDetector] 🔍 looking for polygon in patterns: {self.FIELD_PATTERNS.get('polygon', [])}")

        # 对每个字段类型进行匹配
        print(f"[GeoFieldDetector] 🔍 字段类型列表: {list(self.FIELD_PATTERNS.keys())}")
        print(f"[GeoFieldDetector] 🔍 准备开始循环检测...")

        try:
            for idx, (field_name, patterns) in enumerate(self.FIELD_PATTERNS.items()):
                print(f"[GeoFieldDetector] 🔍 [{idx}] 开始检测字段类型: {field_name}")
                found_match = False
                for col in columns:
                    col_lower = col.lower()
                    # 使用正则表达式进行模糊匹配
                    for p in patterns:
                        match_result = re.search(p, col_lower, re.IGNORECASE)
                        if match_result:
                            detected[field_name] = col
                            found_match = True
                            print(f"[GeoFieldDetector] ✅ [{idx}] {field_name} = '{col}'")
                            break
                    if found_match:
                        break

                # 如果没有找到匹配，设置为 None
                if not found_match:
                    detected[field_name] = None
                    if field_name in ["polygon", "name", "longitude", "latitude"]:
                        print(f"[GeoFieldDetector] ⚠️ [{idx}] {field_name} 未找到匹配")
        except Exception as e:
            print(f"[GeoFieldDetector] ❌ 字段检测过程中出错: {e}")
            import traceback
            traceback.print_exc()

        print(f"[GeoFieldDetector] 🔍 ========== 字段检测完成 ==========")
        print(f"[GeoFieldDetector] 🔍 polygon 检测结果: {detected.get('polygon')}")
        print(f"[GeoFieldDetector] 🔍 检测结果: {detected}")

        # 确定几何类型优先级：polygon > sector > point
        if detected.get("polygon"):
            detected["geometry_type"] = "polygon"
            print(f"[GeoFieldDetector] ✅ 几何类型: POLYGON")
        elif detected.get("azimuth"):
            detected["geometry_type"] = "sector"
            print(f"[GeoFieldDetector] ✅ 几何类型: SECTOR")
        else:
            detected["geometry_type"] = "point"
            print(f"[GeoFieldDetector] ⚠️ 几何类型: POINT (默认)")

        return detected

    def validate_coordinates(
        self, df: pd.DataFrame, lon_col: str, lat_col: str
    ) -> Tuple[bool, str]:
        """
        验证坐标数据的有效性

        Args:
            df: 数据框
            lon_col: 经度列名
            lat_col: 纬度列名

        Returns:
            (是否有效, 错误信息)
        """
        # 尝试将列转换为数值类型
        lon_values = pd.to_numeric(df[lon_col], errors="coerce")
        lat_values = pd.to_numeric(df[lat_col], errors="coerce")

        # 验证坐标范围
        valid_mask = (
            lon_values.between(-180, 180)
            & lat_values.between(-90, 90)
            & lon_values.notna()
            & lat_values.notna()
        )

        valid_count = valid_mask.sum()

        if valid_count == 0:
            return False, self._format_coordinate_error(df, lon_col, lat_col)

        if valid_count < len(df) * 0.5:
            return False, f"有效数据少于50%（{valid_count}/{len(df)}），请检查数据质量"

        return True, ""

    def _format_coordinate_error(
        self, df: pd.DataFrame, lon_col: str, lat_col: str
    ) -> str:
        """格式化友好的坐标错误信息"""
        # 检查前几行的数据
        sample_size = min(5, len(df))
        samples = []
        for idx in range(sample_size):
            lon_val = df.iloc[idx][lon_col]
            lat_val = df.iloc[idx][lat_col]
            samples.append(f"第{idx + 1}行: 经度={lon_val}, 纬度={lat_val}")

        sample_info = "\n".join(samples)

        return (
            "没有检测到有效的经纬度数据。请确保：\n"
            "1. 经度范围：-180 ~ 180\n"
            "2. 纬度范围：-90 ~ 90\n"
            "3. 坐标值为数字格式\n\n"
            f"示例数据：\n{sample_info}\n\n"
            f"检测到的列：经度[{lon_col}]，纬度[{lat_col}]"
        )

    def validate_azimuth(self, df: pd.DataFrame, azi_col: str) -> Tuple[bool, str]:
        """
        验证方位角数据的有效性（角度单位，0-360度）

        Args:
            df: 数据框
            azi_col: 方位角列名

        Returns:
            (是否有效, 错误信息)
        """
        azi_values = pd.to_numeric(df[azi_col], errors="coerce")

        # 方位角范围：0 到 360（角度）
        valid_mask = azi_values.between(0, 360) & azi_values.notna()
        valid_count = valid_mask.sum()

        if valid_count == 0:
            return (
                False,
                f"没有有效的方位角数据。请检查列「{azi_col}」中的值是否在 0 到 360（角度）范围内",
            )

        if valid_count < len(df) * 0.5:
            return False, f"有效方位角数据少于50%（{valid_count}/{len(df)}）"

        return True, ""

    def get_supported_field_names(self) -> Dict[str, List[str]]:
        """
        获取支持的字段名列表，用于错误提示

        Returns:
            字段类型到支持名称的映射
        """
        return self.FIELD_PATTERNS
