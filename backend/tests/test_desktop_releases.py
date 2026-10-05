"""桌面版 OTA 服务端测试：分片上传/sha256/latest 版本比较/Range 下载/计数与鉴权。"""
from __future__ import annotations

import hashlib
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

PAYLOAD = bytes(range(256)) * 40  # 10240 字节，内容可校验


@pytest.fixture()
def ota(tmp_path, monkeypatch):
    from app.api.v1.endpoints import desktop_cloud, desktop_releases
    from app.core.config import settings

    monkeypatch.setattr(settings, "DESKTOP_RELEASES_DIR", tmp_path)
    monkeypatch.setattr(desktop_releases, "RELEASES_DIR", tmp_path)
    desktop_releases._chunked_sessions.clear()

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
    app.include_router(desktop_releases.router, prefix="/api/v1/desktop-releases")
    app.include_router(desktop_cloud.router, prefix="/api/v1/desktop-cloud")
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_admin_user] = lambda: SimpleNamespace(
        username="admin", is_admin=True
    )

    raw_app = FastAPI()
    raw_app.include_router(desktop_releases.router, prefix="/api/v1/desktop-releases")
    raw_app.dependency_overrides[get_db] = override_db

    yield SimpleNamespace(
        client=TestClient(app),
        raw_client=TestClient(raw_app),
        session_factory=TestingSession,
        releases_dir=tmp_path,
    )


def _upload(ota, version="1.0.0", channel="stable", chunk_size=4096, mandatory=False):
    client = ota.client
    total_chunks = (len(PAYLOAD) + chunk_size - 1) // chunk_size
    start = client.post(
        "/api/v1/desktop-releases/chunked/start",
        data={"filename": "NetworkPlanningTool-Setup-1.0.0.exe", "total_chunks": total_chunks,
              "total_size": len(PAYLOAD)},
    )
    assert start.status_code == 200, start.text
    upload_id = start.json()["data"]["id"]
    for index in range(total_chunks):
        part = PAYLOAD[index * chunk_size : (index + 1) * chunk_size]
        resp = client.post(
            f"/api/v1/desktop-releases/chunked/{upload_id}/chunk",
            data={"chunk_index": index},
            files={"file": ("chunk.bin", part, "application/octet-stream")},
        )
        assert resp.status_code == 200, resp.text
    resp = client.post(
        f"/api/v1/desktop-releases/chunked/{upload_id}/complete",
        data={
            "version": version,
            "channel": channel,
            "release_notes": "测试版本",
            "mandatory": str(mandatory).lower(),
            "is_latest": "true",
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_chunked_upload_and_sha256(ota):
    data = _upload(ota)
    assert data["sha256"] == hashlib.sha256(PAYLOAD).hexdigest()
    assert data["file_size"] == len(PAYLOAD)
    assert data["version"] == "1.0.0"
    assert data["is_latest"] is True
    # 落盘文件存在且内容一致
    import pathlib

    stored = pathlib.Path(data["file_path"])
    assert stored.is_file() and stored.read_bytes() == PAYLOAD


def test_complete_requires_admin(ota):
    # 先用管理员通道拿到 upload_id 与分块
    total_chunks = 1
    start = ota.client.post(
        "/api/v1/desktop-releases/chunked/start",
        data={"filename": "x.exe", "total_chunks": total_chunks, "total_size": len(PAYLOAD)},
    )
    upload_id = start.json()["data"]["id"]
    ota.client.post(
        f"/api/v1/desktop-releases/chunked/{upload_id}/chunk",
        data={"chunk_index": 0},
        files={"file": ("c.bin", PAYLOAD, "application/octet-stream")},
    )
    resp = ota.raw_client.post(
        f"/api/v1/desktop-releases/chunked/{upload_id}/complete",
        data={"version": "1.0.1", "channel": "stable"},
    )
    assert resp.status_code in (401, 403)


def test_missing_chunk_rejected(ota):
    start = ota.client.post(
        "/api/v1/desktop-releases/chunked/start",
        data={"filename": "x.exe", "total_chunks": 3, "total_size": 100},
    )
    upload_id = start.json()["data"]["id"]
    ota.client.post(
        f"/api/v1/desktop-releases/chunked/{upload_id}/chunk",
        data={"chunk_index": 0},
        files={"file": ("c.bin", b"abc", "application/octet-stream")},
    )
    resp = ota.client.post(
        f"/api/v1/desktop-releases/chunked/{upload_id}/complete",
        data={"version": "1.0.2", "channel": "stable"},
    )
    assert resp.status_code == 400
    assert "缺失" in resp.json()["detail"]


def test_latest_version_comparison(ota):
    _upload(ota, version="1.0.0")
    resp = ota.client.get("/api/v1/desktop-cloud/releases/latest", params={"current": "0.9.0"})
    data = resp.json()["data"]
    assert data["update_available"] is True
    assert data["download_url"].endswith(f"/{data['id']}")
    assert data["sha256"] == hashlib.sha256(PAYLOAD).hexdigest()

    resp = ota.client.get("/api/v1/desktop-cloud/releases/latest", params={"current": "1.0.0"})
    assert resp.json()["data"]["update_available"] is False

    _upload(ota, version="1.1.0")
    resp = ota.client.get("/api/v1/desktop-cloud/releases/latest", params={"current": "1.0.0"})
    assert resp.json()["data"]["version"] == "1.1.0"

    # 渠道隔离
    resp = ota.client.get("/api/v1/desktop-cloud/releases/latest", params={"channel": "beta"})
    assert resp.json()["data"] is None
    # 无 current 时默认提示可用
    resp = ota.client.get("/api/v1/desktop-cloud/releases/latest")
    assert resp.json()["data"]["update_available"] is True


def test_set_latest_clears_same_channel(ota):
    first = _upload(ota, version="1.0.0")
    second = _upload(ota, version="2.0.0")
    assert second["is_latest"] is True

    resp = ota.client.post(f"/api/v1/desktop-releases/{first['id']}/set-latest")
    assert resp.status_code == 200
    listing = ota.client.get("/api/v1/desktop-releases").json()["data"]["items"]
    latest_flags = {item["version"]: item["is_latest"] for item in listing}
    assert latest_flags == {"1.0.0": True, "2.0.0": False}


def test_range_download_and_counting(ota):
    data = _upload(ota)
    url = f"/api/v1/desktop-cloud/releases/download/{data['id']}"

    # 完整下载：计数 +1，Content-Length = 文件大小
    resp = ota.client.get(url)
    assert resp.status_code == 200
    assert resp.headers["content-length"] == str(len(PAYLOAD))
    assert resp.headers["accept-ranges"] == "bytes"
    assert resp.content == PAYLOAD

    # Range：206 + 正确切片、不计入下载数
    resp = ota.client.get(url, headers={"Range": "bytes=100-199"})
    assert resp.status_code == 206
    assert resp.content == PAYLOAD[100:200]
    assert resp.headers["content-range"] == f"bytes 100-199/{len(PAYLOAD)}"

    # 打开的 Range：到文件尾
    resp = ota.client.get(url, headers={"Range": "bytes=10200-"})
    assert resp.status_code == 206
    assert resp.content == PAYLOAD[10200:]

    # 越界：416
    resp = ota.client.get(url, headers={"Range": f"bytes={len(PAYLOAD)}-99999"})
    assert resp.status_code == 416

    # HEAD 不计数
    ota.client.head(url)

    listing = ota.client.get("/api/v1/desktop-releases").json()["data"]["items"]
    assert listing[0]["download_count"] == 1


def test_delete_removes_file(ota):
    import pathlib

    data = _upload(ota)
    stored = pathlib.Path(data["file_path"])
    assert stored.is_file()

    resp = ota.client.delete(f"/api/v1/desktop-releases/{data['id']}")
    assert resp.status_code == 200
    assert not stored.exists()
    assert ota.client.get("/api/v1/desktop-releases").json()["data"]["total"] == 0
    # 下载已删除的记录 404
    resp = ota.client.get(f"/api/v1/desktop-cloud/releases/download/{data['id']}")
    assert resp.status_code == 404


def test_update_release_fields(ota):
    data = _upload(ota, version="1.0.0", channel="stable")
    resp = ota.client.put(
        f"/api/v1/desktop-releases/{data['id']}",
        data={"version": "1.0.1", "channel": "beta", "release_notes": "改", "mandatory": "true"},
    )
    assert resp.status_code == 200
    updated = resp.json()["data"]
    assert updated["version"] == "1.0.1"
    assert updated["channel"] == "beta"
    assert updated["mandatory"] is True
