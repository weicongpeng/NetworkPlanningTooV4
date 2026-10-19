"""任务索引瘦身：结果外置 + 旧版大索引后台拆分。

背景：历史实现把每个任务的完整 result 一并写进 outputs/tasks_index.json，生产上该
文件已达 271 MB / 267 条，而 TaskManager 在**模块导入时**构造并整份解析它（实测
+6 秒以上，Windows 冻结包更久），直接拖慢桌面端启动与切运行模式重启。

这里覆盖三条硬约束：
1. 构造 TaskManager 时不得解析旧版大索引（启动路径必须秒回）
2. 拆分后索引不含 result、结果落到 sidecar，且仍能按需取回
3. sidecar 缺失时回退 SQLite（PCI/邻区/TAC 类历史任务的兜底路径）
"""
from __future__ import annotations

import json
import time

import pytest


def _legacy_entry(task_id: str, task_type: str, result: dict) -> dict:
    return {
        "task_id": task_id,
        "task_type": task_type,
        "config": {"networkType": "LTE"},
        "status": "completed",
        "progress": 100.0,
        "result": result,
        "error": None,
        "task_name": f"t-{task_id[:4]}",
        "user_name": "alice",
        "city": "广州",
        "operator": "移动",
        "created_at": "2026-01-01T00:00:00",
        "started_at": "2026-01-01T00:00:01",
        "completed_at": "2026-01-01T00:00:02",
    }


def _write_legacy_index(path, count: int = 4, blob: str = "x" * 3_000_000):
    """造一个体积超过 LEGACY_INDEX_SIZE_LIMIT 的旧版索引。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        f"{n:08d}-0000-0000-0000-000000000000": _legacy_entry(
            f"{n:08d}-0000-0000-0000-000000000000",
            "buffer" if n % 2 else "pci",
            {"status": "completed", "results": [{"blob": blob}]},
        )
        for n in range(count)
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


@pytest.fixture()
def index_env(tmp_path, monkeypatch):
    from app.core.config import settings
    from app.services.task_manager import TaskManager

    out_dir = tmp_path / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "OUTPUT_DIR", out_dir, raising=False)
    return {"manager_cls": TaskManager, "out_dir": out_dir, "path": out_dir / "tasks_index.json"}


def test_construct_skips_parsing_legacy_index(index_env):
    """旧版大索引：构造 TaskManager 不得解析它，只打标记等调用方决定时机。"""
    legacy = _write_legacy_index(index_env["path"])
    assert index_env["path"].stat().st_size > index_env["manager_cls"].LEGACY_INDEX_SIZE_LIMIT

    started = time.monotonic()
    manager = index_env["manager_cls"]()
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, f"构造耗时 {elapsed:.2f}s，说明仍然解析了旧索引"
    assert manager._index_migration_pending is True
    assert manager.tasks == {}
    # 原文件必须原样保留（进程中途被杀时下次启动还能重试）
    assert index_env["path"].stat().st_size > index_env["manager_cls"].LEGACY_INDEX_SIZE_LIMIT
    assert not (index_env["out_dir"] / "task_results").exists()
    assert len(legacy) == 4


def test_migration_splits_results_into_sidecars(index_env):
    """拆分后：索引只剩元数据，结果落 sidecar，仍能按需取回且只读一次盘。"""
    legacy = _write_legacy_index(index_env["path"])
    manager = index_env["manager_cls"]()

    assert manager.migrate_legacy_index_if_needed() is True
    assert manager._index_migration_pending is False

    index = json.loads(index_env["path"].read_text(encoding="utf-8"))
    assert set(index) == set(legacy)
    assert all("result" not in entry for entry in index.values())
    assert index_env["path"].stat().st_size < index_env["manager_cls"].LEGACY_INDEX_SIZE_LIMIT

    sidecars = sorted((index_env["out_dir"] / "task_results").glob("*.json"))
    assert len(sidecars) == len(legacy)

    # 迁移时结果就在手上，顺手留在内存里，不必再读一次盘
    task_id = next(iter(legacy))
    assert manager.tasks[task_id].result == legacy[task_id]["result"]
    assert manager.tasks[task_id]._result_pending is False

    # 重启后（索引已是元数据格式）才走「按需装载」
    reloaded = index_env["manager_cls"]()
    assert reloaded.tasks[task_id].result is None
    assert reloaded.tasks[task_id]._result_pending is True
    assert reloaded.get_task_result(task_id) == legacy[task_id]["result"]
    assert reloaded.tasks[task_id]._result_pending is False
    # 已缓存：再取一次不再读盘
    assert reloaded.get_task_result(task_id) == legacy[task_id]["result"]


def test_metadata_only_index_loads_inline(index_env):
    """已经是元数据格式（体积小于阈值）时：构造时正常恢复，不触发迁移。"""
    legacy = _write_legacy_index(index_env["path"], count=2, blob="x" * 10)
    manager = index_env["manager_cls"]()
    manager.migrate_legacy_index_if_needed()

    fresh = index_env["manager_cls"]()
    assert fresh._index_migration_pending is False
    assert set(fresh.tasks) == set(legacy)
    assert fresh.tasks[next(iter(legacy))]._result_pending is True
    # 结果仍可从 sidecar 取回
    assert fresh.get_task_result(next(iter(legacy))) == legacy[next(iter(legacy))]["result"]


def test_result_falls_back_to_sqlite_when_sidecar_missing(index_env, monkeypatch):
    """sidecar 缺失（存量任务/写入失败）时回退 SQLite task_results。"""
    legacy = _write_legacy_index(index_env["path"], count=1)
    manager = index_env["manager_cls"]()
    manager.migrate_legacy_index_if_needed()

    task_id = next(iter(legacy))
    for sidecar in (index_env["out_dir"] / "task_results").glob("*.json"):
        sidecar.unlink()

    db_payload = {"status": "completed", "results": [{"from": "sqlite"}]}
    monkeypatch.setattr(
        manager, "get_task_result_from_db", lambda tid: db_payload if tid == task_id else None
    )
    # 重新装载内存任务，模拟重启
    manager.tasks.clear()
    manager._load_tasks_index()

    assert manager.get_task_result(task_id) == db_payload


def test_persist_writes_sidecar_and_metadata_index(index_env):
    """新完成的任务：结果写 sidecar，索引条目里不含 result。"""
    manager = index_env["manager_cls"]()
    from app.models.schemas import NetworkType
    from app.services.task_manager import Task, TaskStatus, TaskType

    task = Task(TaskType.PCI, {"network_type": NetworkType.LTE}, task_name="n1")
    task.status = TaskStatus.COMPLETED
    task.result = {"status": "completed", "results": [{"siteId": "S1"}]}
    manager.tasks[task.task_id] = task

    manager._persist_task(task.task_id)

    index = json.loads(index_env["path"].read_text(encoding="utf-8"))
    assert "result" not in index[task.task_id]
    sidecar = index_env["out_dir"] / "task_results" / f"{task.task_id}.json"
    assert json.loads(sidecar.read_text(encoding="utf-8")) == task.result


def test_singleton_index_path_follows_settings(tmp_path, monkeypatch):
    """单例的索引路径必须每次取当前 settings.OUTPUT_DIR，不能在导入时定死。

    定死的话，测试里 `TestClient(create_app())` 跑到的 lifespan 会拿着**生产**路径去
    拆分生产索引（同类历史事故：单例固化路径导致测试写生产数据）。真实发生过一次：
    跑测试时把仓库 outputs/tasks_index.json 就地拆分了。
    """
    from app.core.config import settings
    from app.services.task_manager import task_manager

    monkeypatch.setattr(settings, "OUTPUT_DIR", tmp_path, raising=False)
    assert task_manager._tasks_index_file == tmp_path / "tasks_index.json"
    assert task_manager._result_sidecar_dir == tmp_path / "task_results"


def test_server_lifespan_migrates_only_the_configured_dir(tmp_path, monkeypatch):
    """服务器形态 lifespan 触发的拆分只能落在当前 OUTPUT_DIR 里。"""
    from app.core.config import settings
    from app.services.task_manager import task_manager

    out_dir = tmp_path / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "OUTPUT_DIR", out_dir, raising=False)
    monkeypatch.setattr(task_manager, "_index_migration_pending", False)
    task_manager.tasks.clear()

    _write_legacy_index(out_dir / "tasks_index.json")
    assert task_manager._tasks_index_file == out_dir / "tasks_index.json"

    # 走真实路径：启动时只打标记（不解析），由 lifespan 再调迁移
    task_manager._load_tasks_index()
    assert task_manager._index_migration_pending is True
    assert task_manager.migrate_legacy_index_if_needed() is True
    assert (out_dir / "task_results").is_dir()
    assert all(
        "result" not in entry
        for entry in json.loads((out_dir / "tasks_index.json").read_text(encoding="utf-8")).values()
    )


def test_delete_task_removes_sidecar(index_env):
    """删除任务要连结果文件一起清掉，别留垃圾占磁盘。"""
    manager = index_env["manager_cls"]()
    from app.models.schemas import NetworkType
    from app.services.task_manager import Task, TaskStatus, TaskType

    task = Task(TaskType.PCI, {"network_type": NetworkType.LTE})
    task.status = TaskStatus.COMPLETED
    task.result = {"status": "completed", "results": []}
    manager.tasks[task.task_id] = task
    manager._persist_task(task.task_id)
    sidecar = index_env["out_dir"] / "task_results" / f"{task.task_id}.json"
    assert sidecar.is_file()

    assert manager.delete_task(task.task_id) is True
    assert not sidecar.exists()
