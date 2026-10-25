#!/usr/bin/env python3
"""NPT 磁盘清理（默认只预览，不删除）。

安全分级：
- 默认（safe）：临时上传残留、过期导出、无引用上传/数据目录、可回退的结果备份、
  孤儿结果行、旧数据库备份、WAL checkpoint。
- --releases：按版本保留桌面安装包（默认 3 份）。
- --tasks：按天数和条数保留历史任务（默认 90 天 / 300 条，只会删更老的）。
- --dev：Playwright 控制台日志、项目 __pycache__、.pytest_cache、Vite 缓存。
- --vacuum：回收 SQLite 空洞；需后端已停止且磁盘有足够余量。

示例：
  python scripts/npt_disk_cleanup.py                  # 预览
  python scripts/npt_disk_cleanup.py --apply          # 执行安全清理
  python scripts/npt_disk_cleanup.py --apply --releases --keep-releases 3
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DAY = 86400


@dataclass
class Candidate:
    category: str
    path: Path
    size: int
    detail: str = ""
    is_dir: bool = False


@dataclass
class CleanupPlan:
    files: list[Candidate] = field(default_factory=list)
    task_ids: list[str] = field(default_factory=list)
    task_rows: list[tuple] = field(default_factory=list)
    release_rows: list[tuple] = field(default_factory=list)
    apk_rows: list[tuple] = field(default_factory=list)
    row_index_rows: list[tuple] = field(default_factory=list)
    row_index_estimate: int = 0
    notes: list[str] = field(default_factory=list)

    def add(self, item: Candidate) -> None:
        self.files.append(item)


def _size(path: Path) -> int:
    try:
        if path.is_file():
            return path.stat().st_size
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    except OSError:
        return 0


def _age_days(path: Path) -> float:
    try:
        return (time.time() - path.stat().st_mtime) / DAY
    except OSError:
        return 0.0


def _older(path: Path, days: float) -> bool:
    return _age_days(path) >= days


def _is_uuid_like(name: str) -> bool:
    parts = name.split("-")
    return len(parts) == 5 and [len(p) for p in parts] == [8, 4, 4, 4, 12]


def _version_key(version: str) -> tuple:
    parts = re.split(r"[.\-_+]", (version or "").strip())
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts)


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _load_json(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def resolve_roots(root_arg: Optional[str]) -> tuple[Path, Path, bool]:
    """返回 (全局数据根, 当前业务档根, 是否桌面形态)。"""
    env_root = os.environ.get("NPT_DATA_ROOT")
    root = Path(root_arg or env_root or REPO_ROOT)
    desktop = os.environ.get("NPT_DESKTOP", "").strip().lower() in ("1", "true", "yes")
    if not desktop:
        return root, root, False
    profile = os.environ.get("NPT_DESKTOP_PROFILE", "shared").strip().lower()
    if profile not in ("shared", "standalone"):
        profile = "shared"
    return root, root / "profiles" / profile, True


def open_db(path: Path, readonly: bool = False) -> Optional[sqlite3.Connection]:
    if not path.is_file():
        return None
    try:
        if readonly:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        else:
            conn = sqlite3.connect(str(path), timeout=10)
        conn.execute("PRAGMA busy_timeout=5000")
        return conn
    except sqlite3.Error as exc:
        print(f"[warn] 无法打开数据库 {path}: {exc}")
        return None


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "select 1 from sqlite_master where type='table' and name=?", (name,)
    ).fetchone()
    return row is not None


def load_references(conn: Optional[sqlite3.Connection], data_dir: Path) -> tuple[set, set]:
    """返回 (上传文件 stem 集合, data 目录名集合)。"""
    upload_refs: set[str] = set(_load_json(data_dir / "index.json").keys())
    data_refs: set[str] = set(_load_json(data_dir / "index.json").keys())
    if conn is None:
        return upload_refs, data_refs
    tables = {
        row[0] for row in conn.execute("select name from sqlite_master where type='table'")
    }
    if "workbooks" in tables:
        for row in conn.execute("select id, original_path from workbooks"):
            upload_refs.add(str(row[0]))
            if row[1]:
                upload_refs.add(Path(str(row[1])).stem)
    if "geo_files" in tables:
        for row in conn.execute("select id, file_path from geo_files"):
            upload_refs.add(str(row[0]))
            if row[1]:
                p = Path(str(row[1]))
                upload_refs.add(p.stem)
                data_refs.add(p.parent.name)
    if "layers" in tables:
        for row in conn.execute("select id, file_path from layers"):
            upload_refs.add(str(row[0]))
            if row[1]:
                data_refs.add(Path(str(row[1])).parent.name)
    return upload_refs, data_refs


def collect_temp(upload_dir: Path, output_dir: Path, export_days: int) -> list[Candidate]:
    items: list[Candidate] = []
    for sub in ("layer_tmp", "distance_tmp"):
        base = upload_dir / sub
        if not base.is_dir():
            continue
        for path in base.glob("src_*"):
            if path.is_file() and _older(path, 1):
                items.append(Candidate("temp", path, _size(path), "分块上传残留"))
    for path in upload_dir.glob("chunks_*"):
        if path.is_dir() and _older(path, 7):
            items.append(Candidate("temp", path, _size(path), "过期分块目录", is_dir=True))
    for path in upload_dir.glob("tmp*"):
        if path.is_dir() and _older(path, 7):
            items.append(Candidate("temp", path, _size(path), "临时目录", is_dir=True))
    # 导出下载缓存（可重新生成）
    for path in output_dir.glob("*.xlsx"):
        if path.is_file() and _older(path, export_days):
            items.append(Candidate("temp", path, _size(path), "旧导出文件"))
    for path in output_dir.glob("*.csv"):
        if path.is_file() and _older(path, export_days):
            items.append(Candidate("temp", path, _size(path), "旧导出文件"))
    return items


def collect_exports(export_dir: Path, days: int) -> list[Candidate]:
    if not export_dir.is_dir():
        return []
    return [
        Candidate("exports", p, _size(p), "过期导出（可重新生成）")
        for p in export_dir.rglob("*")
        if p.is_file() and _older(p, days)
    ]


def collect_orphan_uploads(upload_dir: Path, refs: set[str], days: int) -> list[Candidate]:
    if not upload_dir.is_dir():
        return []
    items = []
    for path in upload_dir.iterdir():
        if not path.is_file() or _age_days(path) < days:
            continue
        if path.stem not in refs:
            items.append(Candidate("orphan-uploads", path, _size(path), "未被索引/数据库引用"))
    return items


def collect_orphan_data_dirs(data_dir: Path, refs: set[str], days: int) -> list[Candidate]:
    if not data_dir.is_dir():
        return []
    items = []
    for path in data_dir.iterdir():
        if not path.is_dir() or _age_days(path) < days:
            continue
        if path.name in refs:
            continue
        if _is_uuid_like(path.name) or path.name.startswith("_bench_"):
            items.append(Candidate("orphan-data", path, _size(path), "无引用的数据缓存目录", is_dir=True))
    return items


def collect_backups(data_dir: Path, days: int) -> list[Candidate]:
    candidates = sorted(
        [p for p in data_dir.glob("data.db.bak_*") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return [
        Candidate("backups", p, _size(p), "旧数据库备份")
        for p in candidates[1:]  # 保留最新一份
        if _older(p, days)
    ]


def collect_sidecars(
    output_dir: Path, task_ids_with_result: set[str], index_ids: set[str], days: int
) -> list[Candidate]:
    sidecar_dir = output_dir / "task_results"
    if not sidecar_dir.is_dir():
        return []
    items = []
    for path in sidecar_dir.glob("*.json"):
        if _age_days(path) < days:
            continue
        task_id = path.stem
        if task_id in task_ids_with_result:
            items.append(Candidate("sidecars", path, _size(path), "数据库已有完整结果副本"))
        elif task_id not in index_ids:
            items.append(Candidate("sidecars", path, _size(path), "任务索引与数据库均无记录"))
    return items


def collect_result_row_orphans(conn: Optional[sqlite3.Connection]) -> list[tuple[str, int]]:
    if conn is None:
        return []
    if not table_exists(conn, "task_result_rows"):
        return []
    rows = conn.execute(
        "select r.task_id, count(*) from task_result_rows r "
        "where not exists (select 1 from task_results t where t.task_id=r.task_id) "
        "group by r.task_id"
    ).fetchall()
    return [(str(task_id), int(count)) for task_id, count in rows]


def collect_releases(
    conn: Optional[sqlite3.Connection], releases_dir: Path, keep: int
) -> list[tuple[str, str, int, str]]:
    """返回 [(id, file_path, file_size, version)]。"""
    if conn is None or not table_exists(conn, "desktop_releases"):
        return []
    rows = conn.execute(
        "select id, version, channel, file_path, file_size, is_latest, created_at "
        "from desktop_releases"
    ).fetchall()
    rows = sorted(rows, key=lambda row: _version_key(str(row[1])), reverse=True)
    keep_ids: set[int] = set()
    per_channel: dict[str, int] = {}
    for row in rows:
        rid, _version, channel, _path, _size, is_latest, _created = row
        if is_latest:
            keep_ids.add(int(rid))
        count = per_channel.get(channel, 0)
        if count < keep:
            keep_ids.add(int(rid))
            per_channel[channel] = count + 1
    return [
        (str(row[0]), str(row[3]), int(row[4] or 0), str(row[1]))
        for row in rows
        if int(row[0]) not in keep_ids and row[3] and _within(Path(str(row[3])), releases_dir)
    ]


def collect_apk_chunks(apk_dirs: Iterable[Path]) -> list[Candidate]:
    items = []
    for base in apk_dirs:
        if not base.is_dir():
            continue
        for path in base.glob("chunks_*"):
            if path.is_dir() and _older(path, 1):
                items.append(Candidate("apk-temp", path, _size(path), "中断的 APK 分块上传残留", is_dir=True))
    return items


def collect_old_apks(
    conn: Optional[sqlite3.Connection], apk_dirs: list[Path], keep: int
) -> list[tuple[str, str, int, str]]:
    if conn is None or not table_exists(conn, "app_versions"):
        return []
    rows = conn.execute(
        "select id, version, apk_path, file_size, is_latest, created_at "
        "from app_versions"
    ).fetchall()
    rows = sorted(rows, key=lambda row: _version_key(str(row[1])), reverse=True)
    keep_ids: set[int] = set()
    for index, row in enumerate(rows):
        if row[4] or index < max(1, keep):
            keep_ids.add(int(row[0]))
    result = []
    for row in rows:
        rid, version, path_str, size, _latest, _created = row
        if int(rid) in keep_ids or not path_str:
            continue
        path = Path(str(path_str))
        if not any(_within(path, base) for base in apk_dirs):
            continue
        result.append((str(rid), str(path), int(size or 0), str(version)))
    return result


def collect_prunable_row_indexes(
    conn: Optional[sqlite3.Connection], days: int
) -> tuple[list[tuple[str, int]], int]:
    """返回 ([(task_id, row_count)], 估算字节数)。行索引是可重建的派生数据。"""
    if conn is None or not table_exists(conn, "task_result_rows") or not table_exists(conn, "task_results"):
        return [], 0
    total_rows = conn.execute("select count(*) from task_result_rows").fetchone()[0] or 0
    total_bytes = 0
    try:
        for _name, size in conn.execute(
            "select name, sum(pgsize) from dbstat where "
            "name='task_result_rows' or name like 'idx_task_result_rows_%' "
            "or name='task_result_source_groups' or name like 'idx_task_result_groups_%' "
            "group by name"
        ):
            total_bytes += int(size or 0)
    except sqlite3.Error:
        total_bytes = 0
    cutoff = time.time() - max(0, days) * DAY
    rows = conn.execute(
        "select r.task_id, count(*) from task_result_rows r "
        "join task_results t on t.task_id=r.task_id group by r.task_id"
    ).fetchall()
    selected = []
    for task_id, count in rows:
        created = conn.execute(
            "select created_at from task_results where task_id=?", (task_id,)
        ).fetchone()
        try:
            ts = datetime.fromisoformat(str(created[0]).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            ts = 0
        if ts < cutoff:
            selected.append((str(task_id), int(count)))
    selected_count = sum(c for _, c in selected)
    estimate = int(total_bytes * selected_count / total_rows) if total_rows else 0
    return selected, estimate


def collect_old_tasks(
    conn: Optional[sqlite3.Connection], days: int, keep: int
) -> tuple[list[str], list[tuple[str, str]]]:
    if conn is None or not table_exists(conn, "task_results"):
        return [], []
    heavy = ("pci", "neighbor", "tac", "tac_planning", "pci_check")
    rows = conn.execute(
        "select task_id, task_type, created_at from task_results "
        "where status='completed' order by created_at desc"
    ).fetchall()
    heavy_rows = [r for r in rows if r[1] in heavy]
    cutoff = time.time() - max(0, days) * DAY
    result: list[str] = []
    for index, (task_id, _task_type, created_at) in enumerate(heavy_rows):
        if index < max(0, keep):
            continue
        try:
            created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            ts = created.timestamp()
        except ValueError:
            ts = 0
        if ts < cutoff:
            result.append(str(task_id))
    return result, [(str(r[0]), str(r[1])) for r in heavy_rows]


def remove_index_entries(index_file: Path, task_ids: Iterable[str]) -> int:
    ids = set(task_ids)
    if not ids or not index_file.is_file():
        return 0
    data = _load_json(index_file)
    before = len(data)
    for task_id in ids:
        data.pop(task_id, None)
    removed = before - len(data)
    if removed:
        tmp = index_file.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, index_file)
    return removed


def checkpoint_db(conn: Optional[sqlite3.Connection], db_path: Path, vacuum: bool) -> None:
    if conn is None:
        return
    before = db_path.stat().st_size if db_path.exists() else 0
    wal = db_path.with_name(db_path.name + "-wal")
    wal_before = wal.stat().st_size if wal.exists() else 0
    if vacuum:
        try:
            with socket.create_connection(("127.0.0.1", 8000), timeout=0.5):
                print("[skip] 后端 8000 端口仍在监听，跳过 VACUUM；请停机后重试")
                return
        except OSError:
            pass
        free = shutil.disk_usage(db_path.parent).free
        if free < before * 1.2 + 256 * 1024 * 1024:
            print("[skip] 磁盘余量不足，跳过 VACUUM")
            return
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        if vacuum:
            conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    except sqlite3.Error as exc:
        print(f"[warn] SQLite 回收失败（可稍后重试）: {exc}")
        return
    after = db_path.stat().st_size if db_path.exists() else 0
    wal_after = wal.stat().st_size if wal.exists() else 0
    print(
        f"[db] data.db {before/1e6:.0f}MB -> {after/1e6:.0f}MB；"
        f"WAL {wal_before/1e6:.0f}MB -> {wal_after/1e6:.0f}MB"
    )


def collect_dev_caches(repo_root: Path) -> list[Candidate]:
    items = []
    playwright = repo_root / ".playwright-cli"
    if playwright.is_dir():
        items.append(Candidate("dev", playwright, _size(playwright), "Playwright 控制台日志", is_dir=True))
    for base in (repo_root / "backend" / "app", repo_root / "backend" / "tests",
                 repo_root / "desktop", repo_root / "scripts"):
        if not base.is_dir():
            continue
        for path in base.rglob("__pycache__"):
            if path.is_dir() and _within(path, base):
                items.append(Candidate("dev", path, _size(path), "Python 字节码缓存", is_dir=True))
    for path in (repo_root / ".pytest_cache", repo_root / "backend" / ".pytest_cache"):
        if path.is_dir():
            items.append(Candidate("dev", path, _size(path), "pytest 缓存", is_dir=True))
    vite_cache = repo_root / "frontend" / "node_modules" / ".vite"
    if vite_cache.is_dir():
        items.append(Candidate("dev", vite_cache, _size(vite_cache), "Vite 构建缓存", is_dir=True))
    return items


def build_plan(args) -> CleanupPlan:
    data_root, profile_root, _desktop = resolve_roots(args.root)
    data_dir = profile_root / "data"
    upload_dir = profile_root / "uploads"
    output_dir = profile_root / "outputs"
    export_dir = profile_root / "exports"
    releases_dir = data_root / "desktop_releases"
    apk_dirs = [data_root / "apks", REPO_ROOT / "backend" / "app" / "apks"]
    db_path = data_dir / "data.db"
    conn = open_db(db_path, readonly=True)
    index_ids = set(_load_json(output_dir / "tasks_index.json").keys())
    upload_refs, data_refs = load_references(conn, data_dir)

    plan = CleanupPlan()
    for item in collect_temp(upload_dir, output_dir, args.export_retention_days):
        plan.add(item)
    for item in collect_exports(export_dir, args.export_retention_days):
        plan.add(item)
    for item in collect_orphan_uploads(upload_dir, upload_refs, args.upload_retention_days):
        plan.add(item)
    for item in collect_orphan_data_dirs(data_dir, data_refs, args.data_retention_days):
        plan.add(item)
    for item in collect_backups(data_dir, args.backup_retention_days):
        plan.add(item)
    for item in collect_apk_chunks(apk_dirs):
        plan.add(item)

    task_ids_with_result: set[str] = set()
    if conn is not None and table_exists(conn, "task_results"):
        task_ids_with_result = {
            str(row[0]) for row in conn.execute(
                "select task_id from task_results where result_json is not null"
            )
        }
    for item in collect_sidecars(
        output_dir, task_ids_with_result, index_ids, args.sidecar_retention_days
    ):
        plan.add(item)

    plan.task_rows = collect_result_row_orphans(conn)
    if args.releases:
        plan.release_rows = collect_releases(conn, releases_dir, args.keep_releases)
        for path in releases_dir.glob("chunks_*"):
            if path.is_dir() and _older(path, 1):
                plan.add(Candidate("releases", path, _size(path), "中断安装包上传残留", is_dir=True))
    if args.apks:
        plan.apk_rows = collect_old_apks(conn, apk_dirs, args.keep_apks)
    if args.prune_row_indexes:
        plan.row_index_rows, plan.row_index_estimate = collect_prunable_row_indexes(
            conn, args.row_index_retention_days
        )
    if args.tasks:
        plan.task_ids, _all = collect_old_tasks(conn, args.task_retention_days, args.keep_tasks)
    if args.dev:
        for item in collect_dev_caches(REPO_ROOT):
            plan.add(item)

    plan.notes.append(f"data={data_dir} uploads={upload_dir} outputs={output_dir}")
    if db_path.is_file():
        wal = db_path.with_name(db_path.name + "-wal")
        plan.notes.append(
            f"data.db={db_path.stat().st_size/1e6:.0f}MB "
            f"WAL={(wal.stat().st_size/1e6 if wal.is_file() else 0):.0f}MB"
        )
    return plan


def print_plan(plan: CleanupPlan, args) -> None:
    by_category: dict[str, list[Candidate]] = {}
    for item in plan.files:
        by_category.setdefault(item.category, []).append(item)
    total = sum(item.size for item in plan.files)
    print("类别                 数量      可释放")
    print("-" * 42)
    for category, items in sorted(by_category.items()):
        print(f"{category:<18} {len(items):>5}  {sum(i.size for i in items)/1e6:>9.1f} MB")
    if plan.task_rows:
        print(f"{'orphan-result-rows':<18} {len(plan.task_rows):>5}  (数据库行)")
    if plan.release_rows:
        print(f"{'old-releases':<18} {len(plan.release_rows):>5}  "
              f"{sum(r[2] for r in plan.release_rows)/1e6:>9.1f} MB")
    if plan.apk_rows:
        print(f"{'old-apks':<18} {len(plan.apk_rows):>5}  "
              f"{sum(r[2] for r in plan.apk_rows)/1e6:>9.1f} MB")
    if plan.row_index_rows:
        print(f"{'row-indexes':<18} {len(plan.row_index_rows):>5}  "
              f"{plan.row_index_estimate/1e6:>9.1f} MB (可重建)")
    if plan.task_ids:
        print(f"{'old-tasks':<18} {len(plan.task_ids):>5}  (结果/索引/导出，不可恢复)")
    print("-" * 42)
    policy_total = (
        sum(r[2] for r in plan.release_rows)
        + sum(r[2] for r in plan.apk_rows)
        + plan.row_index_estimate
    )
    print(f"文件合计约 {total/1e6:.1f} MB；策略项合计（安装包/可重建索引估算）约 "
          f"{policy_total/1e6:.1f} MB；总计约 {(total + policy_total)/1e6:.1f} MB")
    if args.verbose:
        for category, items in sorted(by_category.items()):
            for item in sorted(items, key=lambda i: -i.size)[:15]:
                print(f"  [{category}] {item.size/1e6:8.2f}MB {item.path} ({item.detail})")
    if plan.notes:
        print("路径: " + "；".join(plan.notes))


def apply_plan(plan: CleanupPlan, args) -> int:
    data_root, profile_root, _desktop = resolve_roots(args.root)
    data_dir = profile_root / "data"
    output_dir = profile_root / "outputs"
    export_dir = profile_root / "exports"
    releases_dir = data_root / "desktop_releases"
    db_path = data_dir / "data.db"
    freed = 0
    for item in plan.files:
        try:
            if item.is_dir:
                shutil.rmtree(item.path, ignore_errors=True)
            else:
                item.path.unlink(missing_ok=True)
            freed += item.size
        except OSError as exc:
            print(f"[warn] 删除失败 {item.path}: {exc}")

    conn = open_db(db_path)
    if conn is not None:
        try:
            if plan.task_rows:
                for task_id, _count in plan.task_rows:
                    conn.execute("delete from task_result_rows where task_id=?", (task_id,))
                    if table_exists(conn, "task_result_source_groups"):
                        conn.execute("delete from task_result_source_groups where task_id=?", (task_id,))
            if plan.release_rows:
                for rid, path_str, _size, _version in plan.release_rows:
                    path = Path(path_str)
                    if _within(path, releases_dir) and path.is_file():
                        path.unlink(missing_ok=True)
                        freed += _size
                    conn.execute("delete from desktop_releases where id=?", (rid,))
            if plan.apk_rows:
                for rid, path_str, _size, _version in plan.apk_rows:
                    path = Path(path_str)
                    if path.is_file() and any(
                        _within(path, base) for base in (data_root / "apks", REPO_ROOT / "backend" / "app" / "apks")
                    ):
                        path.unlink(missing_ok=True)
                        freed += _size
                    conn.execute("delete from app_versions where id=?", (rid,))
            if plan.row_index_rows:
                for task_id, _count in plan.row_index_rows:
                    conn.execute("delete from task_result_rows where task_id=?", (task_id,))
                    if table_exists(conn, "task_result_source_groups"):
                        conn.execute("delete from task_result_source_groups where task_id=?", (task_id,))
                    conn.execute("update task_results set rows_ready=0 where task_id=?", (task_id,))
            if plan.task_ids:
                for task_id in plan.task_ids:
                    conn.execute("delete from task_result_rows where task_id=?", (task_id,))
                    if table_exists(conn, "task_result_source_groups"):
                        conn.execute("delete from task_result_source_groups where task_id=?", (task_id,))
                    conn.execute("delete from task_results where task_id=?", (task_id,))
                    sidecar = output_dir / "task_results" / f"{task_id}.json"
                    if sidecar.is_file():
                        freed += _size(sidecar)
                        sidecar.unlink(missing_ok=True)
                    for factory in (output_dir.glob(f"{task_id}.*"),
                                    export_dir.glob(f"*{task_id}*")):
                        for path in factory:
                            if path.is_file():
                                freed += _size(path)
                                path.unlink(missing_ok=True)
                remove_index_entries(output_dir / "tasks_index.json", plan.task_ids)
            conn.commit()
        except sqlite3.Error as exc:
            conn.rollback()
            print(f"[warn] 数据库清理失败: {exc}")
        finally:
            conn.close()

    checkpoint_db(open_db(db_path), db_path, vacuum=args.vacuum)
    return freed


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="NPT 磁盘清理（默认 dry-run）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--root", default=None, help="数据根（默认 NPT_DATA_ROOT 或仓库根）")
    parser.add_argument("--apply", action="store_true", help="真正执行删除；默认只预览")
    parser.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    parser.add_argument("--verbose", action="store_true", help="列出明细")
    parser.add_argument("--releases", action="store_true", help="清理旧桌面安装包")
    parser.add_argument("--keep-releases", type=int, default=3, help="每个通道保留版本数")
    parser.add_argument("--apks", action="store_true", help="清理旧 APP 安装包")
    parser.add_argument("--keep-apks", type=int, default=2, help="保留 APK 版本数")
    parser.add_argument("--prune-row-indexes", action="store_true",
                        help="删除旧任务的派生行索引（保留任务与结果，可重建）")
    parser.add_argument("--row-index-retention-days", type=int, default=30)
    parser.add_argument("--tasks", action="store_true", help="按保留策略删除旧任务")
    parser.add_argument("--task-retention-days", type=int, default=90)
    parser.add_argument("--keep-tasks", type=int, default=300)
    parser.add_argument("--dev", action="store_true", help="清理开发/测试缓存")
    parser.add_argument("--vacuum", action="store_true", help="VACUUM 数据库（需停机）")
    parser.add_argument("--sidecar-retention-days", type=int, default=7,
                        help="结果备份保留天数；0=删除所有数据库已有副本的备份")
    parser.add_argument("--upload-retention-days", type=int, default=7)
    parser.add_argument("--data-retention-days", type=int, default=30)
    parser.add_argument("--export-retention-days", type=int, default=7)
    parser.add_argument("--backup-retention-days", type=int, default=30)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    plan = build_plan(args)
    print_plan(plan, args)
    if args.apply:
        freed = apply_plan(plan, args)
        print(f"[done] 已释放约 {freed/1e6:.1f} MB")
        if plan.row_index_rows or plan.task_ids:
            print("[note] 数据库内删除的空间需在后端停机后加 --vacuum 才会真正缩小 data.db")
    else:
        print("[dry-run] 未删除任何文件；加 --apply 执行")
    if args.json:
        print(json.dumps({
            "files": [{"category": i.category, "path": str(i.path), "size": i.size}
                      for i in plan.files],
            "task_ids": plan.task_ids,
            "release_rows": plan.release_rows,
            "apk_rows": plan.apk_rows,
            "row_index_rows": plan.row_index_rows,
            "result_row_orphans": plan.task_rows,
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
