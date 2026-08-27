"""
数据管理服务
"""

import json
import os
import sys
import uuid
import shutil
import glob
import re
from datetime import datetime
from typing import List, Optional, Dict, Any, Set, Tuple
from pathlib import Path
import pandas as pd
import numpy as np
import openpyxl

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.database import Workbook, Site, Sector, GeoFile, Layer
from app.models.schemas import DataItem, DataType, DataStatus, SiteData

# 设置stdout编码为utf-8，避免Windows下GBK编码问题
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except:
        pass  # 如果无法配置，忽略错误


# 日志捕获缓冲区（用于工参更新时实时推送后端输出到前端）
_print_buffer: List[str] = []
_print_buffer_active = False

def safe_print(msg: str):
    """安全打印函数，处理可能的编码错误"""
    # 如果日志捕获激活，同时写入缓冲区
    global _print_buffer, _print_buffer_active
    if _print_buffer_active:
        _print_buffer.append(msg)
    try:
        print(msg)
    except UnicodeEncodeError:
        # 如果打印失败，尝试使用GBK编码，替换无法编码的字符
        safe_msg = msg.encode("gbk", "replace").decode("gbk")
        print(safe_msg)
    except Exception:
        # 其他错误也尝试处理
        try:
            safe_msg = msg.encode("gbk", "replace").decode("gbk")
            print(safe_msg)
        except:
            pass  # 如果还是失败，放弃打印


class DataService:
    """数据管理服务类"""

    def __init__(self, lazy_load: bool = True):
        self.data_index_file = settings.DATA_DIR / "index.json"
        self._ensure_directories()
        self._load_index()
        # 数据缓存: {data_id: {"data": data_dict, "mtime": timestamp}}
        self._data_cache: Dict[str, Dict[str, Any]] = {}
        # 索引缓存时间戳
        self._index_mtime: Optional[float] = None
        # 小区搜索索引缓存: (workbook_id, normalized_items) 惰性搜索索引
        self._cell_search_cache = None
        # 扫描uploads目录 - 默认延迟加载以加快启动
        if not lazy_load:
            self._scan_uploads_directory()
        else:
            # 异步扫描，不阻塞启动
            import threading
            threading.Thread(target=self._scan_uploads_directory, daemon=True).start()

    def start_capture_logs(self):
        """激活日志捕获，开始收集 safe_print 输出到缓冲区"""
        global _print_buffer, _print_buffer_active
        _print_buffer = []
        _print_buffer_active = True

    def get_and_clear_captured_logs(self) -> List[str]:
        """获取并清空捕获的日志"""
        global _print_buffer, _print_buffer_active
        logs = list(_print_buffer)
        _print_buffer = []
        return logs

    def stop_capture_logs(self):
        """停用日志捕获"""
        global _print_buffer_active
        _print_buffer_active = False

    def _ensure_directories(self):
        """确保必要的目录存在"""
        settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        settings.DATA_DIR.mkdir(parents=True, exist_ok=True)

    def _load_index(self):
        """加载数据索引（优先 index.json，然后合并 SQLite 中缺失的条目）"""
        if self.data_index_file.exists():
            import json
            try:
                with open(self.data_index_file, "r", encoding="utf-8") as f:
                    self.index = json.load(f)
                safe_print(f"[DataService] 从 index.json 加载了 {len(self.index)} 个索引条目")
            except Exception as e:
                safe_print(f"[DataService] index.json 读取失败: {e}，重新构建索引")
                self.index = {}
        else:
            safe_print(f"[DataService] index.json 不存在，重新构建索引")
            self.index = {}

        # 合并 SQLite 中缺失的条目（应对异步流程未持久化 index.json 等场景）
        db_entries = self._collect_db_entries_for_index()
        missing = {k: v for k, v in db_entries.items() if k not in self.index}
        if missing:
            self.index.update(missing)
            self._save_index()
            safe_print(f"[DataService] 从 SQLite 合并了 {len(missing)} 个缺失条目到 index.json")
        safe_print(f"[DataService] 索引加载完成，共 {len(self.index)} 个条目")

    def _collect_db_entries_for_index(self) -> Dict:
        """从 SQLite 收集 Workbooks 和 GeoFiles 条目（用于合并到 index.json 缺失的部分）"""
        from app.core.database import init_db
        init_db()
        from app.models.database import User, Workbook, GeoFile
        entries: Dict = {}
        db = SessionLocal()
        try:
            users = db.query(User).all()
            user_name_map = {u.id: u.username for u in users}
            for wb in db.query(Workbook).order_by(Workbook.created_at.desc()).all():
                entries[wb.id] = {
                    "id": wb.id, "name": wb.name, "type": "excel",
                    "fileType": wb.file_type, "size": wb.size,
                    "uploadDate": wb.created_at, "status": wb.status,
                    "remark": wb.remark,
                    "metadata": json.loads(wb.metadata_json) if wb.metadata_json else {},
                    "user_id": wb.user_id,
                    "userName": user_name_map.get(wb.user_id, ""),
                    "originalPath": wb.original_path,
                }
            for gf in db.query(GeoFile).order_by(GeoFile.created_at.desc()).all():
                entries[gf.id] = {
                    "id": gf.id, "name": gf.filename, "type": "excel",
                    "fileType": "geo_data", "geometryType": gf.geometry_type,
                    "size": gf.file_size, "uploadDate": gf.created_at,
                    "status": "ready", "user_id": gf.user_id,
                    "userName": user_name_map.get(gf.user_id, ""),
                    "originalPath": gf.file_path,
                    "metadata": {"pointCount": gf.point_count},
                }
        finally:
            db.close()
        return entries

    def _build_index_from_db(self):
        """从 SQLite 构建内存索引（替代 index.json 文件读写）"""
        # 确保数据库迁移已执行（DataService 在模块加载时实例化，早于 lifespan 中的 init_db()）
        from app.core.database import init_db
        init_db()
        from app.models.database import User
        self.index = {}
        db = SessionLocal()
        try:
            # 预加载所有用户的 username 映射
            users = db.query(User).all()
            user_name_map: Dict[int, str] = {u.id: u.username for u in users}

            # 1) Workbooks (Excel 工参)
            for wb in db.query(Workbook).order_by(Workbook.created_at.desc()).all():
                self.index[wb.id] = {
                    "id": wb.id,
                    "name": wb.name,
                    "type": "excel",
                    "fileType": wb.file_type,
                    "size": wb.size,
                    "uploadDate": wb.created_at,
                    "status": wb.status,
                    "remark": wb.remark,
                    "metadata": json.loads(wb.metadata_json) if wb.metadata_json else {},
                    "user_id": wb.user_id,
                    "userName": user_name_map.get(wb.user_id, ""),
                    "originalPath": wb.original_path,
                }

            # 2) GeoFiles (地理化数据)
            for gf in db.query(GeoFile).order_by(GeoFile.created_at.desc()).all():
                self.index[gf.id] = {
                    "id": gf.id,
                    "name": gf.filename,
                    "type": "excel",
                    "fileType": "geo_data",
                    "geometryType": gf.geometry_type,
                    "size": gf.file_size,
                    "uploadDate": gf.created_at,
                    "status": "ready",
                    "user_id": gf.user_id,
                    "userName": user_name_map.get(gf.user_id, ""),
                    "originalPath": gf.file_path,
                    "metadata": {"pointCount": gf.point_count},
                }

            # 3) Layers (MapInfo 图层) — 按数据目录分组，避免重复索引条目
            all_layers = db.query(Layer).order_by(Layer.created_at.desc()).all()
            # 从 file_path 提取父级 data_id 并将同目录的图层归组
            _parent_map: Dict[str, List] = {}
            for layer in all_layers:
                # 尝试从文件路径推断 data_id（路径格式: .../data/<data_id>/...）
                _fp = layer.file_path or ""
                _parts = _fp.replace("\\", "/").split("/")
                _inferred_id = None
                for _i, _p in enumerate(_parts):
                    if _p == "data" and _i + 1 < len(_parts):
                        _candidate = _parts[_i + 1]
                        if len(_candidate) == 36 and _candidate.count("-") == 4:
                            _inferred_id = _candidate
                            break
                _parent_key = _inferred_id or layer.id
                if _parent_key not in _parent_map:
                    _parent_map[_parent_key] = []
                _parent_map[_parent_key].append(layer)

            _seen_parents = set()
            for _parent_key, _group_layers in _parent_map.items():
                if _parent_key in _seen_parents:
                    continue
                _seen_parents.add(_parent_key)

                _first = _group_layers[0]
                _layers_meta = []
                for _l in _group_layers:
                    _layers_meta.append({
                        "id": _l.id,
                        "name": _l.name,
                        "type": _l.geometry_type,
                        "feature_count": _l.feature_count,
                    })

                # 如果已有同名索引条目（如 Workbook），将图层信息合并进去
                # 而不是跳过。这样 ZIP 同时包含工参和 TAC 图层时，TAC 图层也能被搜索到。
                if _parent_key in self.index:
                    _existing = self.index[_parent_key]
                    # 将图层元数据追加到现有条目
                    _existing_meta = _existing.get("metadata", {}) or {}
                    _existing_layers = _existing_meta.get("layers", [])
                    _existing_layer_ids = {l.get("id") for l in _existing_layers}
                    for _lm in _layers_meta:
                        if _lm["id"] not in _existing_layer_ids:
                            _existing_layers.append(_lm)
                    _existing["metadata"] = {
                        **_existing_meta,
                        "layers": _existing_layers,
                        "layerCount": len(_existing_layers),
                    }
                    # 保持 type 为 map 以便 TAC 搜索能找到
                    # 但如果原来是 excel，保留 subtype 信息用于前端显示
                    if _existing.get("type") != "map":
                        _existing["_hasLayers"] = True
                    safe_print(f"[DataService] 已将 {len(_layers_meta)} 个图层合并到现有索引条目: {_parent_key}")
                    continue

                self.index[_parent_key] = {
                    "id": _parent_key,
                    "name": _first.name if len(_group_layers) == 1 else _first.name,
                    "type": "map",
                    "subType": "mapinfo",
                    "size": _first.file_size,
                    "uploadDate": _first.created_at,
                    "status": "ready",
                    "user_id": _first.user_id,
                    "userName": user_name_map.get(_first.user_id, ""),
                    "originalPath": _first.file_path,
                    "metadata": {
                        "layerCount": len(_group_layers),
                        "layers": _layers_meta,
                        "fileCount": len(_group_layers),
                    },
                }
        finally:
            db.close()

        # 4) 扫描 DATA_DIR 中未入库的现网工参目录（before-fix 数据）
        self._scan_missing_current_params()

        # 5) 回退：从遗留 index.json 导入 SQLite 中不存在的条目（map/geo_data 等）
        self._import_from_legacy_index()

    def _scan_missing_current_params(self):
        """扫描 DATA_DIR 中已有的现网工参目录，补充缺失的 Workbook 条目"""
        import re as _re
        _current_params_patterns = [
            r'LTE_SDR_CellInfo_.*\.csv',
            r'LTE_ITBBU_CellInfo_.*\.csv',
            r'NR_CellInfo_.*\.csv',
        ]

        db = SessionLocal()
        try:
            for _subdir in settings.DATA_DIR.iterdir():
                if not _subdir.is_dir():
                    continue
                _did = _subdir.name
                # 已在索引中，跳过
                if _did in self.index:
                    continue
                # 检查是否已有 Workbook 条目
                _existing = db.query(Workbook).filter(Workbook.id == _did).first()
                if _existing:
                    continue

                # 检查子目录是否包含现网工参 CSV 文件
                _is_params = False
                for _f in _subdir.rglob('*.csv'):
                    for _pat in _current_params_patterns:
                        if _re.match(_pat, _f.name, _re.IGNORECASE):
                            _is_params = True
                            break
                    if _is_params:
                        break

                if not _is_params:
                    continue

                # 找到了未入库的现网工参目录 — 补充 Workbook 条目
                safe_print(f"[DataService] 发现未入库的现网工参: {_did}")
                try:
                    _wb = Workbook(
                        id=_did,
                        user_id=1,
                        name=_subdir.name,
                        file_type="current_params",
                        network_types="[]",
                        status="ready",
                        size=None,
                        metadata_json=json.dumps({"isCurrentParams": True}, ensure_ascii=False),
                        created_at=datetime.now().isoformat(),
                    )
                    db.add(_wb)
                    db.commit()
                    safe_print(f"[DataService] 已补充 Workbook 条目: {_did}")

                    self.index[_did] = {
                        "id": _did,
                        "name": _subdir.name,
                        "type": "excel",
                        "fileType": "current_params",
                        "size": None,
                        "uploadDate": datetime.now().isoformat(),
                        "status": "ready",
                        "metadata": {"isCurrentParams": True},
                    }
                except Exception as _e:
                    db.rollback()
                    safe_print(f"[DataService] 补充 Workbook 失败 (非致命): {_e}")
        finally:
            db.close()

    def _import_from_legacy_index(self):
        """从遗留 index.json 导入 SQLite 中不存在的条目（过渡期兼容）"""
        legacy_file = settings.DATA_DIR / "index.json"
        if not legacy_file.exists():
            return

        try:
            with open(legacy_file, "r", encoding="utf-8") as f:
                legacy = json.load(f)

            imported = 0
            for data_id, data_info in legacy.items():
                if data_id not in self.index:
                    self.index[data_id] = data_info
                    imported += 1

            if imported > 0:
                safe_print(f"[DataService] 从遗留 index.json 导入了 {imported} 个条目（共 {len(legacy)} 个）")
        except Exception as e:
            safe_print(f"[DataService] 遗留 index.json 导入失败 (非致命): {e}")

    def reload_index(self):
        """重新加载数据索引（优先 index.json）"""
        self._load_index()
        safe_print(f"[DataService] 索引已重新加载，共 {len(self.index)} 个数据项")

    def _save_index(self):
        """保存数据索引到 index.json（原子写入）"""
        import json
        import tempfile
        import os as _os

        self.data_index_file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=str(self.data_index_file.parent), suffix=".tmp")
        try:
            with _os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.index, f, ensure_ascii=False, indent=2)
            _os.replace(tmp_path, str(self.data_index_file))
        except Exception:
            if _os.path.exists(tmp_path):
                _os.unlink(tmp_path)
            raise

    def _scan_uploads_directory(self):
        """扫描uploads目录中的文件，发现 SQLite 中不存在的文件时自动迁移导入"""
        safe_print(f"[DataService] 开始扫描uploads目录...")

        db = SessionLocal()
        try:
            existing_ids = {wb.id for wb in db.query(Workbook.id).all()}
            existing_layer_ids = {l.id for l in db.query(Layer.id).all()}
        finally:
            db.close()

        # 扫描 xlsx 和 zip 文件
        _scan_patterns = ["*.xlsx", "*.zip"]
        for _pattern in _scan_patterns:
            for file_path in settings.UPLOAD_DIR.glob(_pattern):
                filename = file_path.stem
                if "-" in filename and len(filename.split("-")) == 5:
                    data_id = filename

                    if data_id not in self.index and data_id not in existing_ids and data_id not in existing_layer_ids:
                        safe_print(f"[DataService] 找到未入库文件: {file_path.name}, 尝试迁移...")
                        data_dir = settings.DATA_DIR / data_id
                        if data_dir.exists() and ((data_dir / "original.xlsx").exists() or (data_dir / "original.zip").exists()):
                            try:
                                self._migrate_legacy_data(data_id)
                            except Exception as e:
                                safe_print(f"[DataService] 迁移失败 {file_path.name}: {e}")

        safe_print(f"[DataService] 扫描完成，共 {len(self.index)} 个文件在索引中")

    def parse_points(self, file_path: str) -> List[Dict[str, Any]]:
        """从文件解析点数据"""
        path = Path(file_path)
        if not path.exists():
            raise ValueError(f"文件不存在: {file_path}")

        ext = path.suffix.lower()
        df = None

        try:
            if ext in [".xlsx", ".xls"]:
                df = pd.read_excel(path)
            elif ext == ".csv":
                try:
                    df = pd.read_csv(path, encoding="gbk")
                except:
                    df = pd.read_csv(path, encoding="utf-8")
            elif ext == ".txt":
                # 尝试各种分隔符
                success = False
                for sep in [",", "\t", ";", " "]:
                    try:
                        df = pd.read_csv(path, sep=sep, encoding="gbk")
                        if len(df.columns) > 1:
                            success = True
                            break
                    except:
                        continue
                if not success:
                    try:
                        df = pd.read_csv(path, sep=",", encoding="utf-8")
                    except:
                        raise ValueError("无法解析TXT文件")
            else:
                raise ValueError(f"不支持的文件格式: {ext}")
        except Exception as e:
            raise ValueError(f"读取文件失败: {str(e)}")

        if df is None or df.empty:
            return []

        # 智能匹配列名
        columns = df.columns.tolist()
        lat_col = None
        lng_col = None
        name_col = None

        lat_patterns = [r"lat", r"纬度", r"緯度", r"latitude"]
        lng_patterns = [r"lon", r"lng", r"经度", r"經度", r"longitude"]
        name_patterns = [r"name", r"名称", r"名稱", r"小区名", r"站名"]

        for col in columns:
            col_lower = str(col).lower()
            if not lat_col and any(re.search(p, col_lower) for p in lat_patterns):
                lat_col = col
            if not lng_col and any(re.search(p, col_lower) for p in lng_patterns):
                lng_col = col
            if not name_col and any(re.search(p, col_lower) for p in name_patterns):
                name_col = col

        if not lat_col or not lng_col:
            raise ValueError(
                "未找到经纬度列，请确保包含'经度/纬度'或'longitude/latitude'列"
            )

        points = []
        for _, row in df.iterrows():
            lat = row[lat_col]
            lng = row[lng_col]
            name = row[name_col] if name_col else "未命名点"

            try:
                lat_val = float(lat)
                lng_val = float(lng)
                if pd.isna(lat_val) or pd.isna(lng_val):
                    continue

                points.append(
                    {"name": str(name), "latitude": lat_val, "longitude": lng_val}
                )
            except:
                continue

        return points

    def update_parameters(
        self, full_param_id: str, current_param_id: str,
        username: str = "", user_id: int = 1,
    ) -> Dict[str, Any]:
        """更新工参"""
        safe_print(
            f"[DataService] 开始更新工参: Full={full_param_id}, Current={current_param_id}"
        )

        # 先尝试从内存索引查找
        full_info = self.index.get(full_param_id)
        current_info = self.index.get(current_param_id)

        # 如果内存索引未找到，尝试从磁盘重新加载
        if not full_info or not current_info:
            safe_print(f"[DataService] 内存索引未找到ID，尝试从磁盘重新加载索引...")
            self.reload_index()
            full_info = self.index.get(full_param_id)
            current_info = self.index.get(current_param_id)

        # 如果磁盘索引也未找到，尝试在文件系统中查找
        missing_ids = []
        if not full_info:
            full_dir = settings.DATA_DIR / full_param_id
            if full_dir.exists() and (full_dir / "original.xlsx").exists():
                safe_print(f"[DataService] 在文件系统中找到全量工参数据目录，重建索引...")
                full_info = {
                    "id": full_param_id,
                    "name": full_dir.name,
                    "type": "excel",
                    "fileType": "full_params",
                    "status": "ready",
                }
                self.index[full_param_id] = full_info
        
            else:
                missing_ids.append(f"全量工参({full_param_id[:8]}...)")

        if not current_info:
            current_dir = settings.DATA_DIR / current_param_id
            if current_dir.exists():
                safe_print(f"[DataService] 在文件系统中找到现网工参数据目录，重建索引...")
                current_info = {
                    "id": current_param_id,
                    "name": current_dir.name,
                    "type": "map",
                    "fileType": "current_params",
                    "status": "ready",
                }
                self.index[current_param_id] = current_info
        
            else:
                missing_ids.append(f"现网工参({current_param_id[:8]}...)")

        if missing_ids:
            safe_print(
                f"[DataService] ❌ ID不在索引中且文件系统中未找到! 当前索引共 {len(self.index)} 条"
            )
            safe_print(
                f"[DataService] 请求: full={full_param_id}, current={current_param_id}"
            )
            safe_print(
                f"[DataService] 索引中的全部ID: {list(self.index.keys())}"
            )
            raise ValueError(f"找不到指定的文件ID: {', '.join(missing_ids)}")

        full_dir = settings.DATA_DIR / full_param_id
        current_dir = settings.DATA_DIR / current_param_id

        original_excel = full_dir / "original.xlsx"
        if not original_excel.exists():
            raise ValueError("全量工参原始文件不存在")

        # 2. 准备输出文件
        # 生成新文件名：原文件名 + 时间戳
        original_name = full_info["name"]
        name_part, ext_part = os.path.splitext(original_name)
        # 移除可能已有的时间戳（简单处理：如果文件名以数字结尾，可能是时间戳）
        # 这里直接追加时间戳
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")

        # 尝试替换文件名中的最后一段数字串（如果存在）
        new_name = re.sub(r"\d{14}", timestamp, name_part)
        if new_name == name_part:
            new_name = f"{name_part}_{timestamp}"

        new_filename = f"{new_name}{ext_part}"

        # 创建新的数据ID
        new_data_id = str(uuid.uuid4())
        new_data_dir = settings.DATA_DIR / new_data_id
        new_data_dir.mkdir(parents=True, exist_ok=True)

        output_excel_path = new_data_dir / "original.xlsx"

        # 3. 加载Excel
        safe_print(f"[DataService] 加载Excel: {original_excel}")
        try:
            wb = openpyxl.load_workbook(original_excel)
        except Exception as e:
            raise ValueError(f"无法打开Excel文件: {e}")

        # 4. 处理LTE
        if "LTE Project Parameters" in wb.sheetnames:
            safe_print(f"[DataService] 处理LTE工参...")
            self._update_sheet(wb["LTE Project Parameters"], current_dir, "LTE")
        else:
            safe_print(f"[DataService] 警告: 未找到 'LTE Project Parameters' Sheet")

        # 5. 处理NR
        if "NR Project Parameters" in wb.sheetnames:
            safe_print(f"[DataService] 处理NR工参...")
            self._update_sheet(wb["NR Project Parameters"], current_dir, "NR")
        else:
            safe_print(f"[DataService] 警告: 未找到 'NR Project Parameters' Sheet")

        # 6. 保存结果
        safe_print(f"[DataService] 保存结果到: {output_excel_path}")
        wb.save(output_excel_path)
        wb.close()

        # 7. 解析新文件并写入 SQLite
        safe_print(f"[DataService] 解析新文件并写入 SQLite...")
        metadata = {}
        try:
            import json

            xls = pd.ExcelFile(output_excel_path, engine='calamine')
            parsed_data = {}

            with xls:
                sheet_names = xls.sheet_names
                for network in ["LTE", "NR"]:
                    sheet_name = f"{network} Project Parameters"
                    if sheet_name in sheet_names:
                        sites = self._parse_sheet_data(xls, sheet_name, network)
                        parsed_data[network] = sites
                        metadata[f"{network}SiteCount"] = len(sites)
                        metadata[f"{network}SectorCount"] = sum(
                            len(s.get("sectors", [])) for s in sites
                        )

            # 写入 SQLite（含备注）
            user_id_val = full_info.get("user_id", 1)
            now_str = datetime.now().strftime("%Y/%m/%d %H:%M")
            remark = f"{now_str} {username} 更新" if username else f"{now_str} 更新"
            self._save_to_sqlite(
                data_id=new_data_id,
                filename=new_filename,
                file_type="full_params",
                user_id=user_id_val,
                parsed_data=parsed_data,
                metadata=metadata,
                file_path=output_excel_path,
                original_path=full_info.get("originalPath"),
                remark=remark,
            )

        except Exception as e:
            safe_print(f"[DataService] 解析新文件失败: {e}")
            # 即使解析失败，文件已经生成，我们还是注册它
            pass

        # 8. 注册新文件 & 保存到原始路径（如果存在）
        # 复制一份到uploads目录以便下载（模拟上传行为）
        new_upload_path = settings.UPLOAD_DIR / f"{new_data_id}.xlsx"
        shutil.copy(output_excel_path, new_upload_path)

        # 尝试保存到原始目录
        saved_to_original = False
        original_path = full_info.get("originalPath")
        safe_print(
            f"[DataService] 原始路径信息: originalPath='{original_path}', 类型={type(original_path).__name__}"
        )

        if original_path:
            try:
                # 确保路径是绝对路径并处理编码
                original_file_path = os.path.abspath(original_path)
                original_dir = os.path.dirname(original_file_path)

                safe_print(
                    f"[DataService] 解析后路径: original_file_path='{original_file_path}', original_dir='{original_dir}'"
                )

                if os.path.exists(original_dir):
                    target_path = os.path.join(original_dir, new_filename)
                    safe_print(f"[DataService] 准备保存副本到: {target_path}")

                    shutil.copy2(output_excel_path, target_path)
                    if os.path.exists(target_path):
                        safe_print(f"[DataService] [OK] 副本保存成功到原路径!")
                        saved_to_original = True
                    else:
                        safe_print(f"[DataService] [X] 副本保存失败 - 文件不存在")
                else:
                    safe_print(f"[DataService] [X] 原始目录不存在: {original_dir}")
            except Exception as e:
                safe_print(
                    f"[DataService] [X] 无法保存到原始目录 ({original_path}): {e}"
                )
                import traceback

                traceback.print_exc()
        else:
            safe_print(
                f"[DataService] [X] 未能获取到原始路径 (originalPath is empty or None)"
            )
            safe_print(f"[DataService] 提示: 请检查前端是否正确传递了 file_path 参数")

        # 9. 注册新文件
        self.index[new_data_id] = {
            "id": new_data_id,
            "name": new_filename,
            "type": "excel",
            "fileType": "full_params",
            "size": output_excel_path.stat().st_size,
            "uploadDate": datetime.now().isoformat(),
            "status": "ready",
            "originalPath": full_info.get("originalPath"),  # 继承路径
            "metadata": metadata,
            "user_id": full_info.get("user_id", 1),
            "remark": remark,
        }

        safe_print(f"[DataService] 新文件已注册到索引: {new_data_id}")

        # 10. 删除原始的全量工参和其他旧的全量工参，保持唯一性
        files_to_delete = []
        for existing_id, existing_data in self.index.items():
            # 删除所有其他 full_params 文件（包括原始的 full_param_id），只保留新注册的 new_data_id
            if existing_id != new_data_id and existing_data.get("fileType") == "full_params":
                files_to_delete.append(existing_id)

        if files_to_delete:
            safe_print(
                f"[DataService] 工参更新：删除 {len(files_to_delete)} 个旧的全量工参..."
            )
            for old_id in files_to_delete:
                try:
                    self.delete_data(old_id)
                    safe_print(f"[DataService] 已删除旧全量工参: {old_id}")
                except Exception as e:
                    safe_print(f"[DataService] 删除旧文件失败: {old_id}, 错误: {e}")

        safe_print(f"[DataService] 索引已更新，当前全量工参数量: 1")
        self._save_index()  # 持久化工参更新结果

        # 验证新文件存在
        safe_print(f"[DataService] 验证新文件: data/{new_data_id}/original.xlsx 存在={output_excel_path.exists()}, uploads/{new_data_id}.xlsx 存在={new_upload_path.exists()}")

        return {
            "newFileId": new_data_id,
            "newFileName": new_filename,
            "savedToOriginal": saved_to_original,
        }

    def add_cell_to_full_params(
        self,
        network_type: str,
        managed_element_id: str,
        site_id: str,
        cell_id: str,
        cell_name: str,
        longitude: float,
        latitude: float,
        azimuth: float,
        frequency: Optional[str] = None,
        ssb_frequency: Optional[str] = None,
        cell_cover_type: int = 1,
        user_id: int = 1,
    ) -> Dict[str, Any]:
        """向全量工参文件追加一个新小区（新站录入）

        同时写入 Excel 文件（LTE/NR Project Parameters sheet）和 SQLite 数据库。
        """
        # 1. 定位全量工参文件
        full_params_id = self._find_full_params_id()
        full_params_info = self.index.get(full_params_id) if full_params_id else None

        if not full_params_id or not full_params_info:
            raise ValueError("未找到全量工参文件，请先上传全量工参")

        safe_print(f"[DataService] 新站录入: 定位到全量工参 {full_params_id}")

        data_dir = settings.DATA_DIR / full_params_id
        excel_path = data_dir / "original.xlsx"
        if not excel_path.exists():
            raise ValueError(f"全量工参原始文件不存在: {excel_path}")

        # 查重：在追加 Excel 之前检查该小区是否已存在，避免重复导入
        if self._sector_exists(full_params_id, site_id, cell_id):
            safe_print(f"[DataService] 小区已存在，跳过导入: {site_id}_{cell_id}")
            db_type = self._get_sector_network_type(full_params_id, site_id, cell_id)
            return {
                "success": True,
                "message": self._duplicate_message(
                    str(network_type).upper(), db_type, cell_name
                ),
                "cellId": f"{site_id}_{cell_id}",
            }

        # 2. 确定 sheet 名
        sheet_name = f"{network_type.upper()} Project Parameters"

        # 3. 加载 Excel 并构建 col_map
        try:
            wb = openpyxl.load_workbook(excel_path)
        except Exception as e:
            raise ValueError(f"无法打开 Excel 文件: {e}")

        if sheet_name not in wb.sheetnames:
            wb.close()
            raise ValueError(f"Sheet 不存在: {sheet_name}，可用 Sheets: {wb.sheetnames}")

        ws = wb[sheet_name]
        header_row = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]

        col_map = {}
        for idx, col_val in enumerate(header_row):
            if col_val:
                clean_name = str(col_val).strip().split("\n")[0].strip()
                col_map[clean_name] = idx + 1

        safe_print(f"[DataService] col_map: {col_map}")

        # 4. 准备新行数据
        max_col = max(col_map.values()) if col_map else 0
        new_row = [None] * max_col

        # 字段映射：用户输入 → Excel 列名
        if network_type.upper() == "LTE":
            field_map = {
                "管理网元ID": managed_element_id,
                "eNodeB标识": site_id,
                "小区标识": cell_id,
                "小区名称": cell_name,
                "天线方向角": azimuth,
                "下行链路的中心载频": frequency or "",
                "小区覆盖类型": cell_cover_type,
            }
        else:  # NR
            field_map = {
                "管理网元ID": managed_element_id,
                "gNodeB标识": site_id,
                "小区标识": cell_id,
                "小区名称": cell_name,
                "天线方向角": azimuth,
                "填写SSB频点": ssb_frequency or "",
                "小区覆盖类型": cell_cover_type,
            }

        # 经纬度写入多种可能列名（值保持一致）
        lon_candidates = ["小区经度", "基站经度", "经度"]
        lat_candidates = ["小区纬度", "基站纬度", "纬度"]
        for lon_col in lon_candidates:
            if lon_col in col_map:
                new_row[col_map[lon_col] - 1] = longitude
        for lat_col in lat_candidates:
            if lat_col in col_map:
                new_row[col_map[lat_col] - 1] = latitude

        # 写入映射字段
        for excel_col, val in field_map.items():
            if excel_col in col_map:
                new_row[col_map[excel_col] - 1] = val

        # 5. 固定字段设置（遵循 _append_new_row 的模式）
        if "系统制式" in col_map:
            new_row[col_map["系统制式"] - 1] = 1
        if "第一分组" in col_map:
            new_row[col_map["第一分组"] - 1] = "电信中兴"
        if "是否现网" in col_map:
            new_row[col_map["是否现网"] - 1] = "是"
        if "第二分组" in col_map:
            second_group = self._determine_second_group(cell_name)
            if second_group:
                new_row[col_map["第二分组"] - 1] = second_group

        # 生成 CGI 列
        if "CGI" in col_map:
            try:
                _site_int = str(int(float(str(site_id)))) if site_id else ""
                _cell_int = str(int(float(str(cell_id)))) if cell_id else ""
                cgi = f"{_site_int}-{_cell_int}"
                new_row[col_map["CGI"] - 1] = cgi
            except (ValueError, TypeError):
                pass

        # 6. 追加行并保存 Excel
        ws.append(new_row)
        wb.save(excel_path)
        wb.close()
        safe_print(f"[DataService] Excel 已保存: {excel_path}")

        # 7. 同步保存到 uploads 目录的副本
        upload_path = settings.UPLOAD_DIR / f"{full_params_id}.xlsx"
        if upload_path.exists():
            try:
                import shutil
                shutil.copy2(excel_path, upload_path)
                safe_print(f"[DataService] 已同步更新 uploads 副本")
            except Exception as e:
                safe_print(f"[DataService] 同步 uploads 副本失败 (非致命): {e}")

        # 8. 写入 SQLite
        sector_id_str = f"{site_id}_{cell_id}"
        full_name = full_params_info.get("name", "unknown")
        network_type_val = network_type.upper()
        try:
            db = SessionLocal()
            try:
                # 查重：按 workbook_id + sector_id 检查是否已存在
                existing_sector = db.query(Sector).filter(
                    Sector.workbook_id == full_params_id,
                    Sector.sector_id == sector_id_str,
                ).first()
                if existing_sector:
                    safe_print(f"[DataService] 小区已存在于 SQLite，跳过写入: {sector_id_str}")
                    db.close()
                    return {
                        "success": True,
                        "message": f"小区 {cell_name} 已存在，已在 Excel 中更新覆盖",
                        "cellId": sector_id_str,
                    }

                # 查询或创建 Site
                site = db.query(Site).filter(
                    Site.workbook_id == full_params_id,
                    Site.site_id == str(site_id),
                ).first()

                if not site:
                    site = Site(
                        workbook_id=full_params_id,
                        user_id=user_id,
                        site_id=str(site_id),
                        name=cell_name,
                        longitude=longitude,
                        latitude=latitude,
                        network_type=network_type_val,
                        managed_element_id=managed_element_id,
                    )
                    db.add(site)
                    db.flush()
                    safe_print(f"[DataService] 新建 Site: {site_id}")

                # 写入 Sector
                freq_val = frequency or ssb_frequency or None
                if freq_val is not None:
                    try:
                        freq_val = float(freq_val)
                    except (ValueError, TypeError):
                        pass

                sector = Sector(
                    site_id_fk=site.id,
                    workbook_id=full_params_id,
                    user_id=user_id,
                    sector_id=sector_id_str,
                    name=cell_name,
                    longitude=longitude,
                    latitude=latitude,
                    azimuth=azimuth,
                    frequency=freq_val,
                    cell_cover_type=cell_cover_type,
                    first_group="电信中兴",
                )
                db.add(sector)
                db.commit()
                safe_print(f"[DataService] SQLite 写入成功: Site={site_id}, Sector={sector_id_str}")
            except Exception as e:
                db.rollback()
                safe_print(f"[DataService] SQLite 写入失败 (非致命): {e}")
            finally:
                db.close()
        except Exception as e:
            safe_print(f"[DataService] SQLite 连接失败 (非致命): {e}")

        # 9. 更新 index.json 中的文件大小
        excel_size = excel_path.stat().st_size
        if full_params_id in self.index:
            self.index[full_params_id]["size"] = excel_size
        self._save_index()

        safe_print(f"[DataService] 新站录入完成: {cell_name} ({network_type_val})")
        self._invalidate_cell_search_index()

        return {
            "success": True,
            "message": f"新增小区 {cell_name} 成功",
            "cellId": sector_id_str,
        }

    def _find_full_params_id(self) -> Optional[str]:
        """定位全量工参文件 id（约定全局唯一；多个时告警并取第一个）"""
        found = [
            (_id, _info) for _id, _info in self.index.items()
            if isinstance(_info, dict) and _info.get("fileType") == "full_params"
        ]
        if len(found) > 1:
            safe_print(f"[DataService] WARN: 检测到 {len(found)} 个全量工参文件，仅使用第一个: {found[0][0]}")
        return found[0][0] if found else None

    def _invalidate_cell_search_index(self):
        """写入后使搜索索引失效，下次搜索重建"""
        self._cell_search_cache = None

    def _load_cell_search_index(self, workbook_id: str):
        """惰性构建搜索索引：Site+Sector 一次连接读出，归一化后缓存。"""
        if self._cell_search_cache is not None and self._cell_search_cache[0] == workbook_id:
            return self._cell_search_cache[1]

        db = SessionLocal()
        items = []
        try:
            rows = db.query(Site, Sector).join(Sector, Sector.site_id_fk == Site.id).filter(
                Site.workbook_id == workbook_id
            ).all()
            for site, sector in rows:
                sid = str(sector.sector_id)
                cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
                def _norm(v):
                    return (str(v or "").strip().lower())
                hay = "|".join([
                    _norm(sector.name),
                    _norm(site.site_id),
                    _norm(site.managed_element_id),
                    _norm(site.name),
                ])
                items.append({
                    "rowKey": f"{site.id}:{sector.id}",
                    "networkType": str(site.network_type or "").upper(),
                    "siteId": str(site.site_id),
                    "cellId": cell_id,
                    "cellName": sector.name or "",
                    "siteName": site.name,
                    "managedElementId": site.managed_element_id,
                    "mcc": sector.mcc,
                    "mnc": sector.mnc,
                    "longitude": sector.longitude,
                    "latitude": sector.latitude,
                    "azimuth": sector.azimuth,
                    "frequency": sector.frequency if str(site.network_type or "").upper() == "LTE" else None,
                    "ssbFrequency": sector.frequency if str(site.network_type or "").upper() == "NR" else None,
                    "cellCoverType": sector.cell_cover_type or 1,
                    "_hay": hay,
                })
        finally:
            db.close()
        self._cell_search_cache = (workbook_id, items)
        return items

    def search_cells(self, query: str, network_type: Optional[str] = None,
                     limit: int = 20, workbook_id: Optional[str] = None) -> List[Dict]:
        """智能模糊搜索：小区名/网元ID/基站ID/站点名，返回 top-N。"""
        if not workbook_id:
            workbook_id = self._find_full_params_id()
        if not workbook_id:
            return []
        q = query.strip().lower()
        if not q:
            return []
        nt_filter = (network_type or "").upper() or None

        items = self._load_cell_search_index(workbook_id)
        matched = []
        for it in items:
            if nt_filter and it["networkType"] != nt_filter:
                continue
            if q in it["_hay"]:
                score = 0
                if it["cellName"] and it["cellName"].strip().lower().startswith(q):
                    score += 100
                if it["siteName"] and it["siteName"].strip().lower().startswith(q):
                    score += 90
                if it["managedElementId"] and str(it["managedElementId"]).strip().lower().startswith(q):
                    score += 80
                if it["siteId"] and str(it["siteId"]).strip().lower().startswith(q):
                    score += 70
                if it["cellName"] and q in it["cellName"].strip().lower():
                    score += 20
                if it["siteName"] and q in it["siteName"].strip().lower():
                    score += 15
                matched.append((score, it))

        matched.sort(key=lambda x: (-x[0], x[1]["cellName"] or ""))
        return [m[1] for m in matched[:limit]]

    def batch_add_cells_to_full_params(self, cells: List[Dict]) -> Dict[str, Any]:
        """高性能批量向全量工参追加多个小区（一次性文件操作 + 单事务 SQLite）

        Excel 文件只打开/保存各 1 次，SQLite 使用单事务批量写入。
        cells: [{ networkType, managedElementId, siteId, cellId, cellName, longitude, latitude,
                  azimuth, frequency, ssbFrequency, cellCoverType, userId }]
        返回: { results: [...], total: N, successCount: N }
        """
        # 1. 定位全量工参文件（只需定位一次）
        full_params_id = self._find_full_params_id()
        full_params_info = self.index.get(full_params_id) if full_params_id else None

        if not full_params_id or not full_params_info:
            raise ValueError("未找到全量工参文件，请先上传全量工参")

        data_dir = settings.DATA_DIR / full_params_id
        excel_path = data_dir / "original.xlsx"
        if not excel_path.exists():
            raise ValueError(f"全量工参原始文件不存在: {excel_path}")

        upload_path = settings.UPLOAD_DIR / f"{full_params_id}.xlsx"

        safe_print(f"[DataService] 批量新站录入: {len(cells)} 条, 文件 {full_params_id}")

        # 2. 一次性加载 Excel，获取 LTE/NR 两个 sheet
        try:
            wb = openpyxl.load_workbook(excel_path)
        except Exception as e:
            raise ValueError(f"无法打开 Excel 文件: {e}")

        results = [None] * len(cells)  # pre-allocate to preserve original order

        # 预加载数据库中已有小区 key（site_id + cell_id）→ 制式，用于 Excel 追加前查重
        # 兼容两种 Sector.sector_id 存储格式：纯 cellId 与 siteId_cellId
        existing_cell_keys: Dict[str, str] = {}
        try:
            db = SessionLocal()
            try:
                rows = db.query(Site.site_id, Sector.sector_id, Site.network_type).join(
                    Sector, Sector.site_id_fk == Site.id
                ).filter(Site.workbook_id == full_params_id).all()
                for site_id_val, sector_id_val, net_type in rows:
                    sid = str(sector_id_val)
                    if "_" not in sid:
                        # 纯 cellId 格式（如 '61'）：key = siteId_cellId
                        key = f"{site_id_val}_{sid}"
                    else:
                        # 组合格式（如 '541379_61'）：取最后一段作为 cellId
                        cell_part = sid.rsplit("_", 1)[-1]
                        key = f"{site_id_val}_{cell_part}"
                    existing_cell_keys[key] = str(net_type or "").upper()
            finally:
                db.close()
        except Exception as e:
            safe_print(f"[DataService] 预加载已有小区失败 (非致命): {e}")

        # 过滤重复行：与数据库中已有 (site_id, cell_id) 相同的小区跳过
        # 同制式重复 → "已重复，信息已更新覆盖"；跨制式重复 → "已在[其他制式]工参中存在，请检查"（均不导入）
        filtered_cells = []
        skip_map = {}  # orig_idx -> 原因
        for idx, cell in enumerate(cells):
            site_id_val = str(cell.get("siteId", "")).strip()
            cell_id_val = str(cell.get("cellId", "")).strip()
            key = f"{site_id_val}_{cell_id_val}"
            if key in existing_cell_keys:
                panel_type = str(cell.get("networkType", "")).upper()
                db_type = existing_cell_keys[key]
                skip_map[idx] = "已存在"
                results[idx] = {
                    "index": idx,
                    "networkType": panel_type,
                    "cellName": cell.get("cellName", ""),
                    "siteId": site_id_val,
                    "cellId": cell_id_val,
                    "success": True,
                    "message": self._duplicate_message(panel_type, db_type, cell.get("cellName", "")),
                }
            else:
                filtered_cells.append((idx, cell))
                existing_cell_keys[key] = str(cell.get("networkType", "")).upper()  # 批内后续行查重

        # 按网络类型分组（基于过滤后的行）
        lte_cells = [(i, c) for i, c in filtered_cells if c.get("networkType", "").upper() == "LTE"]
        nr_cells = [(i, c) for i, c in filtered_cells if c.get("networkType", "").upper() == "NR"]
        skipped_count = len(skip_map)
        if skipped_count:
            safe_print(f"[DataService] 批量新站录入: 跳过 {skipped_count} 条已存在小区")

        def _build_row_data(cell: Dict, ws) -> tuple:
            """构建单行数据并写入 ws，返回 (row_data_list, col_map)"""
            header_row = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
            col_map = {}
            for idx, col_val in enumerate(header_row):
                if col_val:
                    clean_name = str(col_val).strip().split("\n")[0].strip()
                    col_map[clean_name] = idx + 1

            max_col = max(col_map.values()) if col_map else 0
            new_row = [None] * max_col

            network_type = cell.get("networkType", "").upper()
            managed_element_id = cell.get("managedElementId", "")
            site_id = cell.get("siteId", "")
            cell_id = cell.get("cellId", "")
            cell_name = cell.get("cellName", "")
            longitude = cell.get("longitude", 0)
            latitude = cell.get("latitude", 0)
            azimuth = cell.get("azimuth", 0)
            frequency = cell.get("frequency") or ""
            ssb_frequency = cell.get("ssbFrequency") or ""
            cell_cover_type = cell.get("cellCoverType", 1)
            mcc = cell.get("mcc") or ""
            mnc = cell.get("mnc") or ""

            # 字段映射
            if network_type == "LTE":
                field_map = {
                    "管理网元ID": managed_element_id,
                    "eNodeB标识": site_id,
                    "小区标识": cell_id,
                    "小区名称": cell_name,
                    "天线方向角": azimuth,
                    "下行链路的中心载频": frequency,
                    "小区覆盖类型": cell_cover_type,
                }
            else:
                field_map = {
                    "管理网元ID": managed_element_id,
                    "gNodeB标识": site_id,
                    "小区标识": cell_id,
                    "小区名称": cell_name,
                    "天线方向角": azimuth,
                    "填写SSB频点": ssb_frequency,
                    "小区覆盖类型": cell_cover_type,
                }

            # 经纬度
            lon_candidates = ["小区经度", "基站经度", "经度"]
            lat_candidates = ["小区纬度", "基站纬度", "纬度"]
            for lon_col in lon_candidates:
                if lon_col in col_map:
                    new_row[col_map[lon_col] - 1] = longitude
            for lat_col in lat_candidates:
                if lat_col in col_map:
                    new_row[col_map[lat_col] - 1] = latitude

            for excel_col, val in field_map.items():
                if excel_col in col_map:
                    new_row[col_map[excel_col] - 1] = val

            # MCC
            if mcc and "移动国家码" in col_map:
                new_row[col_map["移动国家码"] - 1] = mcc
            # MNC
            if mnc and "移动网络码" in col_map:
                new_row[col_map["移动网络码"] - 1] = mnc

            # 固定字段
            if "系统制式" in col_map:
                new_row[col_map["系统制式"] - 1] = 1
            if "第一分组" in col_map:
                new_row[col_map["第一分组"] - 1] = "电信中兴"
            if "是否现网" in col_map:
                new_row[col_map["是否现网"] - 1] = "是"
            if "第二分组" in col_map:
                second_group = self._determine_second_group(cell_name)
                if second_group:
                    new_row[col_map["第二分组"] - 1] = second_group
            if "CGI" in col_map:
                try:
                    _site_int = str(int(float(str(site_id)))) if site_id else ""
                    _cell_int = str(int(float(str(cell_id)))) if cell_id else ""
                    new_row[col_map["CGI"] - 1] = f"{_site_int}-{_cell_int}"
                except (ValueError, TypeError):
                    pass

            return new_row

        # 3. 逐行准备数据，写入 sheet 缓存
        try:
            # 处理 LTE
            if lte_cells:
                sheet_name = "LTE Project Parameters"
                if sheet_name not in wb.sheetnames:
                    raise ValueError(f"Sheet 不存在: {sheet_name}")
                lte_ws = wb[sheet_name]
                for orig_idx, cell in lte_cells:
                    row_data = _build_row_data(cell, lte_ws)
                    lte_ws.append(row_data)
                    results[orig_idx] = {
                        "index": orig_idx,
                        "networkType": "LTE",
                        "cellName": cell.get("cellName", ""),
                        "siteId": cell.get("siteId", ""),
                        "cellId": cell.get("cellId", ""),
                        "success": True,
                        "message": "Excel 行已准备",
                    }

            # 处理 NR
            if nr_cells:
                sheet_name = "NR Project Parameters"
                if sheet_name not in wb.sheetnames:
                    raise ValueError(f"Sheet 不存在: {sheet_name}")
                nr_ws = wb[sheet_name]
                for orig_idx, cell in nr_cells:
                    row_data = _build_row_data(cell, nr_ws)
                    nr_ws.append(row_data)
                    results[orig_idx] = {
                        "index": orig_idx,
                        "networkType": "NR",
                        "cellName": cell.get("cellName", ""),
                        "siteId": cell.get("siteId", ""),
                        "cellId": cell.get("cellId", ""),
                        "success": True,
                        "message": "Excel 行已准备",
                    }
        except Exception as e:
            wb.close()
            raise

        # 4. 一次性保存 Excel
        try:
            wb.save(excel_path)
            safe_print(f"[DataService] 批量 Excel 已保存: {excel_path}")
        except Exception as e:
            wb.close()
            raise ValueError(f"保存 Excel 失败: {e}")
        wb.close()

        # 5. 同步到 uploads 副本（一次性）
        if upload_path.exists():
            try:
                shutil.copy2(excel_path, upload_path)
                safe_print(f"[DataService] 已同步更新 uploads 副本")
            except Exception as e:
                safe_print(f"[DataService] 同步 uploads 副本失败 (非致命): {e}")

        # 6. 批量写入 SQLite（单事务，仅写入过滤后的非重复行）
        sqlite_success = True
        sqlite_error_msg = ""
        try:
            db = SessionLocal()
            try:
                for idx, cell in filtered_cells:
                    network_type = cell.get("networkType", "").upper()
                    site_id = cell.get("siteId", "")
                    cell_id = cell.get("cellId", "")
                    cell_name = cell.get("cellName", "")
                    longitude = cell.get("longitude", 0)
                    latitude = cell.get("latitude", 0)
                    azimuth = cell.get("azimuth", 0)
                    frequency = cell.get("frequency") or cell.get("ssbFrequency")
                    cell_cover_type = cell.get("cellCoverType", 1)
                    managed_element_id = cell.get("managedElementId", "")
                    user_id = cell.get("userId", 1)

                    sector_id_str = f"{site_id}_{cell_id}"

                    mcc = cell.get("mcc") or ""
                    mnc = cell.get("mnc") or ""

                    # 查找或创建 Site
                    site = db.query(Site).filter(
                        Site.workbook_id == full_params_id,
                        Site.site_id == str(site_id),
                    ).first()
                    if not site:
                        site = Site(
                            workbook_id=full_params_id,
                            user_id=user_id,
                            site_id=str(site_id),
                            name=cell_name,
                            longitude=longitude,
                            latitude=latitude,
                            network_type=network_type,
                            managed_element_id=managed_element_id,
                            mcc=mcc or None,
                            mnc=mnc or None,
                        )
                        db.add(site)
                        db.flush()

                    # 写入 Sector
                    freq_val = frequency
                    if freq_val is not None:
                        try:
                            freq_val = float(freq_val)
                        except (ValueError, TypeError):
                            pass

                    sector = Sector(
                        site_id_fk=site.id,
                        workbook_id=full_params_id,
                        user_id=user_id,
                        sector_id=sector_id_str,
                        name=cell_name,
                        longitude=longitude,
                        latitude=latitude,
                        azimuth=azimuth,
                        frequency=freq_val,
                        cell_cover_type=cell_cover_type,
                        first_group="电信中兴",
                        mcc=mcc or None,
                        mnc=mnc or None,
                    )
                    db.add(sector)
                    db.flush()
                    results[idx]["message"] = f"新增小区 {cell_name} 成功"

                # 单事务提交
                db.commit()
                safe_print(f"[DataService] SQLite 批量写入完毕: {len(filtered_cells)} 条")
            except Exception as e:
                db.rollback()
                import traceback
                traceback.print_exc()
                safe_print(f"[DataService] SQLite 批量写入失败: {e}")
                sqlite_success = False
                sqlite_error_msg = str(e)[:200]
            finally:
                db.close()
        except Exception as e:
            import traceback
            traceback.print_exc()
            safe_print(f"[DataService] SQLite 连接失败: {e}")
            sqlite_success = False
            sqlite_error_msg = str(e)[:200]

        if not sqlite_success:
            # SQLite 失败但 Excel 已写入 —— 仍可报告具体错误
            for r in results:
                r["success"] = False
                if "数据库写入失败" not in r.get("message", ""):
                    r["message"] = f"数据库写入失败: {sqlite_error_msg}"
            success_count = 0
            safe_print(f"[DataService] 批量新站录入 SQLite 失败: {sqlite_error_msg}")
        else:
            success_count = sum(1 for r in results if r.get("success"))
            safe_print(f"[DataService] 批量新站录入完成: {success_count}/{len(results)} 成功")

        # 7. 更新 index
        try:
            excel_size = excel_path.stat().st_size
            if full_params_id in self.index:
                self.index[full_params_id]["size"] = excel_size
            self._save_index()
        except Exception as e:
            safe_print(f"[DataService] 更新索引失败 (非致命): {e}")

        self._invalidate_cell_search_index()

        return {
            "success": sqlite_success,
            "message": f"共 {len(results)} 条，成功 {success_count} 条，失败 {len(results) - success_count} 条",
            "results": results,
            "total": len(results),
            "successCount": success_count,
        }

    def _sector_exists(self, workbook_id: str, site_id: Any, cell_id: Any) -> bool:
        """检查指定工参文件下 (site_id, cell_id) 的小区是否已存在

        兼容两种 Sector.sector_id 存储格式：
        - 全量工参解析写入的纯小区标识（如 '61'）
        - 新站录入写入的组合格式（如 '541379_61'）
        通过 join sites 表按真实 site_id 匹配，避免纯 cellId 跨站碰撞。
        """
        if not site_id or not cell_id:
            return False
        db = SessionLocal()
        try:
            row = db.query(Sector.id).join(
                Site, Sector.site_id_fk == Site.id
            ).filter(
                Site.workbook_id == workbook_id,
                Site.site_id == str(site_id),
                Sector.sector_id.in_([str(cell_id), f"{str(site_id)}_{str(cell_id)}"]),
            ).first()
            return row is not None
        except Exception as e:
            safe_print(f"[DataService] _sector_exists 查询失败: {e}")
            return False
        finally:
            db.close()

    def _get_sector_network_type(self, workbook_id: str, site_id: Any, cell_id: Any) -> Optional[str]:
        """查询指定 (site_id, cell_id) 已有小区的制式（无则 None）"""
        if not site_id or not cell_id:
            return None
        db = SessionLocal()
        try:
            row = db.query(Site.network_type).join(
                Sector, Sector.site_id_fk == Site.id
            ).filter(
                Site.workbook_id == workbook_id,
                Site.site_id == str(site_id),
                Sector.sector_id.in_([str(cell_id), f"{str(site_id)}_{str(cell_id)}"]),
            ).first()
            return str(row[0]).upper() if row and row[0] else None
        except Exception as e:
            safe_print(f"[DataService] _get_sector_network_type 查询失败: {e}")
            return None
        finally:
            db.close()

    @staticmethod
    def _duplicate_message(panel_type: str, existing_type: Optional[str], cell_name: str) -> str:
        """生成重复小区逐行提示。

        panel_type: 录入面板制式（LTE/NR）
        existing_type: 库中已有小区的制式（None/空值视为同制式）
        同制式 → "[LTE]小区 X 已重复，信息已更新覆盖"
        跨制式 → "[LTE]小区 X 已在[NR]工参中存在，请检查"
        """
        if not existing_type or existing_type == panel_type:
            return f"[{panel_type}]小区 {cell_name} 已重复，信息已更新覆盖"
        return f"[{panel_type}]小区 {cell_name} 已在[{existing_type}]工参中存在，请检查"

    def check_cell_duplicates(self, cells: List[Dict]) -> Dict[str, Any]:
        """按制式检查 CGI (siteId_cellId) 是否已存在于数据库

        通过 join sites 表按 site_id + cell_id 匹配 Sector.sector_id，
        兼容纯 cellId 与 siteId_cellId 两种存储格式，并带出该小区的制式。

        cells: [{ siteId, cellId, networkType }]
        返回: {
            "duplicates": ["siteId_cellId", ...],
            "exists": { "siteId_cellId": {"lte": bool, "nr": bool}, ... },
        }
        """
        if not cells:
            return {"duplicates": [], "exists": {}}

        # 定位全量工参文件
        full_params_id = None
        for _id, _info in self.index.items():
            if _info.get("fileType") == "full_params":
                full_params_id = _id
                break
        if not full_params_id:
            safe_print("[DataService] 查重失败: 未找到全量工参文件")
            return {"duplicates": [], "exists": {}}

        db = SessionLocal()
        try:
            exists: Dict[str, Dict[str, bool]] = {}
            for cell in cells:
                site_id = str(cell.get("siteId", "")).strip()
                cell_id = str(cell.get("cellId", "")).strip()
                if not site_id or not cell_id:
                    continue
                key = f"{site_id}_{cell_id}"
                flags = {"lte": False, "nr": False}
                row = db.query(Site.network_type).join(
                    Sector, Sector.site_id_fk == Site.id
                ).filter(
                    Site.workbook_id == full_params_id,
                    Site.site_id == str(site_id),
                    Sector.sector_id.in_([str(cell_id), f"{str(site_id)}_{str(cell_id)}"]),
                ).first()
                if row and row[0]:
                    nt = str(row[0]).upper()
                    if nt in ("LTE", "NR"):
                        flags[nt.lower()] = True
                exists[key] = flags
            duplicates = [k for k, v in exists.items() if v["lte"] or v["nr"]]
            return {
                "duplicates": duplicates,
                "exists": exists,
            }
        except Exception as e:
            safe_print(f"[DataService] 查重失败: {e}")
            return {"duplicates": [], "exists": {}}
        finally:
            db.close()

    def validate_cell_fields(self, fields: Dict, network_type: str) -> tuple:
        """校验小区字段（库内校验）：返回 (ok: bool, errors: List[str])

        规则与前端 isRowComplete 一致：必填、数字格式、范围。
        """
        errors = []
        nt = str(network_type or "").upper()

        def _num(v):
            try:
                return float(str(v).strip())
            except (ValueError, TypeError):
                return None

        def _int(v):
            try:
                return int(float(str(v).strip()))
            except (ValueError, TypeError):
                return None

        if not str(fields.get("managedElementId", "") or "").strip():
            errors.append("网元ID必填")
        if not str(fields.get("siteId", "") or "").strip():
            errors.append("基站ID必填")
        if not str(fields.get("cellId", "") or "").strip():
            errors.append("小区ID必填")
        if not str(fields.get("cellName", "") or "").strip():
            errors.append("小区名称必填")

        lon = _num(fields.get("longitude"))
        if lon is not None and not (-180 <= lon <= 180):
            errors.append("经度超出范围 [-180, 180]")
        lat = _num(fields.get("latitude"))
        if lat is not None and not (-90 <= lat <= 90):
            errors.append("纬度超出范围 [-90, 90]")

        azi = _int(fields.get("azimuth"))
        if azi is not None and not (0 <= azi <= 360):
            errors.append("方向角超出范围 [0, 360]")

        mnc = str(fields.get("mnc", "") or "").strip()
        if mnc and (len(mnc) != 2 or not mnc.isdigit()):
            errors.append("MNC 必须为 2 位数字")

        freq_key = "frequency" if nt == "LTE" else "ssbFrequency"
        freq = str(fields.get(freq_key, "") or "").strip()
        if freq and _num(freq) is None:
            errors.append("频点必须为数字")

        ct = fields.get("cellCoverType")
        if ct is not None:
            try:
                ct_int = int(ct)
            except (ValueError, TypeError):
                errors.append("覆盖类型必须为数字")
            else:
                if ct_int not in (1, 4):
                    errors.append("覆盖类型仅支持 1/4")

        return (len(errors) == 0), errors

    @staticmethod
    def _parse_row_key(row_key: str) -> Optional[Tuple[int, int]]:
        """解析 rowKey 'sitePk:sectorPk' → (sitePk, sectorPk)；非法返回 None"""
        try:
            site_pk, sector_pk = (int(x) for x in str(row_key).split(":"))
            return site_pk, sector_pk
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _row_result(row_key: str, rtype: str, success: bool, message: str) -> Dict:
        return {"rowKey": row_key, "type": rtype, "success": success, "message": message}

    def bulk_update_cells(self, updates: List[Dict], deletes: List[Dict],
                          user_id: int = 1, workbook_id: Optional[str] = None) -> Dict[str, Any]:
        """查询/更新：批量更新 + 删除（SQLite 单事务 + Excel 单次 load/save）

        updates: [{rowKey, networkType, fields}]
        deletes: [{rowKey, networkType}]
        返回: { results: [...], updated: N, deleted: M }
        校验失败的行不落库（部分成功语义）。
        """
        if not workbook_id:
            workbook_id = self._find_full_params_id()
        if not workbook_id:
            raise ValueError("未找到全量工参文件，请先上传全量工参")

        data_dir = settings.DATA_DIR / workbook_id
        excel_path = data_dir / "original.xlsx"
        if not excel_path.exists():
            raise ValueError(f"全量工参原始文件不存在: {excel_path}")
        upload_path = settings.UPLOAD_DIR / f"{workbook_id}.xlsx"

        db = SessionLocal()
        results = []
        updated = 0
        deleted = 0

        try:
            # 0. 行级互斥：同一 rowKey 同时出现在 updates 与 deletes → 拒绝
            conflict_keys = {u.get("rowKey") for u in updates} & {d.get("rowKey") for d in deletes}
            if conflict_keys:
                for k in conflict_keys:
                    results.append(self._row_result(k, "conflict", False, "同一记录不能同时更新与删除"))
                updates = [u for u in updates if u.get("rowKey") not in conflict_keys]
                deletes = [d for d in deletes if d.get("rowKey") not in conflict_keys]

            # 1. 预加载库内 (siteId, cellId) → {networkType, sectorPk, sitePk} 冲突表
            conflict_map: Dict[str, dict] = {}
            sector_pk_to_row: Dict[int, tuple] = {}
            rows = db.query(Site, Sector).join(Sector, Sector.site_id_fk == Site.id).filter(
                Site.workbook_id == workbook_id
            ).all()
            for site, sector in rows:
                sector_pk_to_row[sector.id] = (site, sector)
                sid = str(sector.sector_id)
                cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
                conflict_map[f"{site.site_id}_{cell_id}"] = {
                    "networkType": str(site.network_type or "").upper(),
                    "sectorPk": sector.id,
                    "sitePk": site.id,
                }

            # 2. 处理删除（先删，避免与更新冲突表互相干扰）
            for d in deletes:
                row_key = d.get("rowKey", "")
                parsed = self._parse_row_key(row_key)
                if parsed is None:
                    results.append(self._row_result(row_key, "delete", False, "无效的 rowKey"))
                    continue
                _site_pk, _sector_pk = parsed
                sector = db.query(Sector).filter(Sector.id == _sector_pk,
                                                 Sector.workbook_id == workbook_id).first()
                if not sector:
                    results.append(self._row_result(row_key, "delete", False, "记录不存在"))
                    continue
                site = db.query(Site).filter(Site.id == _site_pk).first()
                sid = str(sector.sector_id)
                cell_id = sid.rsplit("_", 1)[-1] if "_" in sid else sid
                # 捕获删除前键（供 Excel 行删除定位：删除后 DB 已无此记录）
                d["_site_id"] = str(site.site_id) if site is not None else None
                d["_cell_id"] = cell_id
                # 释放该键：同批次后续更新可改键到被释放键
                if site is not None:
                    conflict_map.pop(f"{site.site_id}_{cell_id}", None)
                sector_pk_to_row.pop(_sector_pk, None)
                db.delete(sector)
                db.flush()
                remaining = db.query(Sector).filter(Sector.site_id_fk == _site_pk).count()
                if remaining == 0 and site is not None:
                    db.delete(site)
                    db.flush()
                deleted += 1
                results.append(self._row_result(row_key, "delete", True, "小区已删除"))

            # 3. 处理更新（逐行校验；同批次内新键互斥检查）
            for u in updates:
                row_key = u.get("rowKey", "")
                nt = str(u.get("networkType", "")).upper()
                fields = u.get("fields", {}) or {}
                parsed = self._parse_row_key(row_key)
                if parsed is None:
                    results.append(self._row_result(row_key, "update", False, "无效的 rowKey"))
                    continue
                _site_pk, _sector_pk = parsed

                cur = sector_pk_to_row.get(_sector_pk)
                if not cur:
                    results.append(self._row_result(row_key, "update", False, "记录不存在"))
                    continue
                site, sector = cur
                # 捕获更新前键（供 Excel 行定位：Excel 尚未修改仍为旧键）
                _sid = str(sector.sector_id)
                u["_old_site_id"] = str(site.site_id)
                u["_old_cell_id"] = _sid.rsplit("_", 1)[-1] if "_" in _sid else _sid

                full = {
                    "managedElementId": site.managed_element_id,
                    "siteId": str(site.site_id),
                    "cellId": str(sector.sector_id).rsplit("_", 1)[-1],
                    "cellName": sector.name,
                    "mcc": sector.mcc or "",
                    "mnc": sector.mnc or "",
                    "longitude": sector.longitude,
                    "latitude": sector.latitude,
                    "azimuth": sector.azimuth,
                    "frequency": sector.frequency if nt == "LTE" else None,
                    "ssbFrequency": sector.frequency if nt == "NR" else None,
                    "cellCoverType": sector.cell_cover_type or 1,
                }
                full.update({k: v for k, v in fields.items() if v is not None and v != ""})

                ok, errs = self.validate_cell_fields(full, nt)
                if not ok:
                    results.append(self._row_result(row_key, "update", False, "；".join(errs)))
                    continue

                new_key = f"{str(full['siteId'])}.{str(full['cellId'])}"
                old_key = f"{str(site.site_id)}.{str(sector.sector_id).rsplit('_', 1)[-1]}"
                if new_key != old_key:
                    holder = conflict_map.get(f"{full['siteId']}_{full['cellId']}")
                    if holder and holder["sectorPk"] != _sector_pk:
                        msg = self._duplicate_message(
                            nt, holder["networkType"], str(full["cellName"]))
                        results.append(self._row_result(row_key, "update", False, msg))
                        continue
                    in_batch = any(
                        o.get("rowKey") != row_key
                        and o.get("fields", {}).get("siteId") == str(full["siteId"])
                        and o.get("fields", {}).get("cellId") == str(full["cellId"])
                        for o in updates
                    )
                    if in_batch:
                        results.append(self._row_result(
                            row_key, "update", False, f"批内重复: {full['siteId']}_{full['cellId']}"))
                        continue

                new_site_id = str(full["siteId"])
                if new_site_id != str(site.site_id):
                    new_site = db.query(Site).filter(
                        Site.workbook_id == workbook_id, Site.site_id == new_site_id).first()
                    if not new_site:
                        new_site = Site(workbook_id=workbook_id, user_id=user_id,
                                        site_id=new_site_id, name=str(full["cellName"]),
                                        longitude=full["longitude"], latitude=full["latitude"],
                                        network_type=nt,
                                        managed_element_id=str(full["managedElementId"] or ""),
                                        mcc=full["mcc"] or None, mnc=full["mnc"] or None)
                        db.add(new_site)
                        db.flush()
                    sector.site_id_fk = new_site.id
                    site = new_site
                site.managed_element_id = str(full["managedElementId"] or "")
                site.longitude = full["longitude"]
                site.latitude = full["latitude"]
                site.mcc = full["mcc"] or None
                site.mnc = full["mnc"] or None
                sector.sector_id = f"{new_site_id}_{full['cellId']}"
                sector.name = str(full["cellName"])
                sector.longitude = full["longitude"]
                sector.latitude = full["latitude"]
                sector.azimuth = full["azimuth"]
                sector.cell_cover_type = int(full["cellCoverType"] or 1)
                freq = full.get("frequency") or full.get("ssbFrequency")
                try:
                    sector.frequency = float(freq) if freq else None
                except (ValueError, TypeError):
                    sector.frequency = None
                db.flush()

                updated += 1
                results.append({"rowKey": row_key, "type": "update", "success": True,
                                "message": "小区更新成功"})

            db.commit()
        except Exception as e:
            db.rollback()
            import traceback
            traceback.print_exc()
            for r in results:
                r["success"] = False
                r["message"] = f"数据库写入失败: {str(e)[:200]}"
            return {"success": False, "message": "数据库写入失败", "results": results,
                    "updated": 0, "deleted": 0}
        finally:
            db.close()

        # 5. Excel 单次 load/save（先 DB 成功后再写；失败则告警，DB 已提交不回滚）
        excel_error = ""
        try:
            wb = openpyxl.load_workbook(excel_path)
            try:
                self._apply_excel_updates(wb, updates, deletes, results)
                wb.save(excel_path)
            except Exception as e:
                excel_error = str(e)[:200]
                raise
            finally:
                wb.close()
        except Exception as e:
            safe_print(f"[DataService] 查询/更新 Excel 写入失败: {e}")
            excel_error = excel_error or str(e)[:200]
        if not excel_error:
            try:
                if upload_path.exists():
                    shutil.copy2(excel_path, upload_path)
            except Exception as e:
                safe_print(f"[DataService] 同步 uploads 副本失败 (非致命): {e}")
            try:
                excel_size = excel_path.stat().st_size
                if workbook_id in self.index:
                    self.index[workbook_id]["size"] = excel_size
                self._save_index()
            except Exception as e:
                safe_print(f"[DataService] 更新索引失败 (非致命): {e}")

        self._invalidate_cell_search_index()
        return {"success": True, "message": f"更新 {updated} 条，删除 {deleted} 条",
                "results": results, "updated": updated, "deleted": deleted}

    def _apply_excel_updates(self, wb, updates, deletes, results):
        """按 rowKey 在 Excel 中定位数据行并更新/删除（DB 提交成功后调用，尽力保持双写一致）。

        - updates: 用更新前捕获的 (siteId, cellId) 定位（Excel 尚未修改，仍是旧键），
          通过 _apply_row_update 写入 fields 全部非空字段（含改键）。
        - deletes: 用删除前捕获的 (siteId, cellId) 定位，自下而上删除行。
        - 仅处理 results 中 success 的行（校验失败/冲突拒绝的行不动 Excel）。
        """
        def _sheet_col_map(ws):
            header = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
            cm = {}
            for i, v in enumerate(header):
                if v:
                    cm[str(v).strip().split("\n")[0].strip()] = i + 1
            return cm

        def _norm_cell_val(v):
            """Excel 单元格值归一化为纯数字字符串（int/float/str）"""
            if v is None:
                return ""
            try:
                f = float(str(v).strip())
                if f == int(f):
                    return str(int(f))
                return str(f)
            except (ValueError, TypeError):
                return str(v).strip()

        def _find_rows(ws, cm, site_key_col, cell_key_col, site_val, cell_val):
            out = []
            for r in range(2, ws.max_row + 1):
                s = _norm_cell_val(ws.cell(row=r, column=cm[site_key_col]).value)
                c = _norm_cell_val(ws.cell(row=r, column=cm[cell_key_col]).value)
                if s == site_val and c == cell_val:
                    out.append(r)
            return out

        sheet_defs = {
            "LTE": ("LTE Project Parameters", "eNodeB标识", "小区标识"),
            "NR": ("NR Project Parameters", "gNodeB标识", "小区标识"),
        }

        ok_keys = {r.get("rowKey") for r in results if r.get("success")}
        lon_cols = ("小区经度", "基站经度", "经度")
        lat_cols = ("小区纬度", "基站纬度", "纬度")

        # 更新：Excel 行仍为更新前键，用 _old_* 定位后写入全部 fields
        for u in updates:
            row_key = u.get("rowKey", "")
            if row_key not in ok_keys:
                continue
            nt = str(u.get("networkType", "")).upper()
            if nt not in sheet_defs:
                continue
            sheet_name, site_col, cell_col = sheet_defs[nt]
            if sheet_name not in wb.sheetnames:
                continue
            ws = wb[sheet_name]
            cm = _sheet_col_map(ws)
            if site_col not in cm or cell_col not in cm:
                continue
            site_val = u.get("_old_site_id")
            cell_val = u.get("_old_cell_id")
            if site_val is None or cell_val is None:
                continue
            fields = u.get("fields", {}) or {}
            field_map = self._build_update_field_map(fields, nt)
            for r in _find_rows(ws, cm, site_col, cell_col, site_val, cell_val):
                self._apply_row_update(ws[r], cm, fields, field_map, nt)
                # 经度/纬度多目标列直接写入（_apply_row_update 单列映射可能漏列）
                for c in lon_cols:
                    if c in cm and fields.get("longitude") not in (None, ""):
                        ws.cell(row=r, column=cm[c]).value = fields["longitude"]
                for c in lat_cols:
                    if c in cm and fields.get("latitude") not in (None, ""):
                        ws.cell(row=r, column=cm[c]).value = fields["latitude"]

        # 删除：自下而上删行
        for d in deletes:
            row_key = d.get("rowKey", "")
            if row_key not in ok_keys:
                continue
            nt = str(d.get("networkType", "")).upper()
            if nt not in sheet_defs:
                continue
            sheet_name, site_col, cell_col = sheet_defs[nt]
            if sheet_name not in wb.sheetnames:
                continue
            ws = wb[sheet_name]
            cm = _sheet_col_map(ws)
            if site_col not in cm or cell_col not in cm:
                continue
            site_val = d.get("_site_id")
            cell_val = d.get("_cell_id")
            if site_val is None or cell_val is None:
                continue
            # 自下而上删行，避免行号上移导致错位
            for r in reversed(_find_rows(ws, cm, site_col, cell_col, site_val, cell_val)):
                ws.delete_rows(r)

    def _build_update_field_map(self, fields: Dict, network_type: str) -> Dict:
        """构建 Excel 更新字段映射：源字段(camelCase) → Excel 列名

        与 _apply_row_update 契约一致（field_map 的 key 必须是 update_data 中的字段名）。
        经度/纬度的多目标列（小区经度/基站经度/经度 等）由 _apply_excel_updates 直接写入。
        """
        nt = str(network_type or "").upper()
        if nt == "LTE":
            pairs = [
                ("managedElementId", "管理网元ID"),
                ("siteId", "eNodeB标识"),
                ("cellId", "小区标识"),
                ("cellName", "小区名称"),
                ("azimuth", "天线方向角"),
                ("frequency", "下行链路的中心载频"),
                ("cellCoverType", "小区覆盖类型"),
                ("mcc", "移动国家码"),
                ("mnc", "移动网络码"),
            ]
        else:
            pairs = [
                ("managedElementId", "管理网元ID"),
                ("siteId", "gNodeB标识"),
                ("cellId", "小区标识"),
                ("cellName", "小区名称"),
                ("azimuth", "天线方向角"),
                ("ssbFrequency", "填写SSB频点"),
                ("cellCoverType", "小区覆盖类型"),
                ("mcc", "移动国家码"),
                ("mnc", "移动网络码"),
            ]
        return {src: col for src, col in pairs if fields.get(src) not in (None, "")}

    def _update_sheet(self, ws, current_dir: Path, network_type: str):
        """更新单个Sheet"""
        # 1. 确定列索引映射
        header_row = list(ws.iter_rows(min_row=1, max_row=1, values_only=True))[0]
        col_map = {}  # Chinese Name -> Column Index (1-based)

        for idx, col_val in enumerate(header_row):
            if col_val:
                # 提取中文名称（处理可能的前导换行符，取第一行非空内容）
                # 例如: "\ngNodeBLength\n..." -> "gNodeBLength"
                clean_name = str(col_val).strip().split("\n")[0].strip()
                col_map[clean_name] = idx + 1

        # 调试：检查是否找到小区覆盖类型列
        if "小区覆盖类型" in col_map:
            safe_print(
                f"[DataService] 找到'小区覆盖类型'列，列索引={col_map['小区覆盖类型']}"
            )
        else:
            safe_print(f"[DataService] 警告: 未找到'小区覆盖类型'列")

        # 2. 读取现网工参数据
        updates = self._load_current_params(current_dir, network_type)
        safe_print(f"[DataService] 加载到 {len(updates)} 条 {network_type} 现网数据")

        # 3. 遍历Excel行进行更新
        # LTE Key: eNodeB标识 + 小区标识
        # NR Key: 移动国家码 + 移动网络码 + gNodeB标识 + 小区标识

        # 构建Excel中的现有Key集合
        existing_keys = set()

        # 映射字段配置
        if network_type == "LTE":
            key_cols = ["eNodeB标识", "小区标识"]
            # 源CSV字段 -> 目标Excel字段
            # 注意：允许多个源字段映射到同一个目标字段（后遍历的会覆盖前面的，或者根据是否存在来决定）
            # 建议将优先使用的字段放在后面（字典顺序），或者在逻辑中处理
            field_map = {
                "eNBName": "基站名称",
                "UserLabel": "基站名称",  # 备选
                "SubNetwork": "子网ID",
                "ManagedElement": "管理网元ID",
                "cellName": "小区名称",
                "CellName": "小区名称",  # 备选 (常见大写)
                "tac": "跟踪区码",
                "pci": "物理小区识别码",
                "frequency": "下行链路的中心载频",
                "cellLocalId": "小区标识",
                "eNBId": "eNodeB标识",
                "mcc": "移动国家码",
                "mnc": "移动网络码",
                "longitude": "经度",
                "latitude": "纬度",
            }
        else:  # NR
            key_cols = ["移动国家码", "移动网络码", "gNodeB标识", "小区标识"]
            field_map = {
                "eNBName": "基站名称",
                "gNBName": "基站名称",
                "UserLabel": "基站名称",  # 备选
                "dra_GNBName": "基站名称",  # 备选
                "SubNetwork": "子网ID",
                "ManagedElement": "管理网元ID",
                "cellName": "小区名称",
                "CellName": "小区名称",  # 备选
                "tac": "跟踪区码",
                "pci": "物理小区识别码",
                "ssbFrequency": "填写SSB频点",  # 修改：使用ssbFrequency而不是frequency
                "frequencyBandList": "gNodeBLength",  # 新增映射
                "cellLocalId": "小区标识",
                "gNBId": "gNodeB标识",
                "mcc": "移动国家码",
                "mnc": "移动网络码",
                "longitude": "经度",
                "latitude": "纬度",
                # 注意：coverageType 不在 field_map 中，而是单独处理
            }

        # 验证必要的列是否存在于Excel中
        missing_cols = [k for k in key_cols if k not in col_map]
        if missing_cols:
            safe_print(
                f"[DataService] 警告: Sheet中缺少Key列: {missing_cols}，跳过更新"
            )
            return

        # 遍历数据行（从第4行开始）—— 一次性读取，避免多次 iter_rows
        all_rows = list(ws.iter_rows(min_row=4))
        cgi_list = [None] * len(all_rows)
        mnc_list = [None] * len(all_rows)  # NR共享小区判断：记录每行的MNC值

        for row_idx, row in enumerate(all_rows):
            try:
                if network_type == "LTE":
                    enb_id = self._get_cell_val(row, col_map, "eNodeB标识")
                    cell_id = self._get_cell_val(row, col_map, "小区标识")
                    if enb_id is not None and cell_id is not None:
                        def _sheet_norm_int(v):
                            try:
                                return str(int(float(v)))
                            except (ValueError, OverflowError):
                                return v
                        key = f"{_sheet_norm_int(enb_id)}_{_sheet_norm_int(cell_id)}"
                        existing_keys.add(key)

                        if key in updates:
                            self._apply_row_update(row, col_map, updates[key], field_map, network_type)
                            updates[key]["_processed"] = True
                        else:
                            missing_count = getattr(self, '_lte_missing_key_count', 0) + 1
                            self._lte_missing_key_count = missing_count
                            if missing_count <= 10:
                                safe_print(f"[LTE DEBUG] Key未在现网工参中找到: {key}")
                            elif missing_count == 11:
                                safe_print(f"[LTE DEBUG] ...（后续未匹配的Key将不再打印）")

                        # 同一遍历内完成 LTE 后处理
                        if "CGI" in col_map:
                            row[col_map["CGI"] - 1].value = f"{enb_id}-{cell_id}"
                        if "是否共享" in col_map and key in updates:
                            plmn = updates[key].get("plmnIdList")
                            row[col_map["是否共享"] - 1].value = "是" if (plmn and isinstance(plmn, str) and ";" in plmn) else "否"
                        if "第一分组" in col_map and key in updates:
                            row[col_map["第一分组"] - 1].value = "电信中兴"
                        # "是否现网"在"第一分组"设置之后处理，确保"第一分组"已更新
                        first_group = self._get_cell_val(row, col_map, "第一分组")
                        if "是否现网" in col_map:
                            if first_group == "电信中兴" and key in updates:
                                row[col_map["是否现网"] - 1].value = "是"
                            elif key not in updates:
                                row[col_map["是否现网"] - 1].value = "否"
                        if "第二分组" in col_map:
                            # 只有当前为空值时才更新
                            current_second = row[col_map["第二分组"] - 1].value
                            if not current_second or (isinstance(current_second, str) and not current_second.strip()):
                                cell_name = self._get_cell_val(row, col_map, "小区名称")
                                if cell_name:
                                    second_group = self._determine_second_group(cell_name)
                                    if second_group:
                                        row[col_map["第二分组"] - 1].value = second_group

                else:  # NR
                    mcc = self._get_cell_val(row, col_map, "移动国家码")
                    mnc = self._get_cell_val(row, col_map, "移动网络码")
                    gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                    cell_id = self._get_cell_val(row, col_map, "小区标识")

                    if all(v is not None for v in [mcc, mnc, gnb_id, cell_id]):
                        # 与 _load_current_params 中 _safe_int_str 保持一致的归一化
                        def _sheet_norm(v):
                            try:
                                return str(int(float(v)))
                            except (ValueError, OverflowError):
                                return v
                        key = f"{_sheet_norm(mcc)}_{_sheet_norm(mnc)}_{_sheet_norm(gnb_id)}_{_sheet_norm(cell_id)}"
                        existing_keys.add(key)

                        if key in updates:
                            try:
                                self._apply_row_update(row, col_map, updates[key], field_map, network_type)
                                updates[key]["_processed"] = True
                            except Exception as e:
                                import traceback
                                safe_print(f"[DataService] 更新行失败 (Key={key}): {e}")
                                traceback.print_exc()
                        else:
                            safe_print(f"[DEBUG] Key未在现网工参中找到: {key}")

                        # 同一遍历内完成 NR 后处理
                        # 规范化 CGI：确保 gNBId-cellLocalId 用整数表示，避免浮点数问题
                        def _norm_id_str(v):
                            v = v.strip()
                            try:
                                return str(int(float(v)))
                            except (ValueError, OverflowError):
                                return v
                        cgi = f"{_norm_id_str(gnb_id)}-{_norm_id_str(cell_id)}"
                        cgi_list[row_idx] = cgi
                        mnc_list[row_idx] = mnc  # 记录MNC，用于后续"是否共享"判断
                        if "CGI" in col_map:
                            row[col_map["CGI"] - 1].value = cgi
                        if "跟踪区码" in col_map and key in updates:
                            tac = updates[key].get("tac")
                            if tac is not None and not pd.isna(tac):
                                row[col_map["跟踪区码"] - 1].value = tac
                        if "第一分组" in col_map and key in updates:
                            row[col_map["第一分组"] - 1].value = "电信中兴"
                        # "是否现网"在"第一分组"设置之后处理，确保"第一分组"已更新
                        first_group = self._get_cell_val(row, col_map, "第一分组")
                        if "是否现网" in col_map:
                            if first_group == "电信中兴" and key in updates:
                                row[col_map["是否现网"] - 1].value = "是"
                            elif key not in updates:
                                row[col_map["是否现网"] - 1].value = "否"
                        if "第二分组" in col_map:
                            # 只有当前为空值时才更新
                            current_second = row[col_map["第二分组"] - 1].value
                            if not current_second or (isinstance(current_second, str) and not current_second.strip()):
                                cell_name = self._get_cell_val(row, col_map, "小区名称")
                                if cell_name:
                                    second_group = self._determine_second_group(cell_name)
                                    if second_group:
                                        row[col_map["第二分组"] - 1].value = second_group
                        if key not in updates and "gNodeBLength" in col_map:
                            ssb = self._get_cell_val(row, col_map, "填写SSB频点")
                            if ssb:
                                try:
                                    if 900 <= float(ssb) <= 955:
                                        row[col_map["gNodeBLength"] - 1].value = 8
                                except ValueError:
                                    if "-" in ssb:
                                        try:
                                            parts = ssb.split("-")
                                            if float(parts[0].strip()) <= 955 and float(parts[1].strip()) >= 900:
                                                row[col_map["gNodeBLength"] - 1].value = 8
                                        except ValueError:
                                            pass
                                    elif ssb == "900-955":
                                        row[col_map["gNodeBLength"] - 1].value = 8

            except Exception as e:
                import traceback
                safe_print(f"[DataService] 处理行时发生错误: {e}")
                traceback.print_exc()
                continue

        # 5. 追加新行（安全守卫: key 已存在于 Excel 中的不追加）
        new_rows_count = 0
        for key, data in updates.items():
            if not data.get("_processed"):
                if key not in existing_keys:
                    self._append_new_row(ws, col_map, data, field_map, network_type)
                    new_rows_count += 1
                else:
                    safe_print(f"[DataService] 安全守卫: 防止重复追加 key={key}")

        # NR 是否共享列：暂不处理，等追加行和去重完成后统一计算

        # CGI 后处理：同 CGI 的小区拉齐关键字段
        # 对于"CGI"列相同的行，如果某行指定字段为空的，则从同 CGI 的非空行中复制
        # 适用于 LTE 和 NR，覆盖：基站经度、基站纬度、小区经度、小区纬度、天线方向角、天线挂高、小区覆盖类型
        if "CGI" in col_map:
            cgi_idx = col_map["CGI"] - 1

            # 确定需要继承的字段列名（仅匹配自身列名，不跨列模糊匹配）
            field_column_names = {
                "基站经度": ["基站经度"],
                "基站纬度": ["基站纬度"],
                "小区经度": ["小区经度"],
                "小区纬度": ["小区纬度"],
                "天线方向角": ["天线方向角", "方位角"],
                "天线挂高": ["天线挂高", "挂高"],
                "小区覆盖类型": ["小区覆盖类型"],
            }

            # 字段回填时的备用来源（如 小区经度/小区纬度 可从对应基站列取值）
            field_fallbacks = {
                "小区经度": "基站经度",
                "小区纬度": "基站纬度",
            }

            # 同时获取备用来源的列索引（用于构建 CGI 映射时收集数据）
            all_field_names = list(field_column_names.keys()) + [v for v in field_fallbacks.values() if v not in field_column_names]

            # 解析实际列名
            field_indices = {}  # display_name -> column index
            for display_name, candidates in field_column_names.items():
                for candidate in candidates:
                    if candidate in col_map:
                        field_indices[display_name] = col_map[candidate] - 1
                        break

            # 备用来源的列索引
            fallback_indices = {}
            for fb_name in field_fallbacks.values():
                if fb_name in col_map:
                    fallback_indices[fb_name] = col_map[fb_name] - 1

            if field_indices:
                # 重新读取所有行（包括追加的新行，ws.append 后需要重新读）
                all_rows_final = list(ws.iter_rows(min_row=4))

                # 构建 CGI -> 已知字段值映射（包含备用来源字段）
                cgi_field_map = {}
                for row in all_rows_final:
                    cgi_val = row[cgi_idx].value
                    if cgi_val is not None:
                        cgi_str = str(cgi_val).strip()
                        if cgi_str:
                            if cgi_str not in cgi_field_map:
                                cgi_field_map[cgi_str] = {}
                            # 收集主字段值
                            for display_name, col_idx in field_indices.items():
                                if display_name not in cgi_field_map[cgi_str] or cgi_field_map[cgi_str][display_name] is None:
                                    val = row[col_idx].value
                                    if val is not None:
                                        try:
                                            if not (isinstance(val, float) and np.isnan(val)):
                                                if not pd.isna(val):
                                                    cgi_field_map[cgi_str][display_name] = val
                                        except (TypeError, ValueError):
                                            cgi_field_map[cgi_str][display_name] = val
                            # 收集备用来源字段值
                            for fb_name, fb_idx in fallback_indices.items():
                                if fb_name not in cgi_field_map[cgi_str] or cgi_field_map[cgi_str][fb_name] is None:
                                    val = row[fb_idx].value
                                    if val is not None:
                                        try:
                                            if not (isinstance(val, float) and np.isnan(val)):
                                                if not pd.isna(val):
                                                    cgi_field_map[cgi_str][fb_name] = val
                                        except (TypeError, ValueError):
                                            cgi_field_map[cgi_str][fb_name] = val

                # 回填空字段（含备用来源回退）
                fill_counts = {dn: 0 for dn in field_indices}
                for row in all_rows_final:
                    cgi_val = row[cgi_idx].value
                    if cgi_val is not None:
                        cgi_str = str(cgi_val).strip()
                        if cgi_str and cgi_str in cgi_field_map:
                            known_vals = cgi_field_map[cgi_str]
                            for display_name, col_idx in field_indices.items():
                                known_val = known_vals.get(display_name)
                                # 如果主字段无已知值，尝试备用来源
                                if known_val is None and display_name in field_fallbacks:
                                    fb_name = field_fallbacks[display_name]
                                    known_val = known_vals.get(fb_name)
                                if known_val is not None:
                                    cur_val = row[col_idx].value
                                    if cur_val is None or (isinstance(cur_val, float) and np.isnan(cur_val)):
                                        try:
                                            if pd.isna(cur_val):
                                                row[col_idx].value = known_val
                                                fill_counts[display_name] += 1
                                        except (TypeError, ValueError):
                                            row[col_idx].value = known_val
                                            fill_counts[display_name] += 1

                # 打印统计
                total_filled = sum(fill_counts.values())
                if total_filled > 0:
                    detail = ", ".join(f"{k}={v}" for k, v in fill_counts.items() if v > 0)
                    safe_print(f"[DataService] CGI字段回填: {detail} (总计 {total_filled} 行)")

        # 最终去重：按 NR/LTE 唯一键移除工作表中重复的行
        # 从后往前遍历，保留最早出现的行（即原始Excel中的数据优先）
        dedup_count = 0
        all_rows_final = list(ws.iter_rows(min_row=4))
        seen_keys = set()
        for ri in range(len(all_rows_final) - 1, -1, -1):
            row = all_rows_final[ri]
            if network_type == "NR":
                mcc_v = self._get_cell_val(row, col_map, "移动国家码")
                mnc_v = self._get_cell_val(row, col_map, "移动网络码")
                gnb_v = self._get_cell_val(row, col_map, "gNodeB标识")
                cell_v = self._get_cell_val(row, col_map, "小区标识")
                if all(v is not None for v in [mcc_v, mnc_v, gnb_v, cell_v]):
                    def _norm_key(v):
                        try: return str(int(float(v)))
                        except: return v
                    k = f"{_norm_key(mcc_v)}_{_norm_key(mnc_v)}_{_norm_key(gnb_v)}_{_norm_key(cell_v)}"
                else:
                    continue
            else:  # LTE
                enb_v = self._get_cell_val(row, col_map, "eNodeB标识")
                cell_v = self._get_cell_val(row, col_map, "小区标识")
                if enb_v is not None and cell_v is not None:
                    try: k = f"{str(int(float(enb_v)))}_{str(int(float(cell_v)))}"
                    except: continue
                else:
                    continue
            if k in seen_keys:
                ws.delete_rows(4 + ri)  # min_row=4, will auto shift
                dedup_count += 1
            else:
                seen_keys.add(k)

        if dedup_count > 0:
            safe_print(f"[DataService] 最终去重完成: 移除了 {dedup_count} 条重复行")

        # NR 是否共享列：按 CGI 分组，同 CGI 内 MNC 同时存在"01"和"11"为共享小区
        # 必须在所有字段更新、追加行和去重之后最后执行
        if network_type == "NR" and "是否共享" in col_map and "CGI" in col_map and "移动网络码" in col_map:
            # 去重后重新读取所有行，确保索引正确
            all_rows_final = list(ws.iter_rows(min_row=4))
            cgi_mnc_map = {}
            cgi_idx = col_map["CGI"] - 1
            mnc_col_idx = col_map["移动网络码"] - 1
            shared_col_idx = col_map["是否共享"] - 1
            for row in all_rows_final:
                cgi_val = row[cgi_idx].value
                mnc_val = row[mnc_col_idx].value
                if cgi_val is not None and mnc_val is not None:
                    cgi_str = str(cgi_val).strip()
                    mnc_str = str(mnc_val).strip()
                    if cgi_str not in cgi_mnc_map:
                        cgi_mnc_map[cgi_str] = set()
                    cgi_mnc_map[cgi_str].add(mnc_str)
            for row in all_rows_final:
                cgi_val = row[cgi_idx].value
                if cgi_val is not None:
                    cgi_str = str(cgi_val).strip()
                    mnc_set = cgi_mnc_map.get(cgi_str, set())
                    row[shared_col_idx].value = "是" if ("01" in mnc_set and "11" in mnc_set) else "否"

        safe_print(
            f"[DataService] 更新完成: 现有匹配 {len(existing_keys)} 行, 追加新行 {new_rows_count} 行"
        )

    def _get_cell_val(self, row, col_map, col_name):
        """获取行中指定列的值"""
        if col_name in col_map:
            idx = col_map[col_name] - 1  # row is tuple, 0-based index
            val = row[idx].value
            if val is not None:
                return str(val).strip()
        return None

    def _apply_row_update(
        self, row, col_map, update_data, field_map, network_type: str
    ):
        """应用更新到行"""
        # LTE 专用：检查 Excel 中是否有"基站名称"列
        if network_type == "LTE" and "基站名称" not in col_map:
            safe_print(f"[LTE WARN] Excel 中没有 '基站名称' 列!")
            safe_print(f"[LTE WARN] Excel 可用列: {list(col_map.keys())}")

        # 关键修复：处理多个源字段映射到同一目标列的情况
        # 问题：如果后遍历的字段为空，不应覆盖之前已设置的值
        # 解决：为每个目标列只取第一个非空的有效值

        # 按目标列分组源字段（字典的迭代顺序在 Python 3.7+ 中是有序的）
        # 对于每个目标列，按源字段顺序检查，第一个非空值生效
        target_cols_map = {}
        for src_field, target_col in field_map.items():
            if target_col not in target_cols_map:
                target_cols_map[target_col] = []
            target_cols_map[target_col].append(src_field)

        # 对每个目标列，按优先级顺序查找第一个非空值
        for target_col, src_fields in target_cols_map.items():
            if target_col not in col_map:
                continue

            col_idx = col_map[target_col] - 1

            # 按顺序查找第一个非空的源字段值
            final_val = None
            used_src_field = None

            # 基站名称列的特殊调试：记录所有尝试的字段值
            if target_col == "基站名称":
                all_vals = []
                for sf in src_fields:
                    if sf in update_data:
                        all_vals.append(f"{sf}={repr(update_data[sf])}")
                    else:
                        all_vals.append(f"{sf}=不存在")
                if all_vals:
                    safe_print(f"[LTE DEBUG] 基站名称可用字段: {', '.join(all_vals)}")
                    # 同时显示 update_data 中所有字段（前20个）用于调试
                    available_fields = list(update_data.keys())
                    safe_print(f"[LTE DEBUG] update_data 中的所有字段（部分）: {available_fields[:20]}")

            for src_field in src_fields:
                if src_field not in update_data:
                    continue

                val = update_data[src_field]

                # 检查是否为空值（处理numpy NaN、pandas NA、None、空字符串等）
                if val is None:
                    continue
                try:
                    if pd.isna(val):
                        continue
                except (TypeError, ValueError):
                    pass
                if isinstance(val, float) and np.isnan(val):
                    continue
                # 空字符串也视为无效值
                if isinstance(val, str) and not val.strip():
                    continue

                # 找到第一个非空值，使用它
                final_val = val
                used_src_field = src_field
                break  # 找到有效值后立即停止，不被后续字段覆盖

            if final_val is not None:
                # 转换为Python原生类型（处理numpy类型）
                if hasattr(final_val, "item"):  # numpy scalar
                    final_val = final_val.item()
                elif isinstance(final_val, str):
                    final_val = final_val.strip()

                row[col_idx].value = final_val
                # 调试日志（对于基站名称列）
                if target_col == "基站名称":
                    safe_print(f"[LTE UPDATE] 更新基站名称: {used_src_field}={final_val}")
            elif target_col == "基站名称":
                # 特殊日志：基站名称列未找到有效值
                safe_print(f"[LTE WARN] 基站名称未更新: 所有字段都为空")

        # 特殊处理：NR coverageType 映射到小区覆盖类型
        # 只有NR网络类型才处理，且只在现网工参中有coverageType值时才更新
        # LTE网络不处理小区覆盖类型
        if network_type == "NR" and "coverageType" in update_data:
            val = update_data["coverageType"]

            # 调试日志
            safe_print(f"[DataService] NR小区: 发现coverageType字段，原始值={val}")

            # 检查是否为空值
            if not (
                pd.isna(val)
                or val is None
                or (isinstance(val, float) and np.isnan(val))
            ):
                # 转换为字符串并去除空格
                val_str = str(val).strip()

                # coverageType: "Micro" -> 4 (室内), "Macro" -> 1 (室外)
                # 只有明确的Micro或Macro才更新，其他值不更新
                if val_str == "Micro":
                    coverage_val = 4
                    possible_msg = (
                        f"[DataService] NR coverageType映射: Micro -> 小区覆盖类型=4"
                    )
                    safe_print(possible_msg)
                    # 如果Excel中有"小区覆盖类型"列，则更新
                    if "小区覆盖类型" in col_map:
                        col_idx = col_map["小区覆盖类型"] - 1
                        old_val = row[col_idx].value
                        row[col_idx].value = coverage_val
                        safe_print(
                            f"[DataService] 已更新: 原值={old_val}, 新值={coverage_val}"
                        )
                    else:
                        safe_print(
                            f"[DataService] 警告: Excel中没有'小区覆盖类型'列，无法更新"
                        )
                elif val_str == "Macro":
                    coverage_val = 1
                    safe_print(
                        f"[DataService] NR coverageType映射: Macro -> 小区覆盖类型=1"
                    )
                    # 如果Excel中有"小区覆盖类型"列，则更新
                    if "小区覆盖类型" in col_map:
                        col_idx = col_map["小区覆盖类型"] - 1
                        old_val = row[col_idx].value
                        row[col_idx].value = coverage_val
                        safe_print(
                            f"[DataService] 已更新: 原值={old_val}, 新值={coverage_val}"
                        )
                    else:
                        safe_print(
                            f"[DataService] 警告: Excel中没有'小区覆盖类型'列，无法更新"
                        )
                else:
                    # 未知值不更新（保持原值）
                    safe_print(
                        f"[DataService] NR coverageType未知值: {val_str}，跳过更新小区覆盖类型"
                    )
            else:
                safe_print(f"[DataService] NR coverageType为空值，跳过更新")

        # 固定值更新
        # 系统制式固定值是1
        if "系统制式" in col_map:
            row[col_map["系统制式"] - 1].value = 1

    def _append_new_row(self, ws, col_map, data, field_map, network_type):
        """追加新行"""
        # 创建一个空行列表，长度为最大列索引
        max_col = max(col_map.values()) if col_map else 0
        new_row = [None] * max_col

        # 填充映射字段
        for src_field, target_col in field_map.items():
            if src_field in data and target_col in col_map:
                col_idx = col_map[target_col] - 1
                val = data[src_field]

                # 检查是否为空值
                if (
                    pd.isna(val)
                    or val is None
                    or (isinstance(val, float) and np.isnan(val))
                ):
                    continue  # 跳过空值

                # 转换为Python原生类型（处理numpy类型）
                if hasattr(val, "item"):  # numpy scalar
                    val = val.item()
                elif isinstance(val, str):
                    val = val.strip()

                new_row[col_idx] = val

        # 特殊处理：NR coverageType 映射到小区覆盖类型
        # 只有NR网络类型才处理，且只在现网工参中有coverageType值时才更新
        # LTE网络不处理小区覆盖类型
        # 注意：新行（不在现网工参中的小区）只有在现网工参中有明确coverageType值时才设置
        if network_type == "NR" and "coverageType" in data:
            val = data["coverageType"]

            # 调试日志
            safe_print(f"[DataService] NR新行: 发现coverageType字段，原始值={val}")

            # 检查是否为空值
            if not (
                pd.isna(val)
                or val is None
                or (isinstance(val, float) and np.isnan(val))
            ):
                # 转换为字符串并去除空格
                val_str = str(val).strip()

                # coverageType: "Micro" -> 4 (室内), "Macro" -> 1 (室外)
                # 只有明确的Micro或Macro才设置，其他值不设置（保持默认或空）
                if val_str == "Micro":
                    coverage_val = 4
                    safe_print(
                        f"[DataService] NR新行 coverageType映射: Micro -> 小区覆盖类型=4"
                    )
                    # 如果Excel中有"小区覆盖类型"列，则设置
                    if "小区覆盖类型" in col_map:
                        col_idx = col_map["小区覆盖类型"] - 1
                        new_row[col_idx] = coverage_val
                        safe_print(
                            f"[DataService] NR新行已设置: 小区覆盖类型={coverage_val}"
                        )
                    else:
                        safe_print(
                            f"[DataService] NR新行警告: Excel中没有'小区覆盖类型'列"
                        )
                elif val_str == "Macro":
                    coverage_val = 1
                    safe_print(
                        f"[DataService] NR新行 coverageType映射: Macro -> 小区覆盖类型=1"
                    )
                    # 如果Excel中有"小区覆盖类型"列，则设置
                    if "小区覆盖类型" in col_map:
                        col_idx = col_map["小区覆盖类型"] - 1
                        new_row[col_idx] = coverage_val
                        safe_print(
                            f"[DataService] NR新行已设置: 小区覆盖类型={coverage_val}"
                        )
                    else:
                        safe_print(
                            f"[DataService] NR新行警告: Excel中没有'小区覆盖类型'列"
                        )
                else:
                    # 未知值不设置（保持Excel默认值或空）
                    safe_print(
                        f"[DataService] NR新行 coverageType未知值: {val_str}，不设置小区覆盖类型"
                    )
            else:
                safe_print(
                    f"[DataService] NR新行 coverageType为空值，不设置小区覆盖类型"
                )

        # 填充固定字段
        if "系统制式" in col_map:
            new_row[col_map["系统制式"] - 1] = 1

        # 生成CGI列
        if "CGI" in col_map:
            if network_type == "LTE":
                # LTE CGI: eNodeB标识-小区标识
                enb_id = data.get("eNBId")
                cell_id = data.get("cellLocalId")
                if enb_id is not None and cell_id is not None:
                    try:
                        if not pd.isna(enb_id) and not pd.isna(cell_id):
                            cgi = f"{enb_id}-{cell_id}"
                            new_row[col_map["CGI"] - 1] = cgi
                    except (TypeError, ValueError):
                        pass
            else:  # NR
                # NR CGI: gNodeB标识-小区标识（安全转换浮点数为整数）
                gnb_id = data.get("gNBId")
                cell_id = data.get("cellLocalId")
                if gnb_id is not None and cell_id is not None:
                    try:
                        if not pd.isna(gnb_id) and not pd.isna(cell_id):
                            gnb_id_int = str(int(float(gnb_id))) if isinstance(gnb_id, (float, int, np.floating, np.integer)) else str(gnb_id).strip()
                            cell_id_int = str(int(float(cell_id))) if isinstance(cell_id, (float, int, np.floating, np.integer)) else str(cell_id).strip()
                            cgi = f"{gnb_id_int}-{cell_id_int}"
                            new_row[col_map["CGI"] - 1] = cgi
                    except (TypeError, ValueError):
                        pass

        # 更新跟踪区码
        if "跟踪区码" in col_map:
            tac = data.get("tac")
            if tac is not None and not pd.isna(tac):
                # 转换为Python原生类型
                if hasattr(tac, "item"):  # numpy scalar
                    tac = tac.item()
                elif isinstance(tac, str):
                    tac = tac.strip()
                new_row[col_map["跟踪区码"] - 1] = tac

        # 更新是否共享列
        if "是否共享" in col_map:
            if network_type == "LTE":
                # LTE: 基于plmnIdList判断
                plmn_id_list = data.get("plmnIdList")
                if (
                    plmn_id_list
                    and isinstance(plmn_id_list, str)
                    and ";" in plmn_id_list
                ):
                    new_row[col_map["是否共享"] - 1] = "是"
                else:
                    new_row[col_map["是否共享"] - 1] = "否"
            else:  # NR
                # NR: 暂不设置，待去重完成后按CGI分组统一判断
                pass

        # 设置"是否现网"列：追加的新行来自现网工参，填"是"
        if "是否现网" in col_map:
            new_row[col_map["是否现网"] - 1] = "是"

        # 设置第一分组：追加的行都填"电信中兴"
        if "第一分组" in col_map:
            new_row[col_map["第一分组"] - 1] = "电信中兴"

        # 设置第二分组：根据小区名称模糊匹配地区关键字
        if "第二分组" in col_map:
            # 只有当前为空值时才更新（追加的新行默认 None）
            current_second = new_row[col_map["第二分组"] - 1]
            if not current_second or (isinstance(current_second, str) and not current_second.strip()):
                cell_name = data.get("cellName") or data.get("CellName", "")
                if cell_name:
                    second_group = self._determine_second_group(str(cell_name))
                    if second_group:
                        new_row[col_map["第二分组"] - 1] = second_group

        # 将新行添加到工作表
        ws.append(new_row)

    def _determine_second_group(self, cell_name: str) -> Optional[str]:
        """根据小区名称模糊匹配地区关键字，确定第二分组

        匹配规则：
        - 在小区名称中依次查找：市区、东源、龙川、紫金、连平、和平
        - 返回在字符串中出现位置最左边（index 最小）的关键字
        - 若无匹配返回 None
        """
        keywords = ["市区", "东源", "龙川", "紫金", "连平", "和平"]
        best_match = None
        best_pos = len(cell_name)

        for kw in keywords:
            pos = cell_name.find(kw)
            if pos != -1 and pos < best_pos:
                best_pos = pos
                best_match = kw

        return best_match

    def _load_current_params(
        self, current_dir: Path, network_type: str
    ) -> Dict[str, Dict]:
        """读取现网工参CSV文件"""
        updates = {}

        if network_type == "LTE":
            patterns = ["LTE_SDR_CellInfo_*.csv", "LTE_ITBBU_CellInfo_*.csv"]
        else:
            patterns = ["NR_CellInfo_*.csv"]

        files = []
        for pat in patterns:
            files.extend(list(current_dir.glob(pat)))
            # Also try recursive if inside subfolders
            files.extend(list(current_dir.glob(f"**/{pat}")))

        try:
            safe_print(
                f"[DataService] 找到 {len(files)} 个CSV文件: {[f.name for f in files]}"
            )
        except UnicodeEncodeError:
            # 如果文件名包含特殊字符，使用ASCII安全打印
            safe_names = [
                f.name.encode("ascii", "replace").decode("ascii") for f in files
            ]
            safe_print(f"[DataService] 找到 {len(files)} 个CSV文件: {safe_names}")

        for file_path in files:
            try:
                # 尝试不同的编码
                try:
                    df = pd.read_csv(file_path, encoding="gbk")
                except:
                    df = pd.read_csv(file_path, encoding="utf-8")

                # 标准化列名（去除空格）
                df.columns = [c.strip() for c in df.columns]

                # 调试：打印CSV列名（使用安全打印避免GBK编码错误）
                try:
                    safe_print(
                        f"[DataService] CSV文件 {file_path.name} 的列名: {list(df.columns)}"
                    )
                except UnicodeEncodeError:
                    # 如果列名包含特殊字符，使用ASCII安全打印
                    safe_columns = [
                        str(c).encode("ascii", "replace").decode("ascii")
                        for c in df.columns
                    ]
                    safe_print(
                        f"[DataService] CSV文件 {file_path.name} 的列名: {safe_columns}"
                    )

                # LTE 专用：检查基站名称相关字段
                if network_type == "LTE":
                    bs_name_fields = ["eNBName", "UserLabel"]
                    found_bs_fields = [f for f in bs_name_fields if f in df.columns]
                    if found_bs_fields:
                        safe_print(f"[LTE DEBUG] CSV文件 {file_path.name} 中找到基站名称字段: {found_bs_fields}")
                        # 统计非空值数量
                        for field in found_bs_fields:
                            non_empty_count = df[field].notna().sum()
                            safe_print(f"  - {field}: {non_empty_count} 条非空记录")
                            # 显示前几个非空值作为样本
                            sample_values = df[field].dropna().head(3).tolist()
                            safe_print(f"  - {field} 样本值: {sample_values}")
                    else:
                        safe_print(f"[LTE WARN] CSV文件 {file_path.name} 中未找到基站名称字段 ({bs_name_fields})")
                        safe_print(f"[LTE WARN] CSV文件实际列名: {list(df.columns)}")
                        # 检查是否有类似的列名（大小写、空格等）
                        for field in bs_name_fields:
                            similar = [c for c in df.columns if field.lower() in c.lower()]
                            if similar:
                                safe_print(f"[LTE HINT] 可能匹配 '{field}' 的列: {similar}")

                # 特别检查 coverageType 列（仅 NR）
                if network_type == "NR" and "coverageType" in df.columns:
                    unique_values = df["coverageType"].dropna().unique()
                    try:
                        safe_print(
                            f"[DataService] CSV文件 {file_path.name} 中 coverageType 的唯一值: {list(unique_values)}"
                        )
                    except UnicodeEncodeError:
                        # 如果值包含特殊字符，使用ASCII安全打印
                        safe_values = [
                            str(v).encode("ascii", "replace").decode("ascii")
                            for v in unique_values
                        ]
                        safe_print(
                            f"[DataService] CSV文件 {file_path.name} 中 coverageType 的唯一值: {safe_values}"
                        )
                else:
                    safe_print(
                        f"[DataService] CSV文件 {file_path.name} 中没有 coverageType 列"
                    )

                # ===== 向量化处理 PLMN =====
                # 注意：部分CSV（如LTE_ITBBU）自带 mcc/mnc 列且为 int64 类型，
                # 直接赋值字符串会崩溃，需先转为 object 类型
                if "plmn" in df.columns:
                    plmn_mask = df["plmn"].notna()
                    if plmn_mask.any():
                        # 确保 mcc/mnc 列可接受字符串赋值
                        for col in ["mcc", "mnc"]:
                            if col in df.columns and df[col].dtype in ("int64", "float64"):
                                df[col] = df[col].astype(object)
                        plmn_split = df.loc[plmn_mask, "plmn"].astype(str).str.split(
                            "-", n=1, expand=True
                        )
                        df.loc[plmn_mask, "mcc"] = plmn_split[0].str.strip()
                        df.loc[plmn_mask, "mnc"] = (
                            plmn_split[1].str.strip()
                            if plmn_split.shape[1] > 1
                            else ""
                        )
                if "mcc" not in df.columns:
                    df["mcc"] = ""
                if "mnc" not in df.columns:
                    df["mnc"] = ""

                # ===== 向量化 Key 生成 & 列名归一化 =====
                if network_type == "LTE":
                    # 列名归一化：尝试多种可能的列名变体（ITBBU 与 SDR 可能不同）
                    enb_id_col = None
                    for col in ["eNBId", "eNodeBId", "ENBId"]:
                        if col in df.columns:
                            enb_id_col = col
                            break
                    cell_local_id_col = None
                    for col in ["cellLocalId", "CellId", "cellId"]:
                        if col in df.columns:
                            cell_local_id_col = col
                            break
                    if not enb_id_col or not cell_local_id_col:
                        safe_print(f"[DataService] LTE CSV 缺少必要的 eNBId/cellLocalId 列，可用列: {list(df.columns)}，跳过此文件")
                        continue
                    # 归一化列名到标准名称，确保后续 data.get("eNBId") / field_map 能正确匹配
                    col_rename = {}
                    if enb_id_col != "eNBId":
                        col_rename[enb_id_col] = "eNBId"
                    if cell_local_id_col != "cellLocalId":
                        col_rename[cell_local_id_col] = "cellLocalId"
                    if col_rename:
                        safe_print(f"[DataService] LTE 列名归一化: {col_rename}")
                        df.rename(columns=col_rename, inplace=True)
                    # 安全转为整数再转 str，避免 float64 → "12345.0" 与 Excel 的 "12345" 不匹配
                    df["_key"] = (
                        df["eNBId"].fillna("").astype(str).apply(lambda v: str(int(float(v))) if v.strip() else "")
                        + "_" + df["cellLocalId"].fillna("").astype(str).apply(lambda v: str(int(float(v))) if v.strip() else "")
                    )
                else:
                    # NR 列名归一化：尝试多种可能的列名变体
                    gnb_id_col = None
                    for col in ["gNBId", "gNodeBId", "GNBId"]:
                        if col in df.columns:
                            gnb_id_col = col
                            break
                    cell_local_id_col = None
                    for col in ["cellLocalId", "CellId", "cellId"]:
                        if col in df.columns:
                            cell_local_id_col = col
                            break
                    if not gnb_id_col or not cell_local_id_col:
                        safe_print(f"[DataService] NR CSV 缺少必要的 gNBId/cellLocalId 列，可用列: {list(df.columns)}，跳过此文件")
                        continue
                    # 归一化列名到标准名称
                    col_rename = {}
                    if gnb_id_col != "gNBId":
                        col_rename[gnb_id_col] = "gNBId"
                    if cell_local_id_col != "cellLocalId":
                        col_rename[cell_local_id_col] = "cellLocalId"
                    if col_rename:
                        safe_print(f"[DataService] NR 列名归一化: {col_rename}")
                        df.rename(columns=col_rename, inplace=True)
                    # 安全转为整数再转 str，避免 float64 → "12345.0" 与 Excel 的 "12345" 不匹配
                    def _safe_int_str(v):
                        if v.strip():
                            try:
                                return str(int(float(v)))
                            except (ValueError, OverflowError):
                                pass
                        return v
                    df["_key"] = (
                        df["mcc"].fillna("").astype(str).apply(_safe_int_str)
                        + "_" + df["mnc"].fillna("").astype(str).apply(_safe_int_str)
                        + "_" + df["gNBId"].fillna("").astype(str).apply(_safe_int_str)
                        + "_" + df["cellLocalId"].fillna("").astype(str).apply(_safe_int_str)
                    )

                # 过滤无效Key
                df = df[df["_key"].str.strip() != ""].copy()
                df = df[~df["_key"].str.match(r'^[_]+$')].copy()
                if df.empty:
                    continue

                # NR 重复小区处理：
                # 1) "CGI"列（gNBId-cellLocalId）相同的小区，如果经度/纬度为空的，
                #    则填充该CGI下已有非空的经度/纬度值
                # 2) 按NR小区唯一键（mcc_mnc_gNBId_cellLocalId）去重
                if network_type == "NR":
                    # 确定经度/纬度列名
                    lon_col_name = None
                    lat_col_name = None
                    for col in ["longitude", "Longitude", "LONGITUDE", "lon", "Lon"]:
                        if col in df.columns:
                            lon_col_name = col
                            break
                    for col in ["latitude", "Latitude", "LATITUDE", "lat", "Lat"]:
                        if col in df.columns:
                            lat_col_name = col
                            break

                    if lon_col_name and lat_col_name:
                        # 使用 CGI 列（gNBId-cellLocalId）分组填充空经纬度
                        df["_cgi"] = df["gNBId"].fillna("").astype(str).apply(_safe_int_str) + "_" + df["cellLocalId"].fillna("").astype(str).apply(_safe_int_str)
                        cgi_dup_mask = df.duplicated(subset=["_cgi"], keep=False)
                        if cgi_dup_mask.any():
                            for _cgi_val in df.loc[cgi_dup_mask, "_cgi"].unique():
                                _mask = df["_cgi"] == _cgi_val
                                _group = df.loc[_mask]
                                # 找到该CGI组中非空的经纬度
                                _lon_val = _group[lon_col_name].dropna()
                                _lat_val = _group[lat_col_name].dropna()
                                if not _lon_val.empty:
                                    _known_lon = _lon_val.iloc[0]
                                    df.loc[_mask & df[lon_col_name].isna(), lon_col_name] = _known_lon
                                if not _lat_val.empty:
                                    _known_lat = _lat_val.iloc[0]
                                    df.loc[_mask & df[lat_col_name].isna(), lat_col_name] = _known_lat
                        df.drop(columns=["_cgi"], inplace=True)

                    # 去重：相同 _key（NR唯一键）只保留第一条
                    before = len(df)
                    df = df.drop_duplicates(subset=["_key"], keep="first")
                    after = len(df)
                    if before != after:
                        safe_print(f"[DataService] NR 去重: {before} -> {after} 行 (移除了 {before - after} 条重复)")

                # ===== 一次性转 dict + 构建索引 =====
                keys = df["_key"].tolist()
                records = df.to_dict("records")
                file_updates = dict(zip(keys, records))
                updates.update(file_updates)

                # 调试日志（采样前3条）
                sample_keys = list(file_updates.keys())[:3]
                for k in sample_keys:
                    rec = file_updates[k]
                    bs_fields = (
                        ["eNBName", "UserLabel"]
                        if network_type == "LTE"
                        else ["eNBName", "gNBName", "UserLabel", "dra_GNBName"]
                    )
                    bs_vals = {
                        f: rec[f]
                        for f in bs_fields
                        if f in rec and pd.notna(rec[f]) and str(rec[f]).strip()
                    }
                    if bs_vals:
                        safe_print(f"[DEBUG] Key={k}, 基站名称字段: {bs_vals}")
                    elif network_type == "LTE":
                        safe_print(f"[LTE WARN] Key={k} 没有任何基站名称字段")

            except Exception as e:
                import traceback

                safe_print(f"[DataService] 读取CSV失败 {file_path.name}: {e}")
                traceback.print_exc()

        safe_print(f"[DataService] 总共加载 {len(updates)} 条 {network_type} 现网数据")

        # 跨文件 CGI 经纬度填充：NR 相同 CGI 的记录，如果经度/纬度为空的，
        # 则从同 CGI 的非空记录中获取
        if network_type == "NR" and updates:
            def _norm_id(v):
                if v is None:
                    return ""
                try:
                    return str(int(float(v)))
                except (ValueError, OverflowError, TypeError):
                    return str(v).strip()

            cgi_groups = {}
            for key, data in updates.items():
                gnb_id = _norm_id(data.get("gNBId"))
                cell_local_id = _norm_id(data.get("cellLocalId"))
                if gnb_id and cell_local_id:
                    cgi = f"{gnb_id}_{cell_local_id}"
                    if cgi not in cgi_groups:
                        cgi_groups[cgi] = []
                    cgi_groups[cgi].append(key)

            filled_count = 0
            for cgi, keys in cgi_groups.items():
                if len(keys) <= 1:
                    continue
                # 找到该CGI组中非空的经纬度
                known_lon = None
                known_lat = None
                for key in keys:
                    data = updates[key]
                    lon_val = data.get("longitude")
                    lat_val = data.get("latitude")
                    if known_lon is None and lon_val is not None and not (isinstance(lon_val, float) and np.isnan(lon_val)):
                        try:
                            if not pd.isna(lon_val):
                                known_lon = lon_val
                        except (TypeError, ValueError):
                            pass
                    if known_lat is None and lat_val is not None and not (isinstance(lat_val, float) and np.isnan(lat_val)):
                        try:
                            if not pd.isna(lat_val):
                                known_lat = lat_val
                        except (TypeError, ValueError):
                            pass
                # 填充同CGI内经纬度为空的记录
                for key in keys:
                    data = updates[key]
                    if known_lon is not None:
                        cur_lon = data.get("longitude")
                        if cur_lon is None or (isinstance(cur_lon, float) and np.isnan(cur_lon)):
                            try:
                                if pd.isna(cur_lon):
                                    updates[key]["longitude"] = known_lon
                                    filled_count += 1
                            except (TypeError, ValueError):
                                updates[key]["longitude"] = known_lon
                                filled_count += 1
                    if known_lat is not None:
                        cur_lat = data.get("latitude")
                        if cur_lat is None or (isinstance(cur_lat, float) and np.isnan(cur_lat)):
                            try:
                                if pd.isna(cur_lat):
                                    updates[key]["latitude"] = known_lat
                                    filled_count += 1
                            except (TypeError, ValueError):
                                updates[key]["latitude"] = known_lat
                                filled_count += 1

            if filled_count > 0:
                safe_print(f"[DataService] CGI经纬度填充: 总计填充了 {filled_count} 条记录的经纬度")

        return updates

    def _parse_current_params_dataframe(
        self, df: pd.DataFrame, filename: str
    ) -> Dict[str, List[Dict]]:
        """将现网工参CSV DataFrame解析为站点/扇区数据结构

        根据文件名模式自动判断网络类型:
        - LTE_SDR_CellInfo_*/LTE_ITBBU_CellInfo_* → LTE
        - NR_CellInfo_* → NR

        Returns:
            {network_type: [{id, name, longitude, latitude, sectors: [...]}]}
        """
        import re as _re
        _fn_lower = filename.lower()
        if _re.match(r'lte_sdr_cellinfo_|lte_itbbu_cellinfo_', _fn_lower):
            network_type = "LTE"
        elif _re.match(r'nr_cellinfo_', _fn_lower):
            network_type = "NR"
        else:
            safe_print(f"[DataService] 无法从文件名判断网络类型: {filename}，跳过解析")
            return {}

        safe_print(f"[DataService] 解析现网工参CSV: {filename} → {network_type}, {len(df)} 行")

        # 按基站分组
        if network_type == "LTE":
            site_id_col = "eNBId"
            site_name_col = "eNBName"
            sector_id_col = "cellLocalId"
            sector_name_col = "cellName"
            lon_col = "longitude"
            lat_col = "latitude"
            # 备选列名
            for _col in ["eNBId", "eNodeBId"]:
                if _col in df.columns:
                    site_id_col = _col
                    break
            for _col in ["eNBName", "UserLabel", "eNodeBName"]:
                if _col in df.columns:
                    site_name_col = _col
                    break
            for _col in ["cellLocalId", "CellId", "cellId"]:
                if _col in df.columns:
                    sector_id_col = _col
                    break
            for _col in ["cellName", "CellName"]:
                if _col in df.columns:
                    sector_name_col = _col
                    break
            for _col in ["longitude", "Longitude", "LONGITUDE", "lon", "Lon"]:
                if _col in df.columns:
                    lon_col = _col
                    break
            for _col in ["latitude", "Latitude", "LATITUDE", "lat", "Lat"]:
                if _col in df.columns:
                    lat_col = _col
                    break
        else:  # NR
            site_id_col = "gNBId"
            site_name_col = "gNBName"
            sector_id_col = "cellLocalId"
            sector_name_col = "cellName"
            lon_col = "longitude"
            lat_col = "latitude"
            for _col in ["gNBId", "gNodeBId"]:
                if _col in df.columns:
                    site_id_col = _col
                    break
            for _col in ["gNBName", "UserLabel", "dra_GNBName"]:
                if _col in df.columns:
                    site_name_col = _col
                    break
            for _col in ["cellLocalId", "CellId", "cellId"]:
                if _col in df.columns:
                    sector_id_col = _col
                    break
            for _col in ["cellName", "CellName"]:
                if _col in df.columns:
                    sector_name_col = _col
                    break
            for _col in ["longitude", "Longitude", "LONGITUDE", "lon", "Lon"]:
                if _col in df.columns:
                    lon_col = _col
                    break
            for _col in ["latitude", "Latitude", "LATITUDE", "lat", "Lat"]:
                if _col in df.columns:
                    lat_col = _col
                    break

        # 检查必要列
        _required = [site_id_col, sector_id_col]
        _missing = [c for c in _required if c not in df.columns]
        if _missing:
            safe_print(f"[DataService] CSV缺少必要列: {_missing}, 可用列: {list(df.columns)}")
            return {}

        # 按站点ID分组
        sites_map: Dict[str, Dict] = {}
        for _, row in df.iterrows():
            try:
                _site_id = str(int(float(str(row[site_id_col])))) if pd.notna(row[site_id_col]) else ""
                _sector_id = str(int(float(str(row[sector_id_col])))) if pd.notna(row[sector_id_col]) else ""
                if not _site_id or not _sector_id:
                    continue

                _site_name = str(row[site_name_col]) if site_name_col in df.columns and pd.notna(row[site_name_col]) else f"Site_{_site_id}"
                _sector_name = str(row[sector_name_col]) if sector_name_col in df.columns and pd.notna(row[sector_name_col]) else f"Cell_{_site_id}_{_sector_id}"

                _lon = float(row[lon_col]) if lon_col in df.columns and pd.notna(row[lon_col]) else 0.0
                _lat = float(row[lat_col]) if lat_col in df.columns and pd.notna(row[lat_col]) else 0.0

                # 获取其他字段
                _azimuth = 0.0
                for _ac in ["azimuth", "Azimuth", "antennaAzimuth"]:
                    if _ac in df.columns and pd.notna(row[_ac]):
                        try:
                            _azimuth = float(row[_ac])
                        except:
                            pass
                        break

                _pci = None
                for _pc in ["pci", "PCI", "physicalCellId"]:
                    if _pc in df.columns and pd.notna(row[_pc]):
                        try:
                            _pci = int(float(str(row[_pc])))
                        except:
                            pass
                        break

                _tac = None
                for _tc in ["tac", "TAC", "trackingAreaCode"]:
                    if _tc in df.columns and pd.notna(row[_tc]):
                        try:
                            _tac = int(float(str(row[_tc])))
                        except:
                            _tac = str(row[_tc]).strip()
                        break

                _height = 30.0
                for _hc in ["height", "Height", "antennaHeight"]:
                    if _hc in df.columns and pd.notna(row[_hc]):
                        try:
                            _height = float(row[_hc])
                        except:
                            pass
                        break

                _freq = None
                for _fc in ["frequency", "Frequency", "ssbFrequency", "earfcn"]:
                    if _fc in df.columns and pd.notna(row[_fc]):
                        _freq = row[_fc]
                        break

                if _site_id not in sites_map:
                    sites_map[_site_id] = {
                        "id": _site_id,
                        "name": _site_name,
                        "longitude": _lon,
                        "latitude": _lat,
                        "networkType": network_type,
                        "sectors": [],
                    }

                _sector = {
                    "id": f"{_site_id}_{_sector_id}",
                    "siteId": _site_id,
                    "name": _sector_name,
                    "longitude": _lon,
                    "latitude": _lat,
                    "azimuth": _azimuth,
                    "beamwidth": 65.0,
                    "height": _height,
                    "pci": _pci,
                    "tac": _tac,
                }
                if _freq is not None:
                    _sector["earfcn"] = _freq
                    _sector["ssb_frequency"] = _freq

                sites_map[_site_id]["sectors"].append(_sector)
            except Exception as _e:
                continue

        result = {network_type: list(sites_map.values())}
        safe_print(f"[DataService] 解析完成: {filename} → {network_type}: {len(sites_map)} 个基站")
        return result

    async def upload_excel(
        self, file: Optional[Any], original_path: Optional[str] = None,
        user_id: int = 1,
    ) -> Dict[str, Any]:
        """上传并解析Excel工参文件（同步模式，小文件使用）"""
        # 初始化上传（保存文件）
        result = await self.init_upload(file, original_path, user_id=user_id)
        data_id = result["id"]
        # 同步处理（直接等待结果）
        try:
            self._process_upload_sync(data_id)
            return self.index.get(data_id, {"id": data_id, "status": "error"})
        except Exception as e:
            safe_print(f"[DataService] 同步处理失败: {e}")
            self.index[data_id]["status"] = "error"
            self.index[data_id]["errorMessage"] = str(e)
    
            raise

    async def init_upload(
        self, file: Optional[Any], original_path: Optional[str] = None,
        user_id: int = 1, overwrite: bool = False,
    ) -> Dict[str, Any]:
        """上传文件初始化：保存文件并创建处理中的索引条目（快速返回）

        Args:
            overwrite: 如果为 True 且存在同名文件，删除旧文件后用新 ID 覆盖
        """
        safe_print(f"[DataService] ===== 开始上传Excel文件（初始化）=====")

        if original_path:
            original_path = original_path.strip("\"'")

        if original_path:
            filename = os.path.basename(original_path)
            ext = os.path.splitext(filename)[1]
        elif file:
            filename = file.filename
            if not filename:
                raise ValueError("无法从上传的文件中获取文件名")
            ext = os.path.splitext(filename)[1]
        else:
            raise ValueError("必须提供文件或文件路径")

        safe_print(f"[DataService] 文件名: {filename}")

        # 检查是否有同名文件
        existing_id = None
        for exist_id, exist_info in self.index.items():
            if exist_info.get("name") == filename and exist_info.get("type") == "excel":
                existing_id = exist_id
                break

        if existing_id and not overwrite:
            return {
                "id": existing_id,
                "name": filename,
                "status": "duplicate",
                "fileType": self.index[existing_id].get("fileType", "unknown"),
            }

        # 覆盖：删除旧文件
        if existing_id and overwrite:
            safe_print(f"[DataService] 覆盖同名文件: {filename} (旧ID: {existing_id})")
            try:
                self.delete_data(existing_id)
            except Exception as e:
                safe_print(f"[DataService] 删除旧文件失败 (非致命): {e}")

        data_id = str(uuid.uuid4())
        safe_print(f"[DataService] 生成ID: {data_id}")

        import re
        safe_filename = re.sub(r'[<>:"/\\|?*]', "_", filename)
        if len(safe_filename) > 100:
            name, text_ext = os.path.splitext(safe_filename)
            safe_filename = name[:90] + text_ext

        file_path = settings.UPLOAD_DIR / f"{data_id}{ext}"
        safe_print(f"[DataService] 目标路径: {file_path}")

        try:
            if file:
                content = await file.read()
                safe_print(f"[DataService] 已读取 {len(content):,} 字节")
                with open(file_path, "wb") as f:
                    f.write(content)
            elif original_path:
                if not os.path.exists(original_path):
                    raise ValueError(f"文件不存在: {original_path}")
                shutil.copy2(original_path, file_path)

            if file_path.exists():
                file_size = file_path.stat().st_size
                safe_print(f"[DataService] 文件验证成功，大小: {file_size:,} 字节")
            else:
                raise FileNotFoundError(f"文件保存失败: {file_path}")
        except Exception as e:
            safe_print(f"[DataService] 文件准备失败: {type(e).__name__}: {e}")
            raise ValueError(f"文件准备失败: {str(e)}")

        # 创建 data 目录和处理中的索引条目
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)

        try:
            # 保留原始扩展名（xlsx/xls/csv/zip等），避免硬编码为 .xlsx
            shutil.copy(file_path, data_dir / f"original{ext}")
        except Exception as e:
            safe_print(f"[DataService] 保存原始文件失败: {e}")

        # 写入处理中状态索引
        self.index[data_id] = {
            "id": data_id,
            "name": filename,
            "type": "excel",
            "fileType": "pending",
            "size": file_path.stat().st_size,
            "originalPath": original_path,
            "uploadDate": datetime.now().isoformat(),
            "status": "processing",
            "user_id": user_id,
        }

        safe_print(f"[DataService] 已创建处理中索引条目: {data_id}")
        self._save_index()  # 持久化处理中状态

        return {
            "id": data_id,
            "name": filename,
            "status": "processing",
            "fileType": "pending",
        }

    def _process_upload_sync(self, data_id: str) -> None:
        """同步处理上传文件（在线程池中执行）"""
        safe_print(f"[DataService] ===== 开始后台处理: {data_id} =====")

        # 获取文件信息
        data_info = self.index.get(data_id)
        if not data_info:
            safe_print(f"[DataService] 索引中找不到: {data_id}")
            return

        filename = data_info.get("name", "unknown")
        safe_print(f"[DataService] 处理文件: {filename}")

        # 查找文件
        file_path = settings.UPLOAD_DIR / f"{data_id}.xlsx"
        if not file_path.exists():
            file_path = settings.UPLOAD_DIR / f"{data_id}.xls"
        if not file_path.exists():
            for f in settings.UPLOAD_DIR.glob(f"{data_id}.*"):
                file_path = f
                break
        if not file_path.exists():
            safe_print(f"[DataService] 文件不存在: {data_id}")
            self.index[data_id]["status"] = "error"
            self.index[data_id]["errorMessage"] = "上传文件不存在，可能是上传过程中服务器重启导致文件丢失"
    
            return

        import json, time as _time, tempfile as _tempfile, zipfile as _zipfile
        _zip_extract_dir = None  # ZIP解压临时目录，需要在finally中清理
        try:
            _t_start = _time.time()

            # === ZIP 解压处理 ===
            if file_path.suffix.lower() in ['.zip']:
                safe_print(f"[DataService] 检测到ZIP文件，开始解压...")
                data_dir = settings.DATA_DIR / data_id
                data_dir.mkdir(parents=True, exist_ok=True)
                try:
                    with _zipfile.ZipFile(file_path, 'r') as zf:
                        zf.extractall(data_dir)
                    safe_print(f"[DataService] ZIP已解压到: {data_dir}")
                except Exception as e:
                    raise ValueError(f"ZIP文件解压失败: {str(e)}")

                # 在解压后的文件中查找 Excel/CSV/TXT
                _found_excel = None
                _found_csv = None
                _found_txt = None
                _found_mapinfo_tabs = []  # 记录找到的 MapInfo TAB 文件
                for _f in data_dir.rglob('*'):
                    if _f.is_file() and not _f.name.startswith('~$'):
                        _ext_lower = _f.suffix.lower()
                        if _ext_lower in ['.xlsx', '.xls'] and not _found_excel:
                            _found_excel = _f
                        elif _ext_lower == '.csv' and not _found_csv:
                            _found_csv = _f
                        elif _ext_lower in ['.txt'] and not _found_txt:
                            _found_txt = _f
                        elif _ext_lower == '.tab':
                            # 记录 MapInfo TAB 文件以便后续注册为图层
                            _found_mapinfo_tabs.append(_f)

                _candidate = _found_excel or _found_csv or _found_txt
                if _candidate:
                    safe_print(f"[DataService] ZIP中找到数据文件: {_candidate.name}")
                    file_path = _candidate
                elif _found_mapinfo_tabs:
                    # ZIP 中只有 MapInfo TAB 文件，没有 Excel/CSV
                    safe_print(f"[DataService] ZIP中找到 {len(_found_mapinfo_tabs)} 个 MapInfo TAB 文件，尝试解析...")
                    # 让 upload_map 逻辑处理（触发 MapInfo 解析）
                    # 设定 file_path 为第一个 TAB 文件，并标记为 mapinfo 类型
                    file_path = _found_mapinfo_tabs[0]
                    # 此 ZIP 将被视为 MapInfo 图层上传，直接解析图层并返回
                    from app.services.mapinfo_service import parse_mapinfo_files, get_last_parse_errors
                    _mapinfo_layers = parse_mapinfo_files(data_dir, parent_id=data_id)
                    _mapinfo_errors = get_last_parse_errors()
                    layers_json_path = data_dir / "layers.json"
                    with open(layers_json_path, "w", encoding="utf-8") as _lf:
                        json.dump(_mapinfo_layers, _lf, ensure_ascii=False, indent=2)
                    # 后台预热 GeoJSON 磁盘缓存，避免首次勾选时等待 parse + 坐标转换
                    self._prewarm_mapinfo_cache(data_id)
                    # 更新索引为 map 类型
                    _layer_status = (
                        "ready" if _mapinfo_layers
                        else "partial" if _mapinfo_errors
                        else "error"
                    )
                    self.index[data_id].update({
                        "type": "map",
                        "subType": "mapinfo",
                        "fileType": "tac_layer",
                        "status": _layer_status,
                        "metadata": {
                            "fileCount": len(list(data_dir.rglob('*'))),
                            "layerCount": len(_mapinfo_layers),
                            "layers": _mapinfo_layers,
                            "errors": _mapinfo_errors,  # 每个失败文件的具体原因
                        },
                    })
                    safe_print(f"[DataService] MapInfo 图层已注册: {len(_mapinfo_layers)} 个图层")
                    self._save_index()  # 持久化 MapInfo 图层索引
                    return  # 早返回，跳过后续 Excel 处理逻辑
                else:
                    raise ValueError("ZIP文件中未找到有效的数据文件（支持 Excel/CSV/TXT/MapInfo TAB）")

            # 检测是否为现网工参文件（LTE_SDR_CellInfo_*/NR_CellInfo_* CSV）
            _current_params_patterns = [
                r'LTE_SDR_CellInfo_.*\.csv',
                r'LTE_ITBBU_CellInfo_.*\.csv',
                r'NR_CellInfo_.*\.csv',
            ]
            _is_current_params = False
            # 检查候选文件名是否匹配
            _check_name = file_path.name if file_path else filename
            for _pat in _current_params_patterns:
                if re.match(_pat, _check_name, re.IGNORECASE):
                    _is_current_params = True
                    safe_print(f"[DataService] 文件名匹配现网工参模式: {_check_name}")
                    break
            # 如果候选文件不匹配，扫描解压目录中的所有文件（处理ZIP内混合内容的情况）
            if not _is_current_params:
                _extract_dir = settings.DATA_DIR / data_id
                if _extract_dir.exists():
                    for _f in _extract_dir.rglob('*'):
                        if _f.is_file():
                            for _pat in _current_params_patterns:
                                if re.match(_pat, _f.name, re.IGNORECASE):
                                    _is_current_params = True
                                    safe_print(f"[DataService] 目录扫描检测到现网工参文件: {_f.name}")
                                    break
                        if _is_current_params:
                            break

            if _is_current_params:
                safe_print(f"[DataService] 现网工参文件，解析CSV并保存到 data.json")
                # 确保CSV文件以原始文件名存在于数据目录中
                _data_dir = settings.DATA_DIR / data_id
                if file_path.suffix.lower() == '.csv' and file_path.parent != _data_dir:
                    _target_csv = _data_dir / file_path.name
                    if not _target_csv.exists():
                        shutil.copy2(file_path, _target_csv)
                        safe_print(f"[DataService] 保留原始CSV文件名: {_target_csv.name}")
                # 如果是ZIP且还没解压，先解压
                if file_path.suffix.lower() in ['.zip'] and not (_data_dir / file_path.with_suffix('').name).exists():
                    import zipfile as _zf2
                    _extract_dir2 = _data_dir
                    _extract_dir2.mkdir(parents=True, exist_ok=True)
                    with _zf2.ZipFile(file_path, 'r') as zf:
                        zf.extractall(_extract_dir2)
                    safe_print(f"[DataService] 已解压现网工参ZIP到: {_extract_dir2}")

                # 解析现网工参CSV文件并生成 data.json（传统文件处理逻辑）
                parsed_data = {}
                metadata = {"isCurrentParams": True}
                _csv_files = list(_data_dir.glob("*.csv"))
                safe_print(f"[DataService] 找到 {len(_csv_files)} 个CSV文件待解析")
                for _csv_f in _csv_files:
                    try:
                        _df = pd.read_csv(_csv_f, encoding="gbk")
                    except:
                        try:
                            _df = pd.read_csv(_csv_f, encoding="utf-8")
                        except Exception as _e:
                            safe_print(f"[DataService] 跳过无法解析的CSV: {_csv_f.name}: {_e}")
                            continue
                    _df.columns = [c.strip() for c in _df.columns]
                    # 解析为站点/扇区数据
                    _sites = self._parse_current_params_dataframe(_df, _csv_f.name)
                    for _nt, _site_list in _sites.items():
                        if _nt not in parsed_data:
                            parsed_data[_nt] = []
                        parsed_data[_nt].extend(_site_list)
                        metadata[f"{_nt}SiteCount"] = metadata.get(f"{_nt}SiteCount", 0) + len(_site_list)
                        metadata[f"{_nt}SectorCount"] = metadata.get(f"{_nt}SectorCount", 0) + sum(
                            len(s.get("sectors", [])) for s in _site_list
                        )
                safe_print(f"[DataService] 现网工参解析完成: { {k: len(v) for k,v in parsed_data.items()} }")
                file_type = "current_params"

                # 保存到 data.json（传统文件存储，供工参更新使用）
                with open(_data_dir / "data.json", "w", encoding="utf-8") as _dj:
                    json.dump(parsed_data, _dj, ensure_ascii=False, indent=2)
                safe_print(f"[DataService] 现网工参 data.json 已保存")
            elif filename.lower().endswith(".csv") or file_path.suffix.lower() == '.csv':
                try:
                    df = pd.read_csv(file_path, encoding="utf-8")
                except:
                    df = pd.read_csv(file_path, encoding="gbk")
                parsed_data = {"default": self._parse_dataframe(df, filename, "unknown")}
                metadata = {"siteCount": len(parsed_data["default"])}
                file_type = "default"
            elif file_path.suffix.lower() in ['.txt', '.tab']:
                safe_print(f"[DataService] 从ZIP中读取TXT/TAB文件: {file_path.name}")
                for sep in [",", "\t", ";", " ", "|"]:
                    try:
                        df = pd.read_csv(file_path, sep=sep, encoding="gbk")
                        if len(df.columns) > 1:
                            break
                    except:
                        continue
                parsed_data = {"default": self._parse_dataframe(df, filename, "unknown")}
                metadata = {"siteCount": len(parsed_data["default"])}
                file_type = "default"
            else:
                xls = pd.ExcelFile(file_path, engine="calamine")
                try:
                    sheet_names = xls.sheet_names
                    file_type = self._classify_file(filename, sheet_names)
                    safe_print(f"[DataService] 文件类型: {file_type}")

                    if file_type in ["full_params", "target_cells"]:
                        # 新工参上传时，清除所有已有的应用标记（数据已替换，旧的已应用状态失效）
                        if file_type == "full_params":
                            try:
                                from app.core.database import SessionLocal
                                from app.models.database import TaskResult
                                _db_reset = SessionLocal()
                                try:
                                    _count = _db_reset.query(TaskResult).filter(
                                        TaskResult.is_applied == 1
                                    ).update({"is_applied": 0})
                                    _db_reset.commit()
                                    if _count > 0:
                                        safe_print(f"[DataService] 新工参上传，重置了 {_count} 个任务的已应用标记")
                                finally:
                                    _db_reset.close()
                            except Exception as _reset_err:
                                safe_print(f"[DataService] 重置已应用标记失败（非致命）: {_reset_err}")

                        files_to_delete = []
                        for existing_id, existing_data in self.index.items():
                            if existing_data.get("fileType") == file_type and existing_id != data_id:
                                files_to_delete.append(existing_id)
                        for did in files_to_delete:
                            try:
                                self.delete_data(did)
                                safe_print(f"[DataService] 已删除旧文件: {did}")
                            except Exception as e:
                                safe_print(f"[DataService] 删除旧文件失败: {e}")

                    parsed_data = {}
                    metadata = {}

                    if file_type == "full_params":
                        for network in ["LTE", "NR"]:
                            sheet_name = f"{network} Project Parameters"
                            if sheet_name in sheet_names:
                                safe_print(f"[DataService] 解析 {sheet_name}...")
                                sites = self._parse_sheet_data(xls, sheet_name, network)
                                parsed_data[network] = sites
                                metadata[f"{network}SiteCount"] = len(sites)
                                metadata[f"{network}SectorCount"] = sum(
                                    len(s.get("sectors", [])) for s in sites
                                )

                    elif file_type == "target_cells":
                        for network in ["LTE", "NR"]:
                            actual_sheet = None
                            for sn in sheet_names:
                                if sn.strip().lower() == network.lower():
                                    actual_sheet = sn
                                    break
                            if actual_sheet:
                                safe_print(f"[DataService] 解析 {network} (sheet: {actual_sheet})...")
                                sites = self._parse_sheet_data(xls, actual_sheet, network)
                                parsed_data[network] = sites
                                metadata[f"{network}SiteCount"] = len(sites)
                                metadata[f"{network}SectorCount"] = sum(
                                    len(s.get("sectors", [])) for s in sites
                                )
                    else:
                        safe_print(f"[DataService] 使用默认解析...")
                        sites = self._parse_default_excel(xls)
                        parsed_data["default"] = sites
                        metadata["siteCount"] = len(sites)
                        metadata["sectorCount"] = sum(
                            len(s.get("sectors", [])) for s in sites
                        )

                finally:
                    xls.close()

            # 检查解析结果（current_params 不需要解析，跳过此检查）
            if file_type != "current_params" and not parsed_data:
                raise ValueError("解析后数据为空，请检查Excel文件是否包含有效的LTE或NR数据")

            # === ZIP混合内容处理：注册同目录下的 MapInfo TAB 文件为图层 ===
            # 当 ZIP 同时包含工参 CSV 和 TAC 图层 TAB 文件时，
            # 将 TAB 文件注册到 SQLite Layer 表，确保 TAC 核查/规划能搜索到
            if file_path.suffix.lower() in ['.csv', '.xlsx', '.xls']:
                _extract_data_dir = settings.DATA_DIR / data_id
                if _extract_data_dir.exists():
                    for _f in _extract_data_dir.rglob('*.tab'):
                        if _f.is_file() and not _f.name.startswith('~$'):
                            _f_lower = _f.name.lower()
                            # 检查该 TAB 文件是否已入库（避免重复注册）
                            _db = SessionLocal()
                            try:
                                _existing_layer = _db.query(Layer).filter(
                                    Layer.file_path == str(_f)
                                ).first()
                                if not _existing_layer:
                                    # 尝试解析 MapInfo 图层
                                    try:
                                        from app.services.mapinfo_service import parse_mapinfo_files
                                        _map_layers = parse_mapinfo_files(_f, parent_id=data_id)
                                        safe_print(f"[DataService] ZIP混合内容: 已注册 MapInfo 图层 {_f.name}, 共 {len(_map_layers)} 个图层")
                                    except Exception as _me:
                                        safe_print(f"[DataService] ZIP混合内容: 注册 MapInfo 图层失败 {_f.name}: {_me}")
                            finally:
                                _db.close()
                    # 同时检查 .mif 文件
                    for _f in _extract_data_dir.rglob('*.mif'):
                        if _f.is_file() and not _f.name.startswith('~$'):
                            _db = SessionLocal()
                            try:
                                _existing_layer = _db.query(Layer).filter(
                                    Layer.file_path == str(_f)
                                ).first()
                                if not _existing_layer:
                                    try:
                                        from app.services.mapinfo_service import parse_mapinfo_files
                                        _map_layers = parse_mapinfo_files(_f, parent_id=data_id)
                                        safe_print(f"[DataService] ZIP混合内容: 已注册 MapInfo 图层 {_f.name}, 共 {len(_map_layers)} 个图层")
                                    except Exception as _me:
                                        safe_print(f"[DataService] ZIP混合内容: 注册 MapInfo 图层失败 {_f.name}: {_me}")
                            finally:
                                _db.close()
            # === 结束 ZIP 混合内容处理 ===

            # 写入 SQLite（数据持久化）
            # current_params 只写 Workbook 元数据行，不写 Sites/Sectors（parsed_data 为空，循环自动跳过）
            user_id = data_info.get("user_id", 1)
            self._save_to_sqlite(
                data_id=data_id,
                filename=data_info.get("name", filename),
                file_type=file_type,
                user_id=user_id,
                parsed_data=parsed_data,
                metadata=metadata,
                file_path=file_path,
                original_path=data_info.get("originalPath"),
            )

            _t_end = _time.time()
            safe_print(f"[DataService] 后台处理完成: {data_id}, 耗时: {_t_end-_t_start:.1f}s")

            # 更新索引
            self.index[data_id].update({
                "fileType": file_type,
                "status": "ready",
                "metadata": metadata,
            })

            safe_print(f"[DataService] 索引已更新为 ready")
            self._save_index()  # 持久化索引到 index.json

        except Exception as e:
            safe_print(f"[DataService] 后台处理失败: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            self.index[data_id]["status"] = "error"
            self.index[data_id]["errorMessage"] = str(e)
            self._save_index()  # 持久化错误状态
    

    def _save_to_sqlite(
        self,
        data_id: str,
        filename: str,
        file_type: str,
        user_id: int,
        parsed_data: Dict[str, List],
        metadata: Dict[str, Any],
        file_path: Path,
        original_path: Optional[str] = None,
        remark: Optional[str] = None,
    ):
        """将工参数据写入 SQLite（支持 upsert，避免重复写入报错）"""
        db = SessionLocal()
        try:
            # 1) 写入 Workbook（使用 merge 避免重复主键报错）
            network_types = list(parsed_data.keys())
            _existing_wb = db.query(Workbook).filter(Workbook.id == data_id).first()
            if _existing_wb:
                # 更新已有记录
                _existing_wb.name = filename
                _existing_wb.file_type = file_type
                _existing_wb.network_types = json.dumps(network_types) if network_types else None
                _existing_wb.status = "ready"
                _existing_wb.size = file_path.stat().st_size if file_path.exists() else None
                _existing_wb.original_path = original_path
                _existing_wb.metadata_json = json.dumps(metadata, ensure_ascii=False) if metadata else None
                _existing_wb.remark = remark
                _existing_wb.created_at = datetime.now().isoformat()
                safe_print(f"[DataService] 已更新 Workbook 记录: {data_id}")
            else:
                wb = Workbook(
                    id=data_id,
                    user_id=user_id,
                    name=filename,
                    file_type=file_type,
                    network_types=json.dumps(network_types) if network_types else None,
                    status="ready",
                    size=file_path.stat().st_size if file_path.exists() else None,
                    original_path=original_path,
                    metadata_json=json.dumps(metadata, ensure_ascii=False) if metadata else None,
                    remark=remark,
                    created_at=datetime.now().isoformat(),
                )
                db.add(wb)
            db.flush()  # 确保障 Workbook 行已写入，满足 Sites 外键约束

            # 2) 写入 Sites + Sectors
            for network_type, sites in parsed_data.items():
                for site_data in sites:
                    site = Site(
                        workbook_id=data_id,
                        user_id=user_id,
                        site_id=str(site_data.get("id", "")),
                        name=site_data.get("name", "Unknown"),
                        longitude=site_data.get("longitude", 0.0),
                        latitude=site_data.get("latitude", 0.0),
                        network_type=network_type,
                        managed_element_id=site_data.get("managedElementId"),
                        mcc=site_data.get("mcc"),
                        mnc=site_data.get("mnc"),
                    )
                    db.add(site)
                    db.flush()  # 获取 site.id

                    # 批量构建扇区 dict
                    sector_dicts = []
                    for sec in site_data.get("sectors", []):
                        sector_dicts.append({
                            "site_id_fk": site.id,
                            "workbook_id": data_id,
                            "user_id": user_id,
                            "sector_id": str(sec.get("id", "")),
                            "name": sec.get("name", ""),
                            "longitude": sec.get("longitude", 0.0),
                            "latitude": sec.get("latitude", 0.0),
                            "azimuth": sec.get("azimuth", 0.0),
                            "beamwidth": sec.get("beamwidth", 65.0),
                            "height": sec.get("height", 30.0),
                            "pci": sec.get("pci"),
                            "tac": sec.get("tac"),
                            "frequency": sec.get("frequency") or sec.get("earfcn") or sec.get("ssb_frequency"),
                            "cell_cover_type": sec.get("cell_cover_type", 1),
                            "is_shared": sec.get("is_shared"),
                            "first_group": sec.get("first_group"),
                            "mcc": sec.get("mcc"),
                            "mnc": sec.get("mnc"),
                        })
                    if sector_dicts:
                        db.bulk_insert_mappings(Sector, sector_dicts)

            db.commit()
        except Exception as e:
            db.rollback()
            safe_print(f"[DataService] SQLite 写入失败 (非致命): {e}")
        finally:
            db.close()

    def _classify_file(self, filename: str, sheet_names: list) -> str:
        """根据文件名和sheet名称分类文件类型"""
        filename_lower = filename.lower()

        # 待规划小区文件特征 - 以"cell-tree-export"或"cell-tree"开头
        if filename_lower.startswith("cell-tree-export") or filename_lower.startswith("cell-tree"):
            return "target_cells"

        # 全量工参特征检测（提前定义，供后续逻辑使用）
        has_lte_params = any("lte project parameters" in s.lower() for s in sheet_names)
        has_nr_params = any("nr project parameters" in s.lower() for s in sheet_names)

        # 待规划小区文件特征 - 检查sheet名称（支持单网络类型）
        has_lte_sheet = any(s.strip().lower() == "lte" for s in sheet_names)
        has_nr_sheet = any(s.strip().lower() == "nr" for s in sheet_names)
        if has_lte_sheet or has_nr_sheet:
            # 排除全量工参（有Project Parameters后缀的）
            if not (has_lte_params or has_nr_params):
                return "target_cells"

        # 全量工参文件特征 - 多种识别方式
        # 方式1: 检查sheet名称（上面已检测 has_lte_params / has_nr_params）

        # 方式2: 检查文件名特征
        has_projectparam = "projectparameter" in filename_lower or "mongoose" in filename_lower
        has_timestamp = bool(re.search(r'\d{10,}', filename_lower))  # 包含10位以上数字（时间戳）

        # 判断逻辑：如果有 Project Parameters sheet，或者文件名包含相关关键词
        if (has_lte_params or has_nr_params) and (has_projectparam or has_timestamp):
            return "full_params"

        # 兼容：如果有 Project Parameters sheet，就认为是 full_params
        if has_lte_params or has_nr_params:
            return "full_params"

        # 默认类型
        return "default"

    def _parse_sheet_data(
        self, excel_file, sheet_name: str, network_type: str
    ) -> List[Dict]:
        """解析指定sheet的数据"""
        import pandas as pd

        safe_print(f"[DataService] 正在解析sheet: {sheet_name} ({network_type})")

        # 检测是否是全量工参文件（LTE/NR Project Parameters）
        is_full_params = "Project Parameters" in sheet_name
        # 检测是否是待规划小区文件
        # 注意：这里简单判断sheet名是否为LTE/NR且似乎在待规划文件上下文中
        # 更好的方式是传递file_type，但为了保持签名兼容，我们可以通过sheet内容或上下文判断
        # 这里我们假设如果是 'LTE' 或 'NR' 这种简短名字，且解析失败时尝试target_cells逻辑
        # 但既然我们现在在这个方法里，我们不妨先尝试特定的解析逻辑

        # 实际上，调用者知道file_type。但在目前的架构中，_parse_sheet_data是通用的。
        # 我们可以检查列名来决定。

        if is_full_params:
            # 全量工参文件：第一行列名包含\n分隔的多行信息，从第4行开始是数据
            safe_print(f"[DataService] 检测到全量工参文件，使用专用解析逻辑")
            return self._parse_full_params_sheet(excel_file, sheet_name, network_type)

        # 尝试读取前几行来判断是否是target_cells（没有基站经纬度，只有ID）
        try:
            # 简单读取
            df_preview = pd.read_excel(excel_file, sheet_name=sheet_name, nrows=1)
            columns = list(df_preview.columns)

            # 待规划小区特征：包含 eNodeBID/gNodeBID 和 CellID，但不包含 Longitude/Latitude
            has_id = "eNodeBID" in columns or "gNodeBID" in columns
            has_cell = "CellID" in columns
            has_coords = (
                "Longitude" in columns or "Latitude" in columns or "基站经度" in columns
            )

            if has_id and has_cell and not has_coords:
                safe_print(f"[DataService] 检测到待规划小区文件格式，使用专用解析逻辑")
                return self._parse_target_cells_sheet(
                    excel_file, sheet_name, network_type
                )

        except Exception as e:
            safe_print(f"[DataService] 预检查失败: {e}")

        # 尝试不同的解析方式
        df = None

        # 方式1: 跳过前3行
        try:
            df = pd.read_excel(excel_file, sheet_name=sheet_name, header=3)
            # 简单验证一下是否有效
            if len(df.columns) > 1:
                safe_print(f"[DataService] 使用header=3解析成功，共 {len(df)} 行")
            else:
                df = None
        except Exception as e:
            safe_print(f"[DataService] header=3解析失败: {e}")

        # 方式2: 多级列名
        if df is None:
            try:
                df = pd.read_excel(excel_file, sheet_name=sheet_name, header=[0, 1, 2])
                df.columns = [
                    "_".join(str(c).strip() for c in col).strip()
                    for col in df.columns.values
                ]
                print(f"[DataService] 使用多级列名解析成功，共 {len(df)} 行")
            except Exception as e:
                print(f"[DataService] 多级列名解析失败: {e}")

        # 方式3: 默认
        if df is None:
            try:
                df = pd.read_excel(excel_file, sheet_name=sheet_name)
                print(f"[DataService] 使用默认解析成功，共 {len(df)} 行")
            except Exception as e:
                print(f"[DataService] 默认解析失败: {e}")

        if df is None:
            raise ValueError(f"无法解析sheet: {sheet_name}")

        return self._parse_dataframe(df, sheet_name, network_type)

    def _parse_target_cells_sheet(
        self, excel_file, sheet_name: str, network_type: str
    ) -> List[Dict]:
        """解析待规划小区Sheet (只有ID信息) - 向量化优化版本"""
        import pandas as pd

        print(f"[DataService] 解析待规划小区Sheet: {sheet_name}")

        df = pd.read_excel(excel_file, sheet_name=sheet_name)

        # 确定ID列
        site_id_col = "eNodeBID" if network_type == "LTE" else "gNodeBID"

        if site_id_col not in df.columns:
            for col in df.columns:
                if site_id_col.lower() in col.lower():
                    site_id_col = col
                    break

        if site_id_col not in df.columns:
            raise ValueError(f"在Sheet {sheet_name} 中找不到 {site_id_col} 列")

        print(f"[DataService] 使用 {site_id_col} 作为站点ID列")

        # === 向量化处理 ===
        df = df.copy()

        # 站点ID：数值化 → int → str（去除小数点）
        df['_site_id_num'] = pd.to_numeric(df[site_id_col], errors='coerce')
        df = df.dropna(subset=['_site_id_num'])
        if len(df) == 0:
            return []
        df['_site_id'] = df['_site_id_num'].astype(int).astype(str)

        # 小区ID：数值化 → int → str，失败则默认"0"
        if "CellID" in df.columns:
            df['_cell_num'] = pd.to_numeric(df["CellID"], errors='coerce').fillna(0).astype(int)
        else:
            df['_cell_num'] = 0
        df['_cell_id'] = df['_cell_num'].astype(str)

        # 唯一扇区ID
        df['_sector_id'] = df['_site_id'] + '_' + df['_cell_id']

        # 单次to_dict + dict分组
        flat = df[['_site_id', '_sector_id', '_cell_id']].to_dict('records')

        from collections import defaultdict
        site_groups = defaultdict(list)
        for rec in flat:
            site_groups[rec['_site_id']].append(rec)

        # 构建结果
        result = []
        for site_id, recs in site_groups.items():
            sectors = [{
                "id": rec['_sector_id'],
                "siteId": site_id,
                "name": f"Cell_{site_id}_{rec['_cell_id']}",
                "longitude": 0.0,
                "latitude": 0.0,
                "azimuth": 0,
                "beamwidth": 65,
                "height": 30,
                "pci": 0,
                "earfcn": 0,
            } for rec in recs]

            result.append({
                "id": site_id,
                "name": f"Site_{site_id}",
                "longitude": 0.0,
                "latitude": 0.0,
                "networkType": network_type,
                "sectors": sectors,
            })

        return result

    def _parse_full_params_sheet(
        self, excel_file, sheet_name: str, network_type: str
    ) -> List[Dict]:
        """解析全量工参文件（LTE/NR Project Parameters）"""
        import pandas as pd

        print(f"[DataService] 解析全量工参sheet: {sheet_name}")

        try:
            # 直接使用传入的ExcelFile对象
            xls = excel_file

            # 读取第一行获取列名（包含\n分隔的多行信息）
            header_row = pd.read_excel(
                xls, sheet_name=sheet_name, header=None, nrows=1
            ).iloc[0]

            # 提取中文名称（第一行中\n之前的部分）
            clean_columns = []
            # 提取中文名称（第一行中\n之前的部分）并检测是否为复杂表头
            clean_columns = []
            is_complex_header = False
            for col in header_row:
                col_str = str(col).strip() if pd.notna(col) else ""
                if "\n" in col_str:
                    is_complex_header = True
                    # 提取第一个\n之前的中文名称
                    chinese_name = col_str.split("\n")[0].strip()
                    clean_columns.append(chinese_name)
                else:
                    clean_columns.append(col_str)

            print(f"[DataService] 提取到 {len(clean_columns)} 个列名 (复杂表头: {is_complex_header})")

            # 确定跳过的行数
            # 复杂表头通常占3行（第4行开始是数据）
            # 简单表头通常占1行（第2行开始是数据）
            skip_rows = 3 if is_complex_header else 1
            print(f"[DataService] 将跳过 {skip_rows} 行读取数据")

            # 读取数据
            df = pd.read_excel(xls, sheet_name=sheet_name, header=None, skiprows=skip_rows)
            
            # 检查列数是否匹配
            if len(df.columns) == len(clean_columns):
                # 设置清理后的列名
                df.columns = clean_columns
            else:
                print(f"[DataService] 警告: 数据列数({len(df.columns)})与表头列数({len(clean_columns)})不匹配")
                # 尝试重新读取，假设只有1行表头 (如果之前尝试了3行)
                if skip_rows == 3:
                     print(f"[DataService] 尝试使用 skip_rows=1 重新读取...")
                     df = pd.read_excel(xls, sheet_name=sheet_name, header=None, skiprows=1)
                     if len(df.columns) == len(clean_columns):
                         df.columns = clean_columns
                         print(f"[DataService] 重新读取成功")
                     else:
                         # 如果还是不匹配，可能是空数据或者结构严重不符
                         if len(df) == 0:
                             # 空数据，强行赋值columns可能会失败 if len(df.columns)==0
                             # 创建一个空的DataFrame with correct columns
                             df = pd.DataFrame(columns=clean_columns)
                             print(f"[DataService] 数据为空，创建空DataFrame")
                         else:
                             raise ValueError(f"列数不匹配: 期望 {len(clean_columns)}, 实际 {len(df.columns)}")
                else:
                     if len(df) == 0:
                         df = pd.DataFrame(columns=clean_columns)
                         print(f"[DataService] 数据为空，创建空DataFrame")
                     else:
                         raise ValueError(f"列数不匹配: 期望 {len(clean_columns)}, 实际 {len(df.columns)}")

            print(f"[DataService] 全量工参数据加载完成，共 {len(df)} 行")
            column_preview = list(df.columns)[:10]
            try:
                print(f"[DataService] 列名: {column_preview}...")
            except:
                pass

            # 使用专门的解析方法处理全量工参数据
            return self._parse_full_params_dataframe(df, network_type)

        except Exception as e:
            print(f"[DataService] 解析全量工参sheet失败: {sheet_name}, 错误: {e}")
            raise ValueError(f"解析工参表 {sheet_name} 失败: {str(e)}")

    def _parse_full_params_dataframe(
        self, df: pd.DataFrame, network_type: str
    ) -> List[Dict]:
        """解析全量工参DataFrame为站点数据 - 向量化版本

        使用唯一键进行小区去重:
        - LTE: eNodeB标识 + 小区标识
        - NR: 移动国家码 + 移动网络码 + gNodeB标识 + 小区标识
        """
        import time as _time
        _t0 = _time.perf_counter()

        print(f"[DataService] 解析全量工参DataFrame，网络类型: {network_type}")

        # 定义全量工参的列名映射（智能匹配）
        if network_type == "LTE":
            required_columns = {
                "site_id": [
                    "eNodeB标识", "eNodeBID", "eNodeB ID", "基站ID",
                ],
                "site_name": ["基站名称"],
                "longitude": ["基站经度", "经度", "小区经度"],
                "latitude": ["基站纬度", "纬度", "小区纬度"],
                "sector_id": ["小区标识", "小区ID"],
                "sector_name": ["小区名称"],
                "azimuth": ["天线方向角", "方位角"],
                "height": ["天线挂高", "挂高"],
                "pci": ["物理小区识别码", "PCI"],
                "earfcn": ["下行链路的中心载频", "EARFCN"],
                "tac": ["跟踪区码", "TAC"],
                "cell_cover_type": ["小区覆盖类型"],
                "is_shared": ["是否共享"],
                "first_group": ["第一分组"],
            }
        else:  # NR
            required_columns = {
                "site_id": [
                    "gNodeB标识", "gNodeBID", "gNodeB ID", "基站ID", "管理网元ID",
                ],
                "site_name": ["基站名称"],
                "longitude": ["基站经度", "经度", "小区经度"],
                "latitude": ["基站纬度", "纬度", "小区纬度"],
                "sector_id": ["小区标识", "小区ID"],
                "sector_name": ["小区名称"],
                "azimuth": ["天线方向角", "方位角"],
                "height": ["天线挂高", "挂高"],
                "pci": ["物理小区识别码", "PCI"],
                "ssb_frequency": ["填写SSB频点", "SSB频点", "SSB Frequency"],
                "tac": ["跟踪区码", "TAC"],
                "cell_cover_type": ["小区覆盖类型"],
                "is_shared": ["是否共享"],
                "mcc": ["移动国家码", "MCC"],
                "mnc": ["移动网络码", "MNC"],
                "first_group": ["第一分组"],
            }

        # 智能列名匹配函数（精简打印）
        def find_column(col_names, possible_names, column_type=""):
            """在清理后的列名列表中查找匹配的列，返回列名"""
            col_lower = [str(c).strip().lower() for c in col_names]
            col_clean = [str(c).strip() for c in col_names]

            for possible in possible_names:
                pl = possible.lower()

                # 精确匹配
                if pl in col_lower:
                    return col_clean[col_lower.index(pl)]

                # 包含匹配
                for i, cc in enumerate(col_clean):
                    if pl in col_lower[i] or col_lower[i] in pl:
                        return cc

                # 管理网元ID宽松匹配
                if column_type == "managed_element":
                    for cc in col_clean:
                        ccl = cc.lower()
                        if "网元" in cc or "element" in ccl or "managed" in ccl or "管理" in cc:
                            return cc

            return None

        current_columns = list(df.columns)

        # 执行列名匹配
        mapped_columns = {}
        print(f"[DataService] {network_type}] 开始列名匹配...")
        for key, possible_names in required_columns.items():
            found_col = find_column(current_columns, possible_names)
            if found_col is not None:
                mapped_columns[key] = found_col
            else:
                if key in ["site_id", "longitude", "latitude", "sector_id"]:
                    print(f"[DataService] 警告: 未找到列 {key}，可选匹配: {possible_names}")

        # 额外匹配管理网元ID
        managed_element_columns = [
            "管理网元ID", "ManagedElement ID", "ManagedElementId",
            "ManagedElement", "Managed Element", "MEID", "网元ID",
        ]
        managed_element_col = find_column(
            current_columns, managed_element_columns, column_type="managed_element"
        )
        if managed_element_col is not None:
            mapped_columns["managed_element_id"] = managed_element_col
            print(f"[DataService] {network_type}] 找到管理网元ID列: {managed_element_col}")
        else:
            for col in current_columns:
                cl = col.lower()
                if "网元" in col or "element" in cl or "managed" in cl or "管理" in col:
                    mapped_columns["managed_element_id"] = col
                    print(f"[DataService] {network_type}] 手动匹配管理网元ID列: {col}")
                    break

        print(f"[DataService] {network_type}] 最终映射结果: {mapped_columns}")

        # 检查必需列
        required_keys = ["site_id", "longitude", "latitude", "sector_id"]
        missing_keys = [k for k in required_keys if k not in mapped_columns]
        if missing_keys:
            raise ValueError(
                f"全量工参文件缺少必需的列: {missing_keys}。已找到的列: {list(df.columns)}"
            )

        # ========== 向量化处理 ==========

        df = df.copy()

        # 数值字段预清洗函数：去除不可见字符
        # 涵盖：普通空格、\xa0、全角空格、零宽空格/连接符、LRM/RLM、BOM 等
        def _clean_num_str(col_series):
            """将列转为字符串并清理所有不可见空白/零宽字符"""
            return col_series.astype(str).str.replace(
                r'[\s\xa0　​-‏﻿]', '', regex=True
            ).str.strip()

        # 1) 数值字段向量化转换
        df['_lon'] = pd.to_numeric(
            _clean_num_str(df[mapped_columns["longitude"]]), errors='coerce'
        ).fillna(0.0)
        df['_lat'] = pd.to_numeric(
            _clean_num_str(df[mapped_columns["latitude"]]), errors='coerce'
        ).fillna(0.0)

        if "azimuth" in mapped_columns:
            df['_azimuth'] = pd.to_numeric(
                _clean_num_str(df[mapped_columns["azimuth"]]), errors='coerce'
            ).fillna(0.0)
        else:
            df['_azimuth'] = 0.0

        if "height" in mapped_columns:
            df['_height'] = pd.to_numeric(
                _clean_num_str(df[mapped_columns["height"]]), errors='coerce'
            ).fillna(30.0)
        else:
            df['_height'] = 30.0

        if "pci" in mapped_columns:
            df['_pci'] = pd.to_numeric(
                _clean_num_str(df[mapped_columns["pci"]]), errors='coerce'
            )

        if network_type == "LTE" and "earfcn" in mapped_columns:
            df['_earfcn'] = pd.to_numeric(
                _clean_num_str(df[mapped_columns["earfcn"]]), errors='coerce'
            )
        elif network_type == "NR" and "ssb_frequency" in mapped_columns:
            df['_ssb_frequency'] = pd.to_numeric(
                _clean_num_str(df[mapped_columns["ssb_frequency"]]), errors='coerce'
            )

        _t_vecconv = _time.perf_counter()

        # 零宽/不可见字符正则（.strip() 无法处理的）
        _ZW = r'[​‌‍‎‏﻿]'

        # 2) 字符串字段清理
        site_id_col = mapped_columns["site_id"]
        df['_site_id_raw'] = df[site_id_col]

        # 规范化 site_id：处理 Excel 中文本格式数字引起的混合类型问题
        _site_raw = df[site_id_col]
        df['_site_id'] = _site_raw.astype(str).str.strip().str.replace(_ZW, '', regex=True)
        _site_num = pd.to_numeric(_site_raw, errors='coerce')
        _num_valid = _site_num.notna()
        _int_valued = pd.Series(False, index=_site_num.index)
        if _num_valid.any():
            _valid_series = _site_num[_num_valid]
            _is_int_val = (_valid_series == _valid_series.astype(int))
            _in_series = _site_raw[_num_valid]
            _is_float_orig = _in_series.apply(lambda x: isinstance(x, float))
            _int_valued[_num_valid] = _is_int_val.values & _is_float_orig.values
        if _int_valued.any():
            df.loc[_int_valued, '_site_id'] = _site_num[_int_valued].astype(int).astype(str)

        if "site_name" in mapped_columns:
            df['_site_name'] = df[mapped_columns["site_name"]].astype(str).str.strip().str.replace(_ZW, '', regex=True)
        else:
            df['_site_name'] = "Unknown"

        # 3) 过滤无效行
        invalid_mask = (
            df['_site_id'].isin(['', 'nan', 'none', 'NaN', 'None'])
            | df[site_id_col].isna()
        )
        invalid_count = int(invalid_mask.sum())
        df = df[~invalid_mask].copy()
        parsed_count = 0

        if len(df) == 0:
            print(f"[DataService] {network_type}] 过滤后无有效数据")
            print(f"=====================================\n")
            return []

        # 4) 扇区ID转换（str(int(float(val))) 或 str(val).strip()）
        def _convert_sector_id(val):
            if pd.isna(val):
                return None
            try:
                return str(int(float(val)))
            except (ValueError, TypeError):
                return re.sub(_ZW, '', str(val).strip())

        df['_sector_id'] = df[mapped_columns["sector_id"]].apply(_convert_sector_id)
        _t_sectorid = _time.perf_counter()

        # 标记缺失扇区ID的行（后续分配临时唯一ID，避免去重时被误删）
        df['_sector_id_missing'] = df['_sector_id'].isna()
        missing_mask = df['_sector_id_missing']
        if missing_mask.any():
            df.loc[missing_mask, '_sector_id'] = df[missing_mask].index.astype(str).map(lambda x: f'__MISSING_{x}__')

        # 5) 从列中提取有效的小区名称（仅当列存在且值有效时）
        if "sector_name" in mapped_columns:
            sname_col = mapped_columns["sector_name"]
            _sname_clean = df[sname_col].astype(str).str.strip().str.replace(_ZW, '', regex=True)
            valid_mask = (
                df[sname_col].notna()
                & ~_sname_clean.isin(['', '非必填', 'nan', 'None'])
            )
            df['_sector_name_col'] = _sname_clean.where(valid_mask)
        else:
            df['_sector_name_col'] = pd.NA

        # 6) 构建唯一键用于去重
        if network_type == "LTE":
            df['_unique_key'] = df['_site_id'] + '_' + df['_sector_id']
        else:
            if "mcc" in mapped_columns:
                _mcc_raw = df[mapped_columns["mcc"]]
                df['_mcc'] = _mcc_raw.astype(str).str.strip().str.replace(_ZW, '', regex=True)
                _mcc_num = pd.to_numeric(_mcc_raw, errors='coerce')
                _mcc_valid = _mcc_num.notna()
                _mcc_int = pd.Series(False, index=_mcc_num.index)
                if _mcc_valid.any():
                    _mcc_nums = _mcc_num[_mcc_valid]
                    _mcc_int_val = (_mcc_nums == _mcc_nums.astype(int))
                    _mcc_orig = _mcc_raw[_mcc_valid]
                    _mcc_is_float = _mcc_orig.apply(lambda x: isinstance(x, float))
                    _mcc_int[_mcc_valid] = _mcc_int_val.values & _mcc_is_float.values
                if _mcc_int.any():
                    df.loc[_mcc_int, '_mcc'] = _mcc_num[_mcc_int].astype(int).astype(str)
            else:
                df['_mcc'] = ''
            if "mnc" in mapped_columns:
                _mnc_raw = df[mapped_columns["mnc"]]
                df['_mnc'] = _mnc_raw.astype(str).str.strip().str.replace(_ZW, '', regex=True)
                _mnc_num = pd.to_numeric(_mnc_raw, errors='coerce')
                _mnc_valid = _mnc_num.notna()
                _mnc_int = pd.Series(False, index=_mnc_num.index)
                if _mnc_valid.any():
                    _mnc_nums = _mnc_num[_mnc_valid]
                    _mnc_int_val = (_mnc_nums == _mnc_nums.astype(int))
                    _mnc_orig = _mnc_raw[_mnc_valid]
                    _mnc_is_float = _mnc_orig.apply(lambda x: isinstance(x, float))
                    _mnc_int[_mnc_valid] = _mnc_int_val.values & _mnc_is_float.values
                if _mnc_int.any():
                    df.loc[_mnc_int, '_mnc'] = _mnc_num[_mnc_int].astype(int).astype(str)
            else:
                df['_mnc'] = ''
            df['_unique_key'] = df['_mcc'] + '_' + df['_mnc'] + '_' + df['_site_id'] + '_' + df['_sector_id']

        total_before_dedup = len(df)
        df = df.drop_duplicates(subset='_unique_key', keep='last')
        dup_count = total_before_dedup - len(df)
        _t_dedup = _time.perf_counter()

        # 7) 管理网元ID处理函数
        def _extract_me_id(val):
            """处理管理网元ID，将数值转换为整数"""
            if pd.isna(val):
                return None
            val_str = str(val).strip()
            if not val_str or val_str.lower() in ["nan", "none", ""]:
                return None
            try:
                me_id_float = float(val_str)
                if me_id_float.is_integer():
                    return str(int(me_id_float))
            except (ValueError, TypeError):
                pass
            return val_str

        # ========== 向量化计算所有剩余扇区字段 + 单次to_dict ==========

        # 8) 字符串类型字段向量化处理
        df['_is_shared'] = None
        if "is_shared" in mapped_columns:
            col = mapped_columns["is_shared"]
            _is_clean = df[col].astype(str).str.strip().str.replace(_ZW, '', regex=True)
            valid = df[col].notna() & ~_is_clean.isin(['', 'nan', 'None'])
            df.loc[valid, '_is_shared'] = _is_clean[valid]

        df['_first_group'] = None
        if "first_group" in mapped_columns:
            col = mapped_columns["first_group"]
            _fg_clean = df[col].astype(str).str.strip().str.replace(_ZW, '', regex=True)
            valid = df[col].notna() & ~_fg_clean.isin(['', 'nan', 'None'])
            df.loc[valid, '_first_group'] = _fg_clean[valid]

        # 9) TAC字段处理（数值转换）
        df['_tac'] = None
        if "tac" in mapped_columns:
            tac_col = mapped_columns["tac"]
            tac_num = pd.to_numeric(_clean_num_str(df[tac_col]), errors='coerce')
            numeric_mask = tac_num.notna()
            df.loc[numeric_mask, '_tac'] = tac_num.loc[numeric_mask].astype(int)
            non_num_non_null = df[tac_col].notna() & ~numeric_mask
            df.loc[non_num_non_null, '_tac'] = df.loc[non_num_non_null, tac_col].astype(str).str.strip().str.replace(_ZW, '', regex=True)

        # 10) 小区覆盖类型
        df['_cct'] = 1
        if "cell_cover_type" in mapped_columns:
            cct_col = mapped_columns["cell_cover_type"]
            cct_num = pd.to_numeric(df[cct_col], errors='coerce')
            cct_valid = cct_num.notna()
            df.loc[cct_valid, '_cct'] = cct_num.loc[cct_valid].astype(int)

        # 11) 管理网元ID原值
        if "managed_element_id" in mapped_columns:
            df['_me_id'] = df[mapped_columns["managed_element_id"]]

        _t_extra = _time.perf_counter()

        # 12) 单次to_dict + dict分组（完全消除iterrows的Series创建开销）
        from collections import defaultdict

        # 选取输出列
        record_cols = [
            '_site_id', '_site_name', '_sector_id', '_sector_id_missing',
            '_sector_name_col', '_lon', '_lat', '_azimuth', '_height',
            '_pci', '_is_shared', '_first_group', '_tac', '_cct',
        ]
        if network_type == "LTE":
            df['_frequency'] = df['_earfcn'] if '_earfcn' in df.columns else None
            record_cols.append('_frequency')
        else:  # NR
            df['_frequency'] = df['_ssb_frequency'] if '_ssb_frequency' in df.columns else None
            record_cols.extend(['_mcc', '_mnc', '_frequency'])
        if '_me_id' in df.columns:
            record_cols.append('_me_id')

        # 单次to_dict（完全消除iterrows)
        flat_records = df[record_cols].to_dict('records')
        _t_todict = _time.perf_counter()

        # 按site_id分组（O(n)一遍扫描）
        site_groups = defaultdict(list)
        for rec in flat_records:
            site_groups[rec['_site_id']].append(rec)

        # 构建结果
        result = []
        for site_id, records in site_groups.items():
            first = records[0]

            # 站点级数据
            site_data = {
                "id": site_id,
                "name": first['_site_name'] if first['_site_name'] not in ['', 'nan', 'none'] else "Unknown",
                "longitude": float(first['_lon']),
                "latitude": float(first['_lat']),
                "networkType": network_type,
                "sectors": [],
            }

            # 管理网元ID
            me_val = first.get('_me_id')
            if me_val is not None and pd.notna(me_val):
                me_id = _extract_me_id(me_val)
                if me_id is not None:
                    site_data["managedElementId"] = me_id

            # 扇区级数据
            sectors = []
            for n, rec in enumerate(records):
                sector_id = rec['_sector_id']
                if rec['_sector_id_missing']:
                    sector_id = f"{site_id}_{n}"

                # 小区名称
                col_name = rec.get('_sector_name_col')
                sector_name = str(col_name).strip() if pd.notna(col_name) else f"{first['_site_name']}_{sector_id}"

                sector = {
                    "id": sector_id,
                    "siteId": site_id,
                    "name": sector_name,
                    "longitude": float(rec['_lon']),
                    "latitude": float(rec['_lat']),
                    "azimuth": float(rec['_azimuth']),
                    "beamwidth": 65.0,
                    "height": float(rec['_height']),
                }

                # PCI
                pci_v = rec.get('_pci')
                if pd.notna(pci_v):
                    try:
                        sector["pci"] = int(float(pci_v))
                    except:
                        sector["pci"] = str(pci_v)
                else:
                    sector["pci"] = None

                # is_shared
                isv = rec.get('_is_shared')
                if isv is not None:
                    sector["is_shared"] = str(isv).strip()
                else:
                    sector["is_shared"] = None

                # first_group
                fgv = rec.get('_first_group')
                if fgv is not None:
                    sector["first_group"] = str(fgv).strip()
                else:
                    sector["first_group"] = None

                # TAC
                tac_v = rec.get('_tac')
                if tac_v is not None:
                    if isinstance(tac_v, (int, float)):
                        sector["tac"] = int(tac_v)
                    else:
                        sector["tac"] = str(tac_v).strip()
                else:
                    sector["tac"] = None

                # EARFCN / SSB频点
                freq = rec.get('_frequency')
                if pd.notna(freq):
                    try:
                        fv = float(freq)
                        if network_type == "LTE":
                            sector["earfcn"] = fv
                        else:
                            sector["ssb_frequency"] = fv
                        sector["frequency"] = fv
                    except:
                        sv = str(freq).strip()
                        if network_type == "LTE":
                            sector["earfcn"] = sv
                        else:
                            sector["ssb_frequency"] = sv
                        sector["frequency"] = sv
                else:
                    sector["frequency"] = None

                # 小区覆盖类型
                cct = rec.get('_cct', 1)
                sector["cell_cover_type"] = int(cct)
                if cct == 4 and network_type == "NR":
                    print(f"[DataService] NR室内小区: {sector.get('name')} cell_cover_type=4")
                if "cell_cover_type" not in mapped_columns and network_type == "NR":
                    print(f"[DataService] NR未找到小区覆盖类型列，使用默认值1: {sector.get('name')}")

                # NR MCC/MNC
                if network_type == "NR":
                    if pd.notna(rec.get('_mcc')) and str(rec.get('_mcc', '')).strip():
                        sector["mcc"] = str(rec['_mcc']).strip()
                    if pd.notna(rec.get('_mnc')) and str(rec.get('_mnc', '')).strip():
                        sector["mnc"] = str(rec['_mnc']).strip()

                sectors.append(sector)
                parsed_count += 1

            site_data["sectors"] = sectors
            result.append(site_data)

        _t_groupby = _time.perf_counter()

        print(f"\n[DataService] ===== 全量工参解析完成 =====")
        print(f"  共解析: {len(result)} 个基站")
        print(f"  唯一小区数: {parsed_count} 个")
        print(f"  处理总行数: {total_before_dedup} 行")
        print(f"  去重重叠: {dup_count} 行")
        if invalid_count > 0:
            print(f"  过滤无效行: {invalid_count} 行")
        for site in result[:5]:
            print(f"  站点 {site['id']}: {len(site['sectors'])} 个小区")
        if len(result) > 5:
            print(f"  ... (还有 {len(result) - 5} 个站点)")
        print(f"=====================================\n")

        # 打印DF解析各阶段耗时
        print(f"[DATA_TIMING] DataFrame解析阶段耗时 ({network_type}):")
        print(f"  向量化转换:    {_t_vecconv - _t0:.3f}s")
        print(f"  SectorID转换:  {_t_sectorid - _t_vecconv:.3f}s")
        print(f"  去重+构建:     {_t_dedup - _t_sectorid:.3f}s")
        print(f"  额外字段计算:  {_t_extra - _t_dedup:.3f}s")
        print(f"  to_dict+分组:  {_t_todict - _t_extra:.3f}s")
        print(f"  后处理+构建:   {_t_groupby - _t_todict:.3f}s")
        print(f"  合计:          {_time.perf_counter() - _t0:.3f}s")

        return result

    @staticmethod
    def _has_header_columns(df: pd.DataFrame) -> bool:
        """检测DataFrame的列名是否为表头（而非数据值）"""
        for col in df.columns[:5]:
            try:
                float(col)
            except (ValueError, TypeError):
                return True  # 非数值字符串 -> 很可能是表头
        return False  # 全部是数值 -> 很可能是数据行被当成了列名

    def _parse_default_excel(self, excel_file) -> List[Dict]:
        """解析默认格式的Excel文件"""
        import pandas as pd

        df = None
        # 先尝试无 header 模式（单行表头，最常见格式）
        try:
            df_try = pd.read_excel(excel_file)
            if df_try is not None and self._has_header_columns(df_try):
                df = df_try
            else:
                # 列名看起来像数据行，尝试 header=3（兼容多行表头文件）
                df = pd.read_excel(excel_file, header=3)
        except:
            try:
                df = pd.read_excel(excel_file, header=3)
            except:
                pass

        if df is None:
            raise ValueError("无法解析Excel文件")

        return self._parse_dataframe(df, "default", "LTE")

    def _parse_dataframe(
        self, df: pd.DataFrame, sheet_name: str, network_type: str
    ) -> List[Dict]:
        """解析DataFrame为站点数据"""
        print(
            f"[DataService] _parse_dataframe: sheet={sheet_name}, network={network_type}"
        )
        # 复用现有的_parse_excel_data方法，传入网络类型作为文件名标识
        return self._parse_excel_data(df, f"{sheet_name} ({network_type})")

    def _parse_excel_data(self, df: pd.DataFrame, filename: str = "") -> List[Dict]:
        """解析Excel数据 - 支持多种列名格式，包括多行列名"""
        sites = {}

        print(f"[DataService] 开始解析Excel文件: {filename}")
        print(f"[DataService] 数据形状: {df.shape}")
        try:
            print(f"[DataService] 所有列名: {list(df.columns)}")
        except UnicodeEncodeError:
            # 如果列名包含特殊字符，使用ASCII安全打印
            safe_columns = [
                str(c).encode("ascii", "replace").decode("ascii") for c in df.columns
            ]
            print(f"[DataService] 所有列名: {safe_columns}")

        # 改进的列名映射表 - 使用更灵活的模糊匹配
        column_mappings = {
            # 基站ID可能的列名（支持多级列名组合）
            "site_id": [
                "基站ID",
                "eNodeBID",
                "eNodeB ID",
                "gNodeBID",
                "gNodeB ID",
                "站点ID",
                "Site ID",
                "ENODEBID",
                "基站标识",
                "网元ID",
                "NE ID",
                # 多级列名可能的组合
                "基站_ID",
                "eNodeB_ID",
                "gNodeB_ID",
                "站点_ID",
                "Unnamed_0_基站ID",
                "Unnamed_1_基站ID",
            ],
            # 基站名称可能的列名
            "site_name": [
                "基站名称",
                "站点名称",
                "Site Name",
                "eNodeB Name",
                "gNodeB Name",
                "网元名称",
                "NE Name",
                "基站_Name",
                "站点_Name",
            ],
            # 经纬度可能的列名
            "longitude": [
                "经度",
                " Longitude",
                "小区经度",
                "Cell Longitude",
                "eNodeB Longitude",
                "基站经度",
                "经度_经度",
                "Longitude_经度",
            ],
            "latitude": [
                "纬度",
                " Latitude",
                "小区纬度",
                "Cell Latitude",
                "eNodeB Latitude",
                "基站纬度",
                "纬度_纬度",
                "Latitude_纬度",
            ],
            # 网络类型可能的列名
            "network_type": [
                "网络类型",
                "Network Type",
                "RAT",
                "RAT Type",
                "RAT_Type",
                "网络类型_网络类型",
            ],
            # 小区ID可能的列名
            "sector_id": [
                "小区ID",
                "CellID",
                "Cell ID",
                "小区标识",
                "cellLocalId",
                "Cell LocalId",
                "扇区ID",
                "Sector ID",
                "小区_ID",
                "Cell_ID",
            ],
            # 小区名称可能的列名
            "sector_name": [
                "小区名称",
                "Cell Name",
                "CELL NAME",
                "userLabel",
                "UserLabel",
                "扇区名称",
                "Sector Name",
                "小区_小区名称",
                "Cell_Name",
            ],
            # 方位角可能的列名
            "azimuth": [
                "方位角",
                "Azimuth",
                "方位角\nAzimuth",
                "机械下倾角",
                "Azimuth_Azimuth",
                "方位角_方位角",
            ],
            # 波束宽度可能的列名
            "beamwidth": [
                "波束宽度",
                "Beamwidth",
                "水平波束宽度",
                "水平半功率角",
                "波束宽度_波束宽度",
            ],
            # 天线高度可能的列名
            "height": [
                "天线高度",
                "Antenna Height",
                "Height",
                "天线挂高",
                "总高度",
                "天线高度_天线高度",
            ],
            # PCI可能的列名
            "pci": [
                "PCI",
                "物理小区识别码",
                "Physical Cell ID",
                "PCI_PCI",
                "PCI_物理小区识别码",
            ],
            # EARFCN可能的列名
            "earfcn": [
                "EARFCN",
                "earfcnDl",
                "下行链路的中心载频",
                "ARFCN",
                "SSB Frequency",
                "EARFCN_EARFCN",
                "DL EARFCN",
            ],
        }

        # 改进的模糊匹配函数
        def find_column(target_name: str) -> Optional[str]:
            """查找目标列对应的实际列名 - 使用模糊匹配"""
            possible_names = column_mappings.get(target_name, [])

            for col in df.columns:
                col_str = str(col).strip().lower()
                col_str_clean = (
                    col_str.replace(" ", "").replace("_", "").replace("\n", "")
                )

                for possible in possible_names:
                    possible_clean = (
                        possible.lower()
                        .replace(" ", "")
                        .replace("_", "")
                        .replace("\n", "")
                    )

                    # 精确匹配
                    if col_str == possible.lower():
                        return col
                    # 去除特殊字符后匹配
                    if col_str_clean == possible_clean:
                        return col
                    # 包含匹配（列名包含目标词或目标词包含列名）
                    if (
                        possible_clean in col_str_clean
                        or col_str_clean in possible_clean
                    ):
                        if len(possible_clean) > 3:  # 避免过短词误匹配
                            return col

            return None

        # 映射列名
        site_id_col = find_column("site_id")
        site_name_col = find_column("site_name")
        longitude_col = find_column("longitude")
        latitude_col = find_column("latitude")
        network_type_col = find_column("network_type")
        sector_id_col = find_column("sector_id")
        sector_name_col = find_column("sector_name")
        azimuth_col = find_column("azimuth")
        beamwidth_col = find_column("beamwidth")
        height_col = find_column("height")
        pci_col = find_column("pci")
        earfcn_col = find_column("earfcn")

        print(f"\n[DataService] ===== 列名映射结果 =====")
        print(f"  基站ID: {site_id_col}")
        print(f"  基站名称: {site_name_col}")
        print(f"  经度: {longitude_col}")
        print(f"  纬度: {latitude_col}")
        print(f"  网络类型: {network_type_col}")
        print(f"  小区ID: {sector_id_col}")
        print(f"  小区名称: {sector_name_col}")
        print(f"  方位角: {azimuth_col}")
        print(f"  波束宽度: {beamwidth_col}")
        print(f"  天线高度: {height_col}")
        print(f"  PCI: {pci_col}")
        print(f"  EARFCN: {earfcn_col}")
        print(f"==============================\n")

        # 撒点文件模式：只要有经纬度即可，不需要基站ID
        is_point_file = longitude_col is not None and latitude_col is not None

        if not is_point_file:
            raise ValueError(
                "无法找到经度/纬度列，请检查Excel文件格式。撒点文件必须包含经度和纬度列。"
            )

        print(f"[DataService] 开始解析 {len(df)} 行数据...")
        print(
            f"[DataService] 解析模式: {'撒点文件模式（只需经纬度）' if is_point_file else '工参文件模式（需基站ID）'}"
        )

        parsed_count = 0
        skipped_count = 0

        for idx, row in df.iterrows():
            try:
                # 提取经纬度（撒点文件必须有经纬度）
                longitude = 0.0
                latitude = 0.0

                if longitude_col:
                    lon_raw = row.get(longitude_col)
                    if pd.notna(lon_raw):
                        try:
                            lon_str = str(lon_raw).strip()
                            longitude = float(lon_str)
                        except:
                            try:
                                longitude = float(lon_raw)
                            except:
                                pass

                if latitude_col:
                    lat_raw = row.get(latitude_col)
                    if pd.notna(lat_raw):
                        try:
                            lat_str = str(lat_raw).strip()
                            latitude = float(lat_str)
                        except:
                            try:
                                latitude = float(lat_raw)
                            except:
                                pass

                # 跳过无效的经纬度
                if longitude == 0 and latitude == 0:
                    skipped_count += 1
                    continue

                # 撒点文件模式：没有基站ID时使用行号
                if site_id_col:
                    site_id_raw = row.get(site_id_col)
                    if pd.isna(site_id_raw):
                        site_id = f"point_{idx}"
                    else:
                        site_id = str(site_id_raw).strip()
                        # 跳过空行或标题行
                        if (
                            not site_id
                            or site_id.lower() in ["nan", "none", ""]
                            or site_id.startswith("Un")
                        ):
                            site_id = f"point_{idx}"
                else:
                    site_id = f"point_{idx}"

                # 提取基站名称（撒点文件可能有名称列）
                site_name = site_id
                if site_name_col:
                    name_raw = row.get(site_name_col)
                    if pd.notna(name_raw):
                        name_str = str(name_raw).strip()
                        if name_str and name_str.lower() not in ["nan", "none", ""]:
                            site_name = name_str

                # 提取网络类型
                network_type = "LTE"
                if network_type_col:
                    nt_raw = row.get(network_type_col)
                    if pd.notna(nt_raw):
                        nt_str = str(nt_raw).strip().upper()
                        if "NR" in nt_str or "5G" in nt_str or "5GC" in nt_str:
                            network_type = "NR"
                        else:
                            network_type = "LTE"

                # 创建或获取站点
                if site_id not in sites:
                    sites[site_id] = {
                        "id": site_id,
                        "name": site_name,
                        "longitude": longitude,
                        "latitude": latitude,
                        "networkType": network_type,
                        "sectors": [],
                    }

                # 提取小区信息
                sector_id = f"{site_id}_0"  # 默认
                if sector_id_col:
                    sid_raw = row.get(sector_id_col)
                    if pd.notna(sid_raw):
                        try:
                            # 处理科学计数法等格式
                            sector_id = str(int(float(sid_raw)))
                        except:
                            sector_id = str(sid_raw).strip()

                sector_name = f"{site_name}_{sector_id}"
                if sector_name_col:
                    sname_raw = row.get(sector_name_col)
                    if pd.notna(sname_raw):
                        sname_str = str(sname_raw).strip()
                        if sname_str and sname_str not in [
                            "非必填",
                            "UserLabel",
                            "必填",
                            "nan",
                            "None",
                        ]:
                            sector_name = sname_str

                # 收集所有其他列作为属性（用于撒点文件的标签显示）
                point_attributes = {}
                for col in df.columns:
                    if col not in [
                        site_id_col,
                        site_name_col,
                        longitude_col,
                        latitude_col,
                        network_type_col,
                        sector_id_col,
                        sector_name_col,
                        azimuth_col,
                        beamwidth_col,
                        height_col,
                        pci_col,
                        earfcn_col,
                    ]:
                        val = row.get(col)
                        if pd.notna(val):
                            val_str = str(val).strip()
                            if val_str and val_str.lower() not in ["nan", "none", ""]:
                                # 使用列名作为属性名
                                attr_name = str(col).strip()
                                point_attributes[attr_name] = val_str

                # 方位角
                azimuth = 0.0
                if azimuth_col:
                    az_raw = row.get(azimuth_col)
                    if pd.notna(az_raw):
                        try:
                            azimuth = float(az_raw)
                        except:
                            azimuth = 0.0

                # 波束宽度
                beamwidth = 65.0
                if beamwidth_col:
                    bw_raw = row.get(beamwidth_col)
                    if pd.notna(bw_raw):
                        try:
                            beamwidth = float(bw_raw)
                        except:
                            beamwidth = 65.0

                # 天线高度
                height = 30.0
                if height_col:
                    h_raw = row.get(height_col)
                    if pd.notna(h_raw):
                        try:
                            height = float(h_raw)
                        except:
                            height = 30.0

                # 构建小区数据
                sector = {
                    "id": sector_id,
                    "siteId": site_id,
                    "name": sector_name,
                    "longitude": longitude,
                    "latitude": latitude,
                    "azimuth": azimuth,
                    "beamwidth": beamwidth,
                    "height": height,
                    "networkType": network_type,
                }

                # 可选字段：PCI
                if pci_col:
                    pci_raw = row.get(pci_col)
                    if pd.notna(pci_raw):
                        try:
                            pci_val = int(float(pci_raw))
                            if 0 <= pci_val <= 503:  # PCI有效范围检查
                                sector["pci"] = pci_val
                        except:
                            pass

                # 可选字段：EARFCN
                if earfcn_col:
                    earfcn_raw = row.get(earfcn_col)
                    if pd.notna(earfcn_raw):
                        try:
                            earfcn_val = float(earfcn_raw)
                            if earfcn_val > 0:
                                sector["earfcn"] = int(earfcn_val)
                        except:
                            pass

                # 添加撒点文件的额外属性（用于标签显示）
                if point_attributes:
                    sector["attributes"] = point_attributes

                sites[site_id]["sectors"].append(sector)
                parsed_count += 1

            except Exception as e:
                print(f"[DataService] 解析第{idx}行数据失败: {e}")
                skipped_count += 1
                continue

        result = list(sites.values())
        print(f"\n[DataService] ===== 解析完成 =====")
        print(f"  共解析: {len(result)} 个基站")
        print(f"  成功解析: {parsed_count} 个小区")
        print(f"  跳过无效行: {skipped_count} 行")
        for site in result[:5]:  # 只显示前5个站点
            print(f"  站点 {site['id']}: {len(site['sectors'])} 个小区")
        if len(result) > 5:
            print(f"  ... (还有 {len(result) - 5} 个站点)")
        print(f"=====================\n")

        return result

    async def upload_map(
        self, file: Optional[Any], original_path: Optional[str] = None,
        files: Optional[list] = None,
    ) -> Dict[str, str]:
        """上传地图文件（支持 MapInfo 图层文件 / KML / ZIP / 离线地图）
        files: 配套文件列表（与主文件同 stem 的 .dat/.mid/.map/.id 等，
        浏览器模式无真实路径时用于补齐关联文件）"""
        import asyncio
        data_id = str(uuid.uuid4())

        # 处理路径引号
        if original_path:
            original_path = original_path.strip("\"'")

        # 获取文件名和扩展名
        if file:
            filename = file.filename
            if not filename:
                raise ValueError("无法从上传的文件中获取文件名")
            ext = os.path.splitext(filename)[1]
        elif original_path:
            filename = os.path.basename(original_path)
            ext = os.path.splitext(filename)[1]
        else:
            raise ValueError("必须提供文件或文件路径")

        file_path = settings.UPLOAD_DIR / f"{data_id}{ext}"

        # 保存或复制文件
        if file:
            with open(file_path, "wb") as f:
                content = await file.read()
                f.write(content)
        elif original_path:
            if not os.path.exists(original_path):
                raise ValueError(f"文件不存在: {original_path}")
            shutil.copy2(original_path, file_path)

        # 创建数据目录
        data_dir = settings.DATA_DIR / data_id
        data_dir.mkdir(parents=True, exist_ok=True)

        # 检测文件类型（KML 为自包含矢量图层）
        is_mapinfo = filename.lower().endswith((".mif", ".tab", ".dat", ".kml"))
        is_zip = filename.lower().endswith(".zip")

        # 处理 ZIP 文件（离线地图或 MapInfo 包）
        if is_zip:
            import zipfile

            # 保留原始 ZIP 文件以便下载
            original_zip = data_dir / "original.zip"
            # 解压/复制为同步 IO，放线程池避免阻塞单 worker 事件循环
            await asyncio.to_thread(shutil.copy, file_path, original_zip)

            with zipfile.ZipFile(file_path, "r") as zip_ref:
                await asyncio.to_thread(zip_ref.extractall, data_dir)

            # 检查解压后的文件是否为 MapInfo/KML（递归搜索子目录）
            extracted_files = list(data_dir.rglob("*"))
            has_mapinfo = any(
                f.suffix.lower() in [".mif", ".tab", ".kml"]
                for f in extracted_files
                if f.is_file()
            )

            if has_mapinfo:
                # 解析 MapInfo 图层
                from app.services.mapinfo_service import parse_mapinfo_files, get_last_parse_errors
                import json

                try:
                    # 大 .dat 解析（gpd.read_file）可能耗时几十秒，放线程池避免阻塞事件循环
                    layers = await asyncio.to_thread(parse_mapinfo_files, data_dir, parent_id=data_id)
                    _mapinfo_errors = get_last_parse_errors()  # 每个失败文件的具体原因
                except ImportError as e:
                    # 缺少 geopandas 库
                    print(f"[DataService] ❌ 缺少必要的地理数据处理库")
                    print(f"[DataService] 错误详情: {e}")

                    # 保存空的 layers.json
                    with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
                        json.dump([], f)

                    # 标记为错误状态
                    self.index[data_id] = {
                        "id": data_id,
                        "name": filename,
                        "type": "map",
                        "subType": "mapinfo",
                        "size": file_path.stat().st_size,
                        "originalPath": original_path,
                        "uploadDate": datetime.now().isoformat(),
                        "status": "error",
                        "metadata": {
                            "fileCount": len(extracted_files),
                            "layerCount": 0,
                            "layers": [],
                            "error": "缺少必要的地理数据处理库 (geopandas)",
                            "errorDetail": str(e),
                        },
                    }
                    self._save_index()  # 持久化错误状态

                    raise ValueError(
                        f"MapInfo 文件解析失败：缺少必要的地理数据处理库。\n"
                        f"请运行以下命令安装依赖：\n"
                        f"  pip install geopandas shapely\n\n"
                        f"Windows 用户可能需要先安装 GDAL，推荐使用 conda：\n"
                        f"  conda install -c conda-forge geopandas"
                    )
                except Exception as e:
                    print(f"[DataService] 解析 MapInfo 文件失败: {e}")
                    import traceback
                    traceback.print_exc()

                    # 保存空的 layers.json
                    with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
                        json.dump([], f)

                    # 标记为错误状态
                    self.index[data_id] = {
                        "id": data_id,
                        "name": filename,
                        "type": "map",
                        "subType": "mapinfo",
                        "size": file_path.stat().st_size,
                        "originalPath": original_path,
                        "uploadDate": datetime.now().isoformat(),
                        "status": "error",
                        "metadata": {
                            "fileCount": len(extracted_files),
                            "layerCount": 0,
                            "layers": [],
                            "error": str(e),
                        },
                    }
                    self._save_index()  # 持久化错误状态

                    raise ValueError(f"MapInfo 文件解析失败: {e}")

                # 保存图层元数据
                with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
                    json.dump(layers, f, ensure_ascii=False, indent=2)
                # 后台预热 GeoJSON 磁盘缓存，避免首次勾选时等待 parse + 坐标转换
                self._prewarm_mapinfo_cache(data_id)

                print(f"[DataService] 解析到 {len(layers)} 个 MapInfo 图层")
                if len(layers) == 0:
                    print(f"[DataService] ⚠️ 警告: 检测到 MapInfo 文件但未能解析任何图层！")
                    print(f"[DataService] 请检查: 1) geopandas 是否已安装 2) .tab 文件配套的 .dat 文件是否存在")
                    print(f"[DataService] 目录中的文件: {[f.name for f in extracted_files if f.is_file()]}")
                for layer in layers:
                    print(
                        f"  - {layer['name']} ({layer['type']}): {layer['feature_count']} 个要素"
                    )

                # 更新索引
                self.index[data_id] = {
                    "id": data_id,
                    "name": filename,
                    "type": "map",
                    "subType": "mapinfo",  # 标记为 MapInfo 图层文件
                    "size": file_path.stat().st_size,
                    "originalPath": original_path,
                    "uploadDate": datetime.now().isoformat(),
                    "status": (
                        "ready" if layers
                        else "partial" if _mapinfo_errors
                        else "error"
                    ),
                    "metadata": {
                        "fileCount": len(extracted_files),
                        "layerCount": len(layers),
                        "layers": layers,
                        "errors": _mapinfo_errors,  # 每个失败文件的具体原因
                    },
                }
            else:
                # 普通离线地图文件
                self.index[data_id] = {
                    "id": data_id,
                    "name": filename,
                    "type": "map",
                    "subType": "offline",  # 标记为离线地图
                    "size": file_path.stat().st_size,
                    "originalPath": original_path,
                    "uploadDate": datetime.now().isoformat(),
                    "status": "ready",
                    "metadata": {"fileCount": len(extracted_files)},
                }

        # 处理单个 MapInfo 文件
        elif is_mapinfo:
            # 复制文件到数据目录
            target_file = data_dir / filename
            await asyncio.to_thread(shutil.copy, file_path, target_file)

            # 多文件上传的配套文件（浏览器模式无真实路径时，前端把同 stem 的
            # .dat/.mid/.map/.id 等一起上传，由这里写入同一 data_dir）
            if files:
                for _f in files:
                    if not _f or not _f.filename:
                        continue
                    _fname = os.path.basename(_f.filename)
                    if _fname.lower() == filename.lower():
                        continue  # 主文件已复制
                    try:
                        _tgt = data_dir / _fname
                        with open(_tgt, "wb") as _out:
                            _out.write(await _f.read())
                        safe_print(f"[DataService] ✅ 已写入上传的配套文件: {_fname}")
                    except Exception as _e:
                        safe_print(f"[DataService] ⚠️ 配套文件写入失败 {_fname}: {_e}")

            # 🔥 关键修复: MapInfo 文件需要配套文件才能正确解析
            # 获取文件基名（不含扩展名），支持大小写扩展名
            stem = os.path.splitext(filename)[0]

            # 辅助函数：查找文件（忽略大小写）
            def find_file_ignore_case(directory: Path, basename: str, extensions: list) -> Optional[Path]:
                """在目录中查找文件，忽略大小写"""
                for ext in extensions:
                    # 尝试小写
                    test_path = directory / f"{basename.lower()}{ext.lower()}"
                    if test_path.exists():
                        return test_path
                    # 尝试大写
                    test_path = directory / f"{basename.upper()}{ext.upper()}"
                    if test_path.exists():
                        return test_path
                    # 尝试原始大小写组合
                    test_path = directory / f"{basename}{ext}"
                    if test_path.exists():
                        return test_path
                return None

            # 配套文件按格式区分：MIF → .mid（几何在 .mif，属性在 .mid）；TAB → .dat（关键）+ .map/.id（可选）
            is_mif = filename.lower().endswith(".mif")
            is_kml = filename.lower().endswith(".kml")
            if is_kml:
                companion_required = []  # KML 自包含，无需配套
            else:
                companion_required = [".mid"] if is_mif else [".dat"]

            missing_exts = set()
            for ext in companion_required:
                if not find_file_ignore_case(data_dir, stem, [ext, ext.upper(), ext.title()]):
                    missing_exts.add(ext)

            # 🔧 自动复制关联文件（优先级：original_path > uploads/layers > uploads）
            # uploads/layers 是图层制作模块的产物目录，单文件 MIF/TAB 导入时配套文件可能在这里
            copy_sources = []
            if original_path:
                original_dir = os.path.dirname(original_path)
                if original_dir:
                    copy_sources.append(original_dir)
            copy_sources.append(str(settings.UPLOAD_DIR / "layers"))
            copy_sources.append(str(settings.UPLOAD_DIR))

            all_extensions = [".dat", ".map", ".id", ".ind", ".mid", ".mif", ".tab"]
            for src_dir in copy_sources:
                if not missing_exts:
                    break
                try:
                    print(f"[DataService] 🔍 检查关联文件: 目录={src_dir}, 基名={stem}")
                    for ext in all_extensions:
                        for ext_variant in [ext.lower(), ext.upper(), ext]:
                            sibling_path = os.path.join(src_dir, f"{stem}{ext_variant}")
                            if os.path.exists(sibling_path):
                                target_sibling = data_dir / os.path.basename(sibling_path)
                                if not target_sibling.exists():
                                    shutil.copy2(sibling_path, target_sibling)
                                    print(f"[DataService] ✅ 已复制关联文件: {os.path.basename(sibling_path)} (来源 {src_dir})")
                                if ext_variant.lower() in missing_exts:
                                    missing_exts.discard(ext_variant.lower())
                                break  # 找到一个就跳过其他大小写变体
                except Exception as e:
                    print(f"[DataService] ⚠️ 从 {src_dir} 复制关联文件失败: {e}")

            # 检查是否仍然缺少关键文件
            if missing_exts:
                missing_files = [f"{stem}{e}" + ("" if is_mif else " (关键文件)") for e in sorted(missing_exts)]
                print(f"[DataService] ❌ 缺少关键文件: {missing_files}")
                raise ValueError(
                    f"MapInfo 文件缺少配套文件，无法正确解析。\n"
                    f"缺少文件: {', '.join(missing_files)}\n\n"
                    + (
                        f"MapInfo MIF 格式需要以下配套文件：\n"
                        f"  • {stem}.mif - 几何数据\n"
                        f"  • {stem}.mid - 属性数据（必需！）\n\n"
                        if is_mif else
                        f"MapInfo TAB 格式需要以下配套文件：\n"
                        f"  • {stem}.tab - 表结构定义\n"
                        f"  • {stem}.dat - 实际数据（必需！）\n"
                        f"  • {stem}.map - 样式定义（可选）\n"
                        f"  • {stem}.id - 索引文件（可选）\n\n"
                    )
                    + f"解决方案：\n"
                    + f"  1. 上传所有配套文件（推荐）\n"
                    + f"  2. 或打包成 ZIP 文件上传（最佳）"
                )

            # 重新检查文件是否都已复制成功
            tab_file = find_file_ignore_case(data_dir, stem, [".tab", ".TAB"])
            dat_file = find_file_ignore_case(data_dir, stem, [".dat", ".DAT"])
            mid_file = find_file_ignore_case(data_dir, stem, [".mid", ".MID"])

            print(f"[DataService] 📁 文件检查结果:")
            if is_mif:
                print(f"  - MIF 文件: {'✅ ' + str(target_file) if target_file else '❌ 缺失'}")
                print(f"  - MID 文件: {'✅ ' + str(mid_file) if mid_file else '❌ 缺失'}")
            else:
                print(f"  - TAB 文件: {'✅ ' + str(tab_file) if tab_file else '❌ 缺失'}")
                print(f"  - DAT 文件: {'✅ ' + str(dat_file) if dat_file else '❌ 缺失'}")

            # 列出 data_dir 中的所有文件（用于调试）
            try:
                all_files = list(data_dir.glob("*"))
                print(f"  - 数据目录文件列表: {[f.name for f in all_files if f.is_file()]}")
            except Exception as e:
                print(f"  - 列出文件失败: {e}")

            # 解析 MapInfo 图层
            import json
            from app.services.mapinfo_service import parse_mapinfo_files, get_last_parse_errors

            try:
                layers = await asyncio.to_thread(parse_mapinfo_files, target_file, parent_id=data_id)
                _mapinfo_errors = get_last_parse_errors()  # 每个失败文件的具体原因
            except ImportError as e:
                # 缺少 geopandas 库
                print(f"[DataService] ❌ 缺少必要的地理数据处理库")
                print(f"[DataService] 错误详情: {e}")

                # 保存空的 layers.json
                with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
                    json.dump([], f)

                # 标记为错误状态
                self.index[data_id] = {
                    "id": data_id,
                    "name": filename,
                    "type": "map",
                    "subType": "mapinfo",
                    "size": file_path.stat().st_size,
                    "originalPath": original_path,
                    "uploadDate": datetime.now().isoformat(),
                    "status": "error",
                    "metadata": {
                        "fileCount": 1,
                        "layerCount": 0,
                        "layers": [],
                        "error": "缺少必要的地理数据处理库 (geopandas)",
                        "errorDetail": str(e),
                    },
                }
        
                raise ValueError(
                    f"MapInfo 文件解析失败：缺少必要的地理数据处理库。\n"
                    f"请运行以下命令安装依赖：\n"
                    f"  pip install geopandas shapely\n\n"
                    f"Windows 用户可能需要先安装 GDAL，推荐使用 conda：\n"
                    f"  conda install -c conda-forge geopandas"
                )

            # 检查解析结果
            if not layers:
                print(f"[DataService] 警告：未解析到任何图层，文件可能格式不正确")
                print(f"[DataService] 文件路径: {target_file}")
                print(f"[DataService] 文件是否存在: {target_file.exists()}")
                if target_file.exists():
                    file_size = target_file.stat().st_size
                    print(f"[DataService] 文件大小: {file_size} 字节")
                    # 读取前几行内容检查格式
                    try:
                        with open(
                            target_file, "r", encoding="gbk", errors="ignore"
                        ) as f:
                            preview = "".join([f.readline() for _ in range(10)])
                            print(f"[DataService] 文件内容预览:\n{preview}")
                    except:
                        print(f"[DataService] 无法读取文件内容预览")

            # 保存图层元数据（即使为空也保存，便于调试）
            with open(data_dir / "layers.json", "w", encoding="utf-8") as f:
                json.dump(layers, f, ensure_ascii=False, indent=2)
            # 后台预热 GeoJSON 磁盘缓存，避免首次勾选时等待 parse + 坐标转换
            self._prewarm_mapinfo_cache(data_id)

            print(f"[DataService] 解析到 {len(layers)} 个 MapInfo 图层")
            for layer in layers:
                print(
                    f"  - 图层ID: {layer['id']}, 名称: {layer['name']}, 类型: {layer['type']}, 要素数: {layer['feature_count']}"
                )

            # 更新索引
            self.index[data_id] = {
                "id": data_id,
                "name": filename,
                "type": "map",
                "subType": "mapinfo",
                "size": file_path.stat().st_size,
                "originalPath": original_path,
                "uploadDate": datetime.now().isoformat(),
                "status": (
                    "ready" if layers
                    else "partial" if _mapinfo_errors
                    else "error"
                ),
                "metadata": {
                    "fileCount": 1,
                    "layerCount": len(layers),
                    "layers": layers,
                    "errors": _mapinfo_errors,  # 每个失败文件的具体原因
                },
            }
        else:
            # 其他地图文件
            self.index[data_id] = {
                "id": data_id,
                "name": filename,
                "type": "map",
                "subType": "other",
                "size": file_path.stat().st_size,
                "originalPath": original_path,
                "uploadDate": datetime.now().isoformat(),
                "status": "ready",
                "metadata": {"fileCount": 1},
            }



        self._save_index()  # 持久化地图上传索引
        return {"id": data_id, "name": filename, "status": "ready"}

    def list_data(self, page: int = 1, page_size: int = 50) -> List[DataItem]:
        """获取数据列表（支持分页）"""
        items = []
        for data_id, data in self.index.items():
            try:
                # 创建数据副本并转换枚举类型
                data_copy = data.copy()
                # 确保type字段是枚举类型
                if isinstance(data_copy.get("type"), str):
                    if data_copy["type"] == "excel":
                        data_copy["type"] = DataType.EXCEL
                    elif data_copy["type"] == "map":
                        data_copy["type"] = DataType.MAP
                # 确保status字段是枚举类型
                if isinstance(data_copy.get("status"), str):
                    if data_copy["status"] == "ready":
                        data_copy["status"] = DataStatus.READY
                    elif data_copy["status"] == "processing":
                        data_copy["status"] = DataStatus.PROCESSING
                    elif data_copy["status"] == "error":
                        data_copy["status"] = DataStatus.ERROR
                    elif data_copy["status"] == "partial":
                        data_copy["status"] = DataStatus.PARTIAL
                # 确保必填字段存在
                if "size" not in data_copy:
                    data_copy["size"] = 0
                if "uploadDate" not in data_copy:
                    data_copy["uploadDate"] = datetime.now().isoformat()
                # 映射 index 字段到 Pydantic 模型字段
                if "excel_synced" in data_copy:
                    data_copy["excelSynced"] = data_copy.pop("excel_synced")
                if "inplace_updated" in data_copy:
                    data_copy["inplaceUpdated"] = data_copy.pop("inplace_updated")
                # 创建DataItem实例
                item = DataItem(**data_copy)
                items.append(item)
            except Exception as e:
                safe_print(f"[DataService] 创建DataItem失败 (id={data_id}): {e}")
                import traceback

                traceback.print_exc()
                # 跳过无效数据项，继续处理其他项
                continue

        # 按上传日期排序（最新的在前）
        items.sort(key=lambda x: x.uploadDate, reverse=True)

        # 分页逻辑
        total = len(items)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_items = items[start_idx:end_idx]

        safe_print(f"[DataService] list_data返回 {len(paginated_items)}/{total} 个数据项 (page={page}, page_size={page_size})")
        return paginated_items

    def get_total_count(self) -> int:
        """获取数据总数"""
        return len(self.index)

    def _get_cache_key(self, data_id: str, filename: str) -> str:
        """生成缓存键"""
        return f"{data_id}:{filename}"

    def _get_file_mtime(self, file_path: Path) -> float:
        """获取文件修改时间"""
        try:
            return file_path.stat().st_mtime
        except:
            return 0

    def _get_cached_data(self, data_id: str, filename: str, file_path: Path) -> Optional[Dict]:
        """从缓存获取数据，如果缓存失效返回None"""
        cache_key = self._get_cache_key(data_id, filename)
        if cache_key in self._data_cache:
            cached = self._data_cache[cache_key]
            current_mtime = self._get_file_mtime(file_path)
            # 检查缓存是否有效（文件未修改）
            if cached.get("mtime") == current_mtime:
                safe_print(f"[DataService] 从缓存读取数据: {cache_key}")
                return cached["data"]
            else:
                safe_print(f"[DataService] 缓存失效: {cache_key}")
        return None

    def _set_cached_data(self, data_id: str, filename: str, file_path: Path, data: Dict):
        """设置缓存数据"""
        cache_key = self._get_cache_key(data_id, filename)
        self._data_cache[cache_key] = {
            "data": data,
            "mtime": self._get_file_mtime(file_path)
        }
        safe_print(f"[DataService] 数据已缓存: {cache_key}")

    def get_data(self, data_id: str) -> Optional[Dict]:
        """获取数据详情（优先 SQLite，回退到遗留 data.json）"""
        if data_id not in self.index:
            return None

        data_info = self.index[data_id]

        # 处理中：直接返回索引中的基本信息（用于上传后轮询）
        if data_info.get("status") in ("processing", "pending"):
            return {
                "id": data_id,
                "name": data_info.get("name", ""),
                "fileType": data_info.get("fileType"),
                "status": data_info.get("status"),
            }

        # 如果处理失败，返回错误信息而非 404
        if data_info.get("status") == "error":
            return {
                "id": data_id,
                "name": data_info.get("name", ""),
                "fileType": data_info.get("fileType"),
                "status": "error",
                "errorMessage": data_info.get("errorMessage", "文件处理失败，详情未知"),
            }

        if data_info["type"] == "excel":
            import json

            # 主路径：读取 data.json 文件（传统文件处理逻辑）
            data_file = settings.DATA_DIR / data_id / "data.json"
            if data_file.exists():
                with open(data_file, "r", encoding="utf-8") as f:
                    return json.load(f)

            # 回退：地理化数据 default.json 文件
            default_file = settings.DATA_DIR / data_id / "default.json"
            if default_file.exists():
                with open(default_file, "r", encoding="utf-8") as f:
                    return json.load(f)

            # 最后回退：SQLite 遗留数据
            result = self.get_data_from_db(data_id)
            if result is not None:
                return result

            # 兜底：索引中状态为 ready 但 data.json 不存在（分块上传场景）
            # 直接返回索引中的基本信息供前端轮询使用
            if data_info.get("status") == "ready":
                return {
                    "id": data_id,
                    "name": data_info.get("name", ""),
                    "fileType": data_info.get("fileType"),
                    "status": "ready",
                }

            return None
        else:
            # 地图文件返回文件列表（递归搜索子目录）
            data_dir = settings.DATA_DIR / data_id
            files = list(data_dir.rglob("*")) if data_dir.exists() else []
            return {"files": [str(f.relative_to(data_dir)) for f in files if f.is_file()]}

    def _prewarm_mapinfo_cache(self, data_id: str):
        """上传后后台预热 MapInfo 图层 GeoJSON 缓存（幂等，失败仅记日志）。

        复用 mapinfo_service.prebuild_layer_geojson_cache（内部调用 get_layer_data 写入
        磁盘 .cache 缓存），使首次勾选图层时无需等待 parse + 坐标转换。
        后台线程执行，上传请求立即返回。
        """
        def _run():
            import json
            from app.services.mapinfo_service import prebuild_layer_geojson_cache
            data_dir = settings.DATA_DIR / data_id
            layers_file = data_dir / "layers.json"
            if not layers_file.exists():
                return
            try:
                with open(layers_file, "r", encoding="utf-8") as f:
                    layers = json.load(f)
                prebuild_layer_geojson_cache(data_id, data_dir, layers)
            except Exception as e:
                safe_print(f"[DataService] 预热图层缓存失败 (data_id={data_id}): {e}")

        import threading
        threading.Thread(target=_run, daemon=True).start()

    def prewarm_all_map_caches(self):
        """服务启动时后台预热所有 MapInfo 图层的 GeoJSON 缓存。

        解决"首次勾选图层时后端 parse + 坐标转换耗时过长导致前端 300s 超时"：
        扫描索引中所有 map 类型数据，逐个预热 .cache/*.geojson 磁盘缓存。
        幂等、后台线程、失败仅记日志，不阻塞启动。
        """
        def _run():
            map_ids = [
                data_id for data_id, info in self.index.items()
                if isinstance(info, dict) and info.get("type") == "map"
            ]
            if not map_ids:
                return
            safe_print(f"[DataService] 启动预热 {len(map_ids)} 个 MapInfo 数据集的图层缓存...")
            for data_id in map_ids:
                try:
                    self._prewarm_mapinfo_cache(data_id)
                except Exception as e:
                    safe_print(f"[DataService] 预热 {data_id} 失败: {e}")
            safe_print("[DataService] 图层缓存预热任务已全部提交（后台执行）")

        import threading
        threading.Thread(target=_run, daemon=True).start()

    def clear_cache(self, data_id: Optional[str] = None):
        """清除缓存"""
        if data_id is None:
            self._data_cache.clear()
            safe_print("[DataService] 所有缓存已清除")
        else:
            # 清除指定数据ID的缓存
            keys_to_remove = [k for k in self._data_cache.keys() if k.startswith(f"{data_id}:")]
            for key in keys_to_remove:
                del self._data_cache[key]
            safe_print(f"[DataService] 数据 {data_id} 的缓存已清除")

    def delete_data(self, data_id: str, force: bool = False) -> bool:
        """删除数据

        Args:
            data_id: 数据ID
            force: 是否强制删除（即使文件被占用也尝试删除）

        Returns:
            bool: 是否删除成功
        """
        if data_id not in self.index:
            return False

        safe_print(f"[DataService] 删除数据: {data_id}, force={force}")

        # 1. 先清理缓存（防止文件句柄被占用）
        self.clear_cache(data_id)

        # 2. 尝试删除文件（带重试机制）
        data_dir = settings.DATA_DIR / data_id
        deletion_errors = []

        if data_dir.exists():
            if force:
                # 强制删除：使用 onerror 回调处理只读文件和被占用的文件
                def handle_remove_error(func, path, exc_info):
                    """处理删除时的错误"""
                    import stat
                    import time

                    try:
                        # 尝试更改文件权限（Windows 只读文件）
                        if not os.access(path, os.W_OK):
                            os.chmod(path, stat.S_IWRITE)
                            func(path)
                        else:
                            # 文件可能被占用，尝试重试
                            for i in range(3):
                                time.sleep(0.5)
                                try:
                                    func(path)
                                    safe_print(f"[DataService] 重试 {i+1} 次后删除成功: {path}")
                                    return
                                except Exception as e:
                                    if i == 2:
                                        # 最后一次重试失败，记录错误
                                        deletion_errors.append(f"{path}: {str(e)}")
                    except Exception as e:
                        deletion_errors.append(f"{path}: {str(e)}")

                try:
                    shutil.rmtree(data_dir, onerror=handle_remove_error)
                    safe_print(f"[DataService] 数据目录已删除: {data_dir}")
                except Exception as e:
                    deletion_errors.append(f"{data_dir}: {str(e)}")
            else:
                # 普通删除
                try:
                    shutil.rmtree(data_dir)
                    safe_print(f"[DataService] 数据目录已删除: {data_dir}")
                except Exception as e:
                    deletion_errors.append(f"{data_dir}: {str(e)}")

        # 3. 删除上传的原始文件 - 尝试新旧两种格式
        # 新格式：{data_id}.xlsx
        upload_file = settings.UPLOAD_DIR / f"{data_id}.xlsx"
        if upload_file.exists():
            try:
                upload_file.unlink()
                safe_print(f"[DataService] 上传文件已删除: {upload_file}")
            except Exception as e:
                deletion_errors.append(f"{upload_file}: {str(e)}")
        else:
            # 旧格式：{data_id}_{filename}.xlsx (兼容旧数据)
            old_filename = self.index[data_id].get("name", "")
            if old_filename:
                old_upload_file = settings.UPLOAD_DIR / f"{data_id}_{old_filename}"
                if old_upload_file.exists():
                    try:
                        old_upload_file.unlink()
                        safe_print(f"[DataService] 旧格式上传文件已删除: {old_upload_file}")
                    except:
                        # 旧文件删除失败不记录（可能不存在）
                        pass

        # 4. 清理 SQLite 中的数据
        db = SessionLocal()
        try:
            deleted_sectors = db.query(Sector).filter(Sector.workbook_id == data_id).delete()
            deleted_sites = db.query(Site).filter(Site.workbook_id == data_id).delete()
            deleted_wb = db.query(Workbook).filter(Workbook.id == data_id).delete()
            deleted_geo = db.query(GeoFile).filter(GeoFile.id == data_id).delete()
            deleted_layer = db.query(Layer).filter(Layer.id == data_id).delete()
            db.commit()
            safe_print(f"[DataService] SQLite 清理完成: workbook={deleted_wb}, sites={deleted_sites}, sectors={deleted_sectors}, geo={deleted_geo}, layer={deleted_layer}")
        except Exception as e:
            db.rollback()
            safe_print(f"[DataService] SQLite 清理失败 (非致命): {e}")
        finally:
            db.close()

        # 5. 无论文件删除是否成功，都从索引中移除（保持索引一致性）
        # 但如果有严重错误，需要记录警告
        if deletion_errors and not force:
            # 非强制模式下，如果删除文件失败，仍然从索引中移除
            # 但记录警告，让用户知道可能需要手动清理
            safe_print(f"[DataService] 警告: 部分文件删除失败，但已从索引中移除:")
            for error in deletion_errors:
                safe_print(f"  - {error}")

        # 6. 更新索引
        del self.index[data_id]
        self._save_index()  # 持久化删除操作

        safe_print(f"[DataService] 数据 {data_id} 已从索引中移除")

        # 7. 如果是强制删除且有错误，仍然返回成功（因为索引已更新）
        return True

    def preview_data(self, data_id: str, rows: int = 100) -> Optional[Dict]:
        """预览数据（优先 SQLite，回退到 Excel 文件读取）"""
        if data_id not in self.index:
            return None

        data_info = self.index[data_id]
        if data_info["type"] != "excel":
            return None

        # 优先从 SQLite 查询（速度快）
        try:
            db = SessionLocal()
            try:
                wb = db.query(Workbook).filter(Workbook.id == data_id).first()
                if wb is not None:
                    sectors = db.query(Sector).filter(
                        Sector.workbook_id == data_id
                    ).limit(rows).all()

                    if sectors:
                        site_ids = list(set(s.site_id_fk for s in sectors if s.site_id_fk))
                        sites_map = {}
                        if site_ids:
                            site_objs = db.query(Site).filter(Site.id.in_(site_ids)).all()
                            sites_map = {s.id: s for s in site_objs}

                        sector_rows = []
                        for s in sectors:
                            site = sites_map.get(s.site_id_fk)
                            sector_rows.append({
                                "network_type": site.network_type if site else "",
                                "site_id": site.site_id if site else "",
                                "site_name": site.name if site else "",
                                "sector_id": s.sector_id,
                                "sector_name": s.name or "",
                                "pci": s.pci,
                                "tac": s.tac,
                                "azimuth": s.azimuth,
                                "frequency": s.frequency,
                                "longitude": s.longitude,
                                "latitude": s.latitude,
                                "height": s.height,
                                "cell_cover_type": s.cell_cover_type,
                            })

                        total_count = db.query(Sector).filter(
                            Sector.workbook_id == data_id
                        ).count()

                        if sector_rows:
                            return {
                                "columns": list(sector_rows[0].keys()) if sector_rows else [],
                                "rows": sector_rows,
                                "totalRows": total_count,
                            }
            finally:
                db.close()
        except Exception as e:
            safe_print(f"[DataService] SQLite 预览失败，回退到 Excel: {e}")

        # 回退：读取 Excel 文件
        data_dir = settings.DATA_DIR / data_id
        original_file = data_dir / "original.xlsx"

        if original_file.exists():
            df = pd.read_excel(original_file, nrows=rows)
            return {
                "columns": df.columns.tolist(),
                "rows": df.to_dict("records"),
                "totalRows": len(df),
            }

        return None

    def get_workbooks_from_db(self, user_id: int = 1, is_admin: bool = False) -> List[Dict]:
        """从 SQLite 获取所有数据列表（工参 + 地理数据 + 图层，所有用户共享）"""
        db = SessionLocal()
        try:
            results = []

            # 1) Workbooks (Excel 工参)
            for wb in db.query(Workbook).order_by(Workbook.created_at.desc()).all():
                results.append({
                    "id": wb.id,
                    "user_id": wb.user_id,
                    "name": wb.name,
                    "type": "excel",
                    "fileType": wb.file_type,
                    "size": wb.size,
                    "status": wb.status,
                    "uploadDate": wb.created_at,
                    "remark": wb.remark,
                    "metadata": json.loads(wb.metadata_json) if wb.metadata_json else {},
                    "networkTypes": json.loads(wb.network_types) if wb.network_types else [],
                })

            # 2) GeoFiles (地理化数据)
            for gf in db.query(GeoFile).order_by(GeoFile.created_at.desc()).all():
                results.append({
                    "id": gf.id,
                    "user_id": gf.user_id,
                    "name": gf.filename,
                    "type": "excel",
                    "fileType": "geo_data",
                    "geometryType": gf.geometry_type,
                    "size": gf.file_size,
                    "status": "ready",
                    "uploadDate": gf.created_at,
                    "metadata": {"pointCount": gf.point_count},
                })

            # 3) Layers (MapInfo 图层)
            for layer in db.query(Layer).order_by(Layer.created_at.desc()).all():
                results.append({
                    "id": layer.id,
                    "user_id": layer.user_id,
                    "name": layer.name,
                    "type": "map",
                    "subType": "mapinfo",
                    "size": layer.file_size,
                    "status": "ready",
                    "uploadDate": layer.created_at,
                    "metadata": {
                        "layerCount": 1,
                        "layers": [{
                            "id": layer.id,
                            "name": layer.name,
                            "type": layer.geometry_type,
                            "feature_count": layer.feature_count,
                        }],
                        "fileCount": 1,
                    },
                })

            # 按上传日期排序（最新在前）
            results.sort(key=lambda x: x.get("uploadDate", ""), reverse=True)
            return results
        finally:
            db.close()

    def _migrate_legacy_data(self, data_id: str, user_id: int = 1) -> bool:
        """将遗留 data.json 中的数据迁移到 SQLite（可独立于 self.index 工作）"""
        import json

        data_dir = settings.DATA_DIR / data_id
        data_json = data_dir / "data.json"

        if not data_json.exists():
            return False

        with open(data_json, "r", encoding="utf-8") as f:
            parsed_data = json.load(f)

        # 从 self.index 或文件系统获取元数据
        if data_id in self.index:
            data_info = self.index[data_id]
            filename = data_info.get("name", "legacy.xlsx")
            file_type = data_info.get("fileType", "default")
            metadata = data_info.get("metadata", {})
            original_path = data_info.get("original_path") or data_info.get("originalPath")
        else:
            filename = f"{data_id}.xlsx"
            file_type = "full_params" if "LTE" in parsed_data or "NR" in parsed_data else "default"
            metadata = {}
            for net in parsed_data:
                sites = parsed_data[net]
                if isinstance(sites, list):
                    metadata[f"{net}SiteCount"] = len(sites)
                    metadata[f"{net}SectorCount"] = sum(len(s.get("sectors", [])) for s in sites)
            original_path = None

        file_path = settings.UPLOAD_DIR / f"{data_id}.xlsx"
        if not file_path.exists():
            file_path = data_dir / "original.xlsx"

        self._save_to_sqlite(
            data_id=data_id,
            filename=filename,
            file_type=file_type,
            user_id=user_id,
            parsed_data=parsed_data,
            metadata=metadata,
            file_path=file_path,
            original_path=original_path,
        )

        # 将迁移后的条目加入内存索引
        self.index[data_id] = {
            "id": data_id,
            "name": filename,
            "type": "excel",
            "fileType": file_type,
            "size": file_path.stat().st_size if file_path.exists() else 0,
            "uploadDate": datetime.now().isoformat(),
            "status": "ready",
            "metadata": metadata,
            "user_id": user_id,
            "originalPath": original_path,
        }
        self._save_index()  # 持久化迁移条目
        return True

    def get_sectors_preview_from_db(
        self, workbook_id: str, user_id: int = 1, page: int = 1, page_size: int = 100,
        network_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """从 SQLite 获取扇区预览（分页，所有用户共享数据）"""
        db = SessionLocal()
        try:
            exists = db.query(Workbook).filter(Workbook.id == workbook_id).first()
            if not exists:
                # 旧数据：先迁移
                success = self._migrate_legacy_data(workbook_id, user_id)
                if not success:
                    raise ValueError(f"工参不存在: {workbook_id}")

            query = db.query(Sector).filter(
                Sector.workbook_id == workbook_id,
            )
            if network_type:
                query = query.join(Site, Sector.site_id_fk == Site.id).filter(
                    Site.network_type == network_type
                )

            total = query.count()
            sectors = query.offset((page - 1) * page_size).limit(page_size).all()

            site_ids = list(set(s.site_id_fk for s in sectors if s.site_id_fk))
            sites_map = {}
            if site_ids:
                site_objs = db.query(Site).filter(Site.id.in_(site_ids)).all()
                sites_map = {s.id: s for s in site_objs}

            return {
                "sectors": [{
                    "id": s.id,
                    "sector_id": s.sector_id,
                    "name": s.name,
                    "pci": s.pci,
                    "tac": s.tac,
                    "azimuth": s.azimuth,
                    "longitude": s.longitude,
                    "latitude": s.latitude,
                    "network_type": sites_map[s.site_id_fk].network_type if s.site_id_fk in sites_map else None,
                    "cell_cover_type": s.cell_cover_type,
                } for s in sectors],
                "total": total,
                "page": page,
                "page_size": page_size,
            }
        finally:
            db.close()

    def get_data_from_db(self, data_id: str, user_id: Optional[int] = None) -> Optional[Dict]:
        """从 SQLite 获取完整站点/扇区数据，格式与 data.json 一致（所有用户共享数据）

        Returns:
            {network_type: [{id, name, longitude, latitude, networkType, sectors: [...]}]}
            如果数据不存在返回 None
        """
        db = SessionLocal()
        try:
            sites = db.query(Site).filter(Site.workbook_id == data_id).all()

            if not sites:
                return None

            sectors = db.query(Sector).filter(Sector.workbook_id == data_id).all()

            sectors_by_site: Dict[int, List] = {}
            for s in sectors:
                if s.site_id_fk is not None:
                    sectors_by_site.setdefault(s.site_id_fk, []).append(s)

            result: Dict[str, List] = {}
            for site in sites:
                nt = site.network_type
                if nt not in result:
                    result[nt] = []

                site_sectors = sectors_by_site.get(site.id, [])
                site_entry = {
                    "id": site.site_id,
                    "name": site.name or "Unknown",
                    "longitude": site.longitude or 0.0,
                    "latitude": site.latitude or 0.0,
                    "networkType": nt,
                    "sectors": [{**self._sector_to_dict(sec)} for sec in site_sectors],
                }
                if site.managed_element_id:
                    site_entry["managedElementId"] = site.managed_element_id
                if site.mcc:
                    site_entry["mcc"] = site.mcc
                if site.mnc:
                    site_entry["mnc"] = site.mnc

                result[nt].append(site_entry)

            return result if result else None
        finally:
            db.close()

    def _sector_to_dict(self, sector) -> Dict[str, Any]:
        """将 Sector ORM 对象转换为与 data.json 一致的 dict 格式"""
        d = {
            "id": sector.sector_id,
            "siteId": sector.sector_id.split("_")[0] if "_" in sector.sector_id else "",
            "name": sector.name or "",
            "longitude": sector.longitude or 0.0,
            "latitude": sector.latitude or 0.0,
            "azimuth": sector.azimuth or 0.0,
            "beamwidth": sector.beamwidth or 65.0,
            "height": sector.height or 30.0,
            "pci": sector.pci,
            "cell_cover_type": sector.cell_cover_type or 1,
        }
        if sector.frequency is not None:
            d["earfcn"] = sector.frequency
            d["ssb_frequency"] = sector.frequency
        if sector.tac is not None:
            d["tac"] = sector.tac
        if sector.is_shared:
            d["is_shared"] = sector.is_shared
        if sector.first_group:
            d["first_group"] = sector.first_group
        if sector.mcc:
            d["mcc"] = sector.mcc
        if sector.mnc:
            d["mnc"] = sector.mnc
        return d

    def cleanup_index(self) -> Dict[str, Any]:
        """清理无效索引项（SQLite中不存在或文件目录不存在的项）

        Returns:
            dict: 包含 removed（移除的数量）和 items（被移除的项列表）
        """
        safe_print("[DataService] 开始清理无效索引...")

        removed_items = []
        ids_to_remove = []

        db = SessionLocal()
        try:
            sql_workbook_ids = {wb.id for wb in db.query(Workbook.id).all()}
            sql_geo_file_ids = {gf.id for gf in db.query(GeoFile.id).all()}
        finally:
            db.close()

        for data_id, data_info in list(self.index.items()):
            data_dir = settings.DATA_DIR / data_id

            # 检查数据目录是否存在
            if not data_dir.exists():
                safe_print(f"[DataService] 发现无效索引: {data_id} - {data_info.get('name', '未知')} (目录不存在)")
                ids_to_remove.append(data_id)
                removed_items.append({
                    "id": data_id,
                    "name": data_info.get("name", "未知"),
                    "reason": "目录不存在"
                })
                continue

            # 对于 Excel 类型，检查是否在 SQLite 中或至少存在数据文件
            if data_info.get("type") == "excel":
                file_type = data_info.get("fileType", "")

                # 地理化数据：检查 GeoFile 表或 default.json
                if file_type == "geo_data":
                    if data_id not in sql_geo_file_ids and not (data_dir / "default.json").exists():
                        safe_print(f"[DataService] 发现无效地理化数据索引: {data_id} - {data_info.get('name', '未知')} (GeoFile表和文件均不存在)")
                        ids_to_remove.append(data_id)
                        removed_items.append({
                            "id": data_id,
                            "name": data_info.get("name", "未知"),
                            "reason": "GeoFile表中不存在且无数据文件"
                        })
                else:
                    # 普通 Excel 数据：检查 Workbook 表或 original.xlsx
                    if data_id not in sql_workbook_ids and not (data_dir / "original.xlsx").exists():
                        safe_print(f"[DataService] 发现无效索引: {data_id} - {data_info.get('name', '未知')} (SQLite和文件均不存在)")
                        ids_to_remove.append(data_id)
                        removed_items.append({
                            "id": data_id,
                            "name": data_info.get("name", "未知"),
                            "reason": "SQLite中不存在且无original.xlsx"
                        })

        # 移除无效索引
        for data_id in ids_to_remove:
            del self.index[data_id]

        if ids_to_remove:
            safe_print(f"[DataService] 清理完成，移除了 {len(ids_to_remove)} 个无效索引项")
            for data_id in ids_to_remove:
                self.clear_cache(data_id)
        else:
            safe_print("[DataService] 索引有效，无需清理")

        return {
            "removed": len(ids_to_remove),
            "items": removed_items
        }


# 创建全局实例
data_service = DataService()
