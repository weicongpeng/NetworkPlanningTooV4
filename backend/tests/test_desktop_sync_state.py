"""桌面端同步状态机：运行模式、dirty 标记、删除传播。"""
from __future__ import annotations

import pytest

from app.core.config import settings


@pytest.fixture()
def sync_state(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    from app.services import desktop_sync_service as sync

    sync.save_state(run_mode=sync.MODE_OFFLINE, datasets={}, pending_deletes=[], conflicts=[])
    return sync


def test_default_mode_is_offline(sync_state):
    assert sync_state.run_mode() == sync_state.MODE_OFFLINE
    assert sync_state.is_shared() is False


def test_switch_mode_roundtrip(sync_state):
    assert sync_state.set_run_mode("shared") == sync_state.MODE_SHARED
    assert sync_state.is_shared() is True
    assert sync_state.set_run_mode("nonsense") == sync_state.MODE_OFFLINE


def test_mark_dirty_and_record_synced(sync_state):
    sync_state.record_synced("ds-1", 5)
    assert sync_state.load_state()["datasets"]["ds-1"] == {
        **sync_state.load_state()["datasets"]["ds-1"], "rev": 5, "dirty": False,
    }

    sync_state.mark_dirty("ds-1")
    assert sync_state.load_state()["datasets"]["ds-1"]["dirty"] is True
    assert sync_state.status()["pending_uploads"] == 1

    sync_state.record_synced("ds-1", 6)
    assert sync_state.status()["pending_uploads"] == 0


def test_local_delete_queues_pending_delete(sync_state):
    sync_state.record_synced("ds-2", 3)
    sync_state.mark_local_deleted("ds-2")
    state = sync_state.load_state()
    assert "ds-2" not in state["datasets"]
    assert state["pending_deletes"] == ["ds-2"]


def test_note_change_ignored_while_pulling(sync_state, monkeypatch):
    """装包（先删后插）引起的写入不算本地改动：否则刚拉下来的数据会被立刻
    标记 dirty，与服务器来回互相覆盖。"""
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    sync_state.set_run_mode(sync_state.MODE_SHARED)
    sync_state.record_synced("ds-8", 2)

    with sync_state._PullingGuard("ds-8"):
        sync_state.note_change("ds-8", deleted=True)
        sync_state.note_change("ds-8")

    state = sync_state.load_state()
    assert state["pending_deletes"] == []
    assert state["datasets"]["ds-8"]["dirty"] is False


def test_record_synced_clears_stale_delete_intent(sync_state):
    """pull 是「先删后插」：装包留下的本地删除意图必须清掉，否则下一轮会把刚
    拉下来的数据集又从服务器删掉。"""
    sync_state.mark_local_deleted("ds-7")
    assert sync_state.load_state()["pending_deletes"] == ["ds-7"]

    sync_state.record_synced("ds-7", 4)
    state = sync_state.load_state()
    assert state["pending_deletes"] == []
    assert state["datasets"]["ds-7"]["rev"] == 4
    assert state["datasets"]["ds-7"]["dirty"] is False


def test_forget_clears_dataset_and_pending_delete(sync_state):
    sync_state.mark_local_deleted("ds-3")
    sync_state.forget("ds-3")
    state = sync_state.load_state()
    assert state["pending_deletes"] == [] and state["datasets"] == {}


def test_note_change_noop_when_not_desktop(sync_state, monkeypatch):
    monkeypatch.setattr(settings, "NPT_DESKTOP", False)
    sync_state.note_change("ds-4")
    assert sync_state.load_state()["datasets"] == {}


def test_note_change_schedules_immediate_sync(sync_state, monkeypatch):
    """本地改动后共享模式要尽快上行（防抖触发，不再等下一轮轮询）。"""
    import time

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS", 0.05)
    sync_state.set_run_mode(sync_state.MODE_SHARED)

    calls = []
    monkeypatch.setattr(sync_state, "sync_once", lambda: calls.append(True) or {"pulled": 0})

    sync_state.note_change("ds-5")
    sync_state.note_change("ds-5")  # 连续写入只触发一次

    for _ in range(50):
        if calls:
            break
        time.sleep(0.05)
    assert len(calls) == 1
    assert sync_state.load_state()["datasets"]["ds-5"]["dirty"] is True


def test_note_change_no_sync_in_offline_mode(sync_state, monkeypatch):
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    sync_state.set_run_mode(sync_state.MODE_OFFLINE)
    calls = []
    monkeypatch.setattr(sync_state, "sync_once", lambda: calls.append(True) or {})
    sync_state.note_change("ds-6")
    assert calls == []


def test_sync_once_skipped_in_offline_mode(sync_state, monkeypatch):
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    result = sync_state.sync_once()
    assert result["skipped"] is True and result["reason"] == "当前为离线模式"


def test_status_shape(sync_state):
    status = sync_state.status()
    for key in ("run_mode", "activated", "pending_uploads", "conflicts", "synced_datasets"):
        assert key in status


# ---------------------------------------------------------------- LWW（最后更新时间）

def test_mark_dirty_records_changed_at_and_record_synced_clears_it(sync_state):
    """本地改动时间用于按「最后更新时间」选边；与服务器对齐后必须清掉。"""
    sync_state.record_synced("ds-lww", 2, server_updated_at="2026-10-09T10:00:00")
    assert sync_state.load_state()["datasets"]["ds-lww"]["server_updated_at"] == "2026-10-09T10:00:00"

    sync_state.mark_dirty("ds-lww")
    entry = sync_state.load_state()["datasets"]["ds-lww"]
    assert entry["dirty"] is True and entry["changed_at"]

    sync_state.record_synced("ds-lww", 3, server_updated_at="2026-10-09T11:00:00")
    entry = sync_state.load_state()["datasets"]["ds-lww"]
    assert entry["dirty"] is False and "changed_at" not in entry
    assert entry["server_updated_at"] == "2026-10-09T11:00:00"


def test_mark_local_deleted_records_deleted_at(sync_state):
    sync_state.record_synced("ds-del", 1)
    sync_state.mark_local_deleted("ds-del")
    state = sync_state.load_state()
    assert state["pending_deletes"] == ["ds-del"]
    assert state["deleted_at"]["ds-del"]

    sync_state.record_synced("ds-del", 2)
    state = sync_state.load_state()
    assert state["deleted_at"] == {} and state["pending_deletes"] == []


def test_is_local_newer_uses_clock_offset(sync_state):
    """本机时间与服务器时间偏差由清单校准，比较时换算到服务器时间轴。"""
    # 本机比服务器慢 60 秒：本机 10:00:30 实际对应服务器 10:01:30 > 服务器 10:01:00
    sync_state.save_state(clock_offset_seconds=60.0)
    assert sync_state._is_local_newer("2026-10-09T10:00:30", "2026-10-09T10:01:00") is True
    # 本机比服务器快 120 秒：本机 10:05:00 实际对应服务器 10:03:00 < 服务器 10:04:00
    sync_state.save_state(clock_offset_seconds=-120.0)
    assert sync_state._is_local_newer("2026-10-09T10:05:00", "2026-10-09T10:04:00") is False
    # 缺任一时间戳：无法判定，交给人工选边
    assert sync_state._is_local_newer(None, "2026-10-09T10:04:00") is None
    assert sync_state._is_local_newer("2026-10-09T10:05:00", "") is None


def test_remember_clock_offset_ignores_absurd_values(sync_state):
    from datetime import datetime, timedelta

    sync_state._remember_clock_offset((datetime.now() + timedelta(seconds=30)).isoformat(timespec="seconds"))
    assert 25 < sync_state.load_state()["clock_offset_seconds"] < 35
    # 明显异常（>6h）不采信，回 0
    sync_state._remember_clock_offset((datetime.now() + timedelta(hours=10)).isoformat(timespec="seconds"))
    assert sync_state.load_state()["clock_offset_seconds"] == 0.0


def test_clear_conflict_removes_entry(sync_state):
    # save_state 会剪掉没有对应数据集条目的冲突，所以先把数据集登记上
    sync_state.record_synced("ds-c", 1)
    sync_state.record_synced("ds-d", 1)
    sync_state.save_state(conflicts=[{"data_id": "ds-c", "server_rev": 2, "local_rev": 1},
                                     {"data_id": "ds-d", "server_rev": 2, "local_rev": 1}])
    sync_state._clear_conflict("ds-c")
    remaining = sync_state.load_state()["conflicts"]
    assert [c["data_id"] for c in remaining] == ["ds-d"]


def _stub_sync_once_env(monkeypatch, sync_state, monkeypatch_data_index, item):
    """把 sync_once 的外部依赖全部换成内存桩，返回 (pushed, pulled) 记录。"""
    from types import SimpleNamespace

    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud
    from app.services.data_service import data_service

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    sync_state.set_run_mode(sync_state.MODE_SHARED)
    monkeypatch.setattr(sync_state, "_require_active_license", lambda: None)
    monkeypatch.setattr(
        sync_state, "_local_group",
        lambda: (SimpleNamespace(id=1, username="u", city="河源", operator="联通"), "河源", "联通"),
    )
    monkeypatch.setattr(
        sync_state, "_sync_group",
        lambda user, city, operator: {"group": {"city": city, "operator": operator}},
    )
    monkeypatch.setattr(cloud, "sync_manifest", lambda: {"items": [item]})
    monkeypatch.setattr(sync_state, "sync_tasks", lambda city, operator: {"pulled": 0})
    monkeypatch.setattr(data_service, "index", monkeypatch_data_index)

    pushed, pulled = [], []
    monkeypatch.setattr(
        sync_state, "_push",
        lambda data_id, rev, changed_at=None: pushed.append((data_id, changed_at)) or {"action": "push"},
    )
    monkeypatch.setattr(
        sync_state, "_pull",
        lambda data_id, *a, **k: pulled.append(data_id) or {"action": "pull"},
    )
    return pushed, pulled


def _dirty_state(sync_state, changed_at=None):
    entry = {"rev": 1, "dirty": True}
    if changed_at:
        entry["changed_at"] = changed_at
    sync_state.save_state(datasets={"ds-1": entry})


def test_sync_once_lww_pushes_when_local_change_is_newer(sync_state, monkeypatch):
    """本地改动（含服务器上也变了）更晚 → 按最后更新时间上行覆盖服务器。"""
    item = {"data_id": "ds-1", "rev": 2, "deleted": False,
            "server_updated_at": "2026-10-09T10:00:00"}
    pushed, pulled = _stub_sync_once_env(monkeypatch, sync_state, {"ds-1": {"name": "D"}}, item)
    _dirty_state(sync_state, changed_at="2026-10-09T10:05:00")
    monkeypatch.setattr(sync_state, "_clock_offset_seconds", lambda: 0.0)

    summary = sync_state.sync_once()
    assert pushed and pushed[0][0] == "ds-1"
    assert pulled == [] and summary["conflicts"] == 0


def test_sync_once_lww_pulls_when_server_is_newer(sync_state, monkeypatch):
    """服务器版本更晚 → 直接采用服务器版本（本地未上行改动被覆盖，避免乒乓）。"""
    item = {"data_id": "ds-1", "rev": 2, "deleted": False,
            "server_updated_at": "2026-10-09T10:05:00"}
    pushed, pulled = _stub_sync_once_env(monkeypatch, sync_state, {"ds-1": {"name": "D"}}, item)
    _dirty_state(sync_state, changed_at="2026-10-09T10:00:00")
    monkeypatch.setattr(sync_state, "_clock_offset_seconds", lambda: 0.0)

    summary = sync_state.sync_once()
    assert pulled == ["ds-1"] and pushed == []
    assert summary["conflicts"] == 0
    assert sync_state.load_state()["conflicts"] == []


def test_sync_once_keeps_manual_conflict_without_timestamps(sync_state, monkeypatch):
    """存量条目没有改动时间 → 无法判定，保留人工选边。"""
    item = {"data_id": "ds-1", "rev": 2, "deleted": False}
    pushed, pulled = _stub_sync_once_env(monkeypatch, sync_state, {"ds-1": {"name": "D"}}, item)
    _dirty_state(sync_state)

    summary = sync_state.sync_once()
    assert summary["conflicts"] == 1
    assert pushed == [] and pulled == []
    assert sync_state.load_state()["conflicts"][0]["data_id"] == "ds-1"
