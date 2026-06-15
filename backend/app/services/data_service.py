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


def safe_print(msg: str):
    """安全打印函数，处理可能的编码错误"""
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
        # 扫描uploads目录 - 默认延迟加载以加快启动
        if not lazy_load:
            self._scan_uploads_directory()
        else:
            # 异步扫描，不阻塞启动
            import threading
            threading.Thread(target=self._scan_uploads_directory, daemon=True).start()

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
                # 注意：coverageType 不在 field_map 中，而是单独处理
            }

        # 验证必要的列是否存在于Excel中
        missing_cols = [k for k in key_cols if k not in col_map]
        if missing_cols:
            safe_print(
                f"[DataService] 警告: Sheet中缺少Key列: {missing_cols}，跳过更新"
            )
            return

        # 遍历数据行（从第4行开始）
        # 注意：openpyxl的row是1-based
        for row in ws.iter_rows(min_row=4):
            # 获取Key值
            try:
                if network_type == "LTE":
                    enb_id = self._get_cell_val(row, col_map, "eNodeB标识")
                    cell_id = self._get_cell_val(row, col_map, "小区标识")
                    if enb_id is not None and cell_id is not None:
                        key = f"{enb_id}_{cell_id}"
                        existing_keys.add(key)

                        # 检查是否有更新
                        if key in updates:
                            # 获取当前基站名称（更新前）
                            current_bs_name = None
                            if "基站名称" in col_map:
                                current_bs_name = self._get_cell_val(row, col_map, "基站名称")

                            self._apply_row_update(
                                row, col_map, updates[key], field_map, network_type
                            )
                            # 标记为已处理（以便后续追加未处理的）
                            updates[key]["_processed"] = True

                            # 设置"是否现网"列：能匹配到现网工参，填"是"
                            if "是否现网" in col_map:
                                row[col_map["是否现网"] - 1].value = "是"

                            # 检查基站名称是否被更新
                            new_bs_name = None
                            if "基站名称" in col_map:
                                new_bs_name = self._get_cell_val(row, col_map, "基站名称")

                            if current_bs_name != new_bs_name:
                                safe_print(f"[LTE UPDATE] 基站名称已更新: Key={key}, 原值={current_bs_name}, 新值={new_bs_name}")
                        else:
                            # 设置"是否现网"列：未匹配到现网工参，填"否"
                            if "是否现网" in col_map:
                                row[col_map["是否现网"] - 1].value = "否"

                            # LTE Key未找到的调试日志（只记录前几条，避免日志过多）
                            missing_count = getattr(self, '_lte_missing_key_count', 0) + 1
                            self._lte_missing_key_count = missing_count
                            if missing_count <= 10:
                                safe_print(f"[LTE DEBUG] Key未在现网工参中找到: {key}")
                            elif missing_count == 11:
                                safe_print(f"[LTE DEBUG] ...（后续未匹配的Key将不再打印）")

                else:  # NR
                    mcc = self._get_cell_val(row, col_map, "移动国家码")
                    mnc = self._get_cell_val(row, col_map, "移动网络码")
                    gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                    cell_id = self._get_cell_val(row, col_map, "小区标识")

                    if all(v is not None for v in [mcc, mnc, gnb_id, cell_id]):
                        key = f"{mcc}_{mnc}_{gnb_id}_{cell_id}"
                        existing_keys.add(key)

                        if key in updates:
                            try:
                                # 获取当前基站名称（更新前）
                                current_bs_name = None
                                if "基站名称" in col_map:
                                    current_bs_name = self._get_cell_val(row, col_map, "基站名称")

                                self._apply_row_update(
                                    row, col_map, updates[key], field_map, network_type
                                )
                                updates[key]["_processed"] = True

                                # 设置"是否现网"列：能匹配到现网工参，填"是"
                                if "是否现网" in col_map:
                                    row[col_map["是否现网"] - 1].value = "是"

                                # 检查基站名称是否被更新
                                new_bs_name = None
                                if "基站名称" in col_map:
                                    new_bs_name = self._get_cell_val(row, col_map, "基站名称")

                                if current_bs_name != new_bs_name:
                                    safe_print(f"[UPDATE] 基站名称已更新: Key={key}, 原值={current_bs_name}, 新值={new_bs_name}")
                            except Exception as e:
                                import traceback

                                safe_print(f"[DataService] 更新行失败 (Key={key}): {e}")
                                traceback.print_exc()
                        else:
                            # 设置"是否现网"列：未匹配到现网工参，填"否"
                            if "是否现网" in col_map:
                                row[col_map["是否现网"] - 1].value = "否"

                            # Key未找到的调试日志（采样打印，避免日志过多）
                            safe_print(f"[DEBUG] Key未在现网工参中找到: {key}")
            except Exception as e:
                import traceback

                safe_print(f"[DataService] 处理行时发生错误: {e}")
                traceback.print_exc()
                continue

        # 5. 追加新行
        new_rows_count = 0
        for key, data in updates.items():
            if not data.get("_processed"):
                # 准备新行数据
                self._append_new_row(ws, col_map, data, field_map, network_type)
                new_rows_count += 1

        # 4. 处理特殊列：CGI、跟踪区码、是否共享、第一分组、gNodeBLength
        # 收集所有行数据用于处理（包括新追加的行）
        all_rows = list(ws.iter_rows(min_row=4))

        if network_type == "NR":
            # NR网络处理
            # 4.1 生成CGI列
            cgi_list = []
            for row in all_rows:
                gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if gnb_id and cell_id:
                    cgi = f"{gnb_id}-{cell_id}"
                    cgi_list.append(cgi)
                    # 更新CGI列
                    if "CGI" in col_map:
                        row[col_map["CGI"] - 1].value = cgi
                else:
                    cgi_list.append(None)

            # 4.2 更新跟踪区码（从现网工参获取）
            for i, row in enumerate(all_rows):
                mcc = self._get_cell_val(row, col_map, "移动国家码")
                mnc = self._get_cell_val(row, col_map, "移动网络码")
                gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if all([mcc, mnc, gnb_id, cell_id]):
                    key = f"{mcc}_{mnc}_{gnb_id}_{cell_id}"
                    if key in updates and "tac" in updates[key]:
                        tac = updates[key]["tac"]
                        if (
                            "跟踪区码" in col_map
                            and tac is not None
                            and not pd.isna(tac)
                        ):
                            row[col_map["跟踪区码"] - 1].value = tac

            # 4.3 计算是否共享列
            if "是否共享" in col_map:
                # 统计CGI出现次数
                cgi_counts = {}
                for cgi in cgi_list:
                    if cgi:
                        cgi_counts[cgi] = cgi_counts.get(cgi, 0) + 1
                # 更新是否共享列
                for i, row in enumerate(all_rows):
                    cgi = cgi_list[i]
                    if cgi:
                        count = cgi_counts.get(cgi, 0)
                        row[col_map["是否共享"] - 1].value = (
                            "是" if count == 2 else "否"
                        )

            # 4.4 更新第一分组列：在现网工参能找到的小区都填为"电信中兴"
            for i, row in enumerate(all_rows):
                mcc = self._get_cell_val(row, col_map, "移动国家码")
                mnc = self._get_cell_val(row, col_map, "移动网络码")
                gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if all([mcc, mnc, gnb_id, cell_id]):
                    key = f"{mcc}_{mnc}_{gnb_id}_{cell_id}"
                    if key in updates:
                        if "第一分组" in col_map:
                            row[col_map["第一分组"] - 1].value = "电信中兴"

            # 4.5 处理gNodeBLength：未找到的小区根据填写SSB频点判断
            for i, row in enumerate(all_rows):
                mcc = self._get_cell_val(row, col_map, "移动国家码")
                mnc = self._get_cell_val(row, col_map, "移动网络码")
                gnb_id = self._get_cell_val(row, col_map, "gNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if all([mcc, mnc, gnb_id, cell_id]):
                    key = f"{mcc}_{mnc}_{gnb_id}_{cell_id}"
                    if key not in updates:
                        # 未找到的小区，根据填写SSB频点判断
                        ssb_frequency = self._get_cell_val(row, col_map, "填写SSB频点")
                        if ssb_frequency:
                            try:
                                # 尝试将SSB频点转换为数值，处理范围判断
                                # 情况1: 直接是数值，如 "925"
                                ssb_num = float(ssb_frequency)
                                if 900 <= ssb_num <= 955:
                                    if "gNodeBLength" in col_map:
                                        row[col_map["gNodeBLength"] - 1].value = 8
                                # 情况2: 范围字符串，如 "900-955"
                            except ValueError:
                                # 如果转换失败，检查是否是范围字符串
                                if "-" in ssb_frequency:
                                    try:
                                        # 提取范围的上下限
                                        lower, upper = ssb_frequency.split("-")
                                        lower_num = float(lower.strip())
                                        upper_num = float(upper.strip())
                                        # 检查范围是否与900-955有重叠
                                        if lower_num <= 955 and upper_num >= 900:
                                            if "gNodeBLength" in col_map:
                                                row[
                                                    col_map["gNodeBLength"] - 1
                                                ].value = 8
                                    except ValueError:
                                        # 如果范围解析失败，跳过
                                        pass
                                # 检查是否完全匹配 "900-955"
                                elif ssb_frequency == "900-955":
                                    if "gNodeBLength" in col_map:
                                        row[col_map["gNodeBLength"] - 1].value = 8

        else:  # LTE网络
            # LTE网络处理
            # 4.1 生成CGI列
            for row in all_rows:
                enb_id = self._get_cell_val(row, col_map, "eNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if enb_id and cell_id:
                    cgi = f"{enb_id}-{cell_id}"
                    # 更新CGI列
                    if "CGI" in col_map:
                        row[col_map["CGI"] - 1].value = cgi

            # 4.2 更新是否共享列（基于plmnIdList）
            for i, row in enumerate(all_rows):
                enb_id = self._get_cell_val(row, col_map, "eNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if enb_id and cell_id:
                    key = f"{enb_id}_{cell_id}"
                    if key in updates and "plmnIdList" in updates[key]:
                        plmn_id_list = updates[key]["plmnIdList"]
                        if "是否共享" in col_map:
                            if (
                                plmn_id_list
                                and isinstance(plmn_id_list, str)
                                and ";" in plmn_id_list
                            ):
                                row[col_map["是否共享"] - 1].value = "是"
                            else:
                                row[col_map["是否共享"] - 1].value = "否"

            # 4.3 更新第一分组列：在现网工参能找到的小区都填为"电信中兴"
            for i, row in enumerate(all_rows):
                enb_id = self._get_cell_val(row, col_map, "eNodeB标识")
                cell_id = self._get_cell_val(row, col_map, "小区标识")
                if enb_id and cell_id:
                    key = f"{enb_id}_{cell_id}"
                    if key in updates:
                        if "第一分组" in col_map:
                            row[col_map["第一分组"] - 1].value = "电信中兴"

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
                if enb_id and cell_id:
                    cgi = f"{enb_id}-{cell_id}"
                    new_row[col_map["CGI"] - 1] = cgi
            else:  # NR
                # NR CGI: gNodeB标识-小区标识
                gnb_id = data.get("gNBId")
                cell_id = data.get("cellLocalId")
                if gnb_id and cell_id:
                    cgi = f"{gnb_id}-{cell_id}"
                    new_row[col_map["CGI"] - 1] = cgi

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
                # NR: 先设置默认值，后续会根据CGI出现次数更新
                new_row[col_map["是否共享"] - 1] = "否"

        # 设置"是否现网"列：追加的新行来自现网工参，填"是"
        if "是否现网" in col_map:
            new_row[col_map["是否现网"] - 1] = "是"

        # 将新行添加到工作表
        ws.append(new_row)

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

                for _, row in df.iterrows():
                    item = row.to_dict()

                    # 处理PLMN分解
                    if "plmn" in item and pd.notna(item["plmn"]):
                        plmn_parts = str(item["plmn"]).split("-")
                        if len(plmn_parts) >= 2:
                            item["mcc"] = plmn_parts[0]
                            item["mnc"] = plmn_parts[1]
                        else:
                            item["mcc"] = ""
                            item["mnc"] = ""
                    else:
                        item["mcc"] = ""
                        item["mnc"] = ""

                    # 生成Key
                    key = None
                    if network_type == "LTE":
                        if "eNBId" in item and "cellLocalId" in item:
                            key = f"{item['eNBId']}_{item['cellLocalId']}"
                    else:
                        if all(
                            k in item for k in ["mcc", "mnc", "gNBId", "cellLocalId"]
                        ):
                            key = f"{item['mcc']}_{item['mnc']}_{item['gNBId']}_{item['cellLocalId']}"

                    if key:
                        updates[key] = item
                        # LTE 专用：检查基站名称字段（仅打印调试日志，不写入updates）
                        if network_type == "LTE":
                            bs_name_fields = ["eNBName", "UserLabel"]
                        else:
                            bs_name_fields = ["eNBName", "gNBName", "UserLabel", "dra_GNBName"]

                        bs_values = {}
                        has_bs_name = False
                        for field in bs_name_fields:
                            if field in item and pd.notna(item[field]) and str(item[field]).strip():
                                bs_values[field] = item[field]
                                has_bs_name = True

                        if has_bs_name:
                            # 只记录前3条有基站名称的数据作为样本（纯日志，不污染updates）
                            if len(updates) <= 3:
                                safe_print(f"[DEBUG] Key={key}, 基站名称字段: {bs_values}")
                        elif network_type == "LTE":
                            # LTE 专用：记录没有基站名称的数据（仅前5条，纯日志）
                            if len(updates) <= 5:
                                safe_print(f"[LTE WARN] Key={key} 没有任何基站名称字段")

            except Exception as e:
                import traceback

                safe_print(f"[DataService] 读取CSV失败 {file_path.name}: {e}")
                traceback.print_exc()

        safe_print(f"[DataService] 总共加载 {len(updates)} 条 {network_type} 现网数据")
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
                    from app.services.mapinfo_service import parse_mapinfo_files
                    _mapinfo_layers = parse_mapinfo_files(data_dir, parent_id=data_id)
                    layers_json_path = data_dir / "layers.json"
                    with open(layers_json_path, "w", encoding="utf-8") as _lf:
                        json.dump(_mapinfo_layers, _lf, ensure_ascii=False, indent=2)
                    # 更新索引为 map 类型
                    self.index[data_id].update({
                        "type": "map",
                        "subType": "mapinfo",
                        "fileType": "tac_layer",
                        "status": "ready",
                        "metadata": {
                            "fileCount": len(list(data_dir.rglob('*'))),
                            "layerCount": len(_mapinfo_layers),
                            "layers": _mapinfo_layers,
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

        # 1) 数值字段向量化转换
        df['_lon'] = pd.to_numeric(df[mapped_columns["longitude"]], errors='coerce').fillna(0.0)
        df['_lat'] = pd.to_numeric(df[mapped_columns["latitude"]], errors='coerce').fillna(0.0)

        if "azimuth" in mapped_columns:
            df['_azimuth'] = pd.to_numeric(df[mapped_columns["azimuth"]], errors='coerce').fillna(0.0)
        else:
            df['_azimuth'] = 0.0

        if "height" in mapped_columns:
            df['_height'] = pd.to_numeric(df[mapped_columns["height"]], errors='coerce').fillna(30.0)
        else:
            df['_height'] = 30.0

        if "pci" in mapped_columns:
            df['_pci'] = pd.to_numeric(df[mapped_columns["pci"]], errors='coerce')

        if network_type == "LTE" and "earfcn" in mapped_columns:
            df['_earfcn'] = pd.to_numeric(df[mapped_columns["earfcn"]], errors='coerce')
        elif network_type == "NR" and "ssb_frequency" in mapped_columns:
            df['_ssb_frequency'] = pd.to_numeric(df[mapped_columns["ssb_frequency"]], errors='coerce')

        _t_vecconv = _time.perf_counter()

        # 2) 字符串字段清理
        site_id_col = mapped_columns["site_id"]
        df['_site_id_raw'] = df[site_id_col]
        df['_site_id'] = df[site_id_col].astype(str).str.strip()

        if "site_name" in mapped_columns:
            df['_site_name'] = df[mapped_columns["site_name"]].astype(str).str.strip()
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
                return str(val).strip()

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
            valid_mask = (
                df[sname_col].notna()
                & ~df[sname_col].astype(str).str.strip().isin(['', '非必填', 'nan', 'None'])
            )
            df['_sector_name_col'] = df[sname_col].astype(str).str.strip().where(valid_mask)
        else:
            df['_sector_name_col'] = pd.NA

        # 6) 构建唯一键用于去重
        if network_type == "LTE":
            df['_unique_key'] = df['_site_id'] + '_' + df['_sector_id']
        else:
            if "mcc" in mapped_columns:
                df['_mcc'] = df[mapped_columns["mcc"]].astype(str).str.strip()
            else:
                df['_mcc'] = ''
            if "mnc" in mapped_columns:
                df['_mnc'] = df[mapped_columns["mnc"]].astype(str).str.strip()
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
            valid = df[col].notna() & ~df[col].astype(str).str.strip().isin(['', 'nan', 'None'])
            df.loc[valid, '_is_shared'] = df.loc[valid, col].astype(str).str.strip()

        df['_first_group'] = None
        if "first_group" in mapped_columns:
            col = mapped_columns["first_group"]
            valid = df[col].notna() & ~df[col].astype(str).str.strip().isin(['', 'nan', 'None'])
            df.loc[valid, '_first_group'] = df.loc[valid, col].astype(str).str.strip()

        # 9) TAC字段处理（数值转换）
        df['_tac'] = None
        if "tac" in mapped_columns:
            tac_col = mapped_columns["tac"]
            tac_num = pd.to_numeric(df[tac_col], errors='coerce')
            numeric_mask = tac_num.notna()
            df.loc[numeric_mask, '_tac'] = tac_num.loc[numeric_mask].astype(int)
            non_num_non_null = df[tac_col].notna() & ~numeric_mask
            df.loc[non_num_non_null, '_tac'] = df.loc[non_num_non_null, tac_col].astype(str).str.strip()

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
        self, file: Optional[Any], original_path: Optional[str] = None
    ) -> Dict[str, str]:
        """上传地图文件（支持 MapInfo 图层文件）"""
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

        # 检测文件类型
        is_mapinfo = filename.lower().endswith((".mif", ".tab", ".dat"))
        is_zip = filename.lower().endswith(".zip")

        # 处理 ZIP 文件（离线地图或 MapInfo 包）
        if is_zip:
            import zipfile
            import shutil

            # 保留原始 ZIP 文件以便下载
            original_zip = data_dir / "original.zip"
            shutil.copy(file_path, original_zip)

            with zipfile.ZipFile(file_path, "r") as zip_ref:
                zip_ref.extractall(data_dir)

            # 检查解压后的文件是否为 MapInfo（递归搜索子目录）
            extracted_files = list(data_dir.rglob("*"))
            has_mapinfo = any(
                f.suffix.lower() in [".mif", ".tab"]
                for f in extracted_files
                if f.is_file()
            )

            if has_mapinfo:
                # 解析 MapInfo 图层
                from app.services.mapinfo_service import parse_mapinfo_files
                import json

                try:
                    layers = parse_mapinfo_files(data_dir, parent_id=data_id)
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
                    "status": "ready",
                    "metadata": {
                        "fileCount": len(extracted_files),
                        "layerCount": len(layers),
                        "layers": layers,
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
            shutil.copy(file_path, target_file)

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

            # 检查 .tab 和 .dat 文件是否存在（忽略大小写）
            tab_extensions = [".tab", ".TAB", ".Tab"]
            dat_extensions = [".dat", ".DAT", ".Dat"]

            tab_file = find_file_ignore_case(data_dir, stem, tab_extensions)
            dat_file = find_file_ignore_case(data_dir, stem, dat_extensions)

            has_required_files = True
            missing_files = []

            # 检查 .tab 文件是否存在
            if not tab_file:
                has_required_files = False
                missing_files.append(f"{stem}.tab")

            # 检查 .dat 文件是否存在（关键文件！）
            if not dat_file:
                has_required_files = False
                missing_files.append(f"{stem}.dat (关键文件)")

            # 🔧 自动复制关联文件（优先级：original_path > uploads 目录）
            if missing_files and original_path:
                # 方式1: 从原始路径（Electron 桌面模式）
                try:
                    original_dir = os.path.dirname(original_path)
                    print(f"[DataService] 🔍 检查关联文件: 目录={original_dir}, 基名={stem}")

                    # 所有可能的 MapInfo 关联文件后缀
                    all_extensions = [
                        ".dat", ".DAT",
                        ".map", ".MAP",
                        ".id", ".ID",
                        ".ind", ".IND",
                        ".mid", ".MID"
                    ]

                    copied_count = 0
                    for ext in all_extensions:
                        # 尝试多种大小写组合
                        for ext_variant in [ext.lower(), ext.upper(), ext]:
                            sibling_path = os.path.join(original_dir, f"{stem}{ext_variant}")
                            if os.path.exists(sibling_path):
                                target_sibling = data_dir / os.path.basename(sibling_path)
                                if not target_sibling.exists():
                                    shutil.copy2(sibling_path, target_sibling)
                                    print(f"[DataService] ✅ 已复制关联文件: {os.path.basename(sibling_path)}")
                                    copied_count += 1

                                    # 更新文件存在状态
                                    if ext_variant.lower() == ".dat" and any(".dat" in f for f in missing_files):
                                        missing_files = [f for f in missing_files if ".dat" not in f.lower()]
                                    if ext_variant.lower() == ".tab" and any(".tab" in f for f in missing_files):
                                        missing_files = [f for f in missing_files if ".tab" not in f.lower()]
                                break  # 找到一个就跳过其他大小写变体

                    print(f"[DataService] 📊 共复制 {copied_count} 个关联文件")

                except Exception as e:
                    print(f"[DataService] ⚠️ 从原始路径复制关联文件失败: {e}")

            # 如果仍然缺少文件，尝试从 uploads 目录查找
            if missing_files:
                try:
                    uploads_dir = settings.UPLOAD_DIR
                    print(f"[DataService] 🔍 尝试从 uploads 目录查找关联文件: {uploads_dir}")

                    all_extensions = [
                        ".dat", ".DAT",
                        ".map", ".MAP",
                        ".id", ".ID",
                        ".ind", ".IND",
                        ".mid", ".MID"
                    ]

                    for ext in all_extensions:
                        for ext_variant in [ext.lower(), ext.upper(), ext]:
                            sibling_path = uploads_dir / f"{stem}{ext_variant}"
                            if sibling_path.exists():
                                target_sibling = data_dir / sibling_path.name
                                if not target_sibling.exists():
                                    shutil.copy2(sibling_path, target_sibling)
                                    print(f"[DataService] ✅ 从 uploads 复制: {sibling_path.name}")

                                    # 更新文件存在状态
                                    if ext_variant.lower() == ".dat":
                                        missing_files = [f for f in missing_files if ".dat" not in f.lower()]
                                    if ext_variant.lower() == ".tab":
                                        missing_files = [f for f in missing_files if ".tab" not in f.lower()]

                except Exception as e:
                    print(f"[DataService] ⚠️ 从 uploads 目录复制关联文件失败: {e}")

            # 检查是否仍然缺少关键文件
            if missing_files:
                print(f"[DataService] ❌ 缺少关键文件: {missing_files}")
                raise ValueError(
                    f"MapInfo 文件缺少配套文件，无法正确解析。\n"
                    f"缺少文件: {', '.join(missing_files)}\n\n"
                    f"MapInfo TAB 格式需要以下配套文件：\n"
                    f"  • {stem}.tab - 表结构定义\n"
                    f"  • {stem}.dat - 实际数据（必需！）\n"
                    f"  • {stem}.map - 样式定义（可选）\n"
                    f"  • {stem}.id - 索引文件（可选）\n\n"
                    f"解决方案：\n"
                    f"  1. 上传所有配套文件（推荐）\n"
                    f"  2. 或打包成 ZIP 文件上传（最佳）"
                )

            # 重新检查文件是否都已复制成功
            tab_file = find_file_ignore_case(data_dir, stem, [".tab", ".TAB"])
            dat_file = find_file_ignore_case(data_dir, stem, [".dat", ".DAT"])

            print(f"[DataService] 📁 文件检查结果:")
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
            from app.services.mapinfo_service import parse_mapinfo_files

            try:
                layers = parse_mapinfo_files(target_file, parent_id=data_id)
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
                "status": "ready",
                "metadata": {
                    "fileCount": 1,
                    "layerCount": len(layers),
                    "layers": layers,
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
                # 确保必填字段存在
                if "size" not in data_copy:
                    data_copy["size"] = 0
                if "uploadDate" not in data_copy:
                    data_copy["uploadDate"] = datetime.now().isoformat()
                # 如果数据已被应用 PCI/TAC，在文件名后添加后缀（保持原始格式）
                if data_copy.get("inplace_updated"):
                    suffixes = []
                    if data_copy.get("applied_pci"):
                        suffixes.append("PCI已更新")
                    if data_copy.get("applied_tac"):
                        suffixes.append("TAC已更新")
                    if suffixes:
                        import re as _re
                        name = data_copy.get("name", "")
                        name_part, ext_part = os.path.splitext(name) if "." in name else (name, "")
                        clean_name = _re.sub(r"_(PCI已更新|TAC已更新)+$", "", name_part)
                        data_copy["name"] = f"{clean_name}_{'_'.join(suffixes)}{ext_part}"
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

            return None
        else:
            # 地图文件返回文件列表（递归搜索子目录）
            data_dir = settings.DATA_DIR / data_id
            files = list(data_dir.rglob("*")) if data_dir.exists() else []
            return {"files": [str(f.relative_to(data_dir)) for f in files if f.is_file()]}

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
