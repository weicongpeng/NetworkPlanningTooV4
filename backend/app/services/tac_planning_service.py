"""
TAC规划服务
基于TAC图层（.TAB文件）对小区进行TAC分配
"""

import json
import logging
import math
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from datetime import datetime
from collections import OrderedDict
import pandas as pd
import numpy as np
from shapely.geometry import Point, Polygon, MultiPolygon
from shapely.wkt import loads as wkt_loads

# 尝试导入 STRtree，如果不可用则使用线性搜索
try:
    from shapely.strtree import STRtree
    STRTREE_AVAILABLE = True
except ImportError:
    STRTREE_AVAILABLE = False
    logger.warning("STRtree 不可用，将使用线性搜索（性能较慢）")

logger = logging.getLogger(__name__)


class LRUCache:
    """简单的LRU缓存实现，用于存储TAC区域"""

    def __init__(self, capacity: int = 100):
        self.capacity = capacity
        self.cache = OrderedDict()

    def get(self, key: str) -> Optional[Any]:
        if key in self.cache:
            # 移到末尾（最近使用）
            self.cache.move_to_end(key)
            return self.cache[key]
        return None

    def put(self, key: str, value: Any) -> None:
        if key in self.cache:
            # 更新并移到末尾
            self.cache.move_to_end(key)
        else:
            # 如果达到容量上限，删除最久未使用的项
            if len(self.cache) >= self.capacity:
                self.cache.popitem(last=False)
        self.cache[key] = value

    def clear(self) -> None:
        self.cache.clear()

    def __len__(self) -> int:
        return len(self.cache)

    def __contains__(self, key: str) -> bool:
        return key in self.cache

    def __getitem__(self, key: str) -> Any:
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        raise KeyError(key)

    def __setitem__(self, key: str, value: Any) -> None:
        self.put(key, value)

    def items(self):
        return self.cache.items()

    def values(self):
        return self.cache.values()

    def keys(self):
        return self.cache.keys()


class TACPlanningService:
    """TAC规划服务"""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        # 使用LRU缓存替代普通字典，默认最大缓存100个TAC区域
        self.tac_zones = LRUCache(capacity=100)
        self._seen_cells = {}  # 用于NR网络去重的字典
        # STRtree 空间索引缓存 {network_type: (tree, tac_id_map)}
        self._strtree_cache: Dict[str, tuple] = {}

    def load_tac_layers(self, network_type: str) -> Dict[str, Tuple[Polygon, str]]:
        """
        加载TAC图层文件

        Args:
            network_type: 'LTE' 或 'NR'

        Returns:
            {tac_id: (geometry, area_name)}
        """
        try:
            # 根据网络类型选择对应的TAC图层文件
            if network_type == "LTE":
                tac_filename = "4G_TAC.TAB"
                tac_id_field = "HYtac"
                area_name_field = "地区名称"
            else:  # NR
                tac_filename = "5G_TAC.TAB"
                tac_id_field = "河源5GTAC"
                area_name_field = None

            # 直接从 data_service 获取图层文件路径
            from app.services.data_service import data_service
            items = data_service.list_data()

            tac_file = None

            # 辅助函数：在目录中查找 TAB 文件（不区分大小写）
            def _find_tab_file(directory: Path) -> Optional[Path]:
                """在目录中查找第一个 .tab 文件（不区分大小写）"""
                for f in directory.rglob("*"):
                    if f.is_file() and f.suffix.lower() == ".tab":
                        return f
                return None

            def _find_named_tab_file(directory: Path, filename: str) -> Optional[Path]:
                """在目录中查找指定名称的 TAB 文件（不区分大小写）"""
                for f in directory.rglob("*"):
                    if f.is_file() and f.name.lower() == filename.lower():
                        return f
                return None

            for item in items:
                if item.type.value != "map":
                    continue

                data_dir = self.data_dir / item.id

                # 方法1: 检查图层元数据中的layer名称（更可靠）
                if hasattr(item, 'metadata') and item.metadata:
                    metadata_dict = item.metadata.model_dump() if hasattr(item.metadata, 'model_dump') else item.metadata
                    layers = metadata_dict.get('layers', [])
                    for layer in layers:
                        layer_name = layer.get('name', '')
                        # 检查layer名称是否匹配预期的TAC图层名称
                        # 4G: 匹配 "4G_TAC" 或包含 "4G" 和 "TAC"
                        # 5G: 匹配 "5G_TAC" 或 "河源5G-TAC" 等变体
                        if network_type == "LTE":
                            if "4G_TAC" in layer_name or ("4G" in layer_name and "TAC" in layer_name):
                                # 在数据目录中查找实际的.TAB文件（不区分大小写）
                                candidate = _find_tab_file(data_dir)
                                if candidate:
                                    tac_file = candidate
                                    break
                        else:  # NR / 5G
                            if "5G_TAC" in layer_name or ("5G" in layer_name and "TAC" in layer_name) or "河源5G" in layer_name:
                                candidate = _find_tab_file(data_dir)
                                if candidate:
                                    tac_file = candidate
                                    break
                    if tac_file:
                        break

                # 方法2: 文件名直接匹配（不区分大小写，保持向后兼容）
                if tac_file is None:
                    candidate = _find_named_tab_file(data_dir, tac_filename)
                    if candidate:
                        tac_file = candidate
                        break

                # 方法3: 对5G进行更宽松的匹配（处理河源5G-TAC等变体）
                if tac_file is None and network_type == "NR":
                    # 检查是否包含5G和TAC关键词（忽略下划线/连字符差异）
                    name_normalized = item.name.replace("-", "_").replace(" ", "")
                    if "5G" in name_normalized and "TAC" in name_normalized:
                        candidate = _find_tab_file(data_dir)
                        if candidate:
                            tac_file = candidate
                            break

            # 如果在 data_service 中没找到，保留原有深度搜索逻辑作为备份（不区分大小写）
            if tac_file is None:
                tac_file = _find_named_tab_file(self.data_dir, tac_filename)

            if tac_file is None or not tac_file.exists():
                raise ValueError(
                    f"加载TAC图层失败: 未找到TAC图层文件 {tac_filename}，请确保TAC图层在数据管理中导入"
                )

            logger.info(f"正在读取TAC图层文件: {tac_file}")

            # 使用geopandas读取TAB文件
            import geopandas as gpd

            # 尝试多种编码方式读取文件
            encodings_to_try = [None, "utf-8", "gbk", "latin1", "iso-8859-1", "gb18030"]
            gdf = None
            last_error = None

            for encoding in encodings_to_try:
                try:
                    logger.info(
                        f"尝试使用编码读取TAC文件: {encoding if encoding else '默认'}"
                    )
                    if encoding is None:
                        gdf = gpd.read_file(tac_file)
                    else:
                        gdf = gpd.read_file(tac_file, encoding=encoding)
                    logger.info(
                        f"成功使用编码 {encoding if encoding else '默认'} 读取TAC文件"
                    )
                    break
                except Exception as e:
                    last_error = e
                    logger.warning(
                        f"使用编码 {encoding if encoding else '默认'} 读取失败: {e}"
                    )
                    continue

            if gdf is None:
                raise ValueError(
                    f"无法读取TAC文件，尝试的编码: {encodings_to_try}，最后错误: {last_error}"
                )

            logger.info(f"TAC图层数据形状: {gdf.shape}")
            logger.info(f"TAC图层列名: {list(gdf.columns)}")
            logger.info(f"TAC图层坐标系: {gdf.crs}")
            if hasattr(gdf, 'geometry') and len(gdf) > 0:
                bounds = gdf.total_bounds
                logger.info(f"TAC图层坐标范围: x=[{bounds[0]:.4f}, {bounds[2]:.4f}], y=[{bounds[1]:.4f}, {bounds[3]:.4f}]")

            # 打印前3行数据以便调试
            logger.info(f"前3行TAC数据:")
            for i, row in enumerate(gdf.head(3).itertuples()):
                logger.info(f"  行{i + 1}: {dict(row._asdict())}")

            # 检查坐标系，确保是WGS84
            need_crs_conversion = False
            if hasattr(gdf, "crs") and gdf.crs is not None:
                if str(gdf.crs) != "EPSG:4326":
                    need_crs_conversion = True
            else:
                # CRS 未识别：检查几何坐标范围，如果明显不是经纬度则尝试转换
                if len(gdf) > 0 and hasattr(gdf, 'total_bounds'):
                    bounds = gdf.total_bounds
                    # 判断是否为投影坐标（x>360 或 y>90）
                    if bounds[2] > 360 or bounds[3] > 90 or bounds[0] < -180:
                        logger.warning("TAC图层坐标系未识别，但坐标范围显示为投影坐标，尝试转换为WGS84")
                        # 常见中国地图投影：尝试先设为EPSG:3857再转换
                        try:
                            gdf = gdf.set_crs(epsg=3857, allow_override=True)
                            need_crs_conversion = True
                        except Exception as crs_err:
                            logger.warning(f"设置EPSG:3857失败: {crs_err}")

            if need_crs_conversion:
                try:
                    logger.info("将TAC图层转换为WGS84坐标系 (EPSG:4326)")
                    gdf = gdf.to_crs(epsg=4326)
                except Exception as crs_err:
                    logger.error(f"CRS转换失败: {crs_err}")
                    raise ValueError(f"TAC图层坐标转换失败: {crs_err}")

            # 如果TAC ID字段名不匹配，尝试从列名中模糊匹配
            if tac_id_field not in gdf.columns:
                logger.warning(f"TAC ID字段 '{tac_id_field}' 不在TAC图层的列中，尝试模糊匹配...")
                # 尝试不区分大小写匹配
                for col in gdf.columns:
                    if col.lower() == tac_id_field.lower():
                        logger.info(f"通过不区分大小写匹配到字段: '{col}' -> '{tac_id_field}'")
                        tac_id_field = col
                        break
                else:
                    # 尝试部分匹配（包含HYtac关键词）
                    for col in gdf.columns:
                        if "tac" in col.lower():
                            logger.info(f"通过部分匹配到TAC字段: '{col}'")
                            tac_id_field = col
                            break

            tac_zones = {}

            # 使用itertuples()代替iterrows()以提高性能
            for row in gdf.itertuples():
                # 获取TAC ID并标准化（去除空格、前导零、转换为字符串）
                tac_id = ""
                if hasattr(row, tac_id_field):
                    tac_raw = getattr(row, tac_id_field)
                    # 转换为字符串并标准化
                    if pd.notna(tac_raw):
                        tac_id = str(tac_raw).strip()
                        # 去除前导零（但保留单个0）
                        tac_id = tac_id.lstrip("0") or "0"

                if not tac_id or tac_id == "nan" or tac_id == "None":
                    continue

                geometry = row.geometry

                # 过滤掉空几何对象
                if pd.isna(geometry) or geometry.is_empty:
                    continue

                # 只保留Polygon类型，过滤LineString等
                if not isinstance(geometry, (Polygon, MultiPolygon)):
                    logger.debug(
                        f"跳过非Polygon几何对象: {geometry.geom_type}, TAC: {tac_id}"
                    )
                    continue

                # 获取区域名称
                area_name = ""
                if area_name_field and hasattr(row, area_name_field):
                    area_name = str(getattr(row, area_name_field))
                    if area_name == "nan":
                        area_name = ""

                # 标准化几何对象
                if isinstance(geometry, MultiPolygon):
                    # 对于MultiPolygon，取最大的多边形
                    max_area = 0
                    main_polygon = None
                    for poly in geometry.geoms:
                        area = poly.area
                        if area > max_area:
                            max_area = area
                            main_polygon = poly
                    if main_polygon:
                        geometry = main_polygon

                # 保存TAC区域
                if tac_id not in tac_zones:
                    tac_zones[tac_id] = (geometry, area_name)
                    logger.debug(
                        f"加载TAC区域: {tac_id} - {area_name}, 边界: {geometry.bounds}"
                    )
                else:
                    logger.warning(f"TAC ID {tac_id} 已存在，跳过重复项")

            if not tac_zones:
                raise ValueError("未能从TAC图层文件中加载任何TAC区域数据")

            logger.info(f"成功加载 {len(tac_zones)} 个{network_type} TAC区域")

            # 构建 STRtree 空间索引（如果可用）
            if STRTREE_AVAILABLE:
                self._build_strtree_index(network_type, tac_zones)

            return tac_zones

        except Exception as e:
            logger.error(f"加载TAC图层失败: {e}")
            import traceback

            traceback.print_exc()
            raise ValueError(f"加载TAC图层失败: {str(e)}")

    def load_cells(self, network_type: str) -> List[Dict]:
        """
        加载待规划的小区数据
        直接从全量工参文件中获取对应网络类型的所有小区

        Args:
            network_type: 'LTE' 或 'NR'

        Returns:
            小区列表（包含经纬度）
        """
        try:
            cells = []
            # 清空去重字典（针对所有网络类型）
            self._seen_cells = {}
            logger.info(f"从全量工参文件加载待规划{network_type}小区...")

            # 读取索引文件，找到最新的全量工参文件
            # 索引文件在 data/index.json，而不是 uploads/index.json
            index_path = self.data_dir / "index.json"
            if not index_path.exists():
                logger.warning(f"未找到索引文件: {index_path}")
                return cells

            with open(index_path, "r", encoding="utf-8") as f:
                index = json.load(f)

            # 收集所有全量工参文件并按上传时间降序排序（最新的在前）
            full_params_files = []
            for data_id, data_info in index.items():
                file_type = data_info.get("type", "")
                file_name = data_info.get("name", "")
                upload_date = data_info.get("uploadDate", "")

                # 只处理excel类型且文件名包含projectparameter的全量工参文件
                if file_type == "excel" and "projectparameter" in file_name.lower():
                    full_params_files.append({
                        "data_id": data_id,
                        "name": file_name,
                        "upload_date": upload_date
                    })

            # 按上传时间降序排序
            full_params_files.sort(key=lambda x: x["upload_date"], reverse=True)

            if not full_params_files:
                logger.warning(f"未找到全量工参文件（包含projectparameter）")
                return cells

            # 只读取最新的全量工参文件
            latest_file = full_params_files[0]
            data_id = latest_file["data_id"]
            file_name = latest_file["name"]

            logger.info(f"正在读取最新全量工参文件: {file_name} (上传时间: {latest_file['upload_date']})")

            data_json_path = self.data_dir / data_id / "data.json"
            if not data_json_path.exists():
                logger.warning(f"数据文件不存在: {data_json_path}")
                return cells

            # 读取数据
            with open(data_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # 提取指定网络类型的小区
            network_data = data.get(network_type, [])
            logger.info(f"从该文件中找到 {len(network_data)} 个{network_type}基站")

            for site in network_data:
                site_id = site.get("id", "")
                site_name = site.get("name", "")

                for sector in site.get("sectors", []):
                    sector_id = sector.get("id", "")
                    sector_name = sector.get("name", "")

                    if not site_id or not sector_id:
                        continue

                    # 获取经纬度
                    longitude = sector.get("longitude", 0)
                    latitude = sector.get("latitude", 0)

                    # 只保留有经纬度的小区
                    if not longitude or not latitude:
                        logger.debug(
                            f"跳过无经纬度的小区: site={site_id}, sector={sector_id}"
                        )
                        continue

                    # 对所有网络类型使用"站点ID&小区ID"进行去重
                    # 构建唯一键
                    unique_key = f"{site_id}&{sector_id}"
                    # 使用字典去重
                    if unique_key not in self._seen_cells:
                        self._seen_cells[unique_key] = True
                    else:
                        logger.debug(f"{network_type}网络：跳过重复小区: {unique_key}")
                        continue

                    # 获取现网TAC并标准化（去除前导零）
                    existing_tac_raw = sector.get("tac", None)
                    existing_tac = None
                    if existing_tac_raw is not None and pd.notna(existing_tac_raw):
                        existing_tac = str(existing_tac_raw).strip()
                        # 去除前导零（但保留单个0）
                        existing_tac = existing_tac.lstrip("0") or "0"

                    cell = {
                        "sectorId": sector_id,
                        "sectorName": sector_name,
                        "siteId": site_id,
                        "siteName": site_name,
                        "networkType": network_type,
                        "longitude": longitude,
                        "latitude": latitude,
                        "existingTac": existing_tac,
                        "firstGroup": sector.get("first_group", None),
                        "azimuth": sector.get("azimuth", 0),  # 方向角（用于TAC插花检测）
                    }
                    cells.append(cell)

            if not cells:
                raise ValueError(
                    f"未找到{network_type}小区数据，请确保已导入包含经纬度的全量工参文件"
                )

            logger.info(
                f"成功加载 {len(cells)} 个待规划{network_type}小区（包含经纬度）"
            )
            return cells

        except Exception as e:
            logger.error(f"加载小区数据失败: {e}")
            import traceback

            traceback.print_exc()
            raise ValueError(f"加载小区数据失败: {str(e)}")

    def _build_strtree_index(
        self, network_type: str, tac_zones: Dict[str, Tuple[Polygon, str]]
    ) -> None:
        """
        构建 STRtree 空间索引

        Args:
            network_type: 网络类型 ('LTE' 或 'NR')
            tac_zones: TAC区域字典 {tac_id: (geometry, area_name)}
        """
        try:
            geometries = []
            tac_id_map = []  # 将几何对象索引映射到 TAC ID

            for tac_id, (geometry, area_name) in tac_zones.items():
                geometries.append(geometry)
                tac_id_map.append(tac_id)

            # 创建 STRtree
            tree = STRtree(geometries)
            self._strtree_cache[network_type] = (tree, tac_id_map, tac_zones)

            logger.info(
                f"成功构建 {network_type} TAC 空间索引，包含 {len(geometries)} 个多边形"
            )

        except Exception as e:
            logger.warning(f"构建 STRtree 索引失败: {e}，将使用线性搜索")
            self._strtree_cache.pop(network_type, None)

    def match_cell_to_tac(
        self, cell: Dict, tac_zones: Dict[str, Tuple[Polygon, str]], network_type: Optional[str] = None
    ) -> Optional[str]:
        """
        将小区匹配到TAC区域

        使用 STRtree 空间索引优化查询性能（如果可用且提供了 network_type）。

        Args:
            cell: 小区数据
            tac_zones: TAC区域字典 {tac_id: (geometry, area_name)}
            network_type: 网络类型 ('LTE' 或 'NR')，可选。提供时使用STRtree索引。

        Returns:
            TAC ID，如果不匹配则返回None
        """
        try:
            point = Point(cell["longitude"], cell["latitude"])

            # 如果提供了 network_type 且有 STRtree 索引，使用索引查询
            if network_type and STRTREE_AVAILABLE and network_type in self._strtree_cache:
                return self._match_with_strtree(cell, point, network_type)

            # 否则使用线性搜索（向后兼容）
            return self._match_linear(cell, point, tac_zones)

        except Exception as e:
            logger.error(f"匹配小区 {cell.get('sectorId')} 到TAC失败: {e}")
            return None

    def _match_with_strtree(self, cell: Dict, point: Point, network_type: str) -> Optional[str]:
        """使用 STRtree 索引进行匹配"""
        try:
            tree, tac_id_map, tac_zones = self._strtree_cache[network_type]

            # 使用 STRtree 查询候选多边形
            # query 返回的是 numpy 数组，包含与查询几何相交的几何对象的索引
            candidate_indices = tree.query(point)

            # 处理返回的索引数组
            for idx in candidate_indices:
                # 将索引转换为整数（numpy.int64 -> int）
                idx = int(idx)

                # 使用索引获取 TAC ID 和几何对象
                if 0 <= idx < len(tac_id_map):
                    tac_id = tac_id_map[idx]
                    geometry, area_name = tac_zones[tac_id]

                    # 精确检查：点是否在多边形内或接触边界
                    if geometry.contains(point) or geometry.touches(point):
                        logger.debug(
                            f"小区 {cell['sectorId']} 匹配到TAC: {tac_id} ({area_name}) [STRtree]"
                        )
                        return tac_id

            return None

        except Exception as e:
            logger.warning(f"STRtree 匹配失败，回退到线性搜索: {e}")
            return None

    def _match_linear(self, cell: Dict, point: Point, tac_zones: Dict[str, Tuple[Polygon, str]]) -> Optional[str]:
        """使用线性搜索进行匹配（原始方法）"""
        for tac_id, (geometry, area_name) in tac_zones.items():
            if geometry.contains(point) or geometry.touches(point):
                logger.debug(
                    f"小区 {cell['sectorId']} 匹配到TAC: {tac_id} ({area_name}) [线性]"
                )
                return tac_id
        return None

    def plan_tac(
        self,
        network_type: str,
        enable_singularity_check: bool = True,
        singularity_config: Optional[Dict[str, Any]] = None,
        progress_callback=None,
    ) -> Tuple[List[Dict], int, int, int, int]:
        """
        执行TAC核查（含TAC插花检测）

        Args:
            network_type: 网络类型 'LTE' 或 'NR'
            enable_singularity_check: 是否启用TAC插花检测，默认True
            singularity_config: 插花检测配置，包含：
                - search_radius: 搜索半径（米），默认1500
                - singularity_threshold: 异TAC占比阈值，默认0.7
            progress_callback: 进度回调函数

        Returns:
            (results, matched_count, unmatched_count, mismatched_count, singularity_count)
        """
        try:
            # 清空去重字典，防止内存无限增长
            self._seen_cells.clear()

            # 1. 加载TAC图层
            if progress_callback:
                progress_callback(10, "加载TAC图层...")

            tac_zones = self.load_tac_layers(network_type)
            self.tac_zones = tac_zones

            # 调试：打印TAC区域边界
            if tac_zones:
                for tac_id, (geometry, area_name) in list(tac_zones.items())[
                    :3
                ]:  # 只打印前3个
                    bounds = geometry.bounds
                    logger.info(f"TAC区域 {tac_id} ({area_name}) 边界: {bounds}")
                logger.info(f"总共加载了 {len(tac_zones)} 个TAC区域")

            # 2. 加载小区数据
            if progress_callback:
                progress_callback(30, f"加载{network_type}小区数据...")

            cells = self.load_cells(network_type)
            total_cells = len(cells)

            # 调试：打印小区经纬度范围
            if cells:
                longitudes = [c["longitude"] for c in cells]
                latitudes = [c["latitude"] for c in cells]
                logger.info(
                    f"小区经度范围: {min(longitudes):.6f} ~ {max(longitudes):.6f}"
                )
                logger.info(
                    f"小区纬度范围: {min(latitudes):.6f} ~ {max(latitudes):.6f}"
                )
                # 打印前5个小区的经纬度
                for i, cell in enumerate(cells[:5]):
                    logger.info(
                        f"示例小区 {i + 1}: 经度={cell['longitude']:.6f}, 纬度={cell['latitude']:.6f}"
                    )

            # 3. 匹配小区到TAC
            results = []
            matched_count = 0
            unmatched_count = 0
            mismatched_count = 0

            for i, cell in enumerate(cells):
                tac_id = self.match_cell_to_tac(cell, tac_zones)

                # 获取TAC区域名称
                area_name = None
                if tac_id and tac_id in tac_zones:
                    _, area_name = tac_zones[tac_id]

                # 获取现网TAC
                existing_tac = cell.get("existingTac", None)

                # 判断TAC是否一致（去除空格、前导零等问题）
                is_consistent = False
                if tac_id is not None and existing_tac is not None:
                    # 转换为字符串并标准化：去除空格、前导零
                    tac_str = str(tac_id).strip()
                    existing_str = str(existing_tac).strip()
                    # 去除前导零（但保留单个0）
                    tac_str = tac_str.lstrip("0") or "0"
                    existing_str = existing_str.lstrip("0") or "0"
                    is_consistent = tac_str == existing_str

                result = {
                    "sectorId": cell["sectorId"],
                    "sectorName": cell["sectorName"],
                    "siteId": cell["siteId"],
                    "siteName": cell["siteName"],
                    "networkType": network_type,
                    "longitude": cell["longitude"],
                    "latitude": cell["latitude"],
                    "tac": tac_id,
                    "tacAreaName": area_name,
                    "existingTac": existing_tac,
                    "matched": tac_id is not None,
                    "firstGroup": cell.get("firstGroup", None),
                    "suggestedTac": None,  # 默认为空，后续在插花检测中会填充
                }

                results.append(result)

                if tac_id:
                    matched_count += 1
                    # 如果匹配到TAC但与现网TAC不一致，计入错配
                    if existing_tac is not None and not is_consistent:
                        mismatched_count += 1
                else:
                    unmatched_count += 1

                # 调试：每1000个小区打印一次匹配结果
                if (i + 1) % 1000 == 0:
                    logger.info(
                        f"已处理 {i + 1}/{total_cells} 个小区，匹配 {matched_count} 个"
                    )

                # 更新进度
                if progress_callback and (i + 1) % 10 == 0:
                    progress_percent = 30 + (i + 1) / total_cells * 60
                    progress_callback(
                        progress_percent, f"匹配小区 {i + 1}/{total_cells}..."
                    )

            # 完成进度
            if progress_callback:
                progress_callback(100, "TAC核查完成")

            logger.info(
                f"TAC核查完成: 总计{total_cells}个小区, 匹配{matched_count}个, 未匹配{unmatched_count}个, 错配{mismatched_count}个"
            )

            # 调试：打印最终统计
            logger.info(
                f"TAC核查最终统计: total={len(results)}, matched={matched_count}, unmatched={unmatched_count}, mismatched={mismatched_count}"
            )

            # TAC插花检测（只对TAC不一致的小区进行检测）
            singularity_count = 0
            if enable_singularity_check and results:
                if progress_callback:
                    progress_callback(95, "检测TAC插花情况...")

                # 标准化配置键名（兼容前端驼峰命名和后端下划线命名）
                def normalize_config(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
                    """将驼峰命名转换为下划线命名"""
                    if not config:
                        return {}
                    normalized = {}
                    for key, value in config.items():
                        # 处理驼峰命名转下划线命名
                        if key == "searchRadius":
                            normalized["search_radius"] = value
                        elif key == "singularityThreshold":
                            normalized["singularity_threshold"] = value
                        else:
                            normalized[key] = value
                    return normalized

                normalized_config = normalize_config(singularity_config)
                config = normalized_config if normalized_config else {
                    "search_radius": 1500,
                    "singularity_threshold": 0.5,
                }

                logger.info(f"[TAC插花检测配置] search_radius={config.get('search_radius')}, "
                           f"singularity_threshold={config.get('singularity_threshold')}")

                # 1. 筛选出TAC不一致且现网TAC有效的小区（只对这些小区进行插花检测）
                # 需要重新计算is_consistent来找出mismatched cells
                mismatched_cells = []
                mismatched_cell_indices = []  # 记录原始cells中的索引，用于后续标记

                def _normalize_tac_for_check(tac_value: Any) -> Optional[str]:
                    """标准化TAC值为字符串（去除前导零），空值返回None"""
                    if tac_value is None:
                        return None
                    tac_str = str(tac_value).strip()
                    if not tac_str or tac_str.lower() in ('', 'nan', 'none'):
                        return None
                    return tac_str.lstrip("0") or "0"

                for i, (cell, result) in enumerate(zip(cells, results)):
                    tac_id = result.get("tac")
                    existing_tac = cell.get("existingTac")
                    sector_name = cell.get("sectorName", "Unknown")

                    # 判断TAC是否一致
                    is_consistent = False
                    tac_str = ""
                    existing_str = ""
                    if tac_id is not None:
                        tac_str = _normalize_tac_for_check(tac_id) or ""
                    if existing_tac is not None:
                        existing_str = _normalize_tac_for_check(existing_tac) or ""
                    is_consistent = tac_str != "" and existing_str != "" and tac_str == existing_str

                    # 只对TAC不一致且现网TAC有效的小区进行插花检测
                    # 【关键修复】现网TAC为空时，不进行插花检测
                    if tac_id is not None and existing_str != "" and not is_consistent:
                        mismatched_cells.append(cell)
                        mismatched_cell_indices.append(i)
                        logger.debug(
                            f"[TAC不一致筛选] 小区={sector_name}, "
                            f"图层TAC={tac_id}({tac_str}), 现网TAC={existing_tac}({existing_str})"
                        )

                logger.info(f"TAC插花检测: 筛选出 {len(mismatched_cells)} 个TAC不一致且现网TAC有效的小区进行检测（总共{len(cells)}个小区）")

                # 2. 对TAC不一致的小区进行插花检测
                # 关键修复：neighbor_pool使用全量小区（cells），确保TAC一致的正常小区也参与周边TAC分布统计
                singularity_cells = self.check_tac_singularity(
                    cells=mismatched_cells,
                    neighbor_pool=cells,
                    search_radius=config.get("search_radius", 1500),
                    singularity_threshold=config.get("singularity_threshold", 0.7),
                    progress_callback=progress_callback,
                )

                # 3. 创建插花小区的ID集合，用于快速查找
                singularity_ids = set(cell["sectorId"] for cell in singularity_cells)

                # 【关键修复】创建插花位置的坐标集合（用于同位置小区同步标记）
                # 同位置（相同经纬度）的任一小区被标记为插花时，该位置所有小区都应该被标记
                singularity_locations = set()
                for cell in singularity_cells:
                    loc_key = (cell.get("longitude"), cell.get("latitude"))
                    if loc_key[0] is not None and loc_key[1] is not None:
                        singularity_locations.add(loc_key)

                logger.info(f"[TAC插花标记] 发现 {len(singularity_ids)} 个插花小区，涉及 {len(singularity_locations)} 个不同位置")

                # 4. 在结果中标记插花小区
                marked_singularity_count = 0
                for i, (cell, result) in enumerate(zip(cells, results)):
                    tac_id = result.get("tac")
                    existing_tac = cell.get("existingTac")

                    # 判断TAC是否一致
                    is_consistent = False
                    def _normalize_tac_for_mark(tac_value: Any) -> Optional[str]:
                        """标准化TAC值为字符串（去除前导零），空值返回None"""
                        if tac_value is None:
                            return None
                        tac_str = str(tac_value).strip()
                        if not tac_str or tac_str.lower() in ('', 'nan', 'none'):
                            return None
                        return tac_str.lstrip("0") or "0"

                    tac_str = _normalize_tac_for_mark(tac_id)
                    existing_str = _normalize_tac_for_mark(existing_tac)
                    is_consistent = tac_str is not None and existing_str is not None and tac_str == existing_str

                    # 检查是否为插花小区
                    # 【关键修复】只有TAC不一致且现网TAC有效的小区才会被标记为插花
                    # 现网TAC为空的小区永远不应该被标记为插花
                    # 【关键修复】同位置（相同经纬度）的任一小区被标记为插花时，该位置所有小区都应该被标记
                    cell_location = (cell.get("longitude"), cell.get("latitude"))
                    is_at_singularity_location = cell_location in singularity_locations

                    is_singularity = (
                        existing_str is not None  # 现网TAC必须有效（非空）
                        and tac_str is not None
                        and not is_consistent
                        and (result["sectorId"] in singularity_ids or is_at_singularity_location)
                    )

                    # 调试日志：记录同位置小区的插花标记情况
                    if is_at_singularity_location and not (result["sectorId"] in singularity_ids):
                        logger.info(
                            f"[TAC插花标记-同位置同步] 小区={cell.get('sectorName')}, "
                            f"sectorId={result['sectorId']}, 位置={cell_location}, "
                            f"同位置其他小区被标记为插花，本小区同步标记"
                        )

                    # 标记插花状态和建议值
                    result["isSingularity"] = is_singularity

                    if is_singularity:
                        # 获取插花详情
                        singularity_info = next(
                            (s for s in singularity_cells if s["sectorId"] == result["sectorId"]),
                            None,
                        )
                        if singularity_info:
                            result["singularityDetails"] = singularity_info
                        # 对于插花小区，建议值取图层TAC值
                        result["suggestedTac"] = tac_id
                        marked_singularity_count += 1
                    elif existing_str is not None and tac_str is not None and not is_consistent:
                        # TAC不一致但不是插花，建议值取图层TAC
                        result["suggestedTac"] = tac_id
                    else:
                        # TAC一致或现网TAC为空，建议值为空
                        result["suggestedTac"] = None

                singularity_count = marked_singularity_count
                logger.info(f"TAC插花检测完成: 发现 {singularity_count} 个插花小区（从{len(mismatched_cells)}个TAC不一致小区中检测出{len(singularity_cells)}个插花候选）")

            return results, matched_count, unmatched_count, mismatched_count, singularity_count

        except Exception as e:
            logger.error(f"TAC规划失败: {e}")
            raise
        finally:
            # 确保清理去重字典，防止内存泄漏
            self._seen_cells.clear()

    def plan_tac_for_list(
        self, network_type: str, cells_to_plan: List[Dict], progress_callback=None
    ) -> Tuple[List[Dict], int, int]:
        """
        执行TAC规划（对待规划小区清单进行规划）

        根据待规划小区清单的经纬度匹配TAC图层，分配TAC编号

        Args:
            network_type: 网络类型 'LTE' 或 'NR'
            progress_callback: 进度回调函数

        Returns:
            (results, planned_count, unplanned_count)
        """
        try:
            # 1. 加载TAC图层
            if progress_callback:
                progress_callback(10, "加载TAC图层...")

            tac_zones = self.load_tac_layers(network_type)
            self.tac_zones = tac_zones

            logger.info(f"成功加载 {len(tac_zones)} 个{network_type} TAC区域")

            # 2. 加载待规划小区清单
            if progress_callback:
                progress_callback(30, f"加载{network_type}待规划小区清单...")

            cells = self.load_planning_cells(cells_to_plan)
            total_cells = len(cells)

            if not cells:
                raise ValueError(
                    f"未找到{network_type}待规划小区或有效坐标"
                )

            logger.info(f"成功加载 {total_cells} 个{network_type}待规划小区")

            # 3. 匹配小区到TAC
            results = []
            planned_count = 0
            unplanned_count = 0

            for i, cell in enumerate(cells):
                tac_id = self.match_cell_to_tac(cell, tac_zones)

                # 获取TAC区域名称
                area_name = None
                if tac_id and tac_id in tac_zones:
                    _, area_name = tac_zones[tac_id]

                result = {
                    "siteId": cell.get("siteId", ""),
                    "siteName": cell.get("siteName", ""),
                    "sectorId": cell.get("sectorId", ""),
                    "sectorName": cell.get("sectorName", ""),
                    "networkType": network_type,
                    "longitude": cell.get("longitude", 0),
                    "latitude": cell.get("latitude", 0),
                    "tac": tac_id,  # TAC分配值
                    "tacAreaName": area_name,
                    "existingTac": cell.get("existingTac"),
                    "firstGroup": cell.get("firstGroup") or cell.get("first_group"),
                    "matched": tac_id is not None,
                }

                results.append(result)

                if tac_id:
                    planned_count += 1
                else:
                    unplanned_count += 1

                # 更新进度
                if progress_callback and (i + 1) % 10 == 0:
                    progress_percent = 30 + (i + 1) / total_cells * 60
                    progress_callback(
                        progress_percent, f"规划小区 {i + 1}/{total_cells}..."
                    )

            # 完成进度
            if progress_callback:
                progress_callback(100, "TAC规划完成")

            logger.info(
                f"TAC规划完成: 总计{total_cells}个小区, 已规划{planned_count}个, 未规划{unplanned_count}个"
            )

            return results, planned_count, unplanned_count

        except Exception as e:
            logger.error(f"TAC规划失败: {e}")
            import traceback

            traceback.print_exc()
            raise

    def load_planning_cells(self, cells_data: List[Dict]) -> List[Dict]:
        """
        加载待规划小区清单（直接接收并解析数据结构）
        """
        try:
            cells = []
            # 添加去重字典，确保小区唯一性
            seen_cells = {}
            logger.info("准备待规划小区列表...")

            for site in cells_data:
                site_id = site.get("id") or site.get("siteId", "")
                site_name = site.get("name") or site.get("siteName", "")
                # 基站级别坐标作为备选
                site_lon = site.get("longitude")
                site_lat = site.get("latitude")

                for sector in site.get("sectors", []):
                    sector_id = sector.get("id") or sector.get("sectorId", "")
                    sector_name = sector.get("name") or sector.get("sectorName", "")

                    # 优先获取小区级别坐标，否则使用基站级别
                    lon = sector.get("longitude") or site_lon
                    lat = sector.get("latitude") or site_lat

                    if not lon or not lat:
                        continue

                    # 构建唯一键进行去重（站点ID & 小区ID）
                    unique_key = f"{site_id}&{sector_id}"
                    if unique_key in seen_cells:
                        logger.debug(f"跳过重复小区: {unique_key}")
                        continue

                    seen_cells[unique_key] = True

                    cell = {
                        **sector,
                        "siteId": str(site_id),
                        "siteName": str(site_name),
                        "sectorId": str(sector_id),
                        "sectorName": str(sector_name),
                        "longitude": float(lon),
                        "latitude": float(lat),
                        # 兼容：如果 sector 中有 tac，将其作为 existing_tac (现网TAC)
                        "existingTac": sector.get("existingTac") or sector.get("tac"),
                    }
                    cells.append(cell)

            logger.info(f"成功加载 {len(cells)} 个待规划小区（去重后，唯一键数: {len(seen_cells)}）")
            return cells

        except Exception as e:
            logger.error(f"解析待规划小区清单失败: {e}")
            raise ValueError(f"解析待规划小区清单失败: {str(e)}")

    def _calculate_distance(
        self, cell1: Dict, cell2: Dict
    ) -> float:
        """
        计算两个小区之间的距离（Haversine公式，单位：米）

        Args:
            cell1: 小区1数据
            cell2: 小区2数据

        Returns:
            距离（米）
        """
        lon1, lat1 = math.radians(cell1["longitude"]), math.radians(cell1["latitude"])
        lon2, lat2 = math.radians(cell2["longitude"]), math.radians(cell2["latitude"])

        dlat = lat2 - lat1
        dlon = lon2 - lon1

        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        )
        c = 2 * math.asin(math.sqrt(a))

        return 6371000 * c  # 地球半径约6371km

    def check_tac_singularity(
        self,
        cells: List[Dict],
        neighbor_pool: Optional[List[Dict]] = None,
        search_radius: float = 1500,
        singularity_threshold: float = 0.7,
        progress_callback=None,
    ) -> List[Dict[str, Any]]:
        """
        检测TAC插花情况

        使用BallTree空间索引查找邻区，基于空间距离检索，
        通过TAC多数投票机制判断插花小区。

        Args:
            cells: 需要被检测的目标小区列表（通常为TAC不一致的小区）
            neighbor_pool: 邻区搜索池（所有小区），用于构建空间索引和统计周边TAC分布。
                           若为None则默认使用cells本身（兼容旧行为）。
                           【关键】应传入全量小区列表，确保TAC一致的正常小区也参与邻区投票。
            search_radius: 搜索半径（米），默认1500米
            singularity_threshold: 异TAC占比阈值，默认70%
            progress_callback: 进度回调函数

        Returns:
            插花小区列表，每个元素包含：
            - sectorId: 小区ID
            - sectorName: 小区名称
            - siteId: 站点ID
            - siteName: 站点名称
            - cellTAC: 小区TAC
            - dominantTac: 周边主流TAC
            - validNeighborCount: 有效邻区数量
            - 异TAC占比: 异TAC占比百分比
        """
        if not cells:
            return []

        try:
            from sklearn.neighbors import BallTree
        except ImportError:
            logger.error("未安装sklearn库，请运行: pip install scikit-learn")
            return []

        # 确定邻区搜索池：优先使用传入的neighbor_pool，否则退化为cells自身
        pool = neighbor_pool if neighbor_pool is not None else cells

        logger.info(
            f"开始TAC插花检测: 搜索半径={search_radius}m, "
            f"阈值={singularity_threshold}, "
            f"目标小区数={len(cells)}, 邻区搜索池={len(pool)}（全量小区）"
        )

        # 验证数据结构：检查第一个cell的字段
        if cells:
            sample_cell = cells[0]
            logger.info(
                f"[数据结构验证] 样本小区字段: sectorName={sample_cell.get('sectorName')}, "
                f"existingTac={sample_cell.get('existingTac')}, tac={sample_cell.get('tac')}, "
                f"经纬度=({sample_cell.get('latitude')}, {sample_cell.get('longitude')})"
            )

        singularity_results = []
        total_cells = len(cells)

        # 准备邻区搜索池的坐标数据（BallTree需要弧度制）
        # 使用pool（全量小区）构建空间索引，确保能搜索到所有邻区
        pool_coords_rad = np.array([
            [math.radians(cell["latitude"]), math.radians(cell["longitude"])]
            for cell in pool
        ])

        # 构建BallTree空间索引（Haversine距离），基于全量小区
        ball_tree = BallTree(pool_coords_rad, metric="haversine")

        # 为目标小区建立sectorId -> pool索引的映射，用于排除目标小区自身
        target_sector_ids = set(cell["sectorId"] for cell in cells)

        for i, target_cell in enumerate(cells):
            # 更新进度
            if progress_callback and (i + 1) % 100 == 0:
                progress_percent = (i + 1) / total_cells * 100
                progress_callback(progress_percent, f"检测TAC插花 {i + 1}/{total_cells}...")

            # 记录目标小区信息
            target_sector_name = target_cell.get("sectorName", "Unknown")
            target_existing_tac = target_cell.get("existingTac")
            target_layer_tac = target_cell.get("tac")  # 图层TAC（如果有）
            target_sector_id = target_cell["sectorId"]
            target_site_id = target_cell.get("siteId", "")

            target_coord = np.array([[
                math.radians(target_cell["latitude"]),
                math.radians(target_cell["longitude"])
            ]])

            # 增强日志：记录目标小区基本信息
            logger.info(
                f"[TAC插花检测] 开始检测小区 {i+1}/{total_cells}: "
                f"sectorId={target_sector_id}, sectorName={target_sector_name}, "
                f"siteId={target_site_id}, 经纬度=({target_cell['latitude']:.6f}, {target_cell['longitude']:.6f}), "
                f"现网TAC={target_existing_tac}, 图层TAC={target_layer_tac}"
            )

            # 查找半径范围内的邻区（在全量小区pool中搜索）
            # query_radius返回形状为(n_samples, [array_of_indices])，取[0]获得第一个查询点的邻居索引数组
            neighbor_indices = ball_tree.query_radius(
                target_coord,
                r=search_radius / 6371000  # 转换为弧度
            )[0]

            # 筛选有效邻区（仅基于空间距离，移除方向角过滤）
            # 从pool（全量小区）中取邻区，排除目标小区自身
            valid_neighbors = []
            target_sector_id = target_cell["sectorId"]
            target_site_id = target_cell.get("siteId", "")
            target_lon = target_cell["longitude"]
            target_lat = target_cell["latitude"]

            for idx in neighbor_indices:
                neighbor_cell = pool[idx]

                # 跳过目标小区自身（通过sectorId判断）
                if neighbor_cell["sectorId"] == target_sector_id:
                    logger.debug(f"  排除自身: sectorId={target_sector_id}")
                    continue

                # 【关键修复】跳过同位置（相同经纬度）的其他小区
                # 同位置的小区应该被视为"自身"的一部分，不应该参与邻区TAC统计
                neighbor_lon = neighbor_cell.get("longitude")
                neighbor_lat = neighbor_cell.get("latitude")
                if neighbor_lon is not None and neighbor_lat is not None:
                    # 使用容差比较浮点数经纬度（考虑精度问题）
                    lon_same = abs(neighbor_lon - target_lon) < 1e-6
                    lat_same = abs(neighbor_lat - target_lat) < 1e-6
                    if lon_same and lat_same:
                        logger.debug(
                            f"  排除同位置小区: sectorId={neighbor_cell.get('sectorId')}, "
                            f"经纬度=({neighbor_lon:.6f}, {neighbor_lat:.6f})"
                        )
                        continue

                # 计算距离
                distance = self._calculate_distance(target_cell, neighbor_cell)

                # 只考虑半径范围内的邻区
                if distance <= search_radius:
                    valid_neighbors.append(neighbor_cell)
                else:
                    logger.debug(f"  邻区{neighbor_cell.get('sectorId')}距离{distance:.0f}m超出半径{search_radius}m，跳过")

            if not valid_neighbors:
                continue

            # 统计有效邻区的TAC分布（基于地理位置分布，而非站点数量）
            # 修复漏洞：使用距离权重统计，反映真实的地理分布密度
            def _normalize_tac(tac_value: Any) -> Optional[str]:
                """标准化TAC值为字符串（去除前导零）
                注意：None或空字符串返回None，不参与统计
                """
                if tac_value is None:
                    return None
                tac_str = str(tac_value).strip()
                # 空字符串返回None，不参与统计
                if not tac_str or tac_str.lower() in ('', 'nan', 'none'):
                    return None
                # 去除前导零（但保留单个0）
                return tac_str.lstrip("0") or "0"

            # 使用距离权重统计TAC分布：距离越近权重越高
            # 权重函数：weight = 1 / (distance + 1)，距离单位米
            tac_weights: Dict[str, float] = {}
            tac_nearest_dist: Dict[str, float] = {}  # 记录每个TAC的最近距离

            for neighbor in valid_neighbors:
                neighbor_tac_raw = neighbor.get("existingTac")
                neighbor_tac = _normalize_tac(neighbor_tac_raw)

                # 只统计有有效TAC的邻区
                if neighbor_tac:
                    # 计算距离
                    distance = self._calculate_distance(target_cell, neighbor)

                    # 距离权重：使用高斯权重或反距离权重
                    # 使用反距离权重：weight = 1 / (distance + 100)
                    # +100避免除以零，同时给近距离足够高的权重
                    weight = 1.0 / (distance + 100.0)

                    # 累加权重
                    if neighbor_tac not in tac_weights:
                        tac_weights[neighbor_tac] = 0.0
                        tac_nearest_dist[neighbor_tac] = distance
                    tac_weights[neighbor_tac] += weight

                    # 更新最近距离
                    if distance < tac_nearest_dist[neighbor_tac]:
                        tac_nearest_dist[neighbor_tac] = distance

            if not tac_weights:
                continue

            # 找出权重最大的TAC值（基于地理分布密度）
            total_weight = sum(tac_weights.values())
            dominant_tac, max_weight = max(tac_weights.items(), key=lambda x: x[1])
            dominant_ratio = max_weight / total_weight if total_weight > 0 else 0

            # 记录TAC分布（调试用）- 基于距离权重统计
            if total_weight > 0:
                tac_distribution_str = ", ".join([
                    f"TAC{k}={v:.2f}(最近{tac_nearest_dist[k]:.0f}m)"
                    for k, v in sorted(tac_weights.items(), key=lambda x: x[1], reverse=True)
                ])
                # 记录邻区详情（前10个）
                neighbors_detail = []
                for neighbor in valid_neighbors[:10]:
                    neighbor_tac = _normalize_tac(neighbor.get("existingTac"))
                    neighbor_dist = self._calculate_distance(target_cell, neighbor)
                    neighbors_detail.append(f"{neighbor.get('sectorId')}(TAC={neighbor_tac}, dist={neighbor_dist:.0f}m)")
                neighbors_str = ", ".join(neighbors_detail)
                if len(valid_neighbors) > 10:
                    neighbors_str += f", ... (共{len(valid_neighbors)}个邻区)"
                logger.info(
                    f"[TAC分布] 小区={target_sector_name}(ID={target_cell.get('sectorId')}), "
                    f"现网TAC={target_existing_tac}, 图层TAC={target_layer_tac}, "
                    f"邻区小区数={len(valid_neighbors)}, TAC权重分布: {tac_distribution_str}"
                )
                logger.debug(
                    f"[邻区详情] {neighbors_str}"
                )
            else:
                logger.info(
                    f"[TAC分布] 小区={target_sector_name}(ID={target_cell.get('sectorId')}), "
                    f"现网TAC={target_existing_tac}, 没有有效邻区"
                )

            # 判断目标小区TAC是否与周边主流TAC不同且占比超过阈值
            # 【关键修复】现网TAC为空时，不进行插花判断，直接跳过
            target_tac_raw = target_cell.get("existingTac")
            target_tac = _normalize_tac(target_tac_raw)
            is_singularity = (
                target_tac is not None  # 现网TAC必须有效（非空、非NaN）
                and target_tac != dominant_tac
                and dominant_ratio >= singularity_threshold
            )

            # 详细诊断日志
            logger.info(
                f"[TAC插花判断] 小区={target_sector_name}(sectorId={target_sector_id}), "
                f"现网TAC={target_existing_tac}({target_tac}), 图层TAC={target_layer_tac}, "
                f"主流TAC={dominant_tac}, 主流TAC权重占比={dominant_ratio:.2%} (>=阈值={singularity_threshold:.2%}?{dominant_ratio >= singularity_threshold}), "
                f"现网TAC是否有效={target_tac is not None}, "
                f"是否与主流不同={target_tac is not None and target_tac != dominant_tac}, "
                f"是否插花={is_singularity}, 有效邻区小区数={len(valid_neighbors)}, 主流TAC最近距离={tac_nearest_dist.get(dominant_tac, 0):.0f}m"
            )

            # 如果条件接近阈值但未达到，记录警告
            if target_tac and target_tac != dominant_tac:
                if dominant_ratio < singularity_threshold:
                    logger.warning(
                        f"[TAC插花检测-未达阈值] 小区={target_sector_name}, "
                        f"现网TAC={target_existing_tac}({target_tac}), 主流TAC={dominant_tac}, "
                        f"主流权重占比={dominant_ratio:.2%} < 阈值={singularity_threshold:.2%}, "
                        f"邻区小区数={len(valid_neighbors)}"
                    )

            if is_singularity:
                singularity_results.append({
                    "sectorId": target_cell["sectorId"],
                    "sectorName": target_cell["sectorName"],
                    "siteId": target_cell["siteId"],
                    "siteName": target_cell["siteName"],
                    "cellTAC": target_tac,
                    "dominantTac": dominant_tac,
                    "validNeighborCount": len(valid_neighbors),
                    "dominantTacNearestDistance": round(tac_nearest_dist.get(dominant_tac, 0), 2),  # 主流TAC最近距离
                    "异TAC占比": round((1 - dominant_ratio) * 100, 2),
                    "dominantTacRatio": round(dominant_ratio * 100, 2),
                })
                logger.info(
                    f"[TAC插花检测-发现插花] 小区={target_sector_name}, "
                    f"现网TAC={target_existing_tac} != 主流TAC={dominant_tac}, "
                    f"主流权重占比={dominant_ratio:.2%} (主流TAC最近距离={tac_nearest_dist.get(dominant_tac, 0):.0f}m)"
                )

        logger.info(f"TAC插花检测完成: 发现 {len(singularity_results)} 个插花小区")
        return singularity_results
