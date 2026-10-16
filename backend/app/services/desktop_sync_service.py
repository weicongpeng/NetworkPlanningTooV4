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
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings

MODE_SHARED = "shared"
MODE_OFFLINE = "offline"

# 镜像任务（本机无结果）的「已应用」状态只能沿用同组同步来的标记，而该标记是别端按
# 它自己的工参判定的：结果按需落地（点「查看」）后本机改走「规划值 vs 当前全量工参」
# 动态比对，就会看到"查看前后状态跳变"，且工参变更后标记也不会自己更新。
# 这两类规划的结果体积都不大（与 TAC 核查的数 MB 不同），直接把结果预拉取到本机，
# 让镜像行与本地任务走同一套动态判定。
PREPULL_RESULT_TYPES = ("pci", "tac_planning")
PREPULL_MAX_SINGLE_BYTES = 8 * 1024 * 1024   # 单条结果超过该体积（病态）仍按需拉取
PREPULL_MAX_TOTAL_BYTES = 16 * 1024 * 1024   # 每轮同步预拉取总量上限，剩余下轮继续
PREPULL_MAX_PER_SYNC = 30  # 每轮同步最多预拉取条数（首轮收敛，之后基本为 0）

_sync_lock = threading.Lock()
# 同步进行中标记（供前端展示"同步中"动画，读状态接口直接取）
_sync_running = False


class SyncError(Exception):
    """同步失败（网络/授权/服务器拒绝）。"""


# ---------------------------------------------------------------- 本地状态

def state_file() -> Path:
    # 同步状态随配置档隔离：共享/单机各一份，切档重启后互不污染
    return settings.PROFILE_ROOT / "sync_state.json"


def _default_state() -> Dict[str, Any]:
    return {
        "run_mode": MODE_OFFLINE,   # 默认离线，用户显式切换到共享才联网
        "username": None,           # 当前登录账号（后台同步取数据组用）
        "datasets": {},             # data_id -> {rev, sha256, dirty, last_sync_at, changed_at, server_updated_at}
        "pending_deletes": [],      # 本地已删、待上行删除的数据集 id
        "deleted_at": {},           # data_id -> 本地删除时间（LWW：服务器更晚则撤销删除）
        "clock_offset_seconds": 0.0,  # 本机时钟与服务器的偏差（服务器时间 - 本机时间）
        "conflicts": [],            # [{data_id, name, server_rev, local_rev}]
        "tasks_pushed": [],         # 已上行过的本机任务 id（避免重复上传大结果）
        "task_deletes": [],         # 本地已删、待上行删除的同组任务 id
        "task_updates": [],         # 元数据有变化（如应用标记）、待上行更新的任务 id
        "last_sync_at": None,
        "last_result": None,
        "last_error": None,
        "server_fingerprint": None,  # 服务器上次已知的本组数据指纹（变更监听基线）
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
    base["deleted_at"] = base.get("deleted_at") or {}
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


# ---------------------------------------------------------------- 时间（LWW 选边）

def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", ""))
    except (TypeError, ValueError):
        return None
    # 统一成无时区（本系统内部时间戳一律为服务器/本机本地时间）
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _clock_offset_seconds() -> float:
    try:
        return float(load_state().get("clock_offset_seconds") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _to_server_time(local_iso: Optional[str]) -> Optional[str]:
    """把本机时间戳换算到服务器时间轴（叠加最近一次同步测得的时钟偏差）。"""
    parsed = _parse_iso(local_iso)
    if parsed is None:
        return None
    return (parsed + timedelta(seconds=_clock_offset_seconds())).isoformat(timespec="seconds")


def _remember_clock_offset(server_time: Optional[str]) -> None:
    """用清单返回的服务器时间校准本机时钟偏差（明显异常时不采信）。"""
    parsed = _parse_iso(server_time)
    if parsed is None:
        return
    offset = (parsed - datetime.now()).total_seconds()
    if abs(offset) > 6 * 3600:  # 偏差超过 6 小时视为不可信，回 0 走保守判定
        offset = 0.0
    save_state(clock_offset_seconds=offset)


def _is_local_newer(local_changed_at: Optional[str], server_updated_at: Optional[str]) -> Optional[bool]:
    """本地改动（换算到服务器时间轴）是否晚于服务器最后一次写入。

    无法判定（缺任一时间戳）时返回 None，调用方回退到人工选边。
    """
    if not local_changed_at or not server_updated_at:
        return None
    local_time = _parse_iso(_to_server_time(local_changed_at))
    server_time = _parse_iso(server_updated_at)
    if local_time is None or server_time is None:
        return None
    return local_time > server_time


def _clear_conflict(data_id: str) -> None:
    """LWW 自动选边后清掉该数据集残留的人工冲突记录。"""
    state = load_state()
    conflicts = state.get("conflicts") or []
    remaining = [c for c in conflicts if c.get("data_id") != data_id]
    if len(remaining) != len(conflicts):
        save_state(conflicts=remaining)


# ---------------------------------------------------------------- dirty 标记

def mark_dirty(data_id: str) -> None:
    """本地数据被改动 → 下次同步上传到服务器。数据 id 不存在（例如刚删除）时忽略。"""
    if not data_id:
        return
    state = load_state()
    datasets = state["datasets"]
    entry = datasets.get(data_id) or {}
    entry["dirty"] = True
    # 记录最后一次本地改动时间：与服务器更新时间比较，按「最后更新时间」选边
    entry["changed_at"] = _now_iso()
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
    deleted_at = state.get("deleted_at") or {}
    deleted_at[data_id] = _now_iso()
    save_state(datasets=datasets, pending_deletes=pending, deleted_at=deleted_at)


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
        result = sync_once()
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopSync] 即时同步失败（忽略）：{exc}")
        return
    # 上一次同步还没结束：稍后再来一次，否则这次改动要等到下轮定时同步才被发现
    if result.get("skipped") and "尚未结束" in str(result.get("reason") or ""):
        schedule_sync(2)


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
    deleted_at = state.get("deleted_at") or {}
    deleted_at.pop(data_id, None)
    state["deleted_at"] = deleted_at
    state["conflicts"] = [c for c in (state.get("conflicts") or []) if c.get("data_id") != data_id]
    save_state(state)


def record_synced(
    data_id: str, rev: int, sha256: Optional[str] = None, server_updated_at: Optional[str] = None
) -> None:
    """记录"该数据集已与服务器一致"。

    必须同时清掉待上行删除：整包安装（pull）内部是「先删后插」，删除会记一次
    本地删除意图，若不同步清掉，下一轮同步会把刚拉下来的数据集又从服务器删掉。
    同时清掉本地改动时间（changed_at）与删除时间（deleted_at）——本地状态已
    与服务器对齐，下一次改动会重新记录。
    """
    state = load_state()
    datasets = state["datasets"]
    previous = datasets.get(data_id) or {}
    datasets[data_id] = {
        "rev": int(rev or 0),
        "sha256": sha256 or previous.get("sha256"),
        "dirty": False,
        "last_sync_at": datetime.now().isoformat(timespec="seconds"),
        "server_updated_at": server_updated_at or previous.get("server_updated_at") or "",
    }
    pending = [d for d in (state.get("pending_deletes") or []) if d != data_id]
    deleted_at = state.get("deleted_at") or {}
    deleted_at.pop(data_id, None)
    save_state(datasets=datasets, pending_deletes=pending, deleted_at=deleted_at)


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
    data_id: str, user, city: str, operator: str, server_rev: int = 0,
    server_updated_at: Optional[str] = None,
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
    record_synced(data_id, server_rev, server_updated_at=server_updated_at)
    return {"data_id": data_id, "action": "pull", "rev": server_rev}


def repair_dataset(data_id: str) -> Dict[str, Any]:
    """共享模式：把某数据集从服务器整包补拉一次（本机镜像数据体缺失/损坏时用）。

    - 仅在桌面共享模式 + 授权有效时执行；单机/离线不动
    - 本地有未上行修改（dirty）时不拉，避免覆盖用户数据
    - 拉取后本地记录基线修订号，后续按正常同步流转
    """
    if not settings.NPT_DESKTOP or not data_id:
        return {"repaired": False, "reason": "非桌面共享模式"}
    if not is_shared():
        return {"repaired": False, "reason": "当前为离线模式"}
    state = load_state()
    if (state["datasets"].get(data_id) or {}).get("dirty"):
        return {"repaired": False, "reason": "本机有未同步的修改"}

    from app.services import desktop_cloud_client as cloud

    _require_active_license()
    user, city, operator = _local_group()
    server_rev = 0
    server_updated_at: Optional[str] = None
    try:
        manifest = cloud.sync_manifest()
        for item in manifest.get("items") or []:
            if item.get("data_id") == data_id:
                server_rev = int(item.get("rev") or 0)
                server_updated_at = item.get("server_updated_at")
                break
    except Exception:  # noqa: BLE001
        pass  # 拿不到清单就按 0 记基线，下一轮同步会按服务器 rev 修正

    result = _pull(data_id, user, city, operator, server_rev, server_updated_at)
    return {"repaired": True, **result}


def _push(data_id: str, expected_rev: int, changed_at: Optional[str] = None) -> Dict[str, Any]:
    """把本地数据集整包上传（带基地修订号乐观锁 + LWW 改动时间）。"""
    from app.services import desktop_cloud_client as cloud
    from app.services.desktop_dataset_packager import build_package

    package = build_package(data_id)
    try:
        result = cloud.upload_package(
            data_id, package["path"], base_rev=expected_rev,
            # 换算到服务器时间轴，供服务器在修订号冲突时按「最后更新时间」选边
            changed_at=_to_server_time(changed_at),
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


# ---------------------------------------------------------------- 同组任务历史（共享）

def queue_task_delete(task_id: str) -> None:
    """本机删除了同组共享任务 → 待上行删除。"""
    if not task_id:
        return
    state = load_state()
    pending = [d for d in (state.get("task_deletes") or []) if d != task_id]
    pending.append(task_id)
    save_state(task_deletes=pending)


def queue_task_update(task_id: str) -> None:
    """共享任务元数据变化（如「已应用」标记）→ 待上行更新。"""
    if not task_id:
        return
    state = load_state()
    pending = [d for d in (state.get("task_updates") or []) if d != task_id]
    pending.append(task_id)
    save_state(task_updates=pending)


def sync_tasks(city: str, operator: str) -> Dict[str, Any]:
    """同组任务历史同步：拉元数据做镜像 / 推本机新任务 / 传播删除与更新。

    - 只同步规划类任务（`TaskManager.SHARED_TASK_TYPES`），apply_* 不共享
    - 镜像行（origin=shared）只读：大结果不预下载，查看/导出时按需拉取；
      小结果（`PREPULL_RESULT_TYPES`，见常量说明）预拉取，避免「已应用」状态
      在查看前后跳变、且能随工参变更重新比对
    - 本机任务的结果只在首次上行时发一次（`tasks_pushed` 记账）
    - 服务器删除（网页端删记录/应用后清理）→ 删除本机镜像；已上行过的本机任务同理
    - `is_applied` 双向同步：别处应用 → 本机显示已应用；本机刚应用未上行时保留本机值
    - 清单被 LIMIT 截断（`total > len(items)`）时不做删除判定，避免误删老任务
    """
    import json as _json

    from app.core.database import SessionLocal
    from app.models.database import TaskResult
    from app.services import desktop_cloud_client as cloud
    from app.services.task_manager import TaskManager

    manifest = cloud.shared_tasks_manifest()
    items = {str(i.get("task_id")): i for i in (manifest.get("items") or []) if i.get("task_id")}
    # 清单可能因 LIMIT 截断：截断时绝不能把"清单里没有"当成"服务器已删除"
    try:
        total = int(manifest.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    truncated = total > len(items)
    summary: Dict[str, Any] = {"pulled": 0, "pushed": 0, "deleted": 0, "updated": 0, "errors": []}
    state = load_state()
    pushed = set(state.get("tasks_pushed") or [])
    pending_updates = set(state.get("task_updates") or [])
    # 本机已删、删除意图尚未上行到服务器的任务：清单是本轮开头取的快照，
    # 那时服务器可能还留着这些任务——绝不能据此把本机已删的行镜像回来
    # （否则用户会看到"删掉的历史任务又回来了"，直到删除上行完成后的下一轮才消失）
    pending_task_deletes = set(state.get("task_deletes") or [])
    # 待上行更新列表（含本次同步发现的「本机已应用但服务器还没有」的修复项）
    queued_updates: List[str] = list(state.get("task_updates") or [])
    remaining_updates: List[str] = []
    changed_ids: List[str] = []

    db = SessionLocal()
    try:
        local_rows = db.query(TaskResult).all()
        local_by_id = {r.task_id: r for r in local_rows}

        # 1) 服务器已删除 → 清掉本机镜像行；本机自建且已上行过的任务同样清理
        #    （否则网页端删掉的记录会在桌面端一直残留，且被 tasks_pushed 记账挡住不再上行）
        for row in list(local_rows):
            if row.task_id in pending_task_deletes:
                # 本机删除意图优先：本机不该再有这一行（含上一轮按旧清单重建出来的残留）
                db.delete(row)
                pushed.discard(row.task_id)
                changed_ids.append(row.task_id)
                continue
            if row.task_id in items:
                continue
            if row.origin == "shared" or row.task_id in pushed:
                if truncated:
                    continue  # 清单被截断，不能据此判定删除
                db.delete(row)
                pushed.discard(row.task_id)
                summary["deleted"] += 1
                changed_ids.append(row.task_id)

        # 2) 新增/更新镜像行（结果留空，按需拉取），并双向同步"已应用"标记
        for task_id, item in items.items():
            if task_id in pending_task_deletes:
                continue  # 本机删除待上行：不重建镜像（见上方 pending_task_deletes 说明）
            row = local_by_id.get(task_id)
            server_applied = bool(item.get("is_applied"))
            if row is None:
                db.add(TaskResult(
                    task_id=task_id,
                    task_type=item.get("task_type") or "",
                    task_name=item.get("task_name"),
                    user_name=item.get("user_name"),
                    status=item.get("status") or "completed",
                    progress=100.0,
                    is_applied=1 if server_applied else 0,
                    cell_count=item.get("cell_count"),
                    created_at=str(item.get("created_at") or ""),
                    completed_at=item.get("completed_at"),
                    city=item.get("city") or city,
                    operator=item.get("operator") or operator,
                    origin="shared",
                ))
                summary["pulled"] += 1
                continue
            if row.origin == "shared":
                row.task_name = item.get("task_name") or row.task_name
                row.user_name = item.get("user_name") or row.user_name
                row.status = item.get("status") or row.status
                row.completed_at = item.get("completed_at") or row.completed_at
            # 小数量同步（镜像行本机无结果，列表「小区数量」列完全靠它）
            server_cell_count = item.get("cell_count")
            if server_cell_count is not None and int(row.cell_count or 0) != int(server_cell_count):
                row.cell_count = int(server_cell_count)
                changed_ids.append(task_id)
            # 应用标记：服务器置 1 → 本机同步为 1；本机已置 1 而服务器仍是 0
            # （旧版服务器上行时丢过 is_applied）→ 不回落，改为把本机标记上行
            # （服务器单调置位）。「已应用」无撤销语义，本机知道的比服务器新。
            if task_id not in pending_updates:
                new_flag = 1 if server_applied else 0
                if new_flag == 1 and int(row.is_applied or 0) != 1:
                    row.is_applied = 1
                    summary["updated"] += 1
                    changed_ids.append(task_id)
                elif new_flag == 0 and int(row.is_applied or 0) == 1:
                    if task_id not in queued_updates:
                        queued_updates.append(task_id)
        db.commit()

        # 2.5) 挑出需要预拉取结果的镜像行（小结果类型；见 PREPULL_RESULT_TYPES 说明）。
        #      按清单顺序（新 → 旧）取，且限制本轮总字节数（下轮继续，直到收敛）；
        #      体积未知或过大的仍按需拉取。实际拉取放在主会话关闭后（避免同连接写冲突）。
        prepull_ids: List[str] = []
        prepull_bytes = 0
        for task_id, item in items.items():
            if len(prepull_ids) >= PREPULL_MAX_PER_SYNC:
                break
            if str(item.get("task_type") or "") not in PREPULL_RESULT_TYPES:
                continue
            row = local_by_id.get(task_id)
            if row is not None and row.result_json:
                continue  # 本机已有结果（本机任务或已拉取的镜像）
            size = int(item.get("result_size") or 0)
            if size <= 0 or size > PREPULL_MAX_SINGLE_BYTES:
                continue
            if prepull_bytes + size > PREPULL_MAX_TOTAL_BYTES:
                continue  # 本轮预算用尽，留给下一轮（继续找后面更小的条目）
            prepull_ids.append(task_id)
            prepull_bytes += size

        # 3) 本机新建的规划任务上行（含结果，只推一次）；以及待上行更新
        for task_id in queued_updates:
            row = db.query(TaskResult).filter(TaskResult.task_id == task_id).first()
            if row is not None and row.task_type in TaskManager.SHARED_TASK_TYPES:
                try:
                    cloud.upload_shared_task({
                        "task_id": row.task_id,
                        "task_type": row.task_type,
                        "task_name": row.task_name,
                        "user_name": row.user_name,
                        "status": row.status,
                        "created_at": row.created_at,
                        "completed_at": row.completed_at,
                        "is_applied": bool(row.is_applied),
                        "cell_count": row.cell_count if (row.cell_count or 0) > 0 else None,
                    }, _json.loads(row.result_json) if row.result_json else None)
                    pushed.add(row.task_id)
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"更新任务「{task_id[:8]}」失败：{exc}")
                    remaining_updates.append(task_id)

        for row in db.query(TaskResult).all():
            if row.origin == "shared" or row.task_id in items or row.task_id in pushed:
                continue
            if row.task_type not in TaskManager.SHARED_TASK_TYPES:
                continue
            if (row.status or "") != "completed" or not row.result_json:
                continue
            try:
                result = _json.loads(row.result_json)
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"任务「{row.task_name or row.task_id[:8]}」结果解析失败：{exc}")
                continue
            try:
                cloud.upload_shared_task({
                    "task_id": row.task_id,
                    "task_type": row.task_type,
                    "task_name": row.task_name,
                    "user_name": row.user_name,
                    "status": row.status,
                    "created_at": row.created_at,
                    "completed_at": row.completed_at,
                    # 本机已应用的任务首次上行就把标记带上（否则同组永远显示未应用）
                    "is_applied": bool(row.is_applied),
                    "cell_count": row.cell_count if (row.cell_count or 0) > 0 else None,
                }, result)
                pushed.add(row.task_id)
                summary["pushed"] += 1
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"上传任务「{row.task_name or row.task_id[:8]}」失败：{exc}")
    finally:
        db.close()

    # 2.6) 预拉取镜像任务的小结果（结果落地后本机即可按当前工参动态判定「已应用」，
    #      与点「查看」的结果一致；拉取失败只记日志，不阻塞同步）
    from app.services.task_manager import task_manager

    prepulled = 0
    for task_id in prepull_ids:
        try:
            if task_manager._fetch_shared_task_result(task_id) is not None:
                prepulled += 1
                changed_ids.append(task_id)
        except Exception as exc:  # noqa: BLE001
            summary["errors"].append(f"预拉取任务「{task_id[:8]}」结果失败：{exc}")
    if prepulled:
        summary["results_pulled"] = prepulled

    # 4) 待上行删除（幂等：服务器没有就当已删）
    remaining_deletes: List[str] = []
    for task_id in state.get("task_deletes") or []:
        try:
            cloud.delete_shared_task(task_id)
            summary["deleted"] += 1
        except Exception as exc:  # noqa: BLE001
            summary["errors"].append(f"删除任务「{task_id[:8]}」失败：{exc}")
            remaining_deletes.append(task_id)

    # 若本轮从别处同步了任务元数据/删除，失效本机历史列表的应用状态缓存，
    # 让前端刷新时立即看到最新状态
    for task_id in changed_ids:
        TaskManager._history_verify_cache.pop(task_id, None)

    save_state(
        tasks_pushed=sorted(pushed),
        task_deletes=remaining_deletes,
        task_updates=remaining_updates,
    )
    return summary


def _has_pending_work(state: Optional[Dict[str, Any]] = None) -> bool:
    """是否还有本地改动等着上行（dirty 数据集 / 待上行删除 / 任务队列）。"""
    state = state or load_state()
    if any(v.get("dirty") for v in (state.get("datasets") or {}).values()):
        return True
    return bool(state.get("pending_deletes") or state.get("task_updates") or state.get("task_deletes"))


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
    _started = time.time()
    summary: Dict[str, Any] = {"pulled": 0, "pushed": 0, "deleted": 0, "conflicts": 0, "errors": []}
    print("[DesktopSync] 同步开始")
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
        # 用服务器时间校准本机时钟偏差：LWW 选边要把本地改动时间换算到服务器时间轴
        _remember_clock_offset(manifest.get("server_time"))
        local_state = load_state()
        datasets_state = local_state["datasets"]
        # 本机已删、删除尚未上行的 id（工参更新就是"新建 + 删旧"，本轮不能再拉回旧副本）
        pending_deletes = set(local_state.get("pending_deletes") or [])

        # 1. 服务器 → 本地
        for data_id, item in items.items():
            if (data_service.index.get(data_id) or {}).get("status") == "processing":
                continue  # 本机正在导入该数据集：本轮不动，整包覆盖会把导入打断
            if item.get("deleted"):
                if data_id in data_service.index and not (datasets_state.get(data_id) or {}).get("dirty"):
                    data_service.delete_data(data_id, force=True)
                    forget(data_id)  # delete_data 会记 pending_delete，这里要一并清掉
                    summary["deleted"] += 1
                continue
            if data_id in pending_deletes:
                # 服务器上的副本还没删掉：本轮跳过，删除意图由第 3 步上行。
                # 否则"工参更新"刚生成的新工参还在，旧工参又被拉回本机，列表会显示旧文件。
                continue
            local_entry = datasets_state.get(data_id)
            server_rev = int(item.get("rev") or 0)
            server_updated_at = item.get("server_updated_at")
            if data_id not in data_service.index:
                name = item.get("name") or data_id
                try:
                    _pull(data_id, user, city, operator, server_rev, server_updated_at)
                    summary["pulled"] += 1
                    summary.setdefault("details", []).append({"name": name, "action": "pull"})
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"下载「{name}」失败：{exc}")
                continue
            local_rev = int((local_entry or {}).get("rev") or 0)
            name = (data_service.index.get(data_id) or {}).get("name") or data_id
            dirty = (local_entry or {}).get("dirty") or local_entry is None

            if dirty:
                # 本地改过：服务器版本也变了 → 按「最后更新时间」自动选边（LWW），
                # 避免两个用户来回互相覆盖（乒乓）；时间戳缺失的存量条目才交人工选边。
                if server_rev != local_rev:
                    changed_at = (local_entry or {}).get("changed_at")
                    local_newer = _is_local_newer(changed_at, server_updated_at)
                    if local_newer is True:
                        try:
                            _push(data_id, local_rev or None, changed_at=changed_at)
                            summary["pushed"] += 1
                            summary.setdefault("details", []).append({"name": name, "action": "push-lww"})
                            _clear_conflict(data_id)
                        except Exception as exc:  # noqa: BLE001
                            summary["errors"].append(f"上传「{name}」失败：{exc}")
                        continue
                    if local_newer is False:
                        # 服务器版本更晚：采用服务器版本（本机未上行改动被覆盖，属预期 LWW 语义）
                        try:
                            _pull(data_id, user, city, operator, server_rev, server_updated_at)
                            summary["pulled"] += 1
                            summary.setdefault("details", []).append({
                                "name": name, "action": "pull-lww",
                                "note": "服务器版本更新，已按最后更新时间采用",
                            })
                            _clear_conflict(data_id)
                        except Exception as exc:  # noqa: BLE001
                            summary["errors"].append(f"更新「{name}」失败：{exc}")
                        continue
                    # 无法判定时间 → 保留人工选边
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
                    _push(data_id, local_rev or None, changed_at=(local_entry or {}).get("changed_at"))
                    summary["pushed"] += 1
                    summary.setdefault("details", []).append({"name": name, "action": "push"})
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"上传「{name}」失败：{exc}")
                continue

            if server_rev == local_rev:
                continue  # 两边都没动

            try:
                _pull(data_id, user, city, operator, server_rev, server_updated_at)
                summary["pulled"] += 1
                summary.setdefault("details", []).append({"name": name, "action": "pull"})
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"更新「{name}」失败：{exc}")

        # 2. 本地 → 服务器（服务器上没有的数据集 = 本机新建）
        for data_id in list(data_service.index.keys()):
            if data_id in items:
                continue
            if (data_service.index.get(data_id) or {}).get("status") == "processing":
                # 正在导入：解析完成时会 _bump_revision → note_change 触发上行。
                # 这里推上去的只是半成品（大文件往往要传两次整包），还会让同组先拉到不完整数据。
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
                    _push(
                        data_id,
                        int((entry or {}).get("rev") or 0) or None,
                        changed_at=(entry or {}).get("changed_at"),
                    )
                    summary["pushed"] += 1
                except Exception as exc:  # noqa: BLE001
                    summary["errors"].append(f"上传「{data_id}」失败：{exc}")
            else:
                # 服务器已删除且本地没改过 → 清掉本地镜像
                data_service.delete_data(data_id, force=True)
                forget(data_id)
                summary["deleted"] += 1

        # 3. 本地已删除 → 通知服务器。
        #    若服务器在本地删除之后又更新过该数据集，则撤销本地删除并拉回服务器版本，
        #    避免"删除/旧数据"反向覆盖同组的新改动。
        state_before = load_state()
        deleted_at_map = state_before.get("deleted_at") or {}
        remaining: List[str] = []
        for data_id in state_before.get("pending_deletes") or []:
            item = items.get(data_id)
            if item and not item.get("deleted"):
                server_newer = _is_local_newer(
                    deleted_at_map.get(data_id), item.get("server_updated_at")
                )
                if server_newer is False:
                    try:
                        _pull(data_id, user, city, operator,
                              int(item.get("rev") or 0), item.get("server_updated_at"))
                        summary["pulled"] += 1
                        summary.setdefault("details", []).append({
                            "name": item.get("name") or data_id, "action": "pull",
                            "note": "服务器版本更新，已撤销本机删除",
                        })
                    except Exception as exc:  # noqa: BLE001
                        summary["errors"].append(f"恢复「{data_id}」失败：{exc}")
                        remaining.append(data_id)
                    continue
            try:
                cloud.delete_dataset(data_id)
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(f"删除「{data_id}」失败：{exc}")
                remaining.append(data_id)
        save_state(pending_deletes=remaining)

        # 4. 同组任务历史（规划类）：拉元数据做镜像、推本机新任务、传播删除/更新
        try:
            task_summary = sync_tasks(city, operator)
            summary["tasks"] = task_summary
            summary["errors"].extend(task_summary.get("errors") or [])
        except Exception as exc:  # noqa: BLE001
            summary["errors"].append(f"任务历史同步失败：{exc}")

        save_state(
            last_sync_at=datetime.now().isoformat(timespec="seconds"),
            last_result=summary,
            last_error=(summary["errors"][0] if summary["errors"] else None),
        )
        tasks = summary.get("tasks") or {}
        print(
            "[DesktopSync] 同步结束 "
            f"耗时{time.time() - _started:.1f}s 下载{summary['pulled']} "
            f"上传{summary['pushed']} 删除{summary['deleted']} 冲突{summary['conflicts']} "
            f"任务(拉{tasks.get('pulled') or 0}/推{tasks.get('pushed') or 0}/删{tasks.get('deleted') or 0}) "
            f"错误{len(summary['errors'])}"
        )
        # 长同步期间产生的本地改动（用户继续上传/编辑）要立刻补跑一次，
        # 否则只能等下一轮兜底轮询（默认 1 分钟）才上行；本轮有错时交给轮询重试，避免失败空转
        if not summary["errors"] and _has_pending_work():
            schedule_sync(1)
        return summary
    except Exception as exc:  # noqa: BLE001
        save_state(last_error=str(exc))
        print(f"[DesktopSync] 同步失败 耗时{time.time() - _started:.1f}s: {exc}")
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


# ---------------------------------------------------------------- 变更监听（即时同步）

# 长轮询挂起时长：服务器在此期间有变化会立刻返回
WATCH_WAIT_SECONDS = 25


def watch_once(wait_seconds: int = WATCH_WAIT_SECONDS) -> bool:
    """挂起等待同组数据变更；有变化返回 True（调用方负责触发同步）。"""
    from app.services import desktop_cloud_client as cloud

    state = load_state()
    since = str(state.get("server_fingerprint") or "")
    data = cloud.wait_change(since, timeout=wait_seconds)
    fingerprint = str(data.get("fingerprint") or "")
    if not fingerprint or fingerprint == since:
        return False
    save_state(server_fingerprint=fingerprint)
    # 首次只记录基线，不算"有变更"——否则每次启动都会白跑一次同步
    return bool(since)


async def watch_loop(wait_seconds: int = WATCH_WAIT_SECONDS) -> None:
    """监听同组的服务器数据变更，一有变化立即同步。

    这是「服务器 → 桌面端」的主通道（长轮询，秒级感知）；sync_loop 退化为兜底。
    """
    import asyncio

    await asyncio.sleep(20)  # 启动先让本地服务热身
    while True:
        try:
            if is_shared() and _license_valid():
                changed = await asyncio.to_thread(watch_once, wait_seconds)
                if changed:
                    schedule_sync(0)  # 立刻同步，不再等定时轮询
                    continue
            else:
                await asyncio.sleep(10)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopSync] 变更监听异常（忽略）：{exc}")
            await asyncio.sleep(5)


# ---------------------------------------------------------------- 后台定时同步

async def sync_loop(interval_minutes: Optional[int] = None) -> None:
    """桌面版共享模式定时同步（失败仅记录日志，不影响本机离线使用）。

    兜底通道：同组其它端（网页端或另一台桌面端）的改动主要由 watch_loop 的长轮询
    即时发现，这里只按 NPT_DESKTOP_SYNC_INTERVAL_MINUTES（默认 1 分钟）补漏；
    每次只比对修订号，没有变化就不做整包传输。本机自己的改动另走 note_change
    的即时上行。
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
