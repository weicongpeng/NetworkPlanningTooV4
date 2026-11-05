"""桌面端共享/单机配置档隔离：路径分档、存量迁移、当前档探测。"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.desktop_profiles import (
    ACTIVE_PROFILE_FILE,
    PROFILE_SHARED,
    PROFILE_STANDALONE,
    ensure_legacy_migrated,
    normalize_profile,
    profile_root_for,
    read_active_profile,
    write_active_profile,
)


# ----------------------------------------------------------------- 纯函数

def test_normalize_profile():
    assert normalize_profile("standalone") == PROFILE_STANDALONE
    assert normalize_profile("STANDALONE") == PROFILE_STANDALONE
    assert normalize_profile("shared") == PROFILE_SHARED
    # 非法值与空值一律回落 shared
    assert normalize_profile(None) == PROFILE_SHARED
    assert normalize_profile("") == PROFILE_SHARED
    assert normalize_profile("hacker") == PROFILE_SHARED


def test_profile_root_layout(tmp_path):
    assert profile_root_for(tmp_path, PROFILE_SHARED) == tmp_path / "profiles" / "shared"
    assert profile_root_for(tmp_path, PROFILE_STANDALONE) == (
        tmp_path / "profiles" / "standalone"
    )


def test_active_profile_roundtrip(tmp_path):
    assert read_active_profile(tmp_path) == PROFILE_SHARED
    write_active_profile(tmp_path, PROFILE_STANDALONE)
    assert read_active_profile(tmp_path) == PROFILE_STANDALONE
    # 损坏文件不致命，回落默认档
    (tmp_path / ACTIVE_PROFILE_FILE).write_text("not-json", encoding="utf-8")
    assert read_active_profile(tmp_path) == PROFILE_SHARED


# ----------------------------------------------------------------- 存量迁移

def test_legacy_data_moves_into_shared_profile(tmp_path):
    # 旧版本布局：业务数据平铺在数据根
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "data.db").write_text("db", encoding="utf-8")
    (tmp_path / "uploads").mkdir()
    (tmp_path / "outputs").mkdir()
    (tmp_path / "exports").mkdir()
    (tmp_path / "sync_state.json").write_text("{}", encoding="utf-8")

    assert ensure_legacy_migrated(tmp_path, PROFILE_SHARED) is True

    target = tmp_path / "profiles" / "shared"
    assert (target / "data" / "data.db").read_text(encoding="utf-8") == "db"
    assert (target / "sync_state.json").is_file()
    # 旧位置已清空
    assert not (tmp_path / "data").exists()
    assert not (tmp_path / "sync_state.json").exists()


def test_legacy_migration_is_idempotent(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "data.db").write_text("a", encoding="utf-8")

    assert ensure_legacy_migrated(tmp_path, PROFILE_SHARED) is True
    # 第二次启动：旧位置已无数据，目标完好
    assert ensure_legacy_migrated(tmp_path, PROFILE_SHARED) is False
    assert (tmp_path / "profiles" / "shared" / "data" / "data.db").is_file()


def test_standalone_profile_never_touches_legacy_data(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "data.db").write_text("shared-db", encoding="utf-8")

    # 单机档首启：旧数据保持原样，不迁入单机档
    assert ensure_legacy_migrated(tmp_path, PROFILE_STANDALONE) is False
    assert (tmp_path / "data" / "data.db").is_file()
    assert not (tmp_path / "profiles" / "standalone").exists()


def test_fresh_data_root_needs_no_migration(tmp_path):
    assert ensure_legacy_migrated(tmp_path, PROFILE_SHARED) is False


def test_profiles_are_physically_separated(tmp_path):
    """两档各自迁移/写入后互不可见。"""
    # 旧共享数据
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "data.db").write_text("shared", encoding="utf-8")
    ensure_legacy_migrated(tmp_path, PROFILE_SHARED)

    # 单机档全新数据
    standalone_data = profile_root_for(tmp_path, PROFILE_STANDALONE) / "data"
    standalone_data.mkdir(parents=True)
    (standalone_data / "data.db").write_text("standalone", encoding="utf-8")

    shared_db = profile_root_for(tmp_path, PROFILE_SHARED) / "data" / "data.db"
    assert shared_db.read_text(encoding="utf-8") == "shared"
    assert (standalone_data / "data.db").read_text(encoding="utf-8") == "standalone"


# ----------------------------------------------------------------- 探测端点

@pytest.fixture()
def system_client(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", PROFILE_STANDALONE)

    from app.api.v1.endpoints import system as system_endpoint

    app = FastAPI()
    app.include_router(system_endpoint.router, prefix="/api/v1/system")
    return TestClient(app)


def test_desktop_mode_endpoint_reports_profile(system_client):
    resp = system_client.get("/api/v1/system/desktop-mode")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["desktop_mode"] is True
    assert data["desktop_profile"] == PROFILE_STANDALONE
