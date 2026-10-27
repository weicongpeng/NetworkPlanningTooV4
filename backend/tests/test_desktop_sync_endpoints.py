"""桌面端共享模式同步接口（服务器端）：握手绑定组、清单按组隔离、上传乐观锁。"""
from __future__ import annotations

import zipfile

import pytest

from app.utils.machine_code import get_machine_code

from .test_desktop_license_cloud import _activate, _create, cloud_env  # noqa: F401

MACHINE = get_machine_code()


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    """限流桶是模块级全局的，跨用例会累积（同一进程内其它测试也在激活授权）。"""
    from app.api.v1.endpoints import desktop_cloud

    desktop_cloud._rl_buckets.clear()
    yield
    desktop_cloud._rl_buckets.clear()


def _issue(cloud_env) -> str:
    """管理员预建授权 → 客户端用激活码激活 → 返回许可文件（桌面端的身份凭证）。"""
    record = _create(cloud_env.client, name="共享模式测试")
    resp = _activate(cloud_env.client, record["activation_code"], machine=MACHINE)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["license_file"]


def test_session_binds_group_then_locks_it(cloud_env):  # noqa: F811
    license_file = _issue(cloud_env)
    client = cloud_env.client

    # 首次同步：授权未绑定组 → 以桌面端上报的组绑定
    resp = client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["group"] == {"city": "广州", "operator": "移动"}
    assert data["group_locked"] is False
    assert data["shadow_user_id"]

    # 第二次：已绑定 → group_locked=True，客户端必须纠正本机组
    resp2 = client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "深圳", "operator": "联通"},
    )
    assert resp2.status_code == 200
    assert resp2.json()["data"]["group_locked"] is True
    assert resp2.json()["data"]["group"] == {"city": "广州", "operator": "移动"}


def test_session_requires_group_and_valid_license(cloud_env):  # noqa: F811
    client = cloud_env.client
    resp = client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": "not-a-license", "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )
    assert resp.status_code == 400

    license_file = _issue(cloud_env)
    resp = client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE, "city": "", "operator": ""},
    )
    assert resp.status_code == 400  # 未指定组且服务器也没绑定


def test_manifest_only_returns_same_group(cloud_env, monkeypatch):  # noqa: F811
    from app.services import dataset_revision_service as revs
    from app.services.data_service import data_service

    license_file = _issue(cloud_env)
    client = cloud_env.client
    client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )

    in_group = "sync-manifest-in"
    out_group = "sync-manifest-out"
    backup = dict(data_service.index)
    monkeypatch.setattr(data_service, "index", {
        in_group: {"id": in_group, "name": "同组工参", "type": "excel",
                   "city": "广州", "operator": "移动", "status": "ready", "metadata": {}},
        out_group: {"id": out_group, "name": "他组工参", "type": "excel",
                    "city": "深圳", "operator": "联通", "status": "ready", "metadata": {}},
    })
    try:
        resp = client.post(
            "/api/v1/desktop-cloud/data/manifest",
            json={"license_file": license_file, "machine_code": MACHINE},
        )
        assert resp.status_code == 200, resp.text
        ids = [i["data_id"] for i in resp.json()["data"]["items"]]
        assert in_group in ids
        assert out_group not in ids
        item = next(i for i in resp.json()["data"]["items"] if i["data_id"] == in_group)
        assert item["rev"] >= 1 and item["deleted"] is False
    finally:
        monkeypatch.setattr(data_service, "index", backup)
        revs.remove(in_group)


def test_push_rejects_stale_base_rev(cloud_env, tmp_path):  # noqa: F811
    from app.services import dataset_revision_service as revs
    from app.services.data_service import data_service

    data_id = "sync-push-conflict"
    backup = dict(data_service.index)
    monkeypatch = cloud_env.monkeypatch
    monkeypatch.setattr(data_service, "index", {
        data_id: {"id": data_id, "name": "工参", "type": "excel",
                  "city": "广州", "operator": "移动", "status": "ready", "metadata": {}},
    })

    license_file = _issue(cloud_env)
    client = cloud_env.client
    client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )
    revs.ensure({data_id: {"city": "广州", "operator": "移动"}})
    revs.bump(data_id, deleted=False, city="广州", operator="移动")  # 服务器 rev=2

    pkg = tmp_path / "push.zip"
    with zipfile.ZipFile(pkg, "w") as zf:
        zf.writestr("meta.json", "{}")  # 内容无效，但乐观锁应先拦下

    try:
        resp = client.post(
            f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
            data={"license_file": license_file, "machine_code": MACHINE, "base_rev": "1"},
            files={"file": ("push.zip", pkg.read_bytes(), "application/zip")},
        )
        assert resp.status_code == 409, resp.text  # 基线落后 → 冲突
    finally:
        monkeypatch.setattr(data_service, "index", backup)
        revs.remove(data_id)


def test_download_rejects_cross_group(cloud_env, monkeypatch):  # noqa: F811
    from app.services.data_service import data_service

    data_id = "sync-cross-group"
    backup = dict(data_service.index)
    cloud_env.monkeypatch.setattr(data_service, "index", {
        data_id: {"id": data_id, "name": "他组数据", "type": "map",
                  "city": "深圳", "operator": "联通", "status": "ready", "metadata": {}},
    })
    license_file = _issue(cloud_env)
    client = cloud_env.client
    client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": "广州", "operator": "移动"},
    )
    try:
        resp = client.get(
            f"/api/v1/desktop-cloud/data/dataset/{data_id}/package",
            params={"license_file": license_file, "machine_code": MACHINE},
        )
        assert resp.status_code == 404  # 跨组一律 404，不泄露数据是否存在
    finally:
        cloud_env.monkeypatch.setattr(data_service, "index", backup)
