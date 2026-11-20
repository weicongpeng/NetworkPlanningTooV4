"""桌面版本机接口：在线激活 / 续期 / 申请授权（仅 NPT_DESKTOP=1 时可用）。

前端只访问本机这些接口，由本机后端去调用授权服务器：
- 客户端本机 JWT 与服务器无关（也不受服务器 CORS 限制）
- 激活/续期成功后统一走 license_service.activate() 落盘并镜像到期日
"""
from __future__ import annotations

import asyncio
import re
import threading
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.services import desktop_screenshot_settings as screenshot_cfg
from app.core.database import get_db
from app.core.security import get_current_admin_user, get_current_user, security_scheme
from app.core.startup_gate import mark_login_completed
from app import desktop_bridge
from app.models.database import User
from app.services import desktop_im_storage
from app.services import desktop_cloud_client as cloud
from app.services.auth_service import auth_service
from app.services.license_service import license_service
from app.utils.machine_code import get_machine_code

router = APIRouter(tags=["桌面客户端本地接口"])


def _gbk_safe(message: str) -> str:
    return str(message).encode("gbk", "replace").decode("gbk")


def _require_desktop() -> None:
    """桌面形态门禁（部分端点在函数体内直接调用，故保持同步）。"""
    if not settings.NPT_DESKTOP:
        raise HTTPException(status_code=404, detail="Not Found")


async def _require_desktop_fast() -> None:
    """交互快路径专用桌面门禁：async 依赖不占用 anyio 线程池 token。

    同步依赖会被 Starlette 丢进线程池再申请一次 token；IM 慢 relay 把 40 个 token
    占满时，连「最小化/最大化」和 400ms 截图热键轮询都会排队几十秒。
    """
    _require_desktop()


async def _require_desktop_window_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
) -> None:
    """窗口控制/状态查询专用轻量鉴权：只校验本机 JWT 签名，不碰数据库。

    ``get_current_user`` 依赖同步 generator ``get_db``，Starlette 会为它申请 anyio
    线程池 token 并在请求结束时再申请一次。桌面共享模式打开「项目沟通」后，
    IM 的 1.5s 无节流轮询叠加最多 12s×2 的慢 relay 会把默认 40 个 token 占满，
    连依赖注入都排不上队 —— 用户看到的就是「点最小化/最大化几十秒没反应」。

    窗口动作不读写任何业务数据，验签足够；其它桌面端点（截图热键、取景等）
    本来就无鉴权，本机后端也只绑 127.0.0.1，这里不会降低实际防护。
    """
    if credentials is None or auth_service.decode_token(credentials.credentials) is None:
        raise HTTPException(status_code=401, detail="请先登录")


def _raise_cloud_error(exc: cloud.CloudError) -> None:
    status_code = exc.status_code if exc.status_code and exc.status_code >= 400 else 502
    raise HTTPException(status_code=status_code, detail=_gbk_safe(exc.message))


def _status_payload() -> Dict[str, Any]:
    state = cloud.load_state()
    return {
        "desktop": True,
        "server_url": cloud.server_url(),
        "machine_code": get_machine_code(),
        "version": settings.NPT_DESKTOP_VERSION or "",
        "channel": settings.NPT_DESKTOP_CHANNEL or "stable",
        "license": license_service.desktop_license_info(),
        "cloud": {
            "license_id": state.get("license_id"),
            "last_renew_at": state.get("last_renew_at"),
            "request_id": state.get("request_id"),
        },
    }


class ActivateRequest(BaseModel):
    activation_code: str = Field(..., description="管理员发放的激活码")


class ApplyRequest(BaseModel):
    applicant_name: str
    organization: Optional[str] = None
    note: Optional[str] = None


class RunModeRequest(BaseModel):
    mode: str = Field(..., description="shared=共享模式 / offline=离线模式")


class SyncResolveRequest(BaseModel):
    data_id: str
    resolution: str = Field(..., description="server=取服务器版本 / local=用本地覆盖")
    force: bool = Field(default=False, description="local 强制覆盖服务器需显式二次确认")


class FrozenChangesRequest(BaseModel):
    action: str = Field(..., description="discard=丢弃冻结的旧改动 / restore=恢复为待上行")


class DesktopRegisterRequest(BaseModel):
    """桌面端注册：与网页端注册字段一致（数据组只能在注册时选择）。"""

    username: str
    password: str
    confirm_password: str
    city: str
    operator: str


# ------------------------------------------------- 桌面端登录（与网页端同一套账号）
#
# 桌面端不再有 owner 免登录账号：登录页输入网页端用户名/密码，由本机后端代理到
# 授权服务器校验，成功后在本机镜像出同名本地账号（组/权限位/管理员位照搬），
# 之后的权限与数据组语义与网页端完全一致。
# 单机模式在授权有效期内允许断网登录（本机保存密码哈希），登录次数下次联机补报。

MODE_SHARED = "shared"
MODE_STANDALONE = "standalone"

# 功能权限位：管理员在网页端「用户管理 → 编辑」设置，网页端与桌面端一致生效
PERMISSION_FIELDS = (
    "can_data_import", "can_data_delete", "can_data_update",
    "can_cell_entry", "can_cell_query_update", "can_assistant",
)


# ---------------------------------------------------------------- 记住账号密码

LAST_LOGIN_FILE = "last_login.json"
LAST_LOGIN_KEY_FILE = ".last_login.key"


def _last_login_paths():
    return settings.DATA_ROOT / LAST_LOGIN_FILE, settings.DATA_ROOT / LAST_LOGIN_KEY_FILE


def _credential_cipher():
    """本机凭据加密器：密钥文件首次生成（0600），丢失则已保存的凭据不再可用。"""
    import os

    from cryptography.fernet import Fernet

    _, key_path = _last_login_paths()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    if key_path.is_file():
        key = key_path.read_bytes().strip()
    else:
        key = Fernet.generate_key()
        fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
    return Fernet(key)


def save_last_login(username: str, password: str, mode: str) -> None:
    """保存最近一次成功登录的账号/密码（加密，仅本机后端可解密）。旁路：失败不影响登录。"""
    import json as _json

    path, _ = _last_login_paths()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = _credential_cipher().encrypt(_json.dumps({
            "username": username,
            "password": password,
            "mode": mode,
            "saved_at": datetime.now().isoformat(timespec="seconds"),
        }, ensure_ascii=False).encode("utf-8"))
        path.write_bytes(blob)
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopAuth] 保存登录凭据失败（忽略）：{exc}")


def load_last_login() -> Optional[Dict[str, Any]]:
    import json as _json

    path, key_path = _last_login_paths()
    if not path.is_file() or not key_path.is_file():
        return None
    try:
        data = _json.loads(_credential_cipher().decrypt(path.read_bytes()).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict) or not str(data.get("username") or "").strip():
        return None
    return {
        "username": str(data.get("username") or ""),
        "password": str(data.get("password") or ""),
        "mode": str(data.get("mode") or MODE_SHARED),
    }


def clear_last_login() -> None:
    path, _ = _last_login_paths()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _apply_remember(remember: bool, username: str, password: str, mode: str) -> None:
    if remember:
        save_last_login(username, password, mode)
    else:
        clear_last_login()


# ------------------------------------------------- 跨配置档登录（数据隔离）
#
# 登录选择的运行模式与当前配置档不一致时，不能在当前档完成登录（否则共享档的
# 用户镜像/会话又会写进单机档）。此时只把登录凭据加密存为一次性 pending，
# 由 launcher 重启到目标档后消费，实现「切模式即换数据空间」。

PENDING_LOGIN_FILE = "pending_login.json"


def _pending_login_path():
    return settings.DATA_ROOT / PENDING_LOGIN_FILE


def save_pending_login(payload: Dict[str, Any]) -> None:
    """加密保存一次性登录/注册凭据（复用记住密码的 Fernet 密钥）。"""
    import json as _json

    path = _pending_login_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = _credential_cipher().encrypt(
            _json.dumps(payload, ensure_ascii=False).encode("utf-8")
        )
        path.write_bytes(blob)
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopAuth] 保存切换登录凭据失败（忽略）：{exc}")


def consume_pending_login() -> Optional[Dict[str, Any]]:
    """读取一次性登录/注册凭据；**只有确认可用（目标档 == 当前运行档）才销毁**。

    为什么销毁必须放在校验之后（原实现是 `finally` 里无条件删除，而"档是否匹配"
    的判断在删除之后 —— 等于这道校验形同虚设）：跨档重启前，仍在运行的旧进程
    （或前端重复读取兜底路径）会把凭据提前销毁，重启后的新进程就取不到凭据 →
    退回用"记住的旧模式"自动登录 → 再次被判定为跨档 → 二次弹窗要求重启。
    这就是"切换模式要重启两次"的根因。

    档不匹配时**必须保留**（很可能是旧进程的误读），否则重启后永远消费不到。
    """
    import json as _json

    from app.core.desktop_profiles import normalize_profile

    path = _pending_login_path()
    if not path.is_file():
        return None
    data = None
    try:
        data = _json.loads(_credential_cipher().decrypt(path.read_bytes()).decode("utf-8"))
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        # 内容损坏（密钥变更/写坏）：留着只会反复解密失败，销毁
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    # 目标档与当前运行档不一致 → 保留，不要销毁
    if normalize_profile(data.get("mode")) != normalize_profile(
        getattr(settings, "DESKTOP_PROFILE", "")
    ):
        return None
    # 确认可用：读后即删（一次性）
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    return data



def _cross_profile_required(mode: str) -> bool:
    """请求的模式档是否与当前运行档不同（需要重启切换数据空间）。"""
    from app.core.desktop_profiles import normalize_profile

    if not settings.NPT_DESKTOP:
        return False
    return normalize_profile(mode) != normalize_profile(getattr(settings, "DESKTOP_PROFILE", ""))


def _accept_cross_profile_switch(mode: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """跨档登录/注册短路：记账目标档与一次性凭据，不触碰当前档任何数据。"""
    from app.core.desktop_profiles import profile_root_for, write_active_profile

    normalized = MODE_STANDALONE if str(mode).lower() != MODE_SHARED else MODE_SHARED
    save_pending_login({**payload, "mode": normalized})
    # 切回共享档前先冻结目标档遗留的待上行状态：否则重启登录后登录即同步会把它
    # 当成"本轮改动"push，覆盖同组其他用户刚上行的工参（跨档数据覆盖的主要路径）。
    if normalized == MODE_SHARED:
        try:
            from app.services import desktop_sync_service as sync

            sync.freeze_pending_changes(
                reason="切换到共享模式",
                state_path=profile_root_for(settings.DATA_ROOT, normalized) / "sync_state.json",
            )
        except Exception as exc:  # noqa: BLE001 - 冻结失败不阻断登录，但记日志
            print(f"[DesktopSync] 跨档冻结旧改动失败（忽略）：{exc}")
    write_active_profile(settings.DATA_ROOT, normalized)
    return {
        "success": True,
        "data": {
            "restart_required": True,
            "mode": normalized,
        },
    }


class DesktopLoginRequest(BaseModel):
    username: str
    password: str
    mode: str = Field(default=MODE_STANDALONE, description="shared=共享模式 / standalone=单机模式")
    # 记住账号密码：勾选后本机加密保存，登录页可自动登录（默认勾选）
    remember: bool = True


class DesktopPollRequest(BaseModel):
    username: str


def _parse_expiry(value: Any) -> Optional[datetime]:
    """解析服务器下发的授权到期日（ISO 字符串 / 空值）。"""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", ""))
    except ValueError:
        return None
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _mirror_local_expiry(row, incoming: dict) -> None:
    """把服务器「用户管理」里的实际到期日镜像到本机账号。

    本机前端门禁（licenseStore）读的就是 user.license_expiry：不镜像的话，管理员
    提前设置/缩短的到期日传不到桌面端，表现为「网页端提示已到期、桌面端照常能用」。
    运行中由 session-check 心跳（60 秒）重复镜像，管理员改动无需重登即生效。
    """
    raw = incoming.get("effective_license_expiry")
    if raw is None:
        raw = incoming.get("license_expiry")
    row.license_expiry = _parse_expiry(raw)


def _mirror_local_user(db: Session, incoming: dict, mode: str, password: Optional[str] = None):
    """在本机 users 表镜像网页端账号（组、权限位、管理员位照搬）。

    password 为空表示沿用本机已有哈希（轮询批准时拿不到明文密码）；
    新账号则随机生成，正式登录时会覆盖。桌面端不强制改密（改密走网页端）。
    """
    import uuid as _uuid

    from app.models.database import User as UserModel

    username = (incoming.get("username") or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="服务器返回的账号信息不完整")
    row = db.query(UserModel).filter(UserModel.username == username).first()
    if row is None:
        row = UserModel(
            username=username,
            password_hash=auth_service.hash_password(password or str(_uuid.uuid4())),
        )
        db.add(row)
    elif password and not auth_service.verify_password(password, row.password_hash):
        # 仅在密码真的变了时才重哈希：bcrypt 一次 300~1000ms，而这里每次登录都会走到，
        # 无条件重哈希等于给每次登录白加一段开销 + 一次无谓的 commit
        row.password_hash = auth_service.hash_password(password)
    row.is_admin = bool(incoming.get("is_admin"))
    row.is_active = True
    row.must_change_password = False
    row.is_desktop_shadow = False
    row.desktop_run_mode = mode
    row.city = incoming.get("city")
    row.operator = incoming.get("operator")
    # 协作沟通昵称：IM 展示名，随服务器账号信息镜像到本机，保证共享模式登录后
    # 本地 /me 也能带出昵称（否则协作沟通左下角当前用户会退回 username）
    row.nickname = incoming.get("nickname")
    if "avatar" in incoming:
        row.avatar = incoming.get("avatar")
    server_id = incoming.get("id")
    if isinstance(server_id, int) and server_id > 0:
        row.im_user_id = server_id
    elif str(server_id or "").isdigit() and int(server_id) > 0:
        row.im_user_id = int(server_id)
    for perm in PERMISSION_FIELDS:
        setattr(row, perm, bool(incoming.get(perm)))
    _mirror_local_expiry(row, incoming)
    db.commit()
    db.refresh(row)
    return row


def _sync_permissions_from_remote(incoming: Optional[dict]) -> Optional[dict]:
    """把服务器上的最新权限位与授权到期日同步到本机镜像账号，返回同步后的账号载荷。

    管理员在网页端「用户管理 → 编辑」改动权限位/到期日后，运行中的桌面端在下一次
    心跳（session-check）就会拿到新值，无需重新登录：到期日变化会让前端门禁
    （licenseStore）当场判定"已过期"并拦下界面；断网时拿不到新值，沿用本机上次同步的结果。
    """
    if not incoming or not incoming.get("username"):
        return None
    from app.core.database import SessionLocal
    from app.models.database import User as UserModel

    db = SessionLocal()
    try:
        row = db.query(UserModel).filter(UserModel.username == incoming["username"]).first()
        if row is None:
            return None
        row.is_admin = bool(incoming.get("is_admin"))
        row.nickname = incoming.get("nickname")
        if "avatar" in incoming:
            row.avatar = incoming.get("avatar")
        server_id = incoming.get("id")
        if isinstance(server_id, int) and server_id > 0:
            row.im_user_id = server_id
        elif str(server_id or "").isdigit() and int(server_id) > 0:
            row.im_user_id = int(server_id)
        for perm in PERMISSION_FIELDS:
            setattr(row, perm, bool(incoming.get(perm)))
        _mirror_local_expiry(row, incoming)
        db.commit()
        db.refresh(row)
        return auth_service.user_payload(row)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"[DesktopAuth] 同步权限失败（忽略）：{exc}")
        return None
    finally:
        db.close()


def _issue_local_token(db: Session, user, idle_logout_days: Optional[int] = None) -> str:
    """签发本机 JWT：单机模式按授权时长放宽，避免短有效期把人锁在门外。"""
    from datetime import timedelta

    days = int(idle_logout_days or 2)
    delta = timedelta(days=max(days, 2)) if settings.NPT_DESKTOP else None
    token, jti = auth_service.create_access_token(
        user.id, user.username, user.is_admin, expires_delta=delta,
        profile=getattr(settings, "DESKTOP_PROFILE", "") or "",
    )
    # 写会话记录 → 空闲超时（单机模式为管理员设定的天数）才会要求重新登录
    auth_service.record_session(db, user.id, jti, "127.0.0.1", "pc")
    # 记住本机会话 jti：账号在别处登录时可在本地直接注销这个会话
    try:
        cloud.save_state(local_jti=jti, desktop_username=user.username)
    except Exception:  # noqa: BLE001
        pass
    # 成功登录即确认当前配置档（幂等），下次启动直接进该档
    try:
        from app.core.desktop_profiles import write_active_profile

        write_active_profile(settings.DATA_ROOT, getattr(settings, "DESKTOP_PROFILE", ""))
    except Exception:  # noqa: BLE001
        pass
    return token


def _local_offline_login(db: Session, username: str, password: str, mode: str):
    """本机离线直登校验（不发任何网络请求），共享/单机两种模式共用。

    返回 (user, reason)：user 非空表示本地凭据有效、服务器连不上时可立即离线进入；
    reason 供调用方在不能离线登录时给出可操作的提示（许可过期/换机/账号不匹配等），
    而不是笼统的"无法连接服务器"。

    2026-10-09 调整：
    - 管理员完全免授权：本机镜像管理员账号 + 密码即可离线登录，不要求本机许可；
    - 普通用户完成过一次授权后，本机许可无论是共享还是单机模式都可用于离线登录
      （不再要求"必须单机许可"，否则共享模式转单机离线时会被拦下）。
    2026-10-17：共享模式同样适用——本机许可有效时，授权服务器 TLS 握手超时不应
    把用户挡在门外；共享模式离线进入后数据同步暂停，联网后由后台循环自动恢复。
    """
    from app.models.database import User as UserModel

    row = db.query(UserModel).filter(UserModel.username == username).first()
    local_admin = bool(row is not None and row.is_active and row.is_admin)

    if local_admin:
        if not auth_service.verify_password(password, row.password_hash):
            return None, "bad_password"
        row.desktop_run_mode = mode
        db.commit()
        return row, ""

    known_denial = str(cloud.load_state().get("license_error") or "").strip()
    if known_denial and not re.fullmatch(r"HTTP\s?5\d{2}", known_denial):
        return None, known_denial

    info = license_service.desktop_license_info()
    if not info:
        return None, "no_license"
    if not info.get("valid"):
        # 过期 / 机器码不匹配 / 系统时间回拨：直接把许可文件自身的原因透出
        return None, info.get("errorMessage") or "本机授权无效"
    if (info.get("username") or "").strip() != username:
        licensed = (info.get("username") or "").strip() or "其它账号"
        return None, f"本机授权归属于 {licensed}，请改用该账号登录"

    if row is None or not row.is_active:
        return None, "no_local_user"
    if not auth_service.verify_password(password, row.password_hash):
        return None, "bad_password"
    row.desktop_run_mode = mode
    db.commit()
    return row, ""


# 兼容旧名字（测试/历史调用点）
def _standalone_local_login(db: Session, username: str, password: str):
    return _local_offline_login(db, username, password, MODE_STANDALONE)


def _offline_unavailable_detail(reason: str, network_message: str) -> tuple:
    """服务器不可达且不能离线登录时，按本地校验结果给出可操作的提示。"""
    if reason == "bad_password":
        return 401, "用户名或密码错误"
    if reason == "no_local_user":
        return 502, f"{network_message}；本机没有该账号的离线凭据，请先联网登录一次"
    if reason == "no_license":
        return 502, f"{network_message}；本机尚未激活单机授权，首次使用需要联网登录一次"
    if reason:
        return 403, f"{reason}；请连接网络后重试（联网会自动续期）"
    return 502, network_message


def _ensure_local_group(db: Session, user, license_payload: dict) -> None:
    """单机模式必须保证本地账号有数据组：没有组就看不到自己刚上传的数据。

    优先沿用账号组（与网页端一致），其次用授权记录上管理员指定的组，
    最后兜底到地市预设，避免单机用户陷入「数据传上去却看不见」。
    """
    if user.city and user.operator:
        return
    payload = license_payload or {}
    city = (user.city or payload.get("city") or "").strip()
    operator = (user.operator or payload.get("operator") or "").strip()
    if not city:
        presets = settings.CITY_PRESETS or []
        city = (presets[0] if presets else "").strip()
    if city and not operator:
        operator = "移动"
    if not (city and operator):
        return
    user.city = city
    user.operator = operator
    db.commit()
    db.refresh(user)


def _note_offline_login() -> None:
    """记录一次离线登录（联机时补报给服务器）。"""
    count = int(cloud.load_state().get("pending_offline_logins") or 0) + 1
    cloud.save_state(pending_offline_logins=count)


async def _login_via_server(
    username: str, password: str, mode: str, timeout: int = 20, retries: int = 1
) -> Dict[str, Any]:
    """代理到授权服务器登录，顺便把断网期间的登录次数补报上去。

    timeout/retries：本地凭据有效时走"快速探测"（短超时、不重试），连不上立即
    回落离线登录；无本地凭据时给完整超时并对 TLS 握手超时等瞬断重试一次。
    """
    from starlette.concurrency import run_in_threadpool

    pending = int(cloud.load_state().get("pending_offline_logins") or 0)
    data = await run_in_threadpool(
        cloud.login,
        username,
        password,
        mode,
        pending or None,
        timeout=timeout,
        retries=retries,
    )
    if pending:
        cloud.save_state(pending_offline_logins=0)
    return data


def _remember_sync_user(username: str) -> None:
    """同步服务取本机数据组时要知道当前登录的是谁（后台线程拿不到请求上下文）。"""
    from app.services import desktop_sync_service as sync

    sync.save_state(username=username)


def _sync_service():
    from app.services import desktop_sync_service as sync

    return sync


def _force_local_logout(reason: str) -> None:
    """注销本机会话并记账（前端下次请求即 401）。"""
    state = cloud.load_state()
    jti = (state.get("local_jti") or "").strip()
    if jti:
        from app.core.database import SessionLocal

        db = SessionLocal()
        try:
            auth_service.end_session(db, jti)
        except Exception:  # noqa: BLE001
            pass
        finally:
            db.close()
    # save_state 的 None 表示“不更新”，注销标识必须显式删除，否则旧 jti 会残留。
    cloud.clear_state("session_jti", "local_jti")
    cloud.save_state(
        kicked=True,
        kicked_reason=reason or "该账号已在其它设备登录，本机已退出登录",
    )
    print(f"[DesktopAuth] {reason or '该账号已在其它设备登录'}，本机已退出登录")


def _reject_local_license(reason: str) -> Dict[str, Any]:
    """服务器明确撤销授权：持久化拒绝原因并注销本机令牌。"""
    message = _gbk_safe(reason or "授权已失效，请重新登录")
    cloud.save_state(license_error=message)
    cloud.clear_state("needs_license_verify")
    _force_local_logout(message)
    return {"valid": False, "reason": message, "license_error": message}


def notify_server_logout() -> None:
    """桌面端退出登录：通知服务器结束会话，并清掉本机保存的云端会话标识。

    两步缺一不可——只清本机标识，服务器那条 client_type='desktop' 会话仍会被
    心跳刷新；只通知服务器不清标识，本机心跳还会继续把它刷回来。结果都是管理员
    「用户管理」看到「已退出却仍在线」。全程尽力而为：网络不可达也不能阻断本机登出。
    """
    jti = (cloud.load_state().get("session_jti") or "").strip()
    if jti:
        try:
            cloud.logout(jti)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopAuth] 通知服务器退出登录失败（忽略）：{exc}")
    cloud.clear_state("session_jti", "local_jti", "kicked", "kicked_reason")


# 单机模式本地凭据有效时，服务器登录后台探测的总超时（超时按离线登录处理）
STANDALONE_ONLINE_PROBE_SECONDS = 4
# 上面那次探测里，登录请求**愿意等**多久：本机凭据已经证明身份，没必要为网络干等，
# 超过这个时间就先用本机授权进页面，服务器结果到了再由后台补权限/会话
STANDALONE_FAST_PROBE_SECONDS = 1.2


def _task_result_or_none(task: "asyncio.Task") -> Optional[Dict[str, Any]]:
    """取出已完成的探测任务结果；异常/取消一律当"没探测到"处理。

    必须在这里取一次异常，否则 asyncio 会打 "Task exception was never retrieved"。
    """
    if task.cancelled():
        return None
    exc = task.exception()
    if exc is not None:
        print(f"[DesktopAuth] 服务器探测失败（已按离线登录处理）：{exc}")
        return None
    result = task.result()
    return result if isinstance(result, dict) else None


def _finish_offline_login(db: Session, user, mode: str = MODE_STANDALONE) -> Dict[str, Any]:
    """离线登录：本地许可 + 本机账号密码校验通过即签发令牌，不等网络。

    单机模式：run_mode 置 offline（数据本机私有，不参与同步）；
    共享模式：run_mode 保持 shared（同步循环联网后自动恢复），数据仍按共享档可见。
    登录次数先本机记账、联网后补报；同时留下 needs_license_verify 标记，
    由后台巡检在能连上服务器时用许可续期通道校验一次授权并续期。
    """
    from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

    info = license_service.desktop_license_info() or {}
    if mode == MODE_STANDALONE:
        set_run_mode(MODE_OFFLINE)  # 单机模式数据本机私有，不参与服务器数据同步
    # 共享模式离线进入：不切 run_mode，sync_loop/watch_loop 继续按 shared 尝试，
    # 连不上时各自按"下一轮再试"处理，联网后自动恢复同步
    _ensure_local_group(db, user, info)
    _remember_sync_user(user.username)
    _note_offline_login()  # 登录次数先本机记账，下次联机补报
    # 旧会话标识不再代表本次登录：清掉，避免联网后拿旧 jti 校验把用户误判为"已登出"
    cloud.clear_state("session_jti", "kicked", "kicked_reason")
    cloud.save_state(
        needs_license_verify=True,  # 联网后自动校验授权
        desktop_username=user.username,
        desktop_mode=mode,
    )
    token = _issue_local_token(db, user, info.get("idle_logout_days"))
    # 放行「登录优先」的后台重活队列（图层预热/索引对账/首次同步等）
    mark_login_completed()
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
            "mode": mode,
            "offline": True,
            "verify_pending": True,
            "sync_started": False,
            "idle_logout_days": info.get("idle_logout_days") or 2,
            "license": info,
        },
    }


def verify_pending_license_once() -> Optional[str]:
    """联网时用许可续期通道补一次授权校验（离线登录后调用，不依赖密码/会话）。

    成功返回新到期日（顺带把过期授权续期、把到期日镜像回本机用户）；
    仅服务器 4xx 明确拒绝（禁用/解绑/机器不匹配等）时写 license_error 并停止重试；
    5xx（含 Cloudflare 隧道 530）与网络不可达都属于临时故障，保留标记下轮再试，
    避免把「云端服务暂不可用」误报成「授权校验异常」。离线导入的许可无需在线校验。
    """
    if not cloud.load_state().get("needs_license_verify"):
        return None
    info = license_service.desktop_license_info() or {}
    if info.get("issued_via") != "online" or not info.get("license_id"):
        cloud.clear_state("needs_license_verify")  # 离线导入许可：无在线记录，无需校验
        return None
    try:
        data = cloud.renew_local_license()
    except cloud.CloudError as exc:
        if 400 <= exc.status_code < 500 and exc.status_code != 429:
            # 禁用/解绑/机器不匹配等明确拒绝必须撤销本机会话，不能只给前端提示。
            _reject_local_license(exc.message)
        # status_code=0、429 或 >=500：保留标记下轮再试，不误伤离线使用
        return None
    cloud.clear_state("needs_license_verify", "license_error")
    print(f"[DesktopAuth] 联网后授权校验通过，已续期至 {data.get('expire_date')}")
    return str(data.get("expire_date") or "")


def _local_user_payload_from_state() -> Optional[dict]:
    """取本机当前登录镜像账号的最新载荷（续期后到期日即时回传前端授权门禁）。"""
    username = (cloud.load_state().get("desktop_username") or "").strip()
    if not username:
        return None
    from app.core.database import SessionLocal
    from app.models.database import User as UserModel

    db = SessionLocal()
    try:
        row = db.query(UserModel).filter(UserModel.username == username).first()
        return auth_service.user_payload(row) if row is not None else None
    except Exception:  # noqa: BLE001
        return None
    finally:
        db.close()


def check_session_once() -> Dict[str, Any]:
    """周期性巡检本机会话与授权；仅明确失效才登出，网络故障继续离线使用。"""
    state = cloud.load_state()
    if state.get("kicked"):
        result: Dict[str, Any] = {
            "valid": False,
            "reason": state.get("kicked_reason") or "登录已失效，请重新登录",
        }
        if state.get("license_error"):
            result["license_error"] = state["license_error"]
        return result

    # 兼容旧版本误报：纯 HTTP 5xx 是临时故障，真实业务拒绝则立即撤销本机会话。
    stale_error = str(state.get("license_error") or "").strip()
    if re.fullmatch(r"HTTP\s?5\d{2}", stale_error):
        cloud.clear_state("license_error")
        state = cloud.load_state()
    elif stale_error:
        return _reject_local_license(stale_error)

    jti = (state.get("session_jti") or "").strip()
    data: Dict[str, Any] = {"valid": True}
    if jti:
        try:
            result = cloud.session_check(jti)
        except Exception as exc:  # noqa: BLE001
            result = {"valid": True, "offline": True, "reason": str(exc)}
        if result.get("valid") is False:
            reason = str(result.get("reason") or "")
            if result.get("license_invalid"):
                return _reject_local_license(reason)
            _force_local_logout(reason)
            return {"valid": False, "reason": reason}
        data["offline"] = bool(result.get("offline"))
        user_payload = _sync_permissions_from_remote(result.get("user"))
        if user_payload is not None:
            data["user"] = user_payload
    else:
        data["skipped"] = True
        # 离线登录/批准轮询没有云端 session_jti，也必须持续检查授权，不能首次成功后就跳过。
        if not state.get("needs_license_verify"):
            info = license_service.desktop_license_info() or {}
            if info.get("issued_via") == "online" and info.get("license_id"):
                try:
                    license_result = cloud.license_check()
                except Exception:  # noqa: BLE001
                    # 接口的明确授权拒绝会以 valid=false 正常返回；HTTP 404 等只可能是
                    # 旧版服务器尚无此接口或临时网络故障，不能据此踢人。
                    data["offline"] = True
                else:
                    if license_result.get("valid") is False:
                        return _reject_local_license(str(license_result.get("reason") or ""))
                    data["offline"] = False

    expire_date = verify_pending_license_once()
    state = cloud.load_state()
    if state.get("kicked"):
        return {
            "valid": False,
            "reason": state.get("kicked_reason") or "授权已失效，请重新登录",
            "license_error": state.get("license_error") or state.get("kicked_reason"),
        }
    if expire_date:
        data["license_verified"] = True
        data["license_expire_date"] = expire_date
        refreshed = _local_user_payload_from_state()
        if refreshed is not None:
            data["user"] = refreshed
    return data


async def session_guard_loop(interval_seconds: int = 60) -> None:
    """周期性校验登录态：同一账号在网页端/另一台桌面端登录 → 本机自动登出。"""
    import asyncio

    await asyncio.sleep(30)  # 启动先让本地服务热身
    while True:
        try:
            await asyncio.to_thread(check_session_once)
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopAuth] 登录态校验异常（忽略）：{exc}")
        await asyncio.sleep(max(15, interval_seconds))


# 登录优先：共享模式的首次同步延后这么久再跑（整包下载+解压+导入会抢磁盘，
# 留足首屏请求落地的时间，避免"刚进首页就卡一下"）
LOGIN_SYNC_DELAY_SECONDS = 15.0


def _start_shared_sync() -> None:
    """共享模式登录成功即同步一次同组数据。

    同步要下载并导入多个数据集，与登录、首屏请求抢资源会让"登录很慢"，
    因此延后再跑：登录响应与首屏先完成，同步仍是同一次后台任务
    （失败只写状态，不影响本机使用）。
    """
    from app.services.desktop_sync_service import MODE_SHARED, set_run_mode

    set_run_mode(MODE_SHARED)
    timer = threading.Timer(LOGIN_SYNC_DELAY_SECONDS, _run_sync_once)
    timer.name = "desktop-login-sync"
    timer.daemon = True
    timer.start()


def _run_sync_once() -> None:
    try:
        _sync_service().sync_once()
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopSync] 登录同步失败（忽略）：{exc}")


def _complete_online_login(
    db: Session,
    incoming: Dict[str, Any],
    mode: str,
    password: str,
    username: str,
    server_jti: Optional[str],
    idle_logout_days: Optional[int],
    fallback_license: Optional[Dict[str, Any]] = None,
):
    """服务器校验通过后的本机收尾：镜像账号 → 许可信息 → 会话记录 → 签发本机令牌。

    整段含 bcrypt（实测 300~1000ms）与多次 SQLite 提交，是登录请求里最重的一段
    纯本地开销；必须整体丢线程池执行，否则会卡住事件循环上的所有其它请求。
    """
    user = _mirror_local_user(db, incoming, mode, password)
    info = license_service.desktop_license_info() or (fallback_license or {})
    _remember_sync_user(username)
    # 在线登录成功即清除旧撤销标记，重新登录是恢复授权后的显式入口。
    cloud.clear_state("license_error", "needs_license_verify")
    cloud.save_state(session_jti=server_jti or None, kicked=False, kicked_reason=None)
    if mode == MODE_STANDALONE:
        # 单机模式数据本机私有，不参与服务器数据同步
        from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

        set_run_mode(MODE_OFFLINE)
        _ensure_local_group(db, user, info)
    else:
        # 共享模式：登录即开始同步同组数据（延后触发，见 _start_shared_sync）
        _start_shared_sync()
    token = _issue_local_token(db, user, idle_logout_days)
    return user, info, token


def _apply_late_login_result(data: Optional[Dict[str, Any]]) -> None:
    """单机模式「快速探测」超时后，服务器结果姗姗来迟时的后台补账。

    用户此刻已经用本机授权离线登录成功，这里只把服务器上的权限位/到期日与会话标识
    补上（等价于 60 秒心跳 session_guard_loop 会做的事），不改变已下发的本机令牌。
    """
    if not isinstance(data, dict) or data.get("result") == "pending":
        return
    try:
        incoming = data.get("user") or {}
        if incoming:
            _sync_permissions_from_remote(incoming)
        server_jti = (data.get("session_jti") or "").strip()
        if server_jti:
            cloud.clear_state("license_error", "needs_license_verify")
            cloud.save_state(session_jti=server_jti, kicked=False, kicked_reason=None)
    except Exception as exc:  # noqa: BLE001
        print(f"[DesktopAuth] 迟到的服务器登录结果处理失败（忽略）：{exc}")


def _apply_late_login_probe(task: "asyncio.Task") -> None:
    """asyncio 完成回调：起个线程去补账，绝不在事件循环里做 DB 写。"""
    data = _task_result_or_none(task)
    if data is None:
        return
    threading.Thread(
        target=_apply_late_login_result,
        args=(data,),
        daemon=True,
        name="npt-late-login-probe",
    ).start()


@router.get("/app-version")
async def desktop_app_version() -> Dict[str, Any]:
    """手机 APP 最新版本（公开）：桌面端不分发 APK，直接取服务器的最新版。

    相对下载路径拼成服务器绝对地址，客户端才能扫码/下载（本机 127.0.0.1 不可达）。
    """
    from starlette.concurrency import run_in_threadpool

    _require_desktop()
    try:
        data = await run_in_threadpool(cloud.app_version)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    if not data:
        return {"success": True, "data": None}
    download_url = str(data.get("download_url") or "")
    if download_url and not download_url.startswith("http"):
        download_url = f"{cloud.server_url()}{download_url}"
    return {"success": True, "data": {**data, "download_url": download_url}}


@router.get("/session-status")
async def session_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """本机登录是否仍有效（同一账号被其它端登录时 valid=False）。

    前端登录后周期轮询：失效即清理本地凭据并回到登录页。
    """
    state = cloud.load_state()
    if state.get("kicked"):
        return {
            "success": True,
            "data": {
                "valid": False,
                "reason": state.get("kicked_reason") or "该账号已在其它设备登录，本机已退出登录",
            },
        }
    from starlette.concurrency import run_in_threadpool

    result = await run_in_threadpool(check_session_once)
    return {"success": True, "data": result}


@router.get("/sync-status")
async def sync_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """共享模式同步状态：当前模式、上次同步时间、待上传数、冲突列表。"""
    return {"success": True, "data": _sync_service().status()}


@router.put("/run-mode")
async def set_run_mode(
    payload: RunModeRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """切换共享/离线同步。离线模式不与服务器通信，数据完全本机私有。

    单机模式（登录时选择）不参与服务器数据共享，只能保持离线。
    """
    from app.services.desktop_sync_service import MODE_SHARED, is_shared, run_mode, set_run_mode

    if payload.mode == MODE_SHARED and current_user.desktop_run_mode == MODE_STANDALONE:
        raise HTTPException(
            status_code=403, detail="单机模式不与服务器共享数据，如需共享请以共享模式重新登录"
        )
    mode = set_run_mode(payload.mode)
    detail = {"run_mode": mode, "shared": is_shared()}
    # 切到共享模式立刻同步一次（网络失败不影响本地继续使用）
    if mode == MODE_SHARED:
        from starlette.concurrency import run_in_threadpool

        try:
            result = await run_in_threadpool(_sync_service().sync_once)
            detail["sync_result"] = result
        except Exception as exc:  # noqa: BLE001
            detail["sync_result"] = {"error": str(exc)}
    return {"success": True, "data": {**detail, **_sync_service().status()}}


@router.post("/sync")
async def sync_now(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """立即与服务器同步一次（离线模式下返回跳过）。"""
    from starlette.concurrency import run_in_threadpool

    result = await run_in_threadpool(_sync_service().sync_once)
    message = None
    if result.get("skipped"):
        message = (
            "当前为离线模式，不与服务器同步；切到共享模式后可共享同组数据"
            if result.get("reason") == "当前为离线模式"
            else result.get("reason")
        )
    elif result.get("error"):
        raise HTTPException(status_code=502, detail=_gbk_safe(result["error"]))
    return {
        "success": True,
        "message": message or "同步完成",
        "data": {**result, **_sync_service().status()},
    }


@router.post("/sync-resolve")
async def sync_resolve(
    payload: SyncResolveRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """冲突选边：server=下载服务器版本覆盖本地；local=用本地覆盖服务器。"""
    from starlette.concurrency import run_in_threadpool

    try:
        result = await run_in_threadpool(
            _sync_service().resolve_conflict, payload.data_id, payload.resolution, payload.force
        )
    except _sync_service().SyncError as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))
    return {"success": True, "data": {**result, **_sync_service().status()}}


@router.post("/sync-frozen-resolve")
async def sync_frozen_resolve(
    payload: FrozenChangesRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """确认跨档切换前冻结的旧待上行改动：discard 丢弃 / restore 恢复后上行。"""
    from starlette.concurrency import run_in_threadpool

    try:
        result = await run_in_threadpool(
            _sync_service().resolve_frozen_changes, payload.action
        )
    except _sync_service().SyncError as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))
    return {"success": True, "data": {**result, **_sync_service().status()}}


@router.get("/register-options")
async def desktop_register_options() -> Dict[str, Any]:
    """注册选项（公开）：地市预设与运营商取自服务器，桌面端注册与网页端一致。"""
    from app.services.data_group import OPERATORS

    _require_desktop()
    try:
        from starlette.concurrency import run_in_threadpool

        data = await run_in_threadpool(cloud.register_options)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {
        "success": True,
        "data": {
            "cities": data.get("cities") or [],
            "operators": data.get("operators") or list(OPERATORS),
        },
    }


@router.post("/register")
async def desktop_register(
    payload: DesktopRegisterRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面端注册：与网页端同一套注册规则（账号创建在服务器上）。

    注册成功后自动以共享模式登录并同步同组数据；数据组只能在注册时选择，
    之后只能由服务器管理员修改。
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    city = (payload.city or "").strip()
    operator = (payload.operator or "").strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="用户名长度至少3位")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="密码长度至少6位")
    if password != (payload.confirm_password or ""):
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")
    if not city or not operator:
        raise HTTPException(status_code=400, detail="请选择地市与运营商")

    # 注册成功即以共享模式登录：当前若是单机档，同样先重启切档再注册，
    # 避免在服务器建号后本机登录落进错误的数据空间
    if _cross_profile_required(MODE_SHARED):
        return _accept_cross_profile_switch(MODE_SHARED, {
            "kind": "register",
            "username": username,
            "password": password,
            "confirm_password": payload.confirm_password,
            "city": city,
            "operator": operator,
        })

    try:
        await _register_via_server(username, password, city, operator)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    # 注册成功即共享模式登录（注册时已选定数据组），登录会触发同组数据同步
    return await desktop_login(
        DesktopLoginRequest(username=username, password=password, mode="shared"), db
    )


async def _register_via_server(
    username: str, password: str, city: str, operator: str
) -> None:
    from starlette.concurrency import run_in_threadpool

    await run_in_threadpool(
        cloud.register, username, password, city, operator
    )


@router.post("/login")
async def desktop_login(
    payload: DesktopLoginRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面端登录：共享模式与网页端同账号同权限；单机模式需管理员单独授权。

    单机模式「本地优先」：本机授权 + 本机镜像账号密码校验通过就立即登录（无需网络、
    不等待授权服务器），联网后的授权校验/权限刷新由后台任务补齐；本地凭据不可用时
    才请求服务器（首次登录、等待批准、联网续期等）。
    """
    username = (payload.username or "").strip()
    password = payload.password or ""
    mode = MODE_STANDALONE if str(payload.mode).lower() != MODE_SHARED else MODE_SHARED
    if not username or not password:
        raise HTTPException(status_code=400, detail="请输入用户名与密码")

    # 数据隔离：模式与当前配置档不一致时绝不在当前档登录（镜像账号/会话/数据同步
    # 都会落进错误的数据空间），只记账一次性凭据并重启到目标档完成登录
    if _cross_profile_required(mode):
        return _accept_cross_profile_switch(mode, {
            "kind": "login",
            "username": username,
            "password": password,
            "remember": bool(payload.remember),
        })

    local_user = None
    local_reason = ""
    # 两种模式都先做一次本机离线凭据校验（bcrypt，丢线程池别卡事件循环）：
    # 本机镜像账号 + 有效许可存在时，服务器连不上也能立即进入，不必干等 TLS 握手超时
    local_user, local_reason = await run_in_threadpool(
        _local_offline_login, db, username, password, mode
    )

    try:
        if local_user is not None:
            # 本机凭据有效：服务器只做「快速探测」。本地凭据已经证明用户身份，没必要
            # 让用户干等网络——超过 FAST 秒立即离线进入，探测结果稍后由
            # _apply_late_login_result 在后台补权限/会话（共享模式同步会在联网后恢复）。
            probe_task = asyncio.create_task(
                _login_via_server(
                    username, password, mode,
                    STANDALONE_ONLINE_PROBE_SECONDS, retries=0,
                )
            )
            try:
                data = await asyncio.wait_for(
                    asyncio.shield(probe_task), timeout=STANDALONE_FAST_PROBE_SECONDS
                )
            except asyncio.TimeoutError:
                print(
                    f"[DesktopAuth] 授权服务器响应超过 {STANDALONE_FAST_PROBE_SECONDS}s，"
                    "先用本机授权登录，结果到达后后台补校验"
                )
                probe_task.add_done_callback(_apply_late_login_probe)
                _apply_remember(payload.remember, username, password, mode)
                return _finish_offline_login(db, local_user, mode)
        else:
            # 本机没有可用离线凭据（首次登录/等待批准/许可归属其它账号）：
            # 只能等服务器；完整超时 + TLS 握手超时等瞬断自动重试一次
            data = await _login_via_server(username, password, mode, 10, retries=1)
    except cloud.CloudError as exc:
        # 本地凭据有效且只是网络不可达/服务器故障 → 离线进入，拿到本机授权继续用
        if local_user is not None and (exc.status_code == 0 or exc.status_code >= 500):
            print(
                f"[DesktopAuth] 授权服务器暂不可用（{exc.status_code or '网络'}），"
                "改用本机授权离线登录"
            )
            _apply_remember(payload.remember, username, password, mode)
            return _finish_offline_login(db, local_user, mode)
        # 鉴权/授权类错误照常抛出（密码错、待批准、许可无效等不能离线绕过）
        if exc.status_code != 0:
            raise HTTPException(
                status_code=exc.status_code or 502, detail=_gbk_safe(exc.message)
            )
        # 网络不可达且本地不能离线登录：按本地校验的具体原因提示（过期/换机/账号不符…）
        status_code, detail = _offline_unavailable_detail(local_reason, exc.message)
        raise HTTPException(status_code=status_code, detail=_gbk_safe(detail))

    if data.get("result") == "pending":
        return {"success": True, "data": data}

    incoming = data.get("user") or {}
    user, info, token = await run_in_threadpool(
        _complete_online_login,
        db,
        incoming,
        mode,
        password,
        username,
        (data.get("session_jti") or "").strip(),
        data.get("idle_logout_days"),
        data.get("license") or {},
    )
    _apply_remember(payload.remember, username, password, mode)
    # 放行「登录优先」的后台重活队列（图层预热/索引对账/首次同步等）
    mark_login_completed()
    # 自身登录不弹气泡/不响敲门声：共享模式下由服务器端广播给「除自身外的
    # 其他用户端」，本机回包不再带 online_event
    return {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
            "mode": mode,
            "offline": False,
            "sync_started": mode != MODE_STANDALONE,
            "idle_logout_days": data.get("idle_logout_days") or 2,
            "license": info,
        },
    }


@router.get("/pending-login")
async def get_pending_login(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """消费跨档重启前保存的一次性登录/注册凭据（读后即删）。

    目标档与当前运行档不一致时返回 null（凭据同时被销毁）。
    """
    return {"success": True, "data": consume_pending_login()}


def _discard_pending_login() -> None:
    """销毁跨档一次性凭据（用户在确认弹窗点了取消）。"""
    try:
        _pending_login_path().unlink(missing_ok=True)
    except OSError:
        pass


@router.post("/restart")
async def desktop_restart(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """切换配置档后重启应用：拉起重启脚本并退出当前进程。

    Windows 桌面壳返回 restart_supported=true；非 Windows/壳环境不支持自动重启，
    前端提示用户手动关闭后重新打开（数据空间已在标记文件中指定）。
    """
    from app.core.desktop_profiles import spawn_relaunch

    spawned = spawn_relaunch(settings.DATA_ROOT)
    if not spawned:
        return {"success": True, "data": {"restart_supported": False, "exiting": False}}
    from app import desktop_bridge

    exiting = desktop_bridge.request_exit()
    return {"success": True, "data": {"restart_supported": True, "exiting": bool(exiting)}}


@router.post("/switch-cancel")
async def desktop_switch_cancel(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """用户在重启确认弹窗取消：放弃模式切换。

    跨档登录短路时已把 active_profile 改写为目标档；取消必须恢复成当前运行档
    并销毁一次性凭据，否则下次启动应用会误入目标档（空数据空间）。
    """
    from app.core.desktop_profiles import write_active_profile

    current = write_active_profile(settings.DATA_ROOT, getattr(settings, "DESKTOP_PROFILE", ""))
    _discard_pending_login()
    return {"success": True, "data": {"cancelled": True, "mode": current}}


@router.get("/profile")
async def get_desktop_profile(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """当前**实际运行**的配置档（shared / standalone）。

    登录页必须按它来预填与自动登录，不能用"记住账号密码"里保存的 mode ——
    跨档重启后那份 mode 是切换前的旧值，照它登录会被再次判定为跨档，
    于是弹窗又要求重启一次（"切换模式要重启两次"）。
    """
    from app.core.desktop_profiles import normalize_profile

    return {"success": True, "data": {
        "profile": normalize_profile(getattr(settings, "DESKTOP_PROFILE", "")),
    }}


@router.get("/last-login")
async def get_last_login(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """最近一次记住的登录账号/密码（本机加密文件，仅桌面端可用）。

    登录页据此预填并在勾选「记住」时自动登录；没有保存过则 data=null。
    """
    return {"success": True, "data": load_last_login()}


@router.delete("/last-login")
async def delete_last_login(_: None = Depends(_require_desktop)) -> Dict[str, Any]:
    """清除记住的账号/密码（用户取消勾选或主动清除时调用）。"""
    clear_last_login()
    return {"success": True, "data": None}


@router.post("/auth-poll")
async def desktop_auth_poll(
    payload: DesktopPollRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """单机模式：轮询「申请授权」结果，管理员一批准即完成登录。"""
    username = (payload.username or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="缺少用户名")
    try:
        data = cloud.poll_login(username)
    except cloud.CloudError as exc:
        raise HTTPException(status_code=exc.status_code or 502, detail=_gbk_safe(exc.message))

    if data.get("result") != "ok":
        return {"success": True, "data": data}

    incoming = data.get("user") or {}
    # 轮询阶段没有明文密码：本机已有账号就沿用其哈希（_mirror 在 password=None 时保留）
    user = _mirror_local_user(db, incoming, MODE_STANDALONE)
    info = license_service.desktop_license_info() or {}
    _ensure_local_group(db, user, info)
    from app.services.desktop_sync_service import MODE_OFFLINE, set_run_mode

    set_run_mode(MODE_OFFLINE)
    _remember_sync_user(username)
    # 与 /desktop/login 返回同形状：前端轮询入口按 result/access_token 判定登录成功，
    # 缺了这两个字段管理员批准后桌面端会一直停在等待弹窗
    token = _issue_local_token(db, user, data.get("idle_logout_days"))
    return {
        "success": True,
        "data": {
            "result": "ok",
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": auth_service.user_payload(user),
            "mode": MODE_STANDALONE,
            "idle_logout_days": data.get("idle_logout_days") or 2,
        },
    }


@router.get("/cloud-status")
async def cloud_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    return {"success": True, "data": _status_payload()}


@router.post("/cloud-activate")
def cloud_activate(
    payload: ActivateRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.activate(payload.activation_code.strip())
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    ok, message = license_service.activate(str(data.get("license_file") or ""))
    if not ok:
        raise HTTPException(status_code=500, detail=_gbk_safe(f"许可文件校验失败：{message}"))
    return {"success": True, "message": message, "data": _status_payload()}


@router.post("/cloud-renew")
def cloud_renew(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.renew_local_license()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {
        "success": True,
        "message": f"已续期至 {data.get('expire_date', '')}",
        "data": _status_payload(),
    }


@router.post("/cloud-apply")
def cloud_apply(
    payload: ApplyRequest,
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        data = cloud.apply_license(payload.applicant_name, payload.organization, payload.note)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {"success": True, "data": data}


@router.get("/cloud-apply")
def cloud_apply_poll(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    try:
        result = cloud.poll_apply()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)

    activated = False
    if result.get("status") == "issued" and result.get("activation_code"):
        try:
            data = cloud.activate(str(result["activation_code"]))
            ok, message = license_service.activate(str(data.get("license_file") or ""))
            activated = bool(ok)
            if not ok:
                result["message"] = f"许可文件校验失败：{message}"
        except cloud.CloudError as exc:
            result["message"] = exc.message

    return {
        "success": True,
        "data": {
            "status": result.get("status"),
            "message": result.get("message"),
            "activated": activated,
            "status_detail": _status_payload() if activated else None,
        },
    }


# ---------------------------------------------------------------- OTA 更新

class UpdateRequest(BaseModel):
    version: Optional[str] = None


@router.get("/update/status")
def update_status(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    try:
        release = updater.check_latest(raise_on_error=True)
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {
        "success": True,
        "data": {
            "current": settings.NPT_DESKTOP_VERSION or "",
            "channel": settings.NPT_DESKTOP_CHANNEL or "stable",
            "release": release,
            "update_available": bool(release and release.get("update_available")),
            "download": updater.progress(),
            # 上一次安装的结果（目标版本/退出码/是否已生效）：装失败时前端要给出人工安装提示
            "last_result": updater.last_result(),
        },
    }


@router.post("/update/download")
def update_download(
    payload: UpdateRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """下载新版本：桌面端是本机单机形态，登录用户即可更新（接口仅桌面形态存在）。"""
    from app.services import desktop_update_service as updater

    release = updater.check_latest()
    if not release:
        raise HTTPException(
            status_code=502, detail="无法获取版本信息，请检查网络或授权服务器地址"
        )
    # 只下载确实高于本机的版本：手动装了新版本后，服务器仍可能标着一个更旧的包
    if not release.get("update_available"):
        raise HTTPException(status_code=409, detail="当前已是最新版本，无需下载")
    return {"success": True, "data": updater.start_download(release)}


@router.get("/update/progress")
async def update_progress(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    return {"success": True, "data": updater.progress()}


@router.post("/update/background")
def update_background(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """「后台运行」：转入后台更新，窗口关闭后继续下载并自动安装（对所有登录用户开放）。"""
    from app.services import desktop_update_service as updater

    try:
        data = updater.arm_background()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {"success": True, "data": data}


@router.post("/update/install")
def update_install(
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    from app.services import desktop_update_service as updater

    try:
        result = updater.install_and_exit()
    except cloud.CloudError as exc:
        _raise_cloud_error(exc)
    return {"success": True, "data": result}


@router.post("/exit")
async def desktop_exit(
    admin_user: User = Depends(get_current_admin_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """仅用于"重启并安装"：关闭窗口退出应用（web/服务器模式返回 403）。"""
    from app import desktop_bridge

    if not desktop_bridge.request_exit():
        raise HTTPException(status_code=403, detail="当前运行环境不支持退出（非桌面壳）")
    return {"success": True, "message": "正在退出"}


class WindowTitleRequest(BaseModel):
    title: str = Field(..., description="窗口标题（应用名 + 运行模式 + 同步状态）")


@router.post("/window-title")
async def desktop_window_title(
    payload: WindowTitleRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """把「运行模式 + 实时同步状态」写到桌面窗口标题栏（web/服务器模式返回 403）。

    前端在运行模式或同步状态变化时调用；标题串由前端按当前语言拼好，后端只做转发。
    """
    from app import desktop_bridge

    title = (payload.title or "").strip()[:200]
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")
    if not desktop_bridge.set_window_title(title):
        raise HTTPException(status_code=403, detail="当前运行环境不支持修改窗口标题（非桌面壳）")
    return {"success": True, "data": {"title": title}}


class FullscreenRequest(BaseModel):
    fullscreen: bool = Field(..., description="true=进入全屏，false=退出全屏")


@router.post("/fullscreen")
async def desktop_fullscreen(
    payload: FullscreenRequest,
    current_user: User = Depends(get_current_user),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """地图页「全屏」：把桌面主窗口切成系统级全屏（覆盖整个屏幕、无标题栏）。

    WebView2 里的 HTML Fullscreen API 只让网页内容占满 WebView 本身，窗口不变；
    桌面端由壳层直接切换窗口全屏。非桌面壳返回 403（网页端继续走浏览器 API）。
    """
    from app import desktop_bridge

    fullscreen = bool(payload.fullscreen)
    if not desktop_bridge.set_window_fullscreen(fullscreen):
        raise HTTPException(status_code=403, detail="当前运行环境不支持窗口全屏（非桌面壳）")
    return {"success": True, "data": {"fullscreen": fullscreen}}


class WindowControlRequest(BaseModel):
    action: Literal[
        "minimize", "toggle-maximize", "close", "resize-edge", "drag", "activate"
    ] = Field(
        ..., description="窗口控制动作（自绘标题栏按钮 / 边缘缩放把手 / 原生拖窗 / 截图后回焦）"
    )
    direction: Optional[Literal["n", "s", "e", "w", "ne", "nw", "se", "sw"]] = Field(
        None, description="resize-edge 缩放方向（n/s/e/w/ne/nw/se/sw，对应上/下/右/左与四角）"
    )


class ImStoragePathRequest(BaseModel):
    path: str = Field(..., max_length=1024, description="新的聊天附件本地保存目录（绝对路径）")


@router.post("/window-control")
async def desktop_window_control(
    payload: WindowControlRequest,
    _: None = Depends(_require_desktop_fast),
    __: None = Depends(_require_desktop_window_user),
) -> Dict[str, Any]:
    """frameless 窗口自绘标题栏的窗口动作：最小化/最大化还原/关闭/边缘缩放/回焦。

    关闭走 window.destroy() → events.closing（保留后台更新例外与看门狗兜底）；
    缩放把方向交给壳层，由系统原生缩放循环接管（四边四角都能拉）；activate 是截图
    共享其它应用窗口后把主窗口带回前台，非 Windows / 无原生句柄时返回 activated=False。
    非桌面壳（桥接未注入 / 动作执行失败）返回 403。

    交互快路径：鉴权只验 JWT 签名（不占 anyio 线程池），壳层把原生窗口动作派发到
    独立线程（不冻结事件循环），因此 IM 轮询/relay 再忙也不会把按钮点按排队几十秒。
    """
    from app import desktop_bridge

    params: Dict[str, Any] = {}
    if payload.action == "resize-edge":
        if not payload.direction:
            raise HTTPException(status_code=400, detail="resize-edge 需要提供 direction")
        params = {"direction": payload.direction}
    result = desktop_bridge.control_window(payload.action, params)
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持窗口控制（非桌面壳）")
    return {"success": True, "data": result}


@router.get("/screenshot-hotkey")
async def desktop_screenshot_hotkey(
    _: None = Depends(_require_desktop_fast),
) -> Dict[str, Any]:
    """壳层 Win32 全局热键 Alt+Z 的序号（前端 400ms 轮询，增量即触发截图）。

    不做登录校验：登录页也能拿到基线序号，避免登录后立刻把历史序号误判成一次热键。
    """
    from app import desktop_bridge

    return {"success": True, "data": {"seq": desktop_bridge.screenshot_hotkey_seq()}}


@router.get("/window-state")
async def desktop_window_state(
    _: None = Depends(_require_desktop_fast),
    __: None = Depends(_require_desktop_window_user),
) -> Dict[str, Any]:
    """查询窗口状态缓存（maximized/fullscreen），供自绘标题栏在窗口聚焦时校准按钮图标。"""
    from app import desktop_bridge

    result = desktop_bridge.control_window("state")
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持窗口状态查询（非桌面壳）")
    return {"success": True, "data": result}


# ------------------------------------------------------- 项目沟通本地存储管理
#
# 仅桌面形态可见：路径配置按 shared/standalone 档隔离，不影响网页端与服务器。
# 迁移/清理是低频重活，全部丢线程池，不阻塞 uvicorn 事件循环。

@router.get("/im-storage")
async def desktop_im_storage_state(
    _: None = Depends(_require_desktop),
    __: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """当前档的附件保存路径、默认路径与可清理缓存占用。"""
    state = await run_in_threadpool(desktop_im_storage.current_state)
    return {"success": True, "data": state}


@router.post("/im-storage/path")
async def desktop_im_storage_set_path(
    payload: ImStoragePathRequest,
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
    __: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """修改路径并整体迁移；目标非空、系统目录、不可写或迁移校验失败一律拒绝。"""
    def _apply() -> Dict[str, Any]:
        target = desktop_im_storage.validate_path(payload.path)
        return desktop_im_storage.migrate_attachment_dir(target)

    try:
        state = await run_in_threadpool(_apply)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "data": state}


@router.post("/im-storage/clean")
async def desktop_im_storage_clean(
    db: Session = Depends(get_db),
    _: None = Depends(_require_desktop),
    __: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """清理临时分片、未引用孤立文件与旧的输入附件临时副本（不动消息与正式附件）。"""
    result = await run_in_threadpool(desktop_im_storage.cleanup_now, db)
    return {"success": True, "data": result}


@router.post("/im-storage/pick-directory")
async def desktop_im_storage_pick_directory(
    _: None = Depends(_require_desktop),
    __: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """调壳层原生文件夹选择框；无壳 / 用户取消返回 picked=null。"""
    picked = await run_in_threadpool(desktop_bridge.pick_folder)
    return {"success": True, "data": {"picked": picked}}


# ---------------------------------------------------------------- 桌面取景截图
#
# 与 /screenshot-hotkey 一样不做登录校验：全局热键要求「应用不关闭就始终可用」，
# 不能因为登录态过期 / 停留在登录页而让在其它应用窗口按下的快捷键失效。
# 本机后端只绑定 127.0.0.1，且 _require_desktop 保证网页/服务器模式一律 404。

class ScreenshotCaptureRequest(BaseModel):
    hide_im_window: bool = Field(False, description="是否隐藏协作沟通会话浮窗后取景")
    frame_ready: bool = Field(
        False,
        description="前端已完成 DOM 稳定化（清标记/关遮罩/收下拉/等两帧），壳层可立即抓屏",
    )


class ScreenshotSettingsRequest(BaseModel):
    hotkey: Dict[str, Any] = Field(..., description="组合键：{modifiers: [...], key: 'Z'}")
    hideImWindow: bool = Field(False, description="截图时隐藏会话窗口（默认关闭）")


@router.post("/screenshot-capture")
async def desktop_screenshot_capture(
    payload: ScreenshotCaptureRequest,
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """发起一次壳层取景；HTTP 立即返回基线序号，蒙层交互在独立线程进行。

    ``started=false`` 且 ``busy=true`` 表示已有取景进行中；``unsupported=true``
    表示当前不是 Windows 桌面壳，前端应降级到网页端的窗口选择截图。
    """
    from app import desktop_bridge

    # 前端已接管这一轮全局热键：撤销壳层的 watchdog 兜底，避免重复铺蒙层。
    # 旧前端不带 frame_ready 也能正常 claim，只是壳层会多等一帧。
    desktop_bridge.claim_screenshot_round()
    result = desktop_bridge.screenshot(
        "start", {
            "hideImWindow": bool(payload.hide_im_window),
            "frameReady": bool(payload.frame_ready),
        }
    )
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持壳层取景截图（非桌面壳）")
    return {"success": True, "data": result}


@router.post("/screenshot-cancel")
async def desktop_screenshot_cancel(
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """中止仍在取景的蒙层（用户提前关闭截图弹窗时调用，避免置顶窗口残留）。"""
    from app import desktop_bridge

    result = desktop_bridge.screenshot("cancel")
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持壳层取景截图（非桌面壳）")
    return {"success": True, "data": result}


@router.get("/screenshot-result")
async def desktop_screenshot_result(
    after: int = Query(0, ge=0, description="发起时拿到的基线序号"),
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """按序号增量轮询取景结果：``ready`` / ``cancelled`` 决定前端下一步。"""
    from app import desktop_bridge

    result = desktop_bridge.screenshot("status", {"after": after})
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持壳层取景截图（非桌面壳）")
    return {"success": True, "data": result}


@router.get("/screenshot-image")
async def desktop_screenshot_image(
    _: None = Depends(_require_desktop),
) -> Response:
    """取走最近一帧裁剪好的 PNG（读后即弃）；走二进制避免 base64 膨胀与 JSON 内存峰值。"""
    from app import desktop_bridge

    result = desktop_bridge.screenshot("image")
    if result is None:
        raise HTTPException(status_code=403, detail="当前运行环境不支持壳层取景截图（非桌面壳）")
    png = result.get("png")
    if not png:
        raise HTTPException(status_code=404, detail="截图结果已被取走或尚未生成")
    return Response(
        content=png, media_type="image/png",
        headers={"Cache-Control": "no-store", "Content-Disposition": "inline"},
    )


@router.get("/screenshot-settings")
async def desktop_get_screenshot_settings(
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """读本机截图设置（组合键 + 隐藏会话窗口开关）与热键当前注册状态。"""
    from app import desktop_bridge

    stored = screenshot_cfg.load_settings(settings.DATA_ROOT)
    hotkey = desktop_bridge.screenshot("hotkey-status") or {}
    return {"success": True, "data": {
        "settings": stored,
        "hotkey": {**hotkey, "display": screenshot_cfg.format_hotkey(stored)},
    }}


@router.put("/screenshot-settings")
async def desktop_put_screenshot_settings(
    payload: ScreenshotSettingsRequest,
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """保存截图设置并让壳层热键线程按新组合键重注册。

    组合键被其它应用占用（RegisterHotKey 返回 1409）时**回滚**到上一次可用配置，
    返回 ``conflict=true``，前端据此提示用户更换。配置写本机文件而非跨设备用户设置，
    因为全局热键在其它应用窗口触发时前端可能未登录 / 不在前台。
    """
    from app import desktop_bridge

    raw = {"hotkey": payload.hotkey, "hideImWindow": bool(payload.hideImWindow)}
    candidate, error = screenshot_cfg.validate_settings(raw)
    if error:
        raise HTTPException(status_code=400, detail=f"截图快捷键设置无效：{error}")

    previous = screenshot_cfg.load_settings(settings.DATA_ROOT)
    hotkey_changed = candidate["hotkey"] != previous["hotkey"]
    screenshot_cfg.save_settings(settings.DATA_ROOT, candidate)
    # 只切换「隐藏窗口截图」开关时无需重注册：否则当前组合键恰好被占用会让一个
    # 与热键无关的开关操作也被回滚，还会白白注销/注册一次系统热键。
    if not hotkey_changed:
        status = desktop_bridge.screenshot("hotkey-status") or {}
        return {"success": True, "data": {
            "settings": candidate, "conflict": False,
            "registered": bool(status.get("registered")), "reverted": False,
        }}
    applied = desktop_bridge.screenshot("apply")
    if applied is None:
        # 桥接未注入（旧壳 / 非 Windows）：配置已落盘，下次启动生效
        return {"success": True, "data": {
            "settings": candidate, "conflict": False, "registered": False,
            "shellUnavailable": True, "reverted": False,
        }}
    if applied.get("conflict"):
        screenshot_cfg.save_settings(settings.DATA_ROOT, previous)
        desktop_bridge.screenshot("apply")
        return {"success": True, "data": {
            "settings": previous, "conflict": True, "registered": False,
            "reverted": True, "error": applied.get("error", 0),
        }}
    return {"success": True, "data": {
        "settings": candidate, "conflict": False,
        "registered": bool(applied.get("registered")), "reverted": False,
    }}


@router.get("/cloud-ws-config")
async def desktop_cloud_ws_config(
    _: None = Depends(_require_desktop),
) -> Dict[str, Any]:
    """桌面共享模式的云端 IM 推送配置（仅本机 127.0.0.1 下发许可凭证）。

    桌面端没有云端 JWT，云 WS 靠「签名许可 + 机器码」鉴权；凭证只经本端点交给
    本机 WebView2，由客户端放在**首条 auth 消息**里，绝不进 URL / 访问日志。
    单机模式、网页端、未激活或开关关闭时返回 ``enabled=false``，前端退回 relay 轮询。
    """
    import hashlib

    if not settings.NPT_IM_CLOUD_WS_ENABLED:
        return {"success": True, "data": {"enabled": False}}
    try:
        from app.services import im_desktop_proxy

        if not im_desktop_proxy.is_shared_desktop():
            return {"success": True, "data": {"enabled": False}}
    except Exception:  # noqa: BLE001
        return {"success": True, "data": {"enabled": False}}

    base = cloud.server_url()
    if not base:
        return {"success": True, "data": {"enabled": False}}
    try:
        license_file = cloud._license_file_text()
    except Exception:  # noqa: BLE001
        return {"success": True, "data": {"enabled": False}}
    ws_base = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return {"success": True, "data": {
        "enabled": True,
        "url": f"{ws_base}/api/v1/ws/tasks?kind=license",
        "license_file": license_file,
        "machine_code": get_machine_code(),
        "auth_timeout_ms": int(settings.NPT_IM_CLOUD_WS_AUTH_TIMEOUT_MS),
        "reauth_interval_ms": 300000,
        # 许可续期后指纹变化：客户端据此主动重连重鉴权，避免旧身份常驻
        "license_fingerprint": hashlib.sha256(license_file.encode("utf-8")).hexdigest()[:16],
    }}
