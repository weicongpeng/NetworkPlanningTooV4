"""
场景图层匹配：参考 TAC 规划的点面判定，把工参小区归入「场景图层.zip」对应的场景。

- 图层来源：数据管理中已导入的同组图层（ZIP 解压出的 MapInfo/KML/Shapefile/GeoJSON 等）。
- 场景名称：取图层要素的属性字段（如 MapInfo TAB 的 NAME，值为「一般城区核心区域」），
  绝不把图层 UUID 缓存文件名或笼统的图层名「场景图层」当作场景名。
- 经纬度为空/0/非数字/超范围时返回 None（工参留空）；有效坐标未命中或无图层时填「农村」。
"""

import json
import logging
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from app.core.config import settings

logger = logging.getLogger(__name__)

DEFAULT_SCENE_NAME = "农村"
SCENE_LAYER_TOKEN = "场景"
# 顺序即优先级；NAME/name 是 MapInfo/GeoJSON 图层最常见的要素名称字段
SCENE_NAME_FIELDS = (
    "场景名称", "场景名", "场景", "scene_name", "scene", "scenename",
    "name", "名称", "area_name",
)
VECTOR_SUFFIXES = (".tab", ".mif", ".kml", ".shp", ".geojson", ".json", ".gpkg")
SKIP_FILE_NAMES = {"layers.json", "index.json", "data.json"}
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class SceneMatcher:
    """按经纬度把小区匹配到场景图层边界内；未命中返回 DEFAULT_SCENE_NAME。"""

    def __init__(self, data_service=None):
        self.data_service = data_service
        self._entries: List[Tuple[Any, str]] = []  # [(Polygon, 场景名称)]
        self._tree = None
        self.available = False
        self.warning = ""
        self.stats: Dict[str, int] = {"layers": 0, "polygons": 0}

    def _reset(self) -> None:
        self._entries = []
        self._tree = None
        self.available = False
        self.warning = ""
        self.stats = {"layers": 0, "polygons": 0}

    def _group_entries(self, city: Optional[str], operator: Optional[str]):
        """本组数据条目（不分页，避免 list_data 默认 50 条漏掉场景图层）。"""
        if self.data_service is not None:
            ds = self.data_service
        else:
            from app.services.data_service import data_service as ds
        for data_id, entry in ds.index.items():
            if city or operator:
                if (entry.get("city"), entry.get("operator")) != (city, operator):
                    continue
            yield data_id, entry

    @staticmethod
    def _entry_layer_names(entry: Dict[str, Any]) -> List[str]:
        metadata = entry.get("metadata") or {}
        if hasattr(metadata, "model_dump"):
            metadata = metadata.model_dump()
        if not isinstance(metadata, dict):
            return []
        layers = metadata.get("layers") or []
        names = []
        for layer in layers:
            if isinstance(layer, dict) and layer.get("name"):
                names.append(str(layer["name"]))
        return names

    @classmethod
    def _is_scene_entry(cls, entry: Dict[str, Any]) -> bool:
        name = str(entry.get("name") or "")
        layer_names = cls._entry_layer_names(entry)
        haystack = " ".join([name] + layer_names).casefold()
        return SCENE_LAYER_TOKEN in haystack or "scene" in haystack

    @staticmethod
    def _valid_scene_name(text: str) -> bool:
        """图层 UUID / 内部 id / 笼统的图层名都不是场景名，不能写进工参。"""
        if not text or text.casefold() in ("nan", "none", "null"):
            return False
        if UUID_PATTERN.fullmatch(text):
            return False
        if text.casefold() in {"场景图层", "场景", "scene", "scenelayer"}:
            return False
        return True

    @classmethod
    def _scene_name_from_row(cls, row, columns, layer_name: str) -> str:
        """取要素属性里的场景名（如 NAME=一般城区核心区域）；无有效属性时才回退。"""
        folded = {str(col).strip().casefold(): col for col in columns}
        for candidate in SCENE_NAME_FIELDS:
            col = folded.get(candidate.casefold())
            if col is None:
                continue
            value = row.get(col)
            if value is None:
                continue
            try:
                if pd.isna(value):
                    continue
            except (TypeError, ValueError):
                pass
            text = str(value).strip()
            if cls._valid_scene_name(text):
                return text
        return layer_name if cls._valid_scene_name(layer_name) else DEFAULT_SCENE_NAME

    @staticmethod
    def _vector_files_for_dir(data_dir: Path) -> List[Path]:
        """只取 layers.json 声明的源图层，跳过 .cache 下以图层 UUID 命名的 GeoJSON 缓存。"""
        preferred_stems = set()
        layers_json = data_dir / "layers.json"
        if layers_json.is_file():
            try:
                layers = json.loads(layers_json.read_text(encoding="utf-8"))
                for layer in layers if isinstance(layers, list) else []:
                    if not isinstance(layer, dict):
                        continue
                    if layer.get("name"):
                        preferred_stems.add(str(layer["name"]).casefold())
                    metadata = layer.get("metadata") or {}
                    if isinstance(metadata, dict) and metadata.get("source_file"):
                        preferred_stems.add(Path(str(metadata["source_file"])).stem.casefold())
            except Exception as exc:  # noqa: BLE001 - 清单损坏时退回按文件扫描
                logger.warning("读取场景图层清单失败 %s: %s", layers_json, exc)

        files: List[Path] = []
        for path in sorted(data_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in VECTOR_SUFFIXES:
                continue
            if path.name.lower() in SKIP_FILE_NAMES or ".cache" in path.parts:
                continue
            if UUID_PATTERN.fullmatch(path.stem):
                continue
            if preferred_stems and path.stem.casefold() not in preferred_stems:
                continue
            files.append(path)
        return files

    @staticmethod
    def _read_vector_file(path: Path):
        import geopandas as gpd

        last_error = None
        for encoding in (None, "utf-8", "gbk", "gb18030", "latin1"):
            try:
                if encoding is None:
                    return gpd.read_file(path)
                return gpd.read_file(path, encoding=encoding)
            except Exception as exc:  # noqa: BLE001 - 图层编码/驱动多样，逐个尝试
                last_error = exc
        raise ValueError(f"无法读取场景图层 {path.name}: {last_error}")

    @staticmethod
    def _normalize_crs(gdf):
        """与 TAC 规划一致：确保几何为 WGS84，否则与工参经纬度无法相交。"""
        if getattr(gdf, "crs", None) is not None:
            if str(gdf.crs) != "EPSG:4326":
                gdf = gdf.to_crs(epsg=4326)
        elif len(gdf) > 0 and hasattr(gdf, "total_bounds"):
            bounds = gdf.total_bounds
            if bounds[2] > 360 or bounds[3] > 90 or bounds[0] < -180:
                try:
                    gdf = gdf.set_crs(epsg=3857, allow_override=True).to_crs(epsg=4326)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("场景图层坐标系未识别，转换失败: %s", exc)
        return gdf

    def load(
        self, city: Optional[str] = None, operator: Optional[str] = None,
        data_id: Optional[str] = None,
    ) -> bool:
        """加载场景图层；data_id 指定时只加载该图层，否则自动搜索本组默认场景图层。"""
        self._reset()
        if not city or not operator:
            self.warning = "缺少数据组（地市/运营商）信息，无法定位本组场景图层；场景名称将统一填写「农村」。"
            logger.warning(self.warning)
            return False
        try:
            from shapely.geometry import Polygon
        except ImportError as exc:
            self.warning = f"场景匹配依赖 shapely 不可用（{exc}），场景名称将统一填写「{DEFAULT_SCENE_NAME}」。"
            logger.warning(self.warning)
            return False

        candidate_dirs: List[Tuple[str, Path]] = []
        if data_id is not None:
            # 用户指定图层：只校验组归属，不强制名称含「场景」（允许自由选择其他图层）
            entry = dict(self._group_entries(city, operator)).get(str(data_id))
            data_dir = settings.DATA_DIR / str(data_id)
            if entry is None or not data_dir.exists():
                self.warning = "所选场景图层不存在或不属于当前数据组，场景名称将统一填写「农村」。"
                logger.warning(self.warning)
                return False
            candidate_dirs.append((str(data_id), data_dir))
        else:
            fallback_dirs: List[Tuple[str, Path]] = []
            for group_data_id, entry in self._group_entries(city, operator):
                data_dir = settings.DATA_DIR / str(group_data_id)
                if not data_dir.exists():
                    continue
                if self._is_scene_entry(entry):
                    candidate_dirs.append((str(group_data_id), data_dir))
                    continue
                # 兜底：条目名/元数据没写「场景」，但包内文件名含场景（如解压后的场景图层）
                for path in data_dir.rglob("*"):
                    if path.is_file() and ".cache" not in path.parts \
                            and path.suffix.lower() in VECTOR_SUFFIXES and SCENE_LAYER_TOKEN in path.stem:
                        fallback_dirs.append((str(group_data_id), data_dir))
                        break

            for item in fallback_dirs:
                if item not in candidate_dirs:
                    candidate_dirs.append(item)

        if not candidate_dirs:
            self.warning = (
                f"未找到已导入的「场景图层.zip」图层（当前组 {city or '-'}/{operator or '-'}）；"
                f"不影响工参更新，场景名称将统一填写「{DEFAULT_SCENE_NAME}」。"
            )
            logger.warning(self.warning)
            return False

        try:
            import geopandas as gpd  # noqa: F401 - 缺失时走下方 except
        except ImportError as exc:
            self.warning = f"场景匹配依赖 geopandas 不可用（{exc}），场景名称将统一填写「{DEFAULT_SCENE_NAME}」。"
            logger.warning(self.warning)
            return False

        for data_id, data_dir in candidate_dirs:
            vector_files = self._vector_files_for_dir(data_dir)
            for path in vector_files:
                try:
                    gdf = self._normalize_crs(self._read_vector_file(path))
                except Exception as exc:  # noqa: BLE001 - 单个图层损坏不应中断工参更新
                    logger.warning("跳过无法读取的场景图层 %s: %s", path, exc)
                    continue
                layer_name = path.stem
                added = 0
                for _, row in gdf.iterrows():
                    geometry = row.get("geometry")
                    if geometry is None or not isinstance(geometry, Polygon) and not hasattr(geometry, "geoms"):
                        continue
                    try:
                        if geometry.is_empty:
                            continue
                    except Exception:  # noqa: BLE001
                        continue
                    scene_name = self._scene_name_from_row(row, gdf.columns, layer_name)
                    polygons = geometry.geoms if hasattr(geometry, "geoms") else [geometry]
                    for polygon in polygons:
                        if isinstance(polygon, Polygon) and not polygon.is_empty:
                            self._entries.append((polygon, scene_name))
                            added += 1
                if added:
                    self.stats["layers"] += 1
                    logger.info("[场景匹配] 图层 %s 加载 %d 个面（场景 %s）", path.name, added, layer_name)

        if not self._entries:
            self.warning = (
                f"「场景图层.zip」中未解析到有效面要素，场景名称将统一填写「{DEFAULT_SCENE_NAME}」。"
            )
            logger.warning(self.warning)
            return False

        try:
            from shapely.strtree import STRtree

            self._tree = STRtree([geometry for geometry, _ in self._entries])
        except Exception as exc:  # noqa: BLE001 - 无索引时退化为线性扫描
            logger.warning("[场景匹配] STRtree 索引构建失败，改用线性扫描: %s", exc)
            self._tree = None

        self.available = True
        self.stats["polygons"] = len(self._entries)
        logger.info("[场景匹配] 加载完成: %d 个图层, %d 个面", self.stats["layers"], self.stats["polygons"])
        return True

    def match(self, longitude: Any, latitude: Any) -> Optional[str]:
        """返回场景名；坐标无效返回 None（工参留空），有效但未命中/无图层返回「农村」。"""
        try:
            lon = float(longitude)
            lat = float(latitude)
        except (TypeError, ValueError):
            return None
        if (not math.isfinite(lon) or not math.isfinite(lat)
                or lon == 0 or lat == 0
                or lon < -180 or lon > 180 or lat < -90 or lat > 90):
            return None
        if not self.available:
            return DEFAULT_SCENE_NAME

        from shapely.geometry import Point

        point = Point(lon, lat)
        indices = self._tree.query(point) if self._tree is not None else range(len(self._entries))
        for raw_idx in indices:
            idx = int(raw_idx)
            if 0 <= idx < len(self._entries):
                geometry, scene_name = self._entries[idx]
                if geometry.contains(point) or geometry.touches(point):
                    return scene_name
        return DEFAULT_SCENE_NAME
