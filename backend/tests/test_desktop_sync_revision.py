"""数据集修订号语义：只有真正写入才推进 rev（同组桌面端同步的依据）。

回归点：
- push（上传）必须 bump：否则其它桌面端比对 rev 无变化，永远拉不到这次改动
- pull（下载）是读操作，不能 bump：否则同组客户端会互相触发重复整包下载
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from app.utils.machine_code import get_machine_code

from .test_desktop_license_cloud import _activate, _create, cloud_env  # noqa: F401

MACHINE = get_machine_code()


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from app.api.v1.endpoints import desktop_cloud

    desktop_cloud._rl_buckets.clear()
    yield
    desktop_cloud._rl_buckets.clear()


@pytest.fixture(autouse=True)
def _city_presets_available(monkeypatch):
    """显式放行本文件用到的地市：非桌面部署的默认地市清单为空（生产靠 .env 配），
    CI 上没有 .env，绑定数据组时会被 validate_group 拦下。"""
    from app.core.config import settings

    monkeypatch.setattr(
        settings, "NPT_CITY_PRESETS", "广州,河源,惠州,深圳", raising=False
    )


def _issue(cloud_env) -> str:
    record = _create(cloud_env.client, name="修订号测试")
    resp = _activate(cloud_env.client, record["activation_code"], machine=MACHINE)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["license_file"]


def _bind_group(client, license_file: str) -> None:
    resp = client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )
    assert resp.status_code == 200, resp.text


def test_push_bumps_revision(cloud_env, tmp_path, monkeypatch):  # noqa: F401
    """桌面端上传后 rev 必须 +1（他端据此判断"服务器有更新"）。"""
    from app.services import dataset_revision_service as revs
    from app.services.desktop_dataset_packager import install_package

    data_id = "sync-rev-push"
    license_file = _issue(cloud_env)
    client = cloud_env.client
    _bind_group(client, license_file)

    installed = {}
    monkeypatch.setattr(
        "app.services.desktop_dataset_packager.install_package",
        lambda *a, **kw: installed.update({"called": True}) or {"data_id": data_id, "type": "excel"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    before = int((revs.get(data_id) or {}).get("rev") or 0)

    pkg = tmp_path / "push.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("meta.json", "{}")

    try:
        resp = client.post(
            f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
            data={"license_file": license_file, "machine_code": MACHINE},
            files={"file": ("push.zip", pkg.read_bytes(), "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        assert installed.get("called") is True
        after = resp.json()["data"]["rev"]
        assert after == before + 1
        assert int((revs.get(data_id) or {}).get("rev") or 0) == after
    finally:
        revs.remove(data_id)


def test_push_clears_tombstone(cloud_env, tmp_path, monkeypatch):  # noqa: F401
    """被删除的数据集重新推上来时，墓碑必须清掉。"""
    from app.services import dataset_revision_service as revs

    data_id = "sync-rev-revive"
    license_file = _issue(cloud_env)
    client = cloud_env.client
    _bind_group(client, license_file)

    monkeypatch.setattr(
        "app.services.desktop_dataset_packager.install_package",
        lambda *a, **kw: {"data_id": data_id, "type": "excel"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    revs.mark_deleted(data_id, city="广州", operator="移动")
    assert (revs.get(data_id) or {}).get("deleted") is True

    pkg = tmp_path / "push.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("meta.json", "{}")

    try:
        resp = client.post(
            f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
            data={"license_file": license_file, "machine_code": MACHINE},
            files={"file": ("push.zip", pkg.read_bytes(), "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        assert (revs.get(data_id) or {}).get("deleted") is False
    finally:
        revs.remove(data_id)


def test_pull_does_not_bump_revision(cloud_env, tmp_path, monkeypatch):  # noqa: F401
    """下载是读操作：只回写摘要，不推进 rev（避免同组客户端来回重拉）。"""
    from app.services import dataset_revision_service as revs
    from app.services.data_service import data_service

    data_id = "sync-rev-pull"
    license_file = _issue(cloud_env)
    client = cloud_env.client
    _bind_group(client, license_file)

    zip_path = tmp_path / "pull.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("meta.json", "{}")

    backup = dict(data_service.index)
    monkeypatch.setattr(data_service, "index", {
        data_id: {"id": data_id, "name": "工参", "type": "excel",
                  "city": "广州", "operator": "移动", "status": "ready", "metadata": {}},
    })
    monkeypatch.setattr(
        "app.services.desktop_dataset_packager.build_package",
        lambda *a, **kw: {"path": Path(zip_path), "size": zip_path.stat().st_size, "sha256": "abc123"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    before = int((revs.get(data_id) or {}).get("rev") or 0)

    try:
        resp = client.get(
            f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
            params={"license_file": license_file, "machine_code": MACHINE},
        )
        assert resp.status_code == 200, resp.text
        after = revs.get(data_id) or {}
        assert int(after.get("rev") or 0) == before  # 读操作不改修订号
        assert after.get("sha256") == "abc123"
    finally:
        monkeypatch.setattr(data_service, "index", backup)
        revs.remove(data_id)


def _push_with_conflict(client, license_file: str, data_id: str, tmp_path, base_rev: int, changed_at: str):
    pkg = tmp_path / f"{data_id}.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("meta.json", "{}")
    return client.post(
        f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
        data={"license_file": license_file, "machine_code": MACHINE,
              "base_rev": str(base_rev), "changed_at": changed_at},
        files={"file": (pkg.name, pkg.read_bytes(), "application/zip")},
    )


def test_push_conflict_accepts_newer_changed_at_lww(cloud_env, tmp_path, monkeypatch):  # noqa: F401
    """修订号冲突时按「最后更新时间」选边：客户端改动时间更晚 → 允许覆盖（LWW）。"""
    from datetime import datetime, timedelta

    from app.services import dataset_revision_service as revs

    data_id = "sync-lww-newer"
    license_file = _issue(cloud_env)
    client = cloud_env.client
    _bind_group(client, license_file)

    monkeypatch.setattr(
        "app.services.desktop_dataset_packager.install_package",
        lambda *a, **kw: {"data_id": data_id, "type": "excel"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    revs.bump(data_id, deleted=False)  # 同组有人刚改过：服务器 rev 已推进
    server_updated_at = (revs.get(data_id) or {}).get("updated_at")
    changed_at = (
        datetime.fromisoformat(server_updated_at) + timedelta(minutes=5)
    ).isoformat(timespec="seconds")

    try:
        resp = _push_with_conflict(client, license_file, data_id, tmp_path, base_rev=1, changed_at=changed_at)
        assert resp.status_code == 200, resp.text
    finally:
        revs.remove(data_id)


def test_push_conflict_rejects_stale_changed_at(cloud_env, tmp_path, monkeypatch):  # noqa: F401
    """本地改动时间不晚于服务器 → 拒绝覆盖，防止旧数据反向覆盖新数据（乒乓）。"""
    from datetime import datetime, timedelta

    from app.services import dataset_revision_service as revs

    data_id = "sync-lww-stale"
    license_file = _issue(cloud_env)
    client = cloud_env.client
    _bind_group(client, license_file)

    monkeypatch.setattr(
        "app.services.desktop_dataset_packager.install_package",
        lambda *a, **kw: {"data_id": data_id, "type": "excel"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    revs.bump(data_id, deleted=False)
    server_updated_at = (revs.get(data_id) or {}).get("updated_at")
    stale_changed_at = (
        datetime.fromisoformat(server_updated_at) - timedelta(minutes=5)
    ).isoformat(timespec="seconds")
    before_rev = int((revs.get(data_id) or {}).get("rev") or 0)

    try:
        resp = _push_with_conflict(client, license_file, data_id, tmp_path, base_rev=1, changed_at=stale_changed_at)
        assert resp.status_code == 409, resp.text
        assert int((revs.get(data_id) or {}).get("rev") or 0) == before_rev  # 未写入
    finally:
        revs.remove(data_id)
