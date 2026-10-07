"""桌面端共享模式同步服务（仅 NPT_DESKTOP=1 的本机后端使用）。

模型：服务器是数据真源，桌面端保留本地全量镜像，按「数据集」粒度同步。

- 服务器只认 Ed25519 签名许可（桌面端没有账号），许可 ⇒ 授权 ⇒ 数据组
- 本地任何改变数据集内容的写入都会标记 dirty（`mark_dirty`），下次同步上行
- 服务器侧修订号变化且本地 clean → 下载覆盖本地；本地 dirty 且服务器也变了 → 冲突，
  由用户在界面上选「取服务器」/「覆盖服务器」（不做行级合并）
- 本地化保存、不参与同步：用户设置、地图偏好、任务历史、装饰图层
"""
from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings

MODE_SHARED = "shared"
MODE_OFFLINE = "offline"

_sync_lock = threading.Lock()
# 同步进行中标记（供前端展示"同步中"动画，读状态接口直接取）
_sync_running = False


class SyncError(Exception):
    """同步失败（网络/授权/服务器拒绝）。"""


# ---------------------------------------------------------------- 本地状态

def state_file() -> Path:
    return settings.DATA_ROOT / "sync_state.json"


def _default_state() -> Dict[str, Any]:
    return {
        "run_mode": MODE_OFFLINE,   # 默认离线，用户显式切换到共享才联网
        "username": None,           # 当前登录账号（后台同步取数据组用）
        "datasets": {},             # data_id -> {rev, sha256, dirty, last_sync_at}
        "pending_deletes": [],      # 本地已删、待上行删除的数据集 id
        "conflicts": [],            # [{data_id, name, server_rev, local_rev}]
        "last_sync_at": None,
        "last_result": None,
        "last_error": None,
    }


def load_state() -> Dict[str, Any]:
    path = state_file()
    if not path.is_file():
        return _default_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return _default_state()
    base = _default_state()
    base.update(data)
    base["datasets"] = base.get("datasets") or {}
    base["pending_deletes"] = base.get("pending_deletes") or []
    base["conflicts"] = base.get("conflicts") or []
    return base


def save_state(patch: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Dict[str, Any]:
    state = load_state()
    if patch:
        state.update(patch)
    if kwargs:
        state.update(kwargs)
    datasets = state["datasets"]
    for item in list(state["conflicts"]):
        if item.get("data_id") not in datasets:
            state["conflicts"].remove(item)
    try:
        state_file().parent.mkdir(parents=True, exist_ok=True)
        state_file().write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return state


# ---------------------------------------------------------------- 模式

def run_mode() -> str:
    mode = (load_state().get("run_mode") or MODE_OFFLINE).lower()
    return MODE_SHARED if mode == MODE_SHARED else MODE_OFFLINE


def is_shared() -> bool:
    return run_mode() == MODE_SHARED


def set_run_mode(mode: str) -> str:
    normalized = MODE_SHARED if str(mode).lower() == MODE_SHARED else MODE_OFFLINE
    save_state(run_mode=normalized)
    return normalized


# ---------------------------------------------------------------- dirty 标记

def mark_dirty(data_id: str) -> None:
    """本地数据被改动 → 下次同步上传到服务器。数据 id 不存在（例如刚删除）时忽略。"""
    if not data_id:
        return
    state = load_state()
    datasets = state["datasets"]
    entry = datasets.get(data_id) or {}
    entry["dirty"] = True
    datasets[data_id] = entry
    save_state(datasets=datasets)


def mark_local_deleted(data_id: str) -> None:
    """本地数据集被删除 → 记录待上行删除（否则服务器会把它当成新数据推回来）。"""
    if not data_id:
        return
    state = load_state()
    datasets = state["datasets"]
    datasets.pop(data_id, None)
    pending = [d for d in state["pending_deletes"] if d != data_id]
    pending.append(data_id)
    save_state(datasets=datasets, pending_deletes=pending)


_pulling_ids: set = set()
_pulling_lock = threading.Lock()


class _PullingGuard:
    """装包（pull）期间：由同步自己引发的写入不算「本地改动」。

    整包安装是「先删后插」，会触发 delete/insert 两条写入记账；若照常标记 dirty，
    刚拉下来的数据会被立刻当成待上传，与服务器来回互相覆盖（rev 抖动）。
    """

    def __init__(self, data_id: str) -> None:
        self.data_id = data_id

    def __enter__(self) -> None:
        with _pulling_lock:
            _pulling_ids.add(self.data_id)

    def __exit__(self, *exc: Any) -> None:
        with _pulling_lock:
            _pulling_ids.discard(self.data_id)


def _is_pulling(data_id: str) -> bool:
    with _pulling_lock:
        return data_id in _pulling_ids


def note_change(data_id: str, deleted: bool = False) -> None:
    """记录本地数据改动（供业务写入路径调用），并尽快触发一次上行同步。

    非桌面模式下什么都不做。同步走防抖：连续写入（例如批量保存图层）只上行一次。
    """
    if not settings.NPT_DESKTOP or not data_id:
        return
    if _is_pulling(data_id):
        return  # 同步装包引起的写入，跳过记账
    try:
        if deleted:
            mark_local_deleted(data_id)
        else:
            mark_dirty(data_id)
    except Exception:  # noqa: BLE001
        pass  # 旁路记账，绝不能影响业务写入
    try:
        schedule_sync()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 同步调度

_sync_timer: Optional[threading.Timer] = None
_sync_timer_lock = threading.Lock()


def _sync_timer_tick() -> None:
    try:
        sync_once()
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopSync] 即时同步失败（忽略）：{exc}")


def schedule_sync(delay_seconds: Optional[float] = None) -> None:
    """本地改动后防抖触发一次同步（共享模式才联网，单机/离线直接跳过）。"""
    global _sync_timer
    if not settings.NPT_DESKTOP or not is_shared():
        return
    delay = float(
        delay_seconds if delay_seconds is not None
        else (getattr(settings, "NPT_DESKTOP_SYNC_DEBOUNCE_SECONDS", 3) or 3)
    )
    with _sync_timer_lock:
        if _sync_timer is not None:
            _sync_timer.cancel()
        timer = threading.Timer(delay, _sync_timer_tick)
        timer.daemon = True
        _sync_timer = timer
        timer.start()


def forget(data_id: str) -> None:
    """彻底遗忘某数据集的本地同步记录（服务器已删除、本地镜像也随之删除时用）。

    必须同时清 pending_deletes：否则 delete_data 触发的 mark_local_deleted
    会让本机再向服务器请求删除一次（虽幂等，但会让墓碑反复推进）。
    """
    if not data_id:
        return
    state = load_state()
    state["datasets"].pop(data_id, None)
    state["pending_deletes"] = [d for d in (state.get("pending_deletes") or []) if d != data_id]
    state["conflicts"] = [c for c in (state.get("conflicts") or []) if c.get("data_id") != data_id]
    save_state(state)


def record_synced(data_id: str, rev: int, sha256: Optional[str] = None) -> None:
    """记录"该数据集已与服务器一致"。

    必须同时清掉待上行删除：整包安装（pull）内部是「先删后插」，删除会记一次
    本地删除意图，若不同步清掉，下一轮同步会把刚拉下来的数据集又从服务器删掉。
    """
    state = load_state()
    datasets = state["datasets"]
    datasets[data_id] = {
        "rev": int(rev or 0),
        "sha256": sha256 or datasets.get(data_id, {}).get("sha256"),
        "dirty": False,
        "last_sync_at": datetime.now().isoformat(timespec="seconds"),
    }
    pending = [d for d in (state.get("pending_deletes") or []) if d != data_id]
    save_state(datasets=datasets, pending_deletes=pending)


# ---------------------------------------------------------------- 上下文

def _local_group() -> tuple:
    """本机当前登录账号及其数据组。

    同步跑在后台线程里拿不到请求上下文，因此登录时把用户名记在 sync_state，
    这里据此取账号（桌面端与网页端共用账号，组归属即账号的组）。
    """
    from app.core.database import SessionLocal
    from app.models.database import User

    username = (load_state().get("username") or "").strip()
    db = SessionLocal()
    try:
        query = db.query(User).filter(User.is_desktop_shadow == False)  # noqa: E712
        user = (
            query.filter(User.username == username).first() if username else None
        ) or query.filter(User.desktop_run_mode.isnot(None)).first()
        if user is None:
            raise SyncError("本机尚未登录，请先登录后再同步")
        return user, (user.city or ""), (user.operator or "")
    finally:
        db.close()


def _require_active_license() -> None:
    from app.services.license_service import license_service

    info = license_service.desktop_license_info() or {}
    if not info.get("valid"):
        raise SyncError("本机尚未激活或授权已过期，共享模式需要先在线激活")


def _license_file_text() -> str:
    from app.services.license_service import license_service

    path = license_service._signed_license_file()
    if not path.is_file():
        raise SyncError("本机尚未激活，请先在线激活或导入授权文件")
    return path.read_text(encoding="utf-8")


def _sync_group(user, city: str, operator: str) -> Dict[str, Any]:
    """与服务器握手段：确定组；服务器锁定时纠正本地组。"""
    from app.services import desktop_cloud_client as cloud

    session = cloud.sync_session(city, operator)
    group = session.get("group") or {}
    server_city = group.get("city") or ""
    server_operator = group.get("operator") or ""
    if session.get("group_locked") and (server_city != city or server_operator != operator):
        _apply_local_group(user, server_city, server_operator)
        city, operator = server_city, server_operator
    elif not city or not operator:
        if server_city and server_operator:
            _apply_local_group(user, server_city, server_operator)
            city, operator = server_city, server_operator
        else:
            raise SyncError("尚未选择数据组（地市+运营商），请先在设置中选择")
    return {"group": {"city": city, "operator": operator}, **session}


def _apply_local_group(user, city: str, operator: str) -> None:
    """改写本机账号的组并迁移存量数据（与网页端改组同一套语义）。"""
    from app.core.database import SessionLocal
    from app.models.database import User

    db = SessionLocal()
    try:
        row = db.query(User).filter(User.id == user.id).first()
        if row is None:
            raise SyncError("本机桌面账号缺失")
        old_city, old_operator = row.city, row.operator
        if (old_city, old_operator) == (city, operator):
            return
        row.city = city
        row.operator = operator
        db.commit()
        if old_city and old_operator:
            from app.services.data_group import migrate_group_data

            _move_group_data(db, row, old_city, old_operator, city, operator)
    finally:
        db.close()


def _move_group_data(db, row, old_city: str, old_operator: str, city: str, operator: str) -> None:
    from app.services.data_group import migrate_group_data

    migrate_group_data(
        db, user_id=row.id, username=row.username,
        old_city=old_city, old_operator=old_operator,
        new_city=city, new_operator=operator, scope="user",
    )


# ---------------------------------------------------------------- 单次同步

def _pull(
    data_id: str, user, city: str, operator: str, server_rev: int = 0
) -> Dict[str, Any]:
    """从服务器下载整包并落到本机（install_package 内部先删后插，不会重复入库）。"""
    import shutil

    from app.services import desktop_cloud_client as cloud
    from app.services.desktop_dataset_packager import install_package

    tmp_zip = cloud.download_package(data_id)
    try:
        with _PullingGuard(data_id):
            install_package(
                tmp_zip, user_id=user.id, city=city, operator=operator, username=user.username
            )
    finally:
        shutil.rmtree(tmp_zip.parent, ignore_errors=True)

    # 记录的是服务器修订号（本地 dataset_revisions 表的数字是本机自己的，不能拿来做基线）
    record_synced(data_id, server_rev)
    return {"data_id": data_id, "action": "pull", "rev": server_rev}


def _push(data_id: str, expected_rev: int) -> Dict[str, Any]:
    """把本地数据集整包上传（带基地修订号乐观锁）。"""
    from app.services import desktop_cloud_client as cloud
    from app.services.desktop_dataset_packager import build_package

    package = build_package(data_id)
    try:
        result = cloud.upload_package(
            data_id, package["path"], base_rev=expected_rev
        )
    finally:
        try:
            import shutil

            shutil.rmtree(package["path"].parent, ignore_errors=True)
        except Exception:
            pass
    rev = int((result or {}).get("rev") or 0)
    record_synced(data_id, rev)
    return {"data_id": data_id, "action": "push", "rev": rev}


def sync_once() -> Dict[str, Any]:
    """执行一次完整同步。返回统计结果（不抛异常，错误写入 state.last_error）。"""
    global _sync_running
    if not settings.NPT_DESKTOP:
        return {"skipped": True, "reason": "非桌面模式"}
    if not is_shared():
        return {"skipped": True, "reason": "当前为离线模式"}
    if not _sync_lock.acquire(blocking=False):
        return {"skipped": True, "reason": "上一次同步尚未结束"}

    _sync_running = True
    summary: Dict[str, Any] = {"pulled": 0, "pushed": 0, "deleted": 0, "conflicts": 0, "errors": []}
    try:
        _require_active_license()
        from app.services import desktop_cloud_client as cloud
        from app.services.data_service import data_service

        user, city, operator = _local_group()
        session = _sync_group(user, city, operator)
        city = session["group"]["city"]
        operator = session["group"]["operator"]

        manifest = cloud.sync_manifest()
        items = {i["data_id"]: i for i in (manifest.get("items") or [])}
        local_state = load_state()
        datasets_state = local_state["datasets"]

        # 1. 服务器 → 本地
        for data_id, item in items.items():
            if item.get("deleted"):
                if data_id in data_service.index and not (datasets_state.get(data_id) or {}).get("dirty"):
                    data_service.delete_data(data_id, force=True)
                    forget(data_id)  # delete_data 会记 pending_delete，这里要一并清掉
                    summary["deleted"] += 1
                continue
            local_entry = datasets_state.get(data_id)
            server_rev = int(item.get("rev") or 0)
            if data_id not in data_service.index:
                name = item.get("name") or data_id
                try:
                    _pull(data_id, user, city, operator, server_rev)
                    summary["pulled"] += 1
                    summary.setdefault("details", []).append({"name": name, "action": "pull"})
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"下载「{name}」失败：{exc}")
                continue
            local_rev = int((local_entry or {}).get("rev") or 0)
            name = (data_service.index.get(data_id) or {}).get("name") or data_id
            dirty = (local_entry or {}).get("dirty") or local_entry is None

            if dirty:
                # 本地改过：服务器版本也变了（或本机从未同步过，无基线）→ 交用户选边；
                # 服务器没动过才直接上行（base_rev 乐观锁）。
                if server_rev != local_rev:
                    state = load_state()
                    conflicts = [c for c in state["conflicts"] if c.get("data_id") != data_id]
                    conflicts.append({
                        "data_id": data_id, "name": name,
                        "server_rev": server_rev, "local_rev": local_rev,
                    })
                    save_state(conflicts=conflicts)
                    summary["conflicts"] += 1
                    continue
                try:
                    _push(data_id, local_rev or None)
                    summary["pushed"] += 1
                    summary.setdefault("details", []).append({"name": name, "action": "push"})
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"上传「{name}」失败：{exc}")
                continue

            if server_rev == local_rev:
                continue  # 两边都没动

            try:
                _pull(data_id, user, city, operator, server_rev)
                summary["pulled"] += 1
                summary.setdefault("details", []).append({"name": name, "action": "pull"})
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"更新「{name}」失败：{exc}")

        # 2. 本地 → 服务器（服务器上没有的数据集 = 本机新建）
        for data_id in list(data_service.index.keys()):
            if data_id in items:
                continue
            if not data_service.is_packagable(data_id):
                # 本地只剩空壳（数据体没了）：推不上去也用不了，直接清掉。
                # 否则每轮同步都抱着它失败，界面会一直显示「同步异常」。
                name = (data_service.index.get(data_id) or {}).get("name") or data_id
                data_service.delete_data(data_id, force=True)
                forget(data_id)  # delete_data 会记一次本地删除意图，一并清掉
                summary.setdefault("cleaned", []).append(name)
                summary["deleted"] += 1
                continue
            entry = datasets_state.get(data_id)
            if entry is None or entry.get("dirty"):
                try:
                    _push(data_id, int((entry or {}).get("rev") or 0) or None)
                    summary["pushed"] += 1
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"上传「{data_id}」失败：{exc}")
            else:
                # 服务器已删除且本地没改过 → 清掉本地镜像
                data_service.delete_data(data_id, force=True)
                forget(data_id)
                summary["deleted"] += 1

        # 3. 本地已删除 → 通知服务器
        remaining: List[str] = []
        for data_id in load_state().get("pending_deletes") or []:
            try:
                cloud.delete_dataset(data_id)
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"删除「{data_id}」失败：{exc}")
                remaining.append(data_id)
        save_state(pending_deletes=remaining)

        save_state(
            last_sync_at=datetime.now().isoformat(timespec="seconds"),
            last_result=summary,
            last_error=(summary["errors"][0] if summary["errors"] else None),
        )
        return summary
    except Exception as exc:  # noqa: BLE001
        save_state(last_error=str(exc))
        return {"error": str(exc)}
    finally:
        _sync_running = False
        _sync_lock.release()


def resolve_conflict(data_id: str, resolution: str) -> Dict[str, Any]:
    """冲突选边：server=取服务器版本（丢弃本地修改）；local=用本地覆盖服务器。"""
    user, city, operator = _local_group()
    state = load_state()
    conflict = next((c for c in state["conflicts"] if c.get("data_id") == data_id), None)
    if conflict is None:
        raise SyncError("该冲突已不存在，可能已在别处解决")
    if resolution == "server":
        result = _pull(data_id, user, city, operator, int(conflict.get("server_rev") or 0))
    elif resolution == "local":
        result = _push(data_id, None)  # 不带 base_rev = 强制覆盖服务器当前版本
    else:
        raise SyncError("未知的解决方式")
    save_state(conflicts=[c for c in state["conflicts"] if c.get("data_id") != data_id])
    return result


def status() -> Dict[str, Any]:
    """给前端展示的同步状态。"""
    state = load_state()
    pending = [d for d, v in (state["datasets"] or {}).items() if v.get("dirty")]
    return {
        "desktop": bool(settings.NPT_DESKTOP),
        "run_mode": run_mode(),
        "syncing": bool(_sync_running),
        "server_url": _server_url(),
        "activated": _license_valid(),
        "last_sync_at": state.get("last_sync_at"),
        "last_error": state.get("last_error"),
        "last_result": state.get("last_result"),
        "pending_uploads": len(pending),
        "conflicts": state.get("conflicts") or [],
        "synced_datasets": len([d for d in state["datasets"] if not state["datasets"][d].get("dirty")]),
    }


def _server_url() -> str:
    from app.services import desktop_cloud_client as cloud

    return cloud.server_url()


def _license_valid() -> bool:
    try:
        from app.services.license_service import license_service

        return bool((license_service.desktop_license_info() or {}).get("valid"))
    except Exception:
        return False


# ---------------------------------------------------------------- 后台定时同步

async def sync_loop(interval_minutes: Optional[int] = None) -> None:
    """桌面版共享模式定时同步（失败仅记录日志，不影响本机离线使用）。

    同组其它端（网页端或另一台桌面端）的改动只能靠轮询发现，因此间隔按
    NPT_DESKTOP_SYNC_INTERVAL_MINUTES（默认 1 分钟）走；每次只拉清单比对
    修订号，没有变化就不做整包传输。本机自己的改动另走 note_change 的即时上行。
    """
    import asyncio

    minutes = int(
        interval_minutes if interval_minutes is not None
        else (getattr(settings, "NPT_DESKTOP_SYNC_INTERVAL_MINUTES", 1) or 1)
    )
    await asyncio.sleep(15)  # 启动先让本地服务热身，避免开局抢资源
    while True:
        try:
            if is_shared():
                result = await asyncio.to_thread(sync_once)
                if result.get("error"):
                    print(f"[DesktopSync] 定时同步失败（忽略）：{result['error']}")
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopSync] 定时同步异常（忽略）：{exc}")
        await asyncio.sleep(max(1, minutes) * 60)
