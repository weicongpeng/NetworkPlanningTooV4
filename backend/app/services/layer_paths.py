"""图层源文件路径解析（跨机器 / 跨数据根可移植）。

历史背景
--------
`layers.json` / `index.json` / SQLite `layers` 表里的 `metadata.source_file`
历史上记录的是**写盘机器上的绝对路径**：

- 桌面端（共享模式）导入的图层推到服务器后，服务器上的 layers.json 里仍是
  `C:\\Users\\...\\data\\<id>\\a.tab`；
- 服务器（网页端）导入的图层拉到桌面端后，路径又变成 `/home/.../data/<id>/a.tab`；
- 桌面端从旧版平铺数据根迁到 `profiles/shared/` 后，旧绝对路径也全部失效。

绝对路径只在写入它的那台机器 / 那个数据根下有效，换端后必然报
「图层源文件不存在」。本模块统一按「先信记录、再按文件名在当前 data_dir 内找」
的顺序解析，并在装包 / 保存时把路径校正为当前机器的真实路径。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# 可作为图层源文件的后缀（与 mapinfo_service.LAYER_SOURCE_EXTS 保持一致）
LAYER_SOURCE_EXTS = (".tab", ".mif", ".kml", ".shp", ".geojson", ".json")

# layers.json 同目录下不是图层的元数据/缓存文件
_NON_LAYER_NAMES = {"layers.json", "meta.json", "index.json"}


def _as_text(value: Any) -> str:
    return str(value or "").strip()


def _basename(raw: str) -> str:
    """取路径末段文件名，同时兼容 Windows 反斜杠与 POSIX 斜杠。

    在 Linux 上 `Path("C:\\Users\\a.tab").name` 会得到整串（反斜杠不是分隔符），
    故这里先统一替换分隔符再取末段。
    """
    return _as_text(raw).replace("\\", "/").rsplit("/", 1)[-1]


def _scan_files(data_dir: Path) -> List[Path]:
    """列出数据目录内全部文件（图层文件通常很少，直接 rglob）。"""
    try:
        return [f for f in data_dir.rglob("*") if f.is_file()]
    except OSError:
        return []


def _match_file(files: Iterable[Path], data_dir: Path, filename: str) -> Optional[Path]:
    """在已扫描的文件列表中按文件名（大小写不敏感）匹配，优先数据根直属文件。"""
    if not filename:
        return None
    target = filename.lower()
    direct = data_dir / filename
    try:
        if direct.is_file():
            return direct
    except OSError:
        pass
    hits = [f for f in files if f.name.lower() == target]
    if not hits:
        return None
    # 直属文件优先，避免 zip 解压多目录时命中同名副本
    hits.sort(key=lambda f: (f.parent != data_dir, len(f.parts)))
    return hits[0]


def _match_by_stem(files: Iterable[Path], data_dir: Path, stem: str) -> Optional[Path]:
    """按 stem 匹配图层源文件（容忍上传后后缀大小写/格式变化）。"""
    if not stem:
        return None
    target = stem.lower()
    for ext in LAYER_SOURCE_EXTS:
        hit = _match_file(files, data_dir, f"{stem}{ext}")
        if hit is not None:
            return hit
    hits = [
        f for f in files
        if f.stem.lower() == target
        and f.suffix.lower() in LAYER_SOURCE_EXTS
        and f.name.lower() not in _NON_LAYER_NAMES
    ]
    if not hits:
        return None
    hits.sort(key=lambda f: (f.parent != data_dir, len(f.parts)))
    return hits[0]


def resolve_layer_source_path(data_dir: Path, entry: Dict[str, Any]) -> Optional[Path]:
    """定位图层源文件：优先记录路径，失效时在当前数据目录内按文件名/图层名回退。

    绝不因为记录的是别的机器的绝对路径就直接失败——这正是跨端同步后
    「图层源文件不存在」的根因。
    """
    data_dir = Path(data_dir)
    if not data_dir.exists():
        return None

    metadata = entry.get("metadata") or {}
    raw = _as_text(
        metadata.get("source_file")
        or metadata.get("sourceFile")
        or entry.get("file_path")
        or entry.get("file")
        or ""
    )
    files: Optional[List[Path]] = None

    def _files() -> List[Path]:
        nonlocal files
        if files is None:
            files = _scan_files(data_dir)
        return files

    if raw:
        candidate = Path(raw)
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            pass
        # 相对路径按数据目录解析（未来若改存相对路径也兼容）
        if not candidate.is_absolute():
            try:
                rel = data_dir / raw.replace("\\", "/")
                if rel.is_file():
                    return rel
            except OSError:
                pass
        # 记录路径里的子目录结构（如 zip 解压出的 sub/a.tab）在各端一致：
        # 取 <data_id>/ 之后的相对段，可在同名文件并存时精确定位。
        normalized = _as_text(raw).replace("\\", "/")
        marker = f"/{data_dir.name}/"
        pos = normalized.find(marker)
        if pos >= 0:
            tail = normalized[pos + len(marker):]
            if tail:
                try:
                    rel_candidate = data_dir / tail
                    if rel_candidate.is_file():
                        return rel_candidate
                except OSError:
                    pass
        base = _basename(raw)
        hit = _match_file(_files(), data_dir, base)
        if hit is not None:
            return hit
        stem = Path(base).stem
        hit = _match_by_stem(_files(), data_dir, stem)
        if hit is not None:
            return hit

    name = _as_text(entry.get("name"))
    if name:
        hit = _match_file(_files(), data_dir, name)
        if hit is not None:
            return hit
        hit = _match_by_stem(_files(), data_dir, Path(name).stem)
        if hit is not None:
            return hit
    return None


def layer_source_suffix(entry: Dict[str, Any]) -> str:
    """图层条目记录的原后缀（小写，兼容 Windows 路径），用于判定可编辑格式。"""
    metadata = entry.get("metadata") or {}
    raw = _as_text(
        metadata.get("source_file")
        or metadata.get("sourceFile")
        or entry.get("file_path")
        or ""
    )
    return Path(_basename(raw)).suffix.lower()


def read_layers_file(data_dir: Path) -> List[Dict[str, Any]]:
    """读取 layers.json（不存在/损坏返回空列表）。"""
    path = Path(data_dir) / "layers.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def write_layers_file(data_dir: Path, layers: List[Dict[str, Any]]) -> None:
    path = Path(data_dir) / "layers.json"
    path.write_text(json.dumps(layers, ensure_ascii=False, indent=2), encoding="utf-8")


def rebase_layer_entries(
    data_dir: Path,
    entries: Optional[List[Dict[str, Any]]] = None,
    *,
    persist: bool = True,
) -> Tuple[List[Dict[str, Any]], bool]:
    """把图层条目的 source_file 校正为当前数据目录下的真实路径。

    Returns:
        (校正后的条目列表, 是否有改动)
    """
    data_dir = Path(data_dir)
    layers = list(entries if entries is not None else read_layers_file(data_dir))
    changed = False
    for entry in layers:
        if not isinstance(entry, dict):
            continue
        resolved = resolve_layer_source_path(data_dir, entry)
        if resolved is None:
            continue
        metadata = entry.setdefault("metadata", {})
        current = _as_text(metadata.get("source_file"))
        new_value = str(resolved)
        if current != new_value:
            metadata["source_file"] = new_value
            changed = True
    if persist and changed:
        write_layers_file(data_dir, layers)
    return layers, changed


    db = SessionLocal()
    try:
        for layer in layers:
            layer_id = layer.get("id") or layer.get("layer_id")
            source = (layer.get("metadata") or {}).get("source_file")
            if not layer_id or not source:
                continue
            db.query(Layer).filter(Layer.id == layer_id).update({"file_path": str(source)})
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
