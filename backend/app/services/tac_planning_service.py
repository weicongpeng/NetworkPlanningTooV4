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

from shapely.strtree import STRtree

logger = logging.getLogger(__name__)


def _cell_identity(site_id: Any, sector_id: Any) -> str:
    """小区复合标识 siteId_sectorId（与前端选中 id 格式一致）

    sectorId 只在站点内唯一、跨站点会大量重复，不能用裸 sectorId 标识小区，
    否则不同站点同 id 的小区会互相连坐/详情串号。
    """
    site = "" if site_id is None else str(site_id)
    sector = "" if sector_id is None else str(sector_id)
    return f"{site}_{sector}"


def _location_key(longitude: Any, latitude: Any) -> Optional[Tuple[float, float]]:
    """位置键：坐标按 6 位小数取整（与邻区同位置排除的 1e-6 容差口径一致）"""
    if longitude is None or latitude is None:
        return None
    try:
        return (round(float(longitude), 6), round(float(latitude), 6))
    except (TypeError, ValueError):
        return None


# TAC不一致但非插花（现网TAC与周边一致、但与图层不符）小区的「TAC建议值」提示文案
SUGGEST_RECHECK_TEXT = "需核查是否存在拉远小区、TAC边界、合并小区等"


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

    def __init__(self, data_dir: Path, data_service=None):
        self.data_dir = data_dir
        self.data_service = data_service
        # 使用LRU缓存替代普通字典，默认最大缓存100个TAC区域
        self.tac_zones = LRUCache(capacity=100)
        self._seen_cells = {}  # 用于NR网络去重的字典
        # STRtree 空间索引缓存 {network_type: (tree, tac_id_map)}
        self._strtree_cache: Dict[str, tuple] = {}
        # 最近一次加载小区时因工参数据不全被跳过的小区记录（供任务结果回传提示）
        self.last_load_skipped: List[Dict] = []

    @staticmethod
    def _coerce_coord(value: Any) -> Optional[float]:
        """把坐标值安全转为 float；None/空串/0/非数字/NaN/Inf 均返回 None（视为缺失）"""
        if value is None or isinstance(value, bool):
            return None
        try:
            coord = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(coord) or coord == 0:
            return None
        return coord

    def _record_skipped(
        self, site_id: Any, site_name: Any, sector_id: Any,
        sector_name: Any, reason: str,
    ) -> None:
        """记录一个因工参数据不全被跳过的小区（reason: missing_ids / missing_coordinates）"""
        self.last_load_skipped.append({
            "siteId": "" if site_id is None else str(site_id),
            "siteName": "" if site_name is None else str(site_name),
            "sectorId": "" if sector_id is None else str(sector_id),
            "sectorName": "" if sector_name is None else str(sector_name),
            "reason": reason,
        })

    def load_tac_layers(
        self,
        network_type: str,
        city: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> Dict[str, Tuple[Polygon, str]]:
        """
        加载TAC图层文件（严格按（地市+运营商）组隔离）

        Args:
            network_type: 'LTE' 或 'NR'
            city/operator: 任务组快照。必须提供；只在本组导入的数据目录中查找，
                绝不全局递归 DATA_DIR，防止本组无图层时读到其他组的 TAC 面数据。

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

            if not city or not operator:
                raise ValueError(
                    f"加载TAC图层失败: 缺少数据组（地市/运营商）信息，"
                    f"无法在本组数据内查找 {tac_filename}"
                )

            # 仅列出同组数据条目（按 DataItem 的组快照属性过滤）
            from app.services.data_service import data_service
            all_items = data_service.list_data()
            items = [
                it for it in all_items
                if getattr(it, "city", None) == city
                and getattr(it, "operator", None) == operator
            ]
            logger.info(
                f"[TAC图层搜索] 组({city}/{operator})内候选条目 {len(items)} 个"
                f"（全部条目 {len(all_items)} 个）"
            )

            tac_file = None

            # 辅助函数：在目录中查找 TAB 文件（不区分大小写）
            def _find_tab_file(directory: Path) -> Optional[Path]:
                """在目录中查找第一个 .tab 文件（不区分大小写）"""
                if not directory.exists():
                    return None
                for f in directory.rglob("*"):
                    if f.is_file() and f.suffix.lower() == ".tab":
                        return f
                return None

            def _find_named_tab_file(directory: Path, filename: str) -> Optional[Path]:
                """在目录中查找指定名称的 TAB 文件（不区分大小写）"""
                if not directory.exists():
                    return None
                for f in directory.rglob("*"):
                    if f.is_file() and f.name.lower() == filename.lower():
                        return f
                return None

            # 收集所有 data 目录子目录的路径，用于后续搜索
            _all_data_subdirs: List[Path] = []

            for item in items:
                # 无论 item 类型是什么，都收集其 data 子目录路径用于 TAB 文件搜索
                data_dir = self.data_dir / item.id
                if data_dir.exists():
                    _all_data_subdirs.append(data_dir)

                # 跳过非 map 类型，但如果有 layers 元数据也检查
                if item.type.value != "map":
                    # 检查非 map 条目是否包含图层元数据（如 ZIP 混合上传场景）
                    if hasattr(item, 'metadata') and item.metadata:
                        metadata_dict = item.metadata.model_dump() if hasattr(item.metadata, 'model_dump') else item.metadata
                        layers = metadata_dict.get('layers', [])
                        if layers:
                            # 有图层元数据的非 map 条目，尝试在其中查找 TAB 文件
                            for layer in layers:
                                layer_name = layer.get('name', '')
                                if network_type == "LTE":
                                    if "4G_TAC" in layer_name or ("4G" in layer_name and "TAC" in layer_name):
                                        candidate = _find_tab_file(data_dir)
                                        if candidate:
                                            tac_file = candidate
                                            logger.info(f"[TAC图层搜索] 在非map条目的图层中找到: {candidate}")
                                            break
                                else:
                                    if "5G_TAC" in layer_name or ("5G" in layer_name and "TAC" in layer_name) or "河源5G" in layer_name:
                                        candidate = _find_tab_file(data_dir)
                                        if candidate:
                                            tac_file = candidate
                                            logger.info(f"[TAC图层搜索] 在非map条目的图层中找到: {candidate}")
                                            break
                            if tac_file:
                                break
                    # 也尝试直接在非 map 条目的 data 目录中搜索 TAB 文件
                    if tac_file is None:
                        candidate = _find_named_tab_file(data_dir, tac_filename)
                        if candidate:
                            tac_file = candidate
                            logger.info(f"[TAC图层搜索] 在非map条目目录中找到: {candidate}")
                            break
                    continue

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

            # 方法4: 在所有 data 子目录中搜索 TAB 文件（包括非 map 类型的 data 目录）
            # 这解决了当 TAC 图层文件被打包在 ZIP 中通过 /upload/excel 上传时，
            # 提取的 TAB 文件位于 excel 类型的 data 目录中而未被 map 搜索覆盖的问题
            if tac_file is None:
                logger.info(f"[TAC图层搜索] 在 {len(_all_data_subdirs)} 个 data 子目录中搜索 {tac_filename}...")
                for subdir in _all_data_subdirs:
                    candidate = _find_named_tab_file(subdir, tac_filename)
                    if candidate:
                        tac_file = candidate
                        logger.info(f"[TAC图层搜索] 在子目录中找到: {candidate}")
                        break

            # 不做 DATA_DIR 全局递归回退：那会跨组读到其他地市/运营商的 TAC 图层。
            # 方法4 已覆盖本组所有导入条目（含 ZIP 内解压出的 TAB）。

            if tac_file is None or not tac_file.exists():
                # 仅列出本组数据目录下的 .tab 文件以便调试（不跨组扫描）
                _group_tabs: List[str] = []
                for subdir in _all_data_subdirs:
                    for t in list(subdir.rglob("*.tab")) + list(subdir.rglob("*.TAB")):
                        _group_tabs.append(str(t))
                if _group_tabs:
                    logger.warning(
                        f"[TAC图层搜索] 组({city}/{operator})内存在以下 .tab 文件但未匹配: "
                        f"{_group_tabs[:20]}"
                    )
                raise ValueError(
                    f"加载TAC图层失败: 本组（{city}/{operator}）未找到TAC图层文件 "
                    f"{tac_filename}，请确保TAC图层已在数据管理中导入"
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

            # 构建 STRtree 空间索引
            self._build_strtree_index(network_type, tac_zones)

            return tac_zones

        except Exception as e:
            logger.error(f"加载TAC图层失败: {e}")
            import traceback

            traceback.print_exc()
            raise ValueError(f"加载TAC图层失败: {str(e)}")

    def load_cells(self, network_type: str, city: Optional[str] = None, operator: Optional[str] = None) -> List[Dict]:
        """
        加载待规划的小区数据
        直接从全量工参文件中获取对应网络类型的所有小区

        Args:
            network_type: 'LTE' 或 'NR'
            city/operator: (地市+运营商) 组快照。必须提供，仅在组内定位全量工参；
                不完整时返回空列表（禁止回退全局，防止跨组串小区）。

        Returns:
            小区列表（包含经纬度）
        """
        # 每次加载前重置跳过记录（含早退分支），避免沿用上一次的结果
        self.last_load_skipped = []
        if not city or not operator:
            return []
        try:
            cells = []
            # 清空去重字典（针对所有网络类型）
            self._seen_cells = {}
            logger.info(f"从全量工参文件加载待规划{network_type}小区...")

            # 获取 data_service 引用
            ds = self.data_service
            if ds is None:
                from app.services.data_service import data_service as _ds
                ds = _ds

            # 收集所有全量工参文件并按上传时间降序排序（最新的在前）
            full_params_files = []
            for data_id, data_info in ds.index.items():
                file_type = data_info.get("type", "")
                file_name = data_info.get("name", "")

                if file_type == "excel" and data_info.get("fileType") == "full_params":
                    # 严格组过滤：仅匹配同组条目（NULL 组/其他组均不匹配）
                    if (data_info.get("city"), data_info.get("operator")) != (city, operator):
                        continue
                    full_params_files.append({
                        "data_id": data_id,
                        "name": file_name,
                        "upload_date": data_info.get("uploadDate", ""),
                    })

            full_params_files.sort(key=lambda x: x["upload_date"], reverse=True)

            if not full_params_files:
                logger.warning(f"未找到全量工参文件")
                return cells

            # 只读取最新的全量工参文件
            latest_file = full_params_files[0]
            data_id = latest_file["data_id"]
            file_name = latest_file["name"]

            logger.info(f"正在读取最新全量工参文件: {file_name} (上传时间: {latest_file['upload_date']})")

            # 从 SQLite 获取数据（回退到遗留 data.json）
            data = ds.get_data_from_db(data_id)
            if data is None:
                data_json_path = self.data_dir / data_id / "data.json"
                if data_json_path.exists():
                    with open(data_json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                else:
                    logger.warning(f"数据不存在: {data_id}")
                    return cells

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
                        self._record_skipped(
                            site_id, site_name, sector_id, sector_name, "missing_ids"
                        )
                        continue

                    # 获取经纬度（0/空/非数字/NaN 均视为缺失，统一转 float）
                    longitude = self._coerce_coord(sector.get("longitude"))
                    latitude = self._coerce_coord(sector.get("latitude"))

                    # 只保留有经纬度的小区
                    if longitude is None or latitude is None:
                        logger.debug(
                            f"跳过无经纬度的小区: site={site_id}, sector={sector_id}"
                        )
                        self._record_skipped(
                            site_id, site_name, sector_id, sector_name, "missing_coordinates"
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
                skipped_note = (
                    f"（其中 {len(self.last_load_skipped)} 个小区因工参数据不全被跳过）"
                    if self.last_load_skipped else ""
                )
                raise ValueError(
                    f"未找到{network_type}小区数据，请确保已导入包含经纬度的全量工参文件{skipped_note}"
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
        geometries = []
        tac_id_map = []  # 将几何对象索引映射到 (TAC ID, area_name)

        for tac_id, (geometry, area_name) in tac_zones.items():
            if isinstance(geometry, Polygon):
                geometries.append(geometry)
                tac_id_map.append((tac_id, area_name))
            elif isinstance(geometry, MultiPolygon):
                # 对于 MultiPolygon，使用最大的多边形
                max_area = 0
                main_poly = None
                for poly in geometry.geoms:
                    if poly.area > max_area:
                        max_area = poly.area
                        main_poly = poly
                if main_poly:
                    geometries.append(main_poly)
                    tac_id_map.append((tac_id, area_name))

        if not geometries:
            logger.warning(f"没有有效的多边形用于构建 STRtree 索引（{network_type}）")
            return

        # 创建 STRtree
        tree = STRtree(geometries)
        self._strtree_cache[network_type] = (tree, geometries, tac_id_map, tac_zones)

        logger.info(
            f"构建 STRtree 索引成功（{network_type}）: {len(geometries)} 个多边形"
        )

    def match_cell_to_tac(
        self, cell: Dict, tac_zones: Dict[str, Tuple[Polygon, str]], network_type: Optional[str] = None
    ) -> Optional[str]:
        """
        将小区匹配到TAC区域

        使用 STRtree 空间索引优化查询性能。当提供了 network_type 时使用 STRtree，
        否则使用线性扫描（仅当未提供 network_type 时使用线性扫描）。

        Args:
            cell: 小区数据
            tac_zones: TAC区域字典 {tac_id: (geometry, area_name)}
            network_type: 网络类型 ('LTE' 或 'NR')，可选。

        Returns:
            TAC ID，如果不匹配则返回None
        """
        point = Point(cell["longitude"], cell["latitude"])

        # 如果提供了 network_type 且有 STRtree 索引，使用索引查询
        if network_type and network_type in self._strtree_cache:
            return self._match_with_strtree(cell, point, network_type)

        # 否则使用线性搜索（仅当未提供 network_type 时）
        return self._match_with_tac_zones(cell, point, tac_zones)

    def _match_with_strtree(self, cell: Dict, point: Point, network_type: str) -> Optional[str]:
        """使用 STRtree 索引进行匹配"""
        if network_type not in self._strtree_cache:
            return None

        tree, geometries, tac_id_map, tac_zones = self._strtree_cache[network_type]

        # STRtree query returns indices
        candidate_indices = tree.query(point)

        for idx in candidate_indices:
            idx = int(idx)
            if 0 <= idx < len(geometries):
                geometry = geometries[idx]
                if geometry.contains(point) or geometry.touches(point):
                    tac_id, area_name = tac_id_map[idx]
                    logger.debug(
                        f"小区 {cell['sectorId']} 匹配到TAC: {tac_id} ({area_name}) [STRtree]"
                    )
                    return tac_id

        # 未通过 STRtree 找到 — 再通过 tac_zones 直接检查一次
        return self._match_with_tac_zones(cell, point, tac_zones)

    def _match_with_tac_zones(self, cell: Dict, point: Point, tac_zones: Dict[str, Tuple[Polygon, str]]) -> Optional[str]:
        """线性扫描 tac_zones 作为 STRtree 的补充或当 network_type 未提供时使用"""
        for tac_id, (geometry, area_name) in tac_zones.items():
            if isinstance(geometry, Polygon) and (geometry.contains(point) or geometry.touches(point)):
                logger.debug(
                    f"小区 {cell['sectorId']} 匹配到TAC: {tac_id} ({area_name}) [Linear]"
                )
                return tac_id
        return None

    def plan_tac(
        self,
        network_type: str,
        enable_singularity_check: bool = True,
        singularity_config: Optional[Dict[str, Any]] = None,
        progress_callback=None,
        city: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> Tuple[List[Dict], int, int, int, int]:
        """
        执行TAC核查（含TAC插花检测）

        Args:
            network_type: 网络类型 'LTE' 或 'NR'
            enable_singularity_check: 是否启用TAC插花检测，默认True
            singularity_config: 插花检测配置，包含：
                - spacing_factor: 站间距系数（默认2.0），搜索半径 = 系数 × 该物理点平均站间距
                  （物理点=100m内小区合并；平均站间距=最近4个站间距均值）
                - search_radius: （可选，兼容/排障）显式固定搜索半径（米），给出时优先于系数
                - singularity_threshold: 异TAC占比阈值（0~1），默认0.5。
                  异TAC占比 = 周边TAC与本站不同的加权占比 = 1 - 本站TAC在周边的加权占比
            progress_callback: 进度回调函数
            city/operator: (地市+运营商) 组快照，提供时仅在组内解析全量工参

        Returns:
            (results, matched_count, unmatched_count, mismatched_count, singularity_count)
        """
        try:
            # 清空去重字典，防止内存无限增长
            self._seen_cells.clear()

            # 1. 加载TAC图层
            if progress_callback:
                progress_callback(10, "加载TAC图层...")

            tac_zones = self.load_tac_layers(network_type, city=city, operator=operator)
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

            cells = self.load_cells(network_type, city=city, operator=operator)
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
                tac_id = self.match_cell_to_tac(cell, tac_zones, network_type)

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
                        if key == "spacingFactor":
                            normalized["spacing_factor"] = value
                        elif key == "searchRadius":
                            # 兼容旧的固定搜索半径配置（显式给出时优先于站间距系数）
                            normalized["search_radius"] = value
                        elif key == "singularityThreshold":
                            normalized["singularity_threshold"] = value
                        else:
                            normalized[key] = value
                    return normalized

                normalized_config = normalize_config(singularity_config)
                config = normalized_config if normalized_config else {
                    "spacing_factor": 2.0,
                    "singularity_threshold": 0.5,
                }

                logger.info(
                    f"[TAC插花检测配置] spacing_factor={config.get('spacing_factor')}, "
                    f"search_radius={config.get('search_radius')}, "
                    f"singularity_threshold={config.get('singularity_threshold')}"
                )

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
                # 搜索半径：优先用显式 search_radius；否则按「系数 × 该物理点平均站间距」逐站点自适应
                singularity_cells = self.check_tac_singularity(
                    cells=mismatched_cells,
                    neighbor_pool=cells,
                    search_radius=config.get("search_radius"),
                    singularity_threshold=config.get("singularity_threshold", 0.5),
                    spacing_factor=config.get("spacing_factor", 2.0),
                    progress_callback=progress_callback,
                )

                # 3. 创建插花小区的复合键集合，用于快速查找
                # 【关键修复】必须用 siteId_sectorId 复合键：sectorId 跨站点大量重复，
                # 用裸 sectorId 会把其他站点同 id 的小区连带标记为插花
                singularity_keys = set(
                    _cell_identity(cell.get("siteId"), cell.get("sectorId"))
                    for cell in singularity_cells
                )

                # 【关键修复】创建插花位置的坐标集合（用于同位置小区同步标记）
                # 同位置（相同经纬度）的任一小区被标记为插花时，该位置所有小区都应该被标记
                singularity_locations = set()
                for cell in singularity_cells:
                    loc_key = _location_key(cell.get("longitude"), cell.get("latitude"))
                    if loc_key is not None:
                        singularity_locations.add(loc_key)

                logger.info(f"[TAC插花标记] 发现 {len(singularity_keys)} 个插花小区，涉及 {len(singularity_locations)} 个不同位置")

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
                    # 【关键修复】自身命中用 siteId_sectorId 复合键判断，避免跨站点同 id 连坐
                    cell_key = _cell_identity(result.get("siteId"), result.get("sectorId"))
                    cell_location = _location_key(cell.get("longitude"), cell.get("latitude"))
                    is_at_singularity_location = (
                        cell_location is not None and cell_location in singularity_locations
                    )
                    is_self_singularity = cell_key in singularity_keys

                    is_singularity = (
                        existing_str is not None  # 现网TAC必须有效（非空）
                        and tac_str is not None
                        and not is_consistent
                        and (is_self_singularity or is_at_singularity_location)
                    )

                    # 调试日志：记录同位置小区的插花标记情况
                    if is_at_singularity_location and not is_self_singularity:
                        logger.info(
                            f"[TAC插花标记-同位置同步] 小区={cell.get('sectorName')}, "
                            f"sectorId={result.get('sectorId')}, 位置={cell_location}, "
                            f"同位置其他小区被标记为插花，本小区同步标记"
                        )

                    # 标记插花状态和建议值
                    result["isSingularity"] = is_singularity

                    if is_singularity:
                        # 获取插花详情（必须用 siteId_sectorId 复合键，避免取到其他站点同 id 小区的详情）
                        singularity_info = next(
                            (
                                s for s in singularity_cells
                                if str(s.get("siteId", "")) == str(result.get("siteId", ""))
                                and str(s.get("sectorId", "")) == str(result.get("sectorId", ""))
                            ),
                            None,
                        )
                        if singularity_info:
                            result["singularityDetails"] = singularity_info
                        # 对于插花小区，建议值取图层TAC值
                        result["suggestedTac"] = tac_id
                        marked_singularity_count += 1
                    elif existing_str is not None and tac_str is not None and not is_consistent:
                        # TAC不一致且非插花（现网TAC与周边一致但与图层不符）：建议人工核查
                        result["suggestedTac"] = SUGGEST_RECHECK_TEXT
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
        self,
        network_type: str,
        cells_to_plan: List[Dict],
        progress_callback=None,
        city: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> Tuple[List[Dict], int, int]:
        """
        执行TAC规划（对待规划小区清单进行规划）

        根据待规划小区清单的经纬度匹配TAC图层，分配TAC编号

        Args:
            network_type: 网络类型 'LTE' 或 'NR'
            progress_callback: 进度回调函数
            city/operator: 任务组快照，TAC 图层仅在本组数据内查找

        Returns:
            (results, planned_count, unplanned_count)
        """
        try:
            # 1. 加载TAC图层
            if progress_callback:
                progress_callback(10, "加载TAC图层...")

            tac_zones = self.load_tac_layers(network_type, city=city, operator=operator)
            self.tac_zones = tac_zones

            logger.info(f"成功加载 {len(tac_zones)} 个{network_type} TAC区域")

            # 2. 加载待规划小区清单
            if progress_callback:
                progress_callback(30, f"加载{network_type}待规划小区清单...")

            cells = self.load_planning_cells(cells_to_plan)
            total_cells = len(cells)

            if not cells:
                skipped_note = (
                    f"（其中 {len(self.last_load_skipped)} 个小区因工参数据不全被跳过）"
                    if self.last_load_skipped else ""
                )
                raise ValueError(
                    f"未找到{network_type}待规划小区或有效坐标{skipped_note}"
                )

            logger.info(f"成功加载 {total_cells} 个{network_type}待规划小区")

            # 3. 匹配小区到TAC
            results = []
            planned_count = 0
            unplanned_count = 0

            for i, cell in enumerate(cells):
                tac_id = self.match_cell_to_tac(cell, tac_zones, network_type)

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
        # 每次加载前重置跳过记录，避免沿用上一次的结果
        self.last_load_skipped = []
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

                    # 优先获取小区级别坐标，否则使用基站级别（0/空/非数字/NaN 均视为缺失）
                    lon = self._coerce_coord(sector.get("longitude")) or self._coerce_coord(site_lon)
                    lat = self._coerce_coord(sector.get("latitude")) or self._coerce_coord(site_lat)

                    if lon is None or lat is None:
                        logger.debug(
                            f"跳过无有效坐标的待规划小区: site={site_id}, sector={sector_id}"
                        )
                        self._record_skipped(
                            site_id, site_name, sector_id, sector_name, "missing_coordinates"
                        )
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

    def _build_search_radius_map(
        self,
        pool: List[Dict],
        spacing_factor: float,
        cluster_radius_m: float = 100.0,
        nearest_count: int = 4,
        fallback_radius_m: float = 1500.0,
    ) -> Dict[str, float]:
        """按物理点计算每个小区的搜索半径 = 站间距系数 × 该点平均站间距

        - 物理点：100m 内的多个小区就近合并为一个物理点（同站多 RRU/室分只算一个点；
          工参里一个 siteId 下挂多个相距数公里的 RRU 时不会被误当成同一个点）
        - 平均站间距：该物理点到最近 nearest_count 个「其他物理点」的距离均值（不足则取可用数量的均值）
        - 没有任何其他物理点时返回 fallback_radius_m（此时任何半径都取不到邻区）

        Returns:
            {f"{siteId}_{sectorId}": 搜索半径(米)}
        """
        pool_cells = [
            c for c in pool
            if c.get("longitude") is not None and c.get("latitude") is not None
        ]
        if not pool_cells:
            return {}

        try:
            from sklearn.neighbors import BallTree
        except ImportError:
            logger.error("未安装sklearn库，无法按站间距计算搜索半径")
            return {}

        lons = np.array([float(c["longitude"]) for c in pool_cells])
        lats = np.array([float(c["latitude"]) for c in pool_cells])

        # 1. 100m 内就近合并为物理点（网格分桶 + 3×3 邻桶查找，不做链式连通）
        # 桶步长取 2×合并半径，保证与某点均值相距≤100m 的小区必落在其 3×3 邻域内
        deg_step = (cluster_radius_m * 2) / 111320.0
        grid: Dict[Tuple[int, int], List[int]] = {}
        sum_lon: List[float] = []
        sum_lat: List[float] = []
        counts: List[int] = []
        point_bucket: List[Tuple[int, int]] = []
        cell_point: List[int] = []

        def _bucket(lon: float, lat: float) -> Tuple[int, int]:
            return (math.floor(lon / deg_step), math.floor(lat / deg_step))

        for i in range(len(pool_cells)):
            lon_i, lat_i = float(lons[i]), float(lats[i])
            gx, gy = _bucket(lon_i, lat_i)
            best_pi = None
            best_dist = None
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for pi in grid.get((gx + dx, gy + dy), ()):
                        plon = sum_lon[pi] / counts[pi]
                        plat = sum_lat[pi] / counts[pi]
                        d = self._calculate_distance(
                            {"longitude": lon_i, "latitude": lat_i},
                            {"longitude": plon, "latitude": plat},
                        )
                        if d <= cluster_radius_m and (best_dist is None or d < best_dist):
                            best_dist, best_pi = d, pi
            if best_pi is None:
                best_pi = len(counts)
                sum_lon.append(lon_i)
                sum_lat.append(lat_i)
                counts.append(1)
                b = _bucket(lon_i, lat_i)
                point_bucket.append(b)
                grid.setdefault(b, []).append(best_pi)
            else:
                sum_lon[best_pi] += lon_i
                sum_lat[best_pi] += lat_i
                counts[best_pi] += 1
                mean_lon = sum_lon[best_pi] / counts[best_pi]
                mean_lat = sum_lat[best_pi] / counts[best_pi]
                nb = _bucket(mean_lon, mean_lat)
                if nb != point_bucket[best_pi]:
                    point_bucket[best_pi] = nb
                    grid.setdefault(nb, []).append(best_pi)
            cell_point.append(best_pi)

        n_points = len(counts)
        point_lon = np.array([sum_lon[i] / counts[i] for i in range(n_points)])
        point_lat = np.array([sum_lat[i] / counts[i] for i in range(n_points)])

        # 2. 每个物理点到最近 nearest_count 个「其他物理点」的距离均值
        point_coords = np.radians(np.column_stack([point_lat, point_lon]))
        point_tree = BallTree(point_coords, metric="haversine")
        k = min(nearest_count + 1, n_points)
        dists, idxs = point_tree.query(point_coords, k=k)

        radius_by_point: List[float] = []
        for i in range(n_points):
            others = [
                float(d) * 6371000.0
                for d, j in zip(dists[i], idxs[i]) if int(j) != i
            ]  # 最近站点只算一个（每个物理点只取一次）
            if not others:
                radius_by_point.append(fallback_radius_m)
            else:
                radius_by_point.append(spacing_factor * (sum(others) / len(others)))

        logger.info(
            f"[站间距搜索半径] 物理点数={n_points}（由 {len(pool_cells)} 个小区合并，"
            f"最近{nearest_count}个站间距均值）, 系数={spacing_factor}, "
            f"半径范围={min(radius_by_point):.0f}~{max(radius_by_point):.0f}m"
        )

        # 3. 映射回每个小区
        radius_map: Dict[str, float] = {}
        for cell, pi in zip(pool_cells, cell_point):
            radius_map[_cell_identity(cell.get("siteId"), cell.get("sectorId"))] = radius_by_point[pi]
        return radius_map

    def check_tac_singularity(
        self,
        cells: List[Dict],
        neighbor_pool: Optional[List[Dict]] = None,
        search_radius: Optional[float] = None,
        singularity_threshold: float = 0.5,
        spacing_factor: float = 2.0,
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
            search_radius: 固定搜索半径（米）。显式给出时所有小区都用它（排障/测试用）；
                为 None（默认）时按 spacing_factor × 该物理点平均站间距逐站点自适应
            spacing_factor: 站间距系数（默认2.0），仅当 search_radius 为 None 时生效。
                搜索半径 = 系数 × 最近4个站间距均值（见 _build_search_radius_map）
            singularity_threshold: 异TAC占比阈值（0~1），默认0.5。
                异TAC占比 = 周边TAC与本站不同的加权占比 = 1 - 本站TAC在周边的加权占比
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

        radius_desc = (
            f"固定半径={search_radius:.0f}m" if search_radius is not None
            else f"站间距系数={spacing_factor}（按站点自适应）"
        )
        logger.info(
            f"开始TAC插花检测: {radius_desc}, "
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

        # 搜索半径：显式给出 search_radius 时用固定半径；否则按「系数 × 该物理点平均站间距」自适应
        radius_map: Dict[str, float] = {}
        if search_radius is None:
            radius_map = self._build_search_radius_map(pool, spacing_factor)

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

            # 该小区的搜索半径
            if search_radius is not None:
                cell_radius = search_radius
            else:
                cell_radius = radius_map.get(
                    _cell_identity(target_site_id, target_sector_id), 1500.0
                )

            target_coord = np.array([[
                math.radians(target_cell["latitude"]),
                math.radians(target_cell["longitude"])
            ]])

            # 增强日志：记录目标小区基本信息
            logger.info(
                f"[TAC插花检测] 开始检测小区 {i+1}/{total_cells}: "
                f"sectorId={target_sector_id}, sectorName={target_sector_name}, "
                f"siteId={target_site_id}, 经纬度=({target_cell['latitude']:.6f}, {target_cell['longitude']:.6f}), "
                f"现网TAC={target_existing_tac}, 图层TAC={target_layer_tac}, "
                f"搜索半径={cell_radius:.0f}m"
            )

            # 查找半径范围内的邻区（在全量小区pool中搜索）
            # query_radius返回形状为(n_samples, [array_of_indices])，取[0]获得第一个查询点的邻居索引数组
            neighbor_indices = ball_tree.query_radius(
                target_coord,
                r=cell_radius / 6371000  # 转换为弧度
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

                # 跳过目标小区自身（siteId_sectorId 复合键判断）
                # 【关键修复】不能用裸 sectorId：会把其他站点同 id 的小区也误当"自身"排除，
                # 导致邻区统计缺失正常邻区
                if _cell_identity(
                    neighbor_cell.get("siteId"), neighbor_cell.get("sectorId")
                ) == _cell_identity(target_site_id, target_sector_id):
                    logger.debug(f"  排除自身: siteId={target_site_id}, sectorId={target_sector_id}")
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
                if distance <= cell_radius:
                    valid_neighbors.append(neighbor_cell)
                else:
                    logger.debug(f"  邻区{neighbor_cell.get('sectorId')}距离{distance:.0f}m超出半径{cell_radius:.0f}m，跳过")

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
                    f"[TAC分布] 小区={target_sector_name}(siteId={target_cell.get('siteId')}/ID={target_cell.get('sectorId')}), "
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

            # 判断目标小区是否为插花：
            # ① 现网TAC有效；② 与周边主流TAC不同；③ 异TAC占比达到阈值。
            # 异TAC占比 = 周边小区中TAC与本站不同的加权占比 = 1 - 本站TAC在周边的加权占比。
            # 说明：早期实现误用「主流TAC占比≥阈值」判断，导致周边TAC碎片化（无多数派）时
            #       即使本站TAC在周边几乎不存在也不会被判为插花，与参数「异TAC阈值」语义相反。
            target_tac_raw = target_cell.get("existingTac")
            target_tac = _normalize_tac(target_tac_raw)
            cell_tac_weight = tac_weights.get(target_tac, 0.0) if target_tac else 0.0
            cell_tac_ratio = cell_tac_weight / total_weight if total_weight > 0 else 0.0
            diff_tac_ratio = 1.0 - cell_tac_ratio
            is_singularity = (
                target_tac is not None  # 现网TAC必须有效（非空、非NaN）
                and target_tac != dominant_tac
                and diff_tac_ratio >= singularity_threshold
            )

            # 详细诊断日志
            logger.info(
                f"[TAC插花判断] 小区={target_sector_name}(sectorId={target_sector_id}), "
                f"现网TAC={target_existing_tac}({target_tac}), 图层TAC={target_layer_tac}, "
                f"主流TAC={dominant_tac}(占比{dominant_ratio:.2%}), "
                f"本站TAC占比={cell_tac_ratio:.2%}, 异TAC占比={diff_tac_ratio:.2%} "
                f"(>=阈值={singularity_threshold:.2%}?{diff_tac_ratio >= singularity_threshold}), "
                f"是否与主流不同={target_tac is not None and target_tac != dominant_tac}, "
                f"是否插花={is_singularity}, 有效邻区小区数={len(valid_neighbors)}, "
                f"主流TAC最近距离={tac_nearest_dist.get(dominant_tac, 0):.0f}m"
            )

            # 如果与主流TAC不同但异TAC占比未达阈值，记录警告
            if target_tac and target_tac != dominant_tac and diff_tac_ratio < singularity_threshold:
                logger.warning(
                    f"[TAC插花检测-未达阈值] 小区={target_sector_name}, "
                    f"现网TAC={target_existing_tac}({target_tac}), 主流TAC={dominant_tac}, "
                    f"异TAC占比={diff_tac_ratio:.2%} < 阈值={singularity_threshold:.2%}, "
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
                    "cellTacRatio": round(cell_tac_ratio * 100, 2),  # 本站TAC在周边的加权占比
                    "异TAC占比": round(diff_tac_ratio * 100, 2),  # 周边TAC与本站不同的加权占比
                    "dominantTacRatio": round(dominant_ratio * 100, 2),
                })
                logger.info(
                    f"[TAC插花检测-发现插花] 小区={target_sector_name}, "
                    f"现网TAC={target_existing_tac} != 主流TAC={dominant_tac}, "
                    f"异TAC占比={diff_tac_ratio:.2%} (本站TAC占比={cell_tac_ratio:.2%}, "
                    f"主流TAC最近距离={tac_nearest_dist.get(dominant_tac, 0):.0f}m)"
                )

        logger.info(f"TAC插花检测完成: 发现 {len(singularity_results)} 个插花小区")
        return singularity_results
