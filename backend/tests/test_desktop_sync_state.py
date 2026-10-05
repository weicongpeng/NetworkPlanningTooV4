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


def test_forget_clears_dataset_and_pending_delete(sync_state):
    sync_state.mark_local_deleted("ds-3")
    sync_state.forget("ds-3")
    state = sync_state.load_state()
    assert state["pending_deletes"] == [] and state["datasets"] == {}


def test_note_change_noop_when_not_desktop(sync_state, monkeypatch):
    monkeypatch.setattr(settings, "NPT_DESKTOP", False)
    sync_state.note_change("ds-4")
    assert sync_state.load_state()["datasets"] == {}


def test_sync_once_skipped_in_offline_mode(sync_state, monkeypatch):
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    result = sync_state.sync_once()
    assert result["skipped"] is True and result["reason"] == "当前为离线模式"


def test_status_shape(sync_state):
    status = sync_state.status()
    for key in ("run_mode", "activated", "pending_uploads", "conflicts", "synced_datasets"):
        assert key in status
