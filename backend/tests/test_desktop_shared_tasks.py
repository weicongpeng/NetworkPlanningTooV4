"""同组任务历史共享：服务端接口 + 桌面端同步（镜像/上行/删除传播）。

背景（2026-10-08）：同组用户的 PCI/邻区/TAC 核查/TAC 规划历史任务要求互通——
网页端已按组共享；这里补齐桌面端（共享模式）的同步与存量任务归属修正。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.database import Base, TaskResult
from app.services.task_manager import task_manager

from .test_desktop_license_cloud import _activate, _create, cloud_env  # noqa: F401

MACHINE = "AAAA-BBBB-CCCC-DDDD"


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """把任务表指向临时 SQLite（服务端/桌面端共用同一套表结构）。"""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr("app.core.database.SessionLocal", Session)
    monkeypatch.setattr("app.services.task_manager.SessionLocal", Session, raising=False)
    return Session


@pytest.fixture(autouse=True)
def _city_presets_available(monkeypatch):
    """显式放行本文件用到的地市：非桌面部署的默认地市清单为空（生产靠 .env 配），
    CI 上没有 .env，绑定数据组时会被 validate_group 拦下。"""
    from app.core.config import settings

    monkeypatch.setattr(
        settings, "NPT_CITY_PRESETS", "广州,河源,惠州,深圳", raising=False
    )


# ---------------------------------------------------------------- 服务端方法

def test_upsert_and_list_are_group_scoped(temp_db):
    meta = task_manager.upsert_shared_task(
        {
            "task_id": "t-pci-1",
            "task_type": "pci",
            "task_name": "河源联通 PCI",
            "user_name": "pwc",
            "status": "completed",
            "created_at": "2026-10-08T10:00:00",
            "result": {"results": [{"siteId": "A"}]},
        },
        city="河源",
        operator="联通",
    )
    assert meta["task_id"] == "t-pci-1" and meta["is_applied"] is False

    same_group = task_manager.list_shared_tasks("河源", "联通")
    assert [t["task_id"] for t in same_group] == ["t-pci-1"]
    # 跨组不可见
    assert task_manager.list_shared_tasks("惠州", "电信") == []
    # 结果按需拉取（组不符返回 None）
    assert task_manager.get_shared_task_result("t-pci-1", "河源", "联通")["results"][0]["siteId"] == "A"
    assert task_manager.get_shared_task_result("t-pci-1", "惠州", "电信") is None


def test_upsert_rejects_apply_tasks(temp_db):
    """应用类任务绑定本机工参，不参与同组共享。"""
    with pytest.raises(ValueError):
        task_manager.upsert_shared_task(
            {"task_id": "t-apply", "task_type": "apply_pci", "status": "completed"},
            city="河源",
            operator="联通",
        )
    # 非规划类任务也不会出现在清单/结果里
    assert task_manager.get_shared_task_result("t-apply", "河源", "联通") is None
    assert task_manager.delete_shared_task("t-apply", "河源", "联通") is False


def test_delete_shared_task(temp_db):
    task_manager.upsert_shared_task(
        {"task_id": "t-tac-1", "task_type": "tac", "user_name": "u", "status": "completed",
         "created_at": "2026-10-08T10:00:00", "result": {"x": 1}},
        city="河源", operator="联通",
    )
    assert task_manager.delete_shared_task("t-tac-1", "河源", "联通") is True
    assert task_manager.list_shared_tasks("河源", "联通") == []


# ---------------------------------------------------------------- 服务端 HTTP 接口

def _issue(cloud_env) -> str:
    record = _create(cloud_env.client, name="共享任务测试")
    resp = _activate(cloud_env.client, record["activation_code"], machine=MACHINE)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["license_file"]


def _bind_group(cloud_env, license_file: str, city="广州", operator="移动") -> None:
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/data/session",
        json={"license_file": license_file, "machine_code": MACHINE,
              "city": city, "operator": operator},
    )
    assert resp.status_code == 200, resp.text


def test_task_endpoints_roundtrip(cloud_env, temp_db):  # noqa: F811
    license_file = _issue(cloud_env)
    _bind_group(cloud_env, license_file)
    client = cloud_env.client

    # 上传（组以服务器授权记录为准）
    up = client.post(
        "/api/v1/desktop-cloud/data/tasks/t-neighbor-1",
        json={
            "license_file": license_file, "machine_code": MACHINE,
            "task": {"task_id": "t-neighbor-1", "task_type": "neighbor",
                     "task_name": "广州移动邻区", "user_name": "alice",
                     "status": "completed", "created_at": "2026-10-08T11:00:00"},
            "result": {"neighbors": []},
        },
    )
    assert up.status_code == 200, up.text
    assert up.json()["data"]["city"] == "广州"

    # 清单（元数据）
    manifest = client.post(
        "/api/v1/desktop-cloud/data/tasks/manifest",
        json={"license_file": license_file, "machine_code": MACHINE},
    )
    assert manifest.status_code == 200, manifest.text
    items = manifest.json()["data"]["items"]
    assert [i["task_id"] for i in items] == ["t-neighbor-1"]
    assert "result" not in items[0]

    # 结果按需拉取
    got = client.get(
        "/api/v1/desktop-cloud/data/tasks/t-neighbor-1/result",
        params={"license_file": license_file, "machine_code": MACHINE},
    )
    assert got.status_code == 200 and got.json()["data"]["result"] == {"neighbors": []}

    # 删除传播
    deleted = client.post(
        "/api/v1/desktop-cloud/data/tasks/t-neighbor-1/delete",
        json={"license_file": license_file, "machine_code": MACHINE},
    )
    assert deleted.status_code == 200 and deleted.json()["data"]["deleted"] is True
    assert client.post(
        "/api/v1/desktop-cloud/data/tasks/manifest",
        json={"license_file": license_file, "machine_code": MACHINE},
    ).json()["data"]["items"] == []


def test_task_endpoints_reject_apply_type(cloud_env, temp_db):  # noqa: F811
    license_file = _issue(cloud_env)
    _bind_group(cloud_env, license_file)
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/data/tasks/t-apply-1",
        json={
            "license_file": license_file, "machine_code": MACHINE,
            "task": {"task_id": "t-apply-1", "task_type": "apply_pci", "status": "completed"},
        },
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------- 桌面端同步

@pytest.fixture()
def desktop_task_env(tmp_path, monkeypatch, temp_db):
    """桌面端任务同步环境：假云端 + 临时状态文件。"""
    import app.services.desktop_sync_service as sync
    from app.core.config import settings

    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    monkeypatch.setattr(sync, "state_file", lambda: tmp_path / "sync_state.json")
    return sync


def test_sync_tasks_mirrors_pushes_and_deletes(desktop_task_env, temp_db):
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    server: dict = {}

    def _manifest():
        return {"items": [dict(v) for v in server.values()]}

    def _upload(task, result=None):
        server[task["task_id"]] = {k: v for k, v in task.items() if k != "result"}
        server[task["task_id"]]["result"] = result
        return {"task_id": task["task_id"]}

    monkeypatch_ = pytest.MonkeyPatch()
    monkeypatch_.setattr(cloud, "shared_tasks_manifest", _manifest)
    monkeypatch_.setattr(cloud, "upload_shared_task", _upload)
    monkeypatch_.setattr(cloud, "delete_shared_task", lambda tid: {"deleted": True})
    try:
        # 服务器上已有一个同组任务 → 拉成本机镜像
        server["t-remote"] = {
            "task_id": "t-remote", "task_type": "tac_planning", "task_name": "远端 TAC 规划",
            "user_name": "bob", "status": "completed", "is_applied": False,
            "created_at": "2026-10-08T09:00:00", "completed_at": None,
            "city": "河源", "operator": "联通",
        }
        # 本机新建了一个已完成任务 → 上行
        db = temp_db()
        try:
            db.add(TaskResult(
                task_id="t-local", task_type="pci", task_name="本机 PCI", user_name="alice",
                status="completed", progress=100.0, created_at="2026-10-08T08:00:00",
                result_json=json.dumps({"results": []}), origin="local",
                city="河源", operator="联通",
            ))
            db.commit()
        finally:
            db.close()

        summary = sync.sync_tasks("河源", "联通")

        assert summary["pulled"] == 1 and summary["pushed"] == 1
        assert "t-remote" in server  # 镜像不会被反向改写/上传
        assert server["t-remote"].get("result") is None
        assert "t-local" in server  # 本机任务已上行
        assert server["t-local"]["result"] == {"results": []}

        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-remote").first()
            assert mirror is not None and mirror.origin == "shared"
            assert mirror.result_json is None  # 结果不预下载
        finally:
            db.close()

        # 服务器删除镜像任务 → 下次同步清掉本机镜像行
        server.pop("t-remote")
        sync.sync_tasks("河源", "联通")
        db = temp_db()
        try:
            assert db.query(TaskResult).filter(TaskResult.task_id == "t-remote").first() is None
            # 已上行过的本机任务不会重复上传
            assert db.query(TaskResult).filter(TaskResult.task_id == "t-local").first() is not None
        finally:
            db.close()

        # 本地删除一个共享任务 → 记录待上行删除并传播
        sync.queue_task_delete("t-local")
        sync.sync_tasks("河源", "联通")
        assert sync.load_state()["task_deletes"] == []
    finally:
        monkeypatch_.undo()


def _task_row(**kw):
    """构造一条 TaskResult 行参数。"""
    base = dict(
        task_id="t-x", task_type="pci", task_name="任务", user_name="alice",
        status="completed", progress=100.0, created_at="2026-10-08T08:00:00",
        city="河源", operator="联通",
    )
    base.update(kw)
    return base


def _patch_cloud(monkeypatch_, cloud, manifest_items, uploads=None, deletes=None):
    """把云端三个接口换成内存实现，返回可变的 server 列表。"""
    server = {"items": {str(i["task_id"]): dict(i) for i in manifest_items},
              "total": None, "uploads": [], "deletes": []}
    if uploads is not None:
        server["uploads"] = uploads
    if deletes is not None:
        server["deletes"] = deletes

    def _manifest():
        data = {"items": [dict(v) for v in server["items"].values()]}
        if server["total"] is not None:
            data["total"] = server["total"]
        return data

    def _upload(task, result=None):
        server["uploads"].append(task["task_id"])
        server["items"][task["task_id"]] = {k: v for k, v in task.items() if k != "result"}
        return {"task_id": task["task_id"]}

    monkeypatch_.setattr(cloud, "shared_tasks_manifest", _manifest)
    monkeypatch_.setattr(cloud, "upload_shared_task", _upload)
    monkeypatch_.setattr(cloud, "delete_shared_task", lambda tid: server["deletes"].append(tid) or {"deleted": True})
    return server


def test_sync_tasks_prunes_pushed_local_task_deleted_remotely(desktop_task_env, temp_db):
    """本机新建并已上行过的任务，被同组其他端删除后本机也要清理（否则永久残留）。"""
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [])
    try:
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-local", origin="local",
                                          result_json=json.dumps({"results": []}))))
            db.commit()
        finally:
            db.close()

        sync.sync_tasks("河源", "联通")  # 上行（只推一次）
        assert "t-local" in server["items"]

        # 网页端删除该记录 → 清单里没有了 → 本机应删除（且不会被当成"本机新建"再推一次）
        server["items"].pop("t-local")
        summary = sync.sync_tasks("河源", "联通")

        assert summary["deleted"] == 1
        db = temp_db()
        try:
            assert db.query(TaskResult).filter(TaskResult.task_id == "t-local").first() is None
        finally:
            db.close()
        assert sync.load_state()["tasks_pushed"] == []
    finally:
        monkeypatch_.undo()


def test_sync_tasks_syncs_applied_flag_both_ways(desktop_task_env, temp_db):
    """已应用标记双向同步：服务器置 1 → 本机显示；本机待上行更新不被服务器旧值冲掉。"""
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [
        {"task_id": "t-mirror", "task_type": "pci", "task_name": "镜像任务",
         "user_name": "bob", "status": "completed", "is_applied": False,
         "created_at": "2026-10-08T09:00:00", "completed_at": None,
         "city": "河源", "operator": "联通"},
    ])
    try:
        # 本机自建并已上行、且刚应用（待上行更新）
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-local", origin="local", is_applied=1,
                                          result_json=json.dumps({"results": []}))))
            db.commit()
        finally:
            db.close()
        sync.sync_tasks("河源", "联通")          # 上行 t-local（is_applied=True）
        sync.queue_task_update("t-local")        # 模拟"刚应用、待上行"

        # 网页端标记镜像任务为已应用
        server["items"]["t-mirror"]["is_applied"] = True
        summary = sync.sync_tasks("河源", "联通")
        assert summary["updated"] >= 1

        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-mirror").first()
            assert mirror is not None and int(mirror.is_applied) == 1
            local = db.query(TaskResult).filter(TaskResult.task_id == "t-local").first()
            # 本机待上行更新不被服务器旧值（False）覆盖
            assert local is not None and int(local.is_applied) == 1
        finally:
            db.close()

        # 服务器重置标记（如重新导入工参后清空）→ 本机同步回 0
        server["items"]["t-mirror"]["is_applied"] = False
        sync.sync_tasks("河源", "联通")
        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-mirror").first()
            assert mirror is not None and int(mirror.is_applied) == 0
        finally:
            db.close()
    finally:
        monkeypatch_.undo()


def test_sync_tasks_keeps_mirrors_when_manifest_truncated(desktop_task_env, temp_db):
    """清单被 LIMIT 截断时不得按清单删除本地镜像（老任务会被误删）。"""
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [])
    try:
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-old", origin="shared", task_name="老任务")))
            db.commit()
        finally:
            db.close()

        # total=5 但只回了 1 条（截断）→ 不在清单里的镜像必须保留
        server["total"] = 5
        server["items"]["t-new"] = {
            "task_id": "t-new", "task_type": "tac", "task_name": "新任务", "user_name": "bob",
            "status": "completed", "is_applied": False, "created_at": "2026-10-08T10:00:00",
            "completed_at": None, "city": "河源", "operator": "联通",
        }
        sync.sync_tasks("河源", "联通")

        db = temp_db()
        try:
            assert db.query(TaskResult).filter(TaskResult.task_id == "t-old").first() is not None
            assert db.query(TaskResult).filter(TaskResult.task_id == "t-new").first() is not None
        finally:
            db.close()
    finally:
        monkeypatch_.undo()


def test_list_task_history_applied_flag_for_mirror_rows(temp_db):
    """镜像行（结果未落地本机）也要能显示"已应用"——回退到同组同步来的标记。"""
    db = temp_db()
    try:
        db.add(TaskResult(**_task_row(task_id="t-mirror-applied", origin="shared", is_applied=1)))
        db.add(TaskResult(**_task_row(task_id="t-mirror-plain", origin="shared", is_applied=0)))
        db.commit()
    finally:
        db.close()

    history = task_manager.list_task_history(task_type="pci", page=1, page_size=10)
    by_id = {t["taskId"]: t for t in history["tasks"]}
    assert by_id["t-mirror-applied"]["isApplied"] is True
    assert by_id["t-mirror-plain"]["isApplied"] is False
