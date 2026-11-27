"""移动端 APK 默认加载：按文件生成时间取最新、版本留空待配置、手动上传保留。"""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import get_db
from app.core.security import get_current_admin_user
from app.models.database import Base


@pytest.fixture()
def apks(tmp_path, monkeypatch):
    from app.api.v1.endpoints import app_versions

    apk_dir = tmp_path / "apks"
    apk_dir.mkdir()
    monkeypatch.setattr(app_versions, "APKS_DIR", apk_dir)

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(app_versions.router, prefix="/api/v1/app-versions")
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin_user] = lambda: SimpleNamespace(
        username="admin", is_admin=True
    )

    yield SimpleNamespace(client=TestClient(app), directory=apk_dir)


def _put_apk(apks, name: str, age_seconds: int = 0) -> None:
    path = apks.directory / name
    path.write_bytes(b"apk-" + name.encode())
    mtime = os.path.getmtime(path) - age_seconds
    os.utime(path, (mtime, mtime))


def _list(apks):
    return apks.client.get("/api/v1/app-versions").json()["data"]


def test_loads_only_newest_apk_by_file_time(apks):
    _put_apk(apks, "old.apk", age_seconds=3600)
    _put_apk(apks, "new.apk")

    data = _list(apks)

    assert data["total"] == 1
    item = data["items"][0]
    assert item["apk_filename"] == "new.apk"
    assert item["version"] == ""
    assert item["is_latest"] is True
    assert item["file_time"] is not None


def test_newer_build_takes_over_latest(apks):
    _put_apk(apks, "v1.apk", age_seconds=60)
    first = _list(apks)
    assert first["items"][0]["apk_filename"] == "v1.apk"

    _put_apk(apks, "v2.apk")
    data = _list(apks)

    assert data["total"] == 2
    latest = [item for item in data["items"] if item["is_latest"]]
    assert len(latest) == 1
    assert latest[0]["apk_filename"] == "v2.apk"


def test_version_is_set_manually(apks):
    _put_apk(apks, "app-release.apk")
    version_id = _list(apks)["items"][0]["id"]

    resp = apks.client.put(
        f"/api/v1/app-versions/{version_id}", json={"version": "1.2.3", "changelog": "手工填写"}
    )

    assert resp.status_code == 200
    item = _list(apks)["items"][0]
    assert item["version"] == "1.2.3"
    assert item["changelog"] == "手工填写"


def test_manual_upload_still_works(apks):
    resp = apks.client.post(
        "/api/v1/app-versions",
        files={"file": ("manual.apk", b"manual-apk", "application/vnd.android.package-archive")},
        data={"version": "2.0.0", "changelog": "手动上传"},
    )

    assert resp.status_code == 200
    data = _list(apks)
    assert data["total"] == 1
    assert data["items"][0]["version"] == "2.0.0"
