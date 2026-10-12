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

from app.models.database import Base, Sector, Site, TaskResult, Workbook
from app.services.task_manager import TaskManager, task_manager

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

def test_data_changes_fingerprint_includes_shared_tasks(cloud_env, temp_db):  # noqa: F811
    """长轮询指纹必须包含组内共享任务历史（新增/删除/应用标记）。

    否则同组另一端的删除/新任务/应用标记只能等 1 分钟兜底轮询才同步
    （用户报"B 端过一会才同步"）。
    """
    license_file = _issue(cloud_env)
    _bind_group(cloud_env, license_file, city="广州", operator="移动")
    client = cloud_env.client
    cred = {"license_file": license_file, "machine_code": MACHINE}

    baseline = client.post(
        "/api/v1/desktop-cloud/data/changes", json={**cred, "wait_seconds": 0}
    ).json()["data"]["fingerprint"]

    # 1) 新增共享任务 → 指纹变化（同组桌面端的长轮询立刻返回）
    up = client.post(
        "/api/v1/desktop-cloud/data/tasks/t-wh-1",
        json={**cred, "task": {"task_id": "t-wh-1", "task_type": "pci", "status": "completed",
                               "created_at": "2026-10-12T21:38:00"},
              "result": {"results": []}},
    )
    assert up.status_code == 200, up.text
    after_create = client.post(
        "/api/v1/desktop-cloud/data/changes",
        json={**cred, "since": baseline, "wait_seconds": 0},
    ).json()["data"]
    assert after_create["changed"] is True and after_create["fingerprint"] != baseline

    # 2) 删除同样算变化（B 端要能很快看到记录消失）
    deleted = client.post("/api/v1/desktop-cloud/data/tasks/t-wh-1/delete", json=cred)
    assert deleted.status_code == 200, deleted.text
    after_delete = client.post(
        "/api/v1/desktop-cloud/data/changes",
        json={**cred, "since": after_create["fingerprint"], "wait_seconds": 0},
    ).json()["data"]
    assert after_delete["changed"] is True


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
    """已应用标记双向同步：服务器置 1 → 本机显示；本机为 1 而服务器是 0 → 不回落并上行修复。

    「已应用」无撤销语义：服务器为 0 只代表"从没应用过"（旧版服务器还会丢这个标记），
    本机为 1 时以本机为准，把 1 上行到服务器（单调置位）。
    """
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
        # 本机自建并已应用（is_applied=1）
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-local", origin="local", is_applied=1,
                                          result_json=json.dumps({"results": []}))))
            db.commit()
        finally:
            db.close()
        sync.sync_tasks("河源", "联通")          # 上行 t-local（is_applied=True）
        assert server["items"]["t-local"]["is_applied"] is True

        # 网页端标记镜像任务为已应用 → 本机镜像随同步置 1
        server["items"]["t-mirror"]["is_applied"] = True
        summary = sync.sync_tasks("河源", "联通")
        assert summary["updated"] >= 1

        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-mirror").first()
            assert mirror is not None and int(mirror.is_applied) == 1
        finally:
            db.close()

        # 服务器丢失标记（旧版服务器忽略 is_applied / 库里被清 0）：
        # 本机不回落，并把本机「已应用」重新上行
        server["items"]["t-mirror"]["is_applied"] = False
        server["items"]["t-local"]["is_applied"] = False
        sync.sync_tasks("河源", "联通")

        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-mirror").first()
            local = db.query(TaskResult).filter(TaskResult.task_id == "t-local").first()
            assert mirror is not None and int(mirror.is_applied) == 1
            assert local is not None and int(local.is_applied) == 1
        finally:
            db.close()
        assert server["items"]["t-mirror"]["is_applied"] is True
        assert server["items"]["t-local"]["is_applied"] is True
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


def test_list_shared_tasks_includes_result_size(temp_db):
    """清单要带结果体积：桌面端据此决定能否预拉取（小结果才拉）。"""
    task_manager.upsert_shared_task(
        {"task_id": "t-size-1", "task_type": "pci", "task_name": "PCI", "user_name": "alice",
         "status": "completed", "created_at": "2026-10-12T10:00:00",
         "result": {"results": [{"siteId": "S1"}]}},
        city="河源", operator="联通",
    )
    task_manager.upsert_shared_task(
        {"task_id": "t-size-2", "task_type": "pci", "task_name": "无结果", "user_name": "alice",
         "status": "completed", "created_at": "2026-10-12T09:00:00"},
        city="河源", operator="联通",
    )
    sizes = {t["task_id"]: t["result_size"] for t in task_manager.list_shared_tasks("河源", "联通")}
    assert sizes["t-size-1"] > 0
    assert sizes["t-size-2"] == 0


def test_sync_tasks_prepulls_small_shared_results(desktop_task_env, temp_db, monkeypatch):
    """镜像任务的小结果要预拉取，让「已应用」从第一眼起就按当前工参动态判定。

    不预拉取时镜像行只能沿用同组同步来的标记（别端按它自己的工参判定，工参变更后
    也不会更新）；点「查看」把结果按需拉到本机后判定来源切换 → 状态跳变。
    """
    sync = desktop_task_env
    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud
    from app.services.data_service import data_service

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(sync, "is_shared", lambda: True)

    # 本机全量工参：S1_32 的 PCI/TAC 与 t-small 的规划值一致
    wb_id = "wb-prepull"
    db = temp_db()
    try:
        db.add(Workbook(id=wb_id, user_id=1, city="河源", operator="联通", name="全量工参",
                        file_type="full_params", status="completed",
                        created_at="2026-10-12T00:00:00"))
        db.flush()
        site = Site(workbook_id=wb_id, user_id=1, city="河源", operator="联通",
                    site_id="S1", name="站点S1", network_type="LTE")
        db.add(site)
        db.flush()
        db.add(Sector(workbook_id=wb_id, user_id=1, site_id_fk=site.id,
                      sector_id="32", pci=486, tac="33807"))
        db.commit()
    finally:
        db.close()
    monkeypatch.setattr(
        TaskManager, "_resolve_full_params_id",
        staticmethod(lambda city=None, operator=None: wb_id),
    )
    monkeypatch.setattr(data_service, "index", {wb_id: {"fileType": "full_params",
                                                        "city": "河源", "operator": "联通"}})
    TaskManager._sector_values_cache = {}
    TaskManager._history_verify_cache.clear()

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [
        {"task_id": "t-small", "task_type": "pci", "task_name": "小 PCI", "user_name": "bob",
         "status": "completed", "is_applied": False, "cell_count": 1, "result_size": 1200,
         "created_at": "2026-10-12T09:00:00", "completed_at": None,
         "city": "河源", "operator": "联通"},
        {"task_id": "t-big", "task_type": "pci", "task_name": "大 PCI", "user_name": "bob",
         "status": "completed", "is_applied": False, "cell_count": 90000,
         "result_size": 9 * 1024 * 1024,
         "created_at": "2026-10-12T08:00:00", "completed_at": None,
         "city": "河源", "operator": "联通"},
        {"task_id": "t-check", "task_type": "tac", "task_name": "TAC 核查", "user_name": "bob",
         "status": "completed", "is_applied": False, "cell_count": 18000,
         "result_size": 6 * 1024 * 1024,
         "created_at": "2026-10-12T07:00:00", "completed_at": None,
         "city": "河源", "operator": "联通"},
    ])
    pulls: list = []

    def _result(task_id):
        pulls.append(task_id)
        return {"result": {"results": [
            {"siteId": "S1", "sectors": [{"sectorId": "32", "newPCI": 486, "tac": "33807"}]},
        ]}}

    monkeypatch_.setattr(cloud, "shared_task_result", _result)
    try:
        summary = sync.sync_tasks("河源", "联通")

        assert pulls == ["t-small"]              # 只预拉取可判定类型里体积可控的结果
        assert summary["results_pulled"] == 1
        db = temp_db()
        try:
            rows = {r.task_id: r for r in db.query(TaskResult).all()}
        finally:
            db.close()
        assert rows["t-small"].result_json is not None
        assert rows["t-big"].result_json is None    # 体积过大仍按需拉取
        assert rows["t-check"].result_json is None  # 不展示应用状态的类型不预拉取

        # 结果落地后镜像行立即按当前工参判定：规划值与工参一致 → 已应用
        # （若沿用同步标记则是"未应用"，正是"查看前后跳变"的来源）
        history = task_manager.list_task_history(task_type="pci", page=1, page_size=10)
        by_id = {t["taskId"]: t for t in history["tasks"]}
        assert by_id["t-small"]["isApplied"] is True
        assert by_id["t-big"]["isApplied"] is False
    finally:
        monkeypatch_.undo()
        TaskManager._sector_values_cache = {}
        TaskManager._history_verify_cache.clear()


# ---------------------------------------------------------------- 应用标记落库 / 小数量

def test_upsert_shared_task_persists_is_applied_monotonically(temp_db):
    """桌面端应用后上行 is_applied=True 必须落库；已应用无撤销语义，不回落。"""
    base = {"task_id": "t-applied", "task_type": "pci", "task_name": "PCI",
            "user_name": "alice", "status": "completed", "created_at": "2026-10-09T10:00:00"}
    task_manager.upsert_shared_task({**base, "is_applied": True}, city="河源", operator="联通")
    assert task_manager.list_shared_tasks("河源", "联通")[0]["is_applied"] is True

    # 后续上行未携带 True（如镜像任务元数据更新）不得把标记冲回 False
    task_manager.upsert_shared_task({**base, "is_applied": False}, city="河源", operator="联通")
    assert task_manager.list_shared_tasks("河源", "联通")[0]["is_applied"] is True


def test_shared_task_cell_count_roundtrip(temp_db):
    """小数量走元数据（镜像任务上行没有完整 result），历史列表镜像行回退显示。"""
    meta = task_manager.upsert_shared_task(
        {"task_id": "t-cell-1", "task_type": "pci", "task_name": "PCI", "user_name": "alice",
         "status": "completed", "created_at": "2026-10-09T10:00:00", "cell_count": 42},
        city="河源", operator="联通",
    )
    assert meta["cell_count"] == 42
    assert task_manager.list_shared_tasks("河源", "联通")[0]["cell_count"] == 42

    # 没有显式字段时从完整结果提取
    meta2 = task_manager.upsert_shared_task(
        {"task_id": "t-cell-2", "task_type": "tac", "task_name": "核查", "user_name": "bob",
         "status": "completed", "created_at": "2026-10-09T10:00:00",
         "result": {"results": [{"a": 1}, {"a": 2}, {"a": 3}]}},
        city="河源", operator="联通",
    )
    assert meta2["cell_count"] == 3

    # 镜像行（本机无结果）→ resultSummary 带归一化 cellCount，供列表「小区数量」列显示
    history = task_manager.list_task_history(task_type="pci", page=1, page_size=10)
    row = next(t for t in history["tasks"] if t["taskId"] == "t-cell-1")
    assert row["resultSummary"] == {"cellCount": 42}


def test_sync_tasks_mirrors_and_uploads_cell_count(desktop_task_env, temp_db):
    """镜像行写入服务器小数量；本机任务上行携带小数量。"""
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [
        {"task_id": "t-remote-cells", "task_type": "tac_planning", "task_name": "远端",
         "user_name": "bob", "status": "completed", "is_applied": False, "cell_count": 88,
         "created_at": "2026-10-09T09:00:00", "completed_at": None,
         "city": "河源", "operator": "联通"},
    ])
    try:
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-local-cells", origin="local", cell_count=7,
                                          result_json=json.dumps({"results": []}))))
            db.commit()
        finally:
            db.close()

        sync.sync_tasks("河源", "联通")

        db = temp_db()
        try:
            mirror = db.query(TaskResult).filter(TaskResult.task_id == "t-remote-cells").first()
            assert mirror is not None and int(mirror.cell_count) == 88
        finally:
            db.close()
        assert server["items"]["t-local-cells"]["cell_count"] == 7
    finally:
        monkeypatch_.undo()


def test_queue_shared_task_update_schedules_immediate_sync(monkeypatch, temp_db):
    """入队后要立刻安排同步，否则同组用户要等 1 分钟兜底轮询才看到应用标记。"""
    from app.core.config import settings
    from app.services import desktop_sync_service as sync

    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(sync, "is_shared", lambda: True)
    queued, scheduled = [], []
    monkeypatch.setattr(sync, "queue_task_update", lambda tid: queued.append(tid))
    monkeypatch.setattr(sync, "schedule_sync", lambda *a, **k: scheduled.append(True))

    task_manager._queue_shared_task_update("t-abc", "pci")
    assert queued == ["t-abc"] and scheduled == [True]

    # 非共享任务类型不参与
    queued.clear()
    scheduled.clear()
    task_manager._queue_shared_task_update("t-apply", "apply_pci")
    assert queued == [] and scheduled == []


# ---------------------------------------------------------------- 存量「已应用」回填

def test_sync_tasks_does_not_remirror_pending_deleted_task(desktop_task_env, temp_db):
    """本机刚删除的任务不能被本轮清单快照重建回本机（用户报"删掉又回来了"）。

    删除意图下行到服务器之前，本轮开头取的清单里还带着它：旧逻辑按"清单里有、
    本机没有"重建镜像行 → 用户看到删除的任务复活（要等删除上行后的下一轮才消失）。
    这里同时覆盖两种残留：真的没有本机行（刚删）与上一轮被清单建回来的行。
    """
    sync = desktop_task_env
    from app.services import desktop_cloud_client as cloud

    def _item(task_id, name):
        return {"task_id": task_id, "task_type": "pci", "task_name": name, "user_name": "bob",
                "status": "completed", "is_applied": False, "cell_count": 3,
                "created_at": "2026-10-12T21:38:00", "completed_at": None,
                "city": "河源", "operator": "联通"}

    monkeypatch_ = pytest.MonkeyPatch()
    server = _patch_cloud(monkeypatch_, cloud, [
        _item("t-doomed", "刚删除、本机无行"),
        _item("t-residue", "待删但本机还残留行"),
    ])

    def _delete(tid):
        server["deletes"].append(tid)
        server["items"].pop(tid, None)  # 服务器真的删掉（下一轮清单里就没有了）
        return {"deleted": True}

    monkeypatch_.setattr(cloud, "delete_shared_task", _delete)
    try:
        # 两个任务都是"本机已删、删除意图待上行"
        sync.queue_task_delete("t-doomed")
        sync.queue_task_delete("t-residue")
        # t-residue 还残留着上一轮（或旧版本）按清单重建出来的镜像行
        db = temp_db()
        try:
            db.add(TaskResult(**_task_row(task_id="t-residue", origin="shared")))
            db.commit()
        finally:
            db.close()

        sync.sync_tasks("河源", "联通")

        db = temp_db()
        try:
            left = {r.task_id for r in db.query(TaskResult).all()}
        finally:
            db.close()
        assert "t-doomed" not in left      # 不能被清单重建回来
        assert "t-residue" not in left     # 残留行要清掉
        assert sorted(server["deletes"]) == ["t-doomed", "t-residue"]
        assert sync.load_state()["task_deletes"] == []

        # 下一轮：服务器清单里已无这两个任务，本机也保持没有
        sync.sync_tasks("河源", "联通")
        db = temp_db()
        try:
            left = {r.task_id for r in db.query(TaskResult).all()}
        finally:
            db.close()
        assert left == set()
    finally:
        monkeypatch_.undo()


def test_shared_task_mutations_notify_group(temp_db, monkeypatch):
    """共享任务的新增/删除/应用标记要广播 tasks_changed（同组网页端历史列表即时刷新）。"""
    import app.services.websocket_manager as ws

    calls: list = []
    monkeypatch.setattr(
        ws.websocket_manager, "notify_tasks_changed",
        lambda city, operator, task_id="": calls.append((city, operator, task_id)),
    )

    task_manager.upsert_shared_task(
        {"task_id": "t-notify", "task_type": "pci", "status": "completed",
         "created_at": "2026-10-12T21:00:00"},
        city="河源", operator="联通",
    )
    assert calls == [("河源", "联通", "t-notify")]

    calls.clear()
    assert task_manager.mark_task_applied("t-notify") is True
    assert calls == [("河源", "联通", "t-notify")]

    calls.clear()
    assert task_manager.delete_shared_task("t-notify", "河源", "联通") is True
    assert calls == [("河源", "联通", "t-notify")]


def test_backfill_applied_flags_marks_matching_results(temp_db, monkeypatch):
    """存量回填：结果与当前工参一致 → 置 1；不一致 / 无可比值的类型 → 不动。"""
    db = temp_db()
    try:
        db.add(TaskResult(**_task_row(task_id="t-ok", result_json=json.dumps({
            "results": [{"siteId": "S1", "sectorId": "1", "tac": 100}],
        }))))
        db.add(TaskResult(**_task_row(task_id="t-diff", result_json=json.dumps({
            "results": [{"siteId": "S1", "sectorId": "1", "tac": 999}],
        }))))
        # neighbor 类型不在回填范围（结果不含 PCI/TAC 值，误判会把全部邻区任务标成已应用）
        db.add(TaskResult(**_task_row(
            task_id="t-nb", task_type="neighbor",
            result_json=json.dumps({"results": [{"siteId": "S1", "sectorId": "1"}]}),
        )))
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(
        type(task_manager),
        "_load_current_sector_values",
        staticmethod(lambda db, city=None, operator=None: {"S1_1": {"pci": 10, "tac": 100}}),
    )
    updated = task_manager.backfill_applied_flags()
    assert updated == 1

    db = temp_db()
    try:
        flags = {r.task_id: int(r.is_applied or 0) for r in db.query(TaskResult).all()}
    finally:
        db.close()
    assert flags == {"t-ok": 1, "t-diff": 0, "t-nb": 0}
