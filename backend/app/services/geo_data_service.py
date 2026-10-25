"""
地理化数据解析服务
支持 Excel、CSV、TXT 格式的地理化数据导入
"""

import re
import math
import uuid
import json
import pandas as pd
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Tuple, Optional

from app.services.geo_field_detector import GeoFieldDetector
from app.utils.coordinate_transformer import CoordinateTransformer
from app.core.database import SessionLocal
from app.models.database import GeoFile


class GeoDataService:
    """地理化数据解析服务"""

    def __init__(self):
        self.detector = GeoFieldDetector()

    def parse_geo_data(self, file_path: str, filename: str, user_id: int = 1, geo_id: str = None,
                       city: Optional[str] = None, operator: Optional[str] = None) -> Dict[str, Any]:
        """
        解析地理化数据文件

        Args:
            file_path: 文件路径
            filename: 文件名
            user_id: 用户ID（上传者印记）
            geo_id: 可选的 geo 数据 ID（与 API 层 data_id 一致，避免写入时生成新 UUID）
            city/operator: 数据所属组（地市+运营商）归属快照，取自上传者

        Returns:
            解析结果字典：
            {
                'geometryType': 'point' or 'sector',
                'fields': {...},  # 检测到的字段映射
                'data': [...],    # 解析后的数据列表
                'pointCount': n   # 数据点数量
            }
        """
        # 1. 读取文件
        df = self._read_file(file_path)
        if df.empty:
            raise ValueError(f"文件「{filename}」为空或格式不正确")

        # 早期调试：打印 DataFrame 信息（注意：不要带 emoji —— Windows 下
        # print 到 GBK 流会抛 UnicodeEncodeError；参见 app/core/console_encoding.py）
        print(f"[GeoDataService] ===== DataFrame 信息 =====")
        print(f"[GeoDataService] 文件名: {filename}")
        print(f"[GeoDataService] 行数: {len(df)}, 列数: {len(df.columns)}")
        print(f"[GeoDataService] 原始列名: {list(df.columns)}")
        print(
            f"[GeoDataService] 列类型: {[df[col].dtype for col in df.columns]}"
        )
        print(f"[GeoDataService] 前3行数据:\n{df.head(3).to_string()}")
        print(f"[GeoDataService] ==========================")

        # 2. 字段检测
        fields = self.detector.detect_fields(df)

        # 检查是否为多边形数据（POLYGON列包含所有坐标信息，不需要单独的经纬度列）
        if fields.get("geometry_type") == "polygon" and fields.get("polygon"):
            # 多边形数据：只需要POLYGON列，跳过经纬度检查
            print(
                f"[GeoDataService] 检测到POLYGON列「{fields['polygon']}」，使用POLYGON格式解析坐标"
            )
            # 验证POLYGON数据
            polygon_count = df[fields["polygon"]].notna().sum()
            if polygon_count == 0:
                raise ValueError(
                    f"❌ 文件「{filename}」POLYGON列为空\n\n"
                    f"💡 请确保POLYGON列包含有效的坐标数据（格式：经度 纬度,经度 纬度,...）"
                )
            print(
                f"[GeoDataService] 检测到POLYGON列「{fields['polygon']}」，共 {polygon_count} 条多边形数据"
            )
        elif not fields.get("longitude") or not fields.get("latitude"):
            # 点/扇区数据：必须要有经纬度列
            supported_fields = self.detector.get_supported_field_names()
            lon_fields = ", ".join(supported_fields["longitude"][:5])
            lat_fields = ", ".join(supported_fields["latitude"][:5])

            raise ValueError(
                f"❌ 文件「{filename}」未找到必需的经纬度字段\n\n"
                f"📋 检测到的列：{', '.join(df.columns.tolist()[:10])}\n\n"
                f"✅ 支持的经度字段：{lon_fields} 等\n"
                f"✅ 支持的纬度字段：{lat_fields} 等\n\n"
                f"💡 提示：请确保表格包含经度和纬度列，字段名可以是中文或英文"
            )
        else:
            # 3. 验证坐标（仅对点/扇区数据）
            is_valid, error_msg = self.detector.validate_coordinates(
                df, fields["longitude"], fields["latitude"]
            )
            if not is_valid:
                raise ValueError(f"❌ 文件「{filename}」坐标验证失败\n\n{error_msg}")

        # 4. 如果有方位角且不是多边形数据，验证方位角
        azimuth_col = fields.get("azimuth")
        geometry_type = fields["geometry_type"]
        if geometry_type != "polygon":
            if azimuth_col:
                is_valid, error_msg = self.detector.validate_azimuth(df, azimuth_col)
                if not is_valid:
                    raise ValueError(
                        f"❌ 文件「{filename}」方位角验证失败\n\n{error_msg}"
                    )
                print(
                    f"[GeoDataService] 检测到方位角列「{azimuth_col}」，文件将被识别为扇区图层"
                )
            else:
                print(f"[GeoDataService] 未检测到方位角列，文件将被识别为点状图层")

        # 5. 根据 geometry_type 选择提取方式
        geometry_type = fields["geometry_type"]

        # 如果是 POLYGON 多边形数据，先检查 POLYGON 字段
        if geometry_type == "polygon":
            polygon_col = fields.get("polygon")
            if polygon_col:
                # 验证POLYGON数据
                polygon_count = df[polygon_col].notna().sum()
                print(
                    f"[GeoDataService] 检测到POLYGON列「{polygon_col}」，共 {polygon_count} 条多边形数据"
                )
            else:
                print(f"[GeoDataService] 未检测到POLYGON列，降级为点状图层")
                geometry_type = "point"

        # 根据几何类型提取数据
        if geometry_type == "polygon":
            geo_data = self._extract_polygon_data(df, fields)
            coord_zero_count = 0
        else:
            geo_data, coord_zero_count = self._extract_data(df, fields)

        # 验证提取结果
        if len(geo_data) == 0:
            raise ValueError(
                f"❌ 文件「{filename}」未能提取到有效数据\n\n"
                f"💡 可能原因：\n"
                f"  • 所有行的经纬度都为空\n"
                f"  • 坐标值格式不正确\n"
                f"  • 数据被过滤（如非数值类型）"
            )

        # 非致命提醒：坐标缺失/为 0 的小区仍保留（与原工参导入的 coord_zero 约定一致），
        # 但会落在原点并撑大地图/热力范围，前端据此提示用户修正源文件
        import_warnings = (
            [{"code": "coord_zero", "count": coord_zero_count}]
            if coord_zero_count else []
        )

        # 元数据入库（阶段 0 双写）
        _save_geo_file_metadata(
            user_id=user_id,
            filename=filename,
            file_path=file_path,
            geometry_type=geometry_type,
            field_mapping=fields,
            point_count=len(geo_data),
            bbox=_compute_bbox(geo_data) if geo_data else None,
            file_size=Path(file_path).stat().st_size if Path(file_path).exists() else None,
            geo_id=geo_id,
            city=city,
            operator=operator,
            import_warnings=import_warnings,
        )

        return {
            "geometryType": geometry_type,
            "fields": fields,
            "data": geo_data,
            "pointCount": len(geo_data),
            "importWarnings": import_warnings,
        }

    def _read_file(self, file_path: str) -> pd.DataFrame:
        """
        根据扩展名读取文件（支持 ZIP 压缩包自动解压）

        Args:
            file_path: 文件路径

        Returns:
            数据框

        Raises:
            ValueError: 文件格式不支持或读取失败
        """
        path = Path(file_path)
        ext = path.suffix.lower()

        if ext == ".zip":
            # ZIP 压缩包：解压到同目录，递归查找数据文件
            import zipfile as _zipfile
            data_dir = path.parent
            try:
                with _zipfile.ZipFile(path, 'r') as zf:
                    zf.extractall(data_dir)
                print(f"[GeoDataService] ZIP已解压到: {data_dir}")
            except Exception as e:
                raise ValueError(f"ZIP文件解压失败：{str(e)}")

            # 递归查找 Excel/CSV/TXT 文件（排除临时文件）
            for f in sorted(data_dir.rglob('*'), key=lambda x: x.name):
                if f.is_file() and not f.name.startswith('~$'):
                    f_ext = f.suffix.lower()
                    if f_ext in ['.xlsx', '.xls', '.csv', '.txt', '.tab']:
                        print(f"[GeoDataService] ZIP中找到数据文件: {f.name}")
                        return self._read_file(str(f))
            raise ValueError("ZIP文件中未找到有效的数据文件（.xlsx/.xls/.csv/.txt/.tab）")

        if ext in [".xlsx", ".xls"]:
            # Excel 文件
            try:
                return pd.read_excel(path)
            except Exception as e:
                raise ValueError(f"Excel 文件读取失败：{str(e)}")
        elif ext == ".csv":
            # CSV 文件，尝试多种编码
            last_error = None
            for encoding in ["gbk", "utf-8", "utf-8-sig"]:
                try:
                    return pd.read_csv(path, encoding=encoding)
                except UnicodeDecodeError:
                    continue
                except Exception as e:
                    last_error = e
                    if "encoding" not in str(e).lower():
                        raise
            raise ValueError(
                f"❌ CSV 文件编码不支持\n\n"
                f"💡 支持的编码：UTF-8、GBK\n"
                f"💡 建议：用记事本打开文件，另存为 UTF-8 编码"
            )
        elif ext in [".txt", ".tab"]:
            # TXT/TAB 文件，尝试多种分隔符
            last_error = None
            for sep in [",", "\t", ";", " ", "|"]:
                try:
                    df = pd.read_csv(path, sep=sep, encoding="gbk")
                    if len(df.columns) > 1:
                        return df
                except Exception as e:
                    last_error = e
            raise ValueError(
                f"❌ TXT 文件格式无法识别\n\n"
                f"💡 支持的分隔符：逗号、制表符、分号、空格、竖线\n"
                f"💡 建议：确保文件使用统一的分隔符"
            )
        else:
            raise ValueError(
                f"❌ 不支持的文件格式（.{ext}）\n\n"
                f"💡 支持的格式：.xlsx、.xls、.csv、.txt、.tab、.zip"
            )

    def _extract_data(
        self, df: pd.DataFrame, fields: Dict[str, Any]
    ) -> Tuple[List[Dict[str, Any]], int]:
        """提取并转换坐标数据（numpy 向量化优化版）

        Returns:
            (有效数据行, 经纬度为 0 的有效行数)。坐标缺失的行直接丢弃；
            为 0 的行按历史约定保留并由调用方生成 coord_zero 提醒。
        """
        import numpy as np

        lon_col = fields["longitude"]
        lat_col = fields["latitude"]
        azi_col = fields.get("azimuth")
        beam_col = fields.get("beamwidth")
        cover_col = fields.get("cell_cover_type")
        name_col = fields.get("name")

        # 1. 向量化：提取经纬度并验证
        lons = pd.to_numeric(df[lon_col], errors="coerce").values.astype(float)
        lats = pd.to_numeric(df[lat_col], errors="coerce").values.astype(float)
        valid_mask = ~(np.isnan(lons) | np.isnan(lats) |
                       (lons < -180) | (lons > 180) |
                       (lats < -90) | (lats > 90))
        valid_indices = np.where(valid_mask)[0]

        if len(valid_indices) == 0:
            return [], 0
        # 与全量工参 coord_zero 口径一致：经度或纬度为 0 均视为缺失
        coord_zero_count = int(np.sum(((lons == 0) | (lats == 0)) & valid_mask))

        # 2. 向量化批量坐标转换（比逐行 math 快 10-50 倍）
        gcj_lats, gcj_lngs = CoordinateTransformer.wgs84_to_gcj02_batch(
            lats[valid_indices], lons[valid_indices]
        )

        # 3. 遍历有效行构建结果（properties 部分需要逐行处理）
        records = df.to_dict("records")
        result = []

        for pos_idx, df_idx in enumerate(valid_indices):
            lon = float(lons[df_idx])
            lat = float(lats[df_idx])
            rec = records[df_idx]

            point: Dict[str, Any] = {
                "longitude": lon,
                "latitude": lat,
                "displayLng": float(gcj_lngs[pos_idx]),
                "displayLat": float(gcj_lats[pos_idx]),
                "properties": {},
            }

            # 名称
            name_val = rec.get(name_col) if name_col else None
            if name_val is not None and not (isinstance(name_val, float) and math.isnan(name_val)):
                point["name"] = str(name_val).strip()
            else:
                point["name"] = "点_" + str(df_idx + 1)

            # 方位角
            if azi_col:
                azi_val = rec.get(azi_col)
                if azi_val is not None and not (isinstance(azi_val, float) and math.isnan(azi_val)):
                    try:
                        point["azimuth"] = float(azi_val) % 360
                    except (ValueError, TypeError):
                        pass

            # 波束宽度
            if beam_col:
                beam_val = rec.get(beam_col)
                if beam_val is not None and not (isinstance(beam_val, float) and math.isnan(beam_val)):
                    try:
                        point["beamwidth"] = max(5, min(120, float(beam_val)))
                    except (ValueError, TypeError):
                        point["beamwidth"] = 65

            # 覆盖类型
            if cover_col:
                cover_val = rec.get(cover_col)
                if cover_val is not None and not (isinstance(cover_val, float) and math.isnan(cover_val)):
                    try:
                        cover_str = str(cover_val).lower()
                        if "indoor" in cover_str or cover_str == "4":
                            point["cell_cover_type"] = 4
                        elif "outdoor" in cover_str or cover_str == "1":
                            point["cell_cover_type"] = 1
                        else:
                            point["cell_cover_type"] = int(float(cover_str))
                    except (ValueError, TypeError):
                        point["cell_cover_type"] = 1

            # 保存所有原始字段到 properties
            for k, v in rec.items():
                if isinstance(v, float) and math.isnan(v):
                    continue
                if k not in ("displayLng", "displayLat"):
                    point["properties"][k] = v

            result.append(point)

        return result, coord_zero_count

    def _parse_polygon(self, polygon_str: str) -> Tuple[bool, str, List[List[float]]]:
        """
        使用正则表达式解析POLYGON字符串为坐标点列表（已转换WGS84→GCJ02）
        格式：经度 纬度, 经度 纬度, ...
        例如：114.652216 23.645610, 114.652022 23.645609, 114.652000 23.645700

        Args:
            polygon_str: POLYGON格式字符串

        Returns:
            (是否成功, 错误信息, 坐标点列表 [[lat, lng], ...])  # 已转换GCJ02，[lat, lng]顺序
        """
        print(f"[_parse_polygon] 使用正则表达式解析 POLYGON: {polygon_str[:100]}...")

        if not polygon_str or not isinstance(polygon_str, str):
            print(f"[_parse_polygon] POLYGON为空或非字符串")
            return False, "POLYGON为空或非字符串", []

        polygon_str = polygon_str.strip()

        try:
            # 使用正则表达式匹配 "lng lat" 模式
            pattern = r"(\d+\.\d+)\s+(\d+\.\d+)"
            matches = re.findall(pattern, polygon_str)

            print(f"[_parse_polygon] 正则匹配到 {len(matches)} 个坐标对")

            if len(matches) < 3:
                print(
                    f"[_parse_polygon] POLYGON点数不足（需要至少3个点）: {len(matches)}"
                )
                return False, f"POLYGON点数不足（需要至少3个点）: {len(matches)}", []

            # 转换为 [[lat, lng], ...] 格式，并进行 WGS84→GCJ02 转换
            path: List[List[float]] = []
            for lng_str, lat_str in matches:
                lng = float(lng_str)
                lat = float(lat_str)
                # WGS84→GCJ02 转换
                gcj_lat, gcj_lng = CoordinateTransformer.wgs84_to_gcj02(lat, lng)
                path.append([gcj_lat, gcj_lng])  # Leaflet positions 需要 [lat, lng]
                print(
                    f"[_parse_polygon] 坐标转换: WGS84({lat}, {lng}) -> GCJ02({gcj_lat}, {gcj_lng})"
                )

            print(f"[_parse_polygon] POLYGON解析成功，返回 {len(path)} 个点")
            return True, "", path

        except Exception as e:
            import traceback

            traceback.print_exc()
            return False, f"POLYGON解析失败: {str(e)}", []

    def _extract_polygon_data(
        self, df: pd.DataFrame, fields: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        提取多边形数据（to_dict 优化版本）

        Returns:
            [{
                "name": "多边形名称",
                "path": [[lat, lng], ...],  # 已转换GCJ02，直接用于Leaflet
                "properties": {...}
            }]
        """
        print(f"[_extract_polygon_data] 开始提取，共 {len(df)} 行数据")
        polygon_col = fields.get("polygon")
        name_col = fields.get("name")
        print(f"[_extract_polygon_data] POLYGON列: {polygon_col}, 名称列: {name_col}")

        records = df.to_dict("records")
        result = []

        for idx, rec in enumerate(records):
            try:
                polygon_val = rec.get(polygon_col) if polygon_col else None
                if polygon_val is None or (isinstance(polygon_val, float) and math.isnan(polygon_val)):
                    print(f"[_extract_polygon_data] 第{idx + 1}行: POLYGON值为空，跳过")
                    continue

                print(f"[_extract_polygon_data] 第{idx + 1}行 POLYGON: {str(polygon_val)[:80]}...")

                success, error_msg, path = self._parse_polygon(str(polygon_val))
                if not success:
                    print(f"[_extract_polygon_data] 第{idx + 1}行POLYGON解析失败: {error_msg}")
                    continue

                print(f"[_extract_polygon_data] 第{idx + 1}行解析成功，坐标数: {len(path)}")

                # 名称
                name_val = rec.get(name_col) if name_col else None
                name = (
                    str(name_val)
                    if name_val is not None and not (isinstance(name_val, float) and math.isnan(name_val))
                    else f"多边形_{idx + 1}"
                )

                polygon: Dict[str, Any] = {
                    "name": name,
                    "path": path,
                    "properties": {},
                }

                # 所有原始字段到properties（dict O(1) 访问）
                exclude_keys = {"path", "coordinates", "displayLng", "displayLat"}
                if polygon_col:
                    exclude_keys.add(polygon_col)
                for k, v in rec.items():
                    if isinstance(v, float) and math.isnan(v):
                        continue
                    if k not in exclude_keys:
                        polygon["properties"][k] = v

                result.append(polygon)
                print(f"[_extract_polygon_data] 已添加第{idx + 1}个多边形，当前总数: {len(result)}")
            except Exception as e:
                print(f"[_extract_polygon_data] 第{idx + 1}行处理失败: {e}")
                continue

        print(f"[_extract_polygon_data] 完成，共提取 {len(result)} 个多边形")
        return result


def _save_geo_file_metadata(
    user_id: int,
    filename: str,
    file_path: str,
    geometry_type: str,
    field_mapping: dict,
    point_count: int,
    bbox: Optional[List[float]] = None,
    file_size: Optional[int] = None,
    geo_id: Optional[str] = None,
    city: Optional[str] = None,
    operator: Optional[str] = None,
    import_warnings: Optional[List[Dict[str, Any]]] = None,
):
    """保存地理化数据文件元数据到 SQLite

    import_warnings=None 表示尚未检查（存量/旧端解包），启动回填会补算；
    空列表表示已检查且无提醒。
    """
    db = SessionLocal()
    try:
        geo = GeoFile(
            id=geo_id or str(uuid.uuid4()),
            user_id=user_id,
            city=city,
            operator=operator,
            filename=filename,
            file_path=file_path,
            geometry_type=geometry_type,
            field_mapping=json.dumps(field_mapping, ensure_ascii=False) if field_mapping else None,
            point_count=point_count,
            bbox=json.dumps(bbox) if bbox else None,
            file_size=file_size,
            import_warnings=(
                json.dumps(import_warnings, ensure_ascii=False)
                if import_warnings is not None else None
            ),
            created_at=datetime.now().isoformat(),
        )
        db.add(geo)
        db.commit()
        print(f"[GeoDataService] 元数据已入库: id={geo.id}")
    except Exception as e:
        db.rollback()
        print(f"[GeoDataService] 元数据入库失败 (非致命): {e}")
    finally:
        db.close()


def _compute_bbox(data: List[Dict]) -> Optional[List[float]]:
    """计算数据边界框 [minLng, minLat, maxLng, maxLat]"""
    lats, lngs = [], []
    for item in data:
        lat = item.get("lat") or item.get("latitude")
        lng = item.get("lng") or item.get("longitude")
        if lat is not None and lng is not None:
            lats.append(float(lat))
            lngs.append(float(lng))
    if not lats:
        return None
    return [min(lngs), min(lats), max(lngs), max(lats)]
