"""桌面版在线授权/OTA 客户端公开接口 + 共享模式数据同步。

调用方是桌面客户端（经本机后端代理），不使用站点 JWT：
- 激活：凭证是激活码
- 续期：凭证是上一次签发的许可文件（Ed25519 验签）
- 数据同步：凭证同样是许可文件（服务器据此识别是哪一台桌面端）
- 申请：返回一次性 apply_token 轮询结果
- 版本：完全公开
统一做轻量内存限流，防暴力猜码。
"""
from __future__ import annotations

import secrets
import time
import urllib.parse
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.services.desktop_license_service import (
    DesktopLicenseError,
    desktop_license_service,
    ensure_shadow_user,
)

router = APIRouter(tags=["桌面客户端在线接口"])

_rl_buckets: Dict[str, List[float]] = defaultdict(list)


def _gbk_safe(message: str) -> str:
    return str(message).encode("gbk", "replace").decode("gbk")


def _rate_limit(key: str, limit: int = 20, window: int = 300) -> None:
    now = time.time()
    bucket = [t for t in _rl_buckets.get(key, []) if now - t < window]
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    bucket.append(now)
    _rl_buckets[key] = bucket


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for") or ""
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _payload_data(record, license_file: str, expire_date: str) -> Dict[str, Any]:
    return {
        "license_file": license_file,
        "license_id": record.id,
        "licensee": record.licensee_username,
        "organization": record.organization,
        "machine_code": record.machine_code,
        "lease_days": record.lease_days,
        "expire_date": expire_date,
        "remaining_days": desktop_license_service.remaining_days(expire_date),
    }


class ActivateRequest(BaseModel):
    activation_code: str
    machine_code: str
    client_version: Optional[str] = None
    hostname: Optional[str] = None


class RenewRequest(BaseModel):
    license_file: str
    machine_code: str
    client_version: Optional[str] = None


class ApplyRequest(BaseModel):
    machine_code: str
    applicant_name: str = Field(..., description="申请人/单位名称")
    organization: Optional[str] = None
    note: Optional[str] = None
    client_version: Optional[str] = None
    hostname: Optional[str] = None


class LoginRequest(BaseModel):
    """桌面端账号登录：与网页端同一套账号，共享模式直接放行、单机模式需授权。"""

    username: str
    password: str
    mode: str = Field(default="standalone", description="shared=共享模式 / standalone=单机模式")
    machine_code: str
    client_version: Optional[str] = None
    hostname: Optional[str] = None
    offline_logins: Optional[int] = Field(
        default=None, ge=1, le=1000, description="离线期间累计的登录次数（补报）"
    )


class PollLoginRequest(BaseModel):
    """单机模式授权申请轮询：管理员批准后当场签许可。"""

    username: str
    machine_code: str


class SessionCheckRequest(BaseModel):
    """登录态校验：确认本次登录仍是该账号的最后一次登录。"""

    license_file: str
    machine_code: str
    session_jti: str


class RegisterRequest(BaseModel):
    """桌面端注册：规则与网页端注册一致（账号创建在服务器，注册不允许自封管理员）。"""

    username: str
    password: str
    confirm_password: str
    city: str
    operator: str


@router.post("/auth/login")
async def desktop_login(
    payload: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """桌面端账号登录（公开 + 限流，凭证是网页端用户名/密码）。"""
    _rate_limit(f"login:{_client_ip(request)}", limit=20, window=300)
    try:
        result, data = desktop_license_service.login(
            db,
            username=payload.username,
            password=payload.password,
            mode=payload.mode,
            machine_code=payload.machine_code,
            client_version=payload.client_version,
            hostname=payload.hostname,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))

    # 同一账号以最后登录为准：桌面端登录同样占用服务器会话，并踢掉该账号其它
    # 网页端/桌面端登录（客户端据此周期性校验，被踢后本机自动登出）
    if result == "ok":
        try:
            from app.services.auth_service import auth_service

            user_id = int((data.get("user") or {}).get("id") or data.get("user_id") or 0)
            if user_id:
                jti = secrets.token_urlsafe(16)
                auth_service.record_session(db, user_id, jti, _client_ip(request), "desktop")
                auth_service.revoke_other_sessions(db, user_id, jti)
                data["session_jti"] = jti
        except Exception as exc:  # noqa: BLE001
            print(f"[DesktopCloud] 会话记账失败（不影响登录）：{exc}")

    # 单机模式断网期间在本机登录的次数，联机时补报（不影响本次登录本身）
    if result == "ok" and payload.offline_logins:
        try:
            data["login_count"] = desktop_license_service.report_offline_logins(
                db, int(data.get("license_id") or 0), int(payload.offline_logins)
            )
        except DesktopLicenseError:
            pass  # 补报失败不阻断登录
    return {"success": True, "data": {"result": result, **data}}


@router.post("/auth/poll")
async def desktop_login_poll(
    payload: PollLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """单机模式：轮询授权申请结果（approved 时直接返回许可）。"""
    _rate_limit(f"poll:{_client_ip(request)}", limit=120, window=300)
    try:
        result, data = desktop_license_service.poll_login(
            db, username=payload.username, machine_code=payload.machine_code
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": {"result": result, **data}}




@router.post("/auth/session-check")
async def desktop_session_check(
    payload: SessionCheckRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """校验桌面端登录是否仍然有效（同一账号被其它端登录时返回 valid=False）。

    客户端周期性调用：一旦失效就本机登出，实现"网页端/桌面端不能同时在线"。
    网络不可达时返回 valid=True（不因断网把人踢下线）。

    这也是桌面端的心跳（默认每 60s 一次）：必须刷新 last_activity，否则用户
    空闲超过 5 分钟后会被「用户管理」的在线判定（5 分钟活跃窗口）误报为离线。

    valid=True 时一并返回账号当前信息（含权限位）：管理员在「用户管理 → 编辑」
    改了权限后，客户端心跳时即可同步到本机，保持桌面端与网页端权限一致。
    """
    from app.models.database import User, UserSession

    _rate_limit(f"session:{_client_ip(request)}", limit=120, window=300)
    try:
        record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    except HTTPException as exc:
        if exc.status_code in (400, 403, 404, 409):
            return {"success": True, "data": {"valid": False, "reason": _gbk_safe(str(exc.detail))}}
        raise

    jti = (payload.session_jti or "").strip()
    if not jti:
        return {"success": True, "data": {"valid": False, "reason": "缺少会话标识，请重新登录"}}

    session = db.query(UserSession).filter(UserSession.token_jti == jti).first()
    if session is None or session.logout_time is not None:
        return {
            "success": True,
            "data": {"valid": False, "reason": "该账号已在其它设备登录，本机已退出登录"},
        }
    if record.user_id and session.user_id != record.user_id:
        return {"success": True, "data": {"valid": False, "reason": "会话与授权不匹配，请重新登录"}}

    # 心跳即活跃：刷新会话时间，供「用户管理」的桌面端在线状态判定
    session.last_activity = datetime.now(timezone.utc)
    db.commit()

    data: Dict[str, Any] = {"valid": True}
    user = db.query(User).filter(User.id == session.user_id).first()
    if user is not None:
        from app.services.auth_service import auth_service

        data["user"] = auth_service.user_payload(user)
    return {"success": True, "data": data}


@router.post("/auth/register")
async def desktop_register(
    payload: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """桌面端注册（公开 + 限流）：与网页端注册同一套校验，注册后即可登录。"""
    from app.services.auth_service import auth_service
    from app.services.data_group import validate_group

    _rate_limit(f"register:{_client_ip(request)}", limit=10, window=300)

    username = (payload.username or "").strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="用户名长度至少3位")
    if len(payload.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码长度至少6位")
    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")
    group_error = validate_group(payload.city, payload.operator)
    if group_error:
        raise HTTPException(status_code=400, detail=_gbk_safe(group_error))

    user, error = auth_service.create_user(
        db=db,
        username=username,
        password=payload.password,
        is_admin=False,  # 安全：注册不允许自封管理员
        city=(payload.city or "").strip(),
        operator=(payload.operator or "").strip(),
    )
    if error:
        raise HTTPException(status_code=400, detail=_gbk_safe(error))
    return {"success": True, "data": {"username": user.username}, "message": "注册成功"}


@router.get("/config")
async def client_config() -> Dict[str, Any]:
    """客户端握手：激活模式/默认租约/更新渠道（公开，供客户端决定展示哪种激活方式）。"""
    return {
        "success": True,
        "data": {
            "activation_mode": (settings.NPT_DESKTOP_ACTIVATION_MODE or "precreate").lower(),
            "lease_days": int(settings.NPT_DESKTOP_LEASE_DAYS or 30),
            "channel": settings.NPT_DESKTOP_CHANNEL or "stable",
            "server_url": settings.NPT_SERVER_URL,
            "signing_configured": True,  # 私有实现细节不暴露；签发失败时激活接口会返回 503
        },
    }


@router.post("/license/activate")
async def activate_license(
    payload: ActivateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    _rate_limit(f"activate:{_client_ip(request)}", limit=20, window=300)
    try:
        record, license_file, expire_date = desktop_license_service.activate(
            db,
            activation_code=payload.activation_code,
            machine_code=payload.machine_code,
            client_version=payload.client_version,
            hostname=payload.hostname,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": _payload_data(record, license_file, expire_date)}


@router.post("/license/renew")
async def renew_license(
    payload: RenewRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    _rate_limit(f"renew:{_client_ip(request)}", limit=60, window=300)
    try:
        record, license_file, expire_date = desktop_license_service.renew(
            db,
            license_text=payload.license_file,
            machine_code=payload.machine_code,
            client_version=payload.client_version,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": _payload_data(record, license_file, expire_date)}


@router.post("/license/apply")
async def apply_license(
    payload: ApplyRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    _rate_limit(f"apply:{_client_ip(request)}", limit=10, window=600)
    try:
        record = desktop_license_service.apply(
            db,
            machine_code=payload.machine_code,
            applicant_name=payload.applicant_name,
            organization=payload.organization,
            note=payload.note,
            client_version=payload.client_version,
            hostname=payload.hostname,
        )
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {
        "success": True,
        "data": {
            "request_id": record.id,
            "apply_token": record.request_token,
            "status": record.status,
            "activation_mode": settings.NPT_DESKTOP_ACTIVATION_MODE,
        },
    }


@router.get("/license/apply/{request_id}")
async def poll_apply(
    request_id: int,
    token: str = Query(...),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        result = desktop_license_service.poll(db, request_id, token)
    except DesktopLicenseError as exc:
        raise HTTPException(status_code=exc.status_code, detail=_gbk_safe(exc.message))
    return {"success": True, "data": result}


# ------------------------------------------------- 共享模式：数据同步（凭证=许可文件）
#
# 服务器是数据真源，桌面端保留本地全量镜像，按「数据集」粒度双向同步：
#   manifest → 比对修订号 → pull(下载整包) / push(上传整包) / 冲突提示
# 同一数据集并发编辑不合并行，采用「最后写入者胜 + 显式冲突」。

class SyncCredential(BaseModel):
    license_file: str = Field(..., description="本机 Ed25519 签名许可")
    machine_code: str = Field("", description="本机机器码")


class SessionRequest(SyncCredential):
    city: Optional[str] = None
    operator: Optional[str] = None


class _Group:
    """供 index_entry_visible 使用的轻量组对象。"""

    def __init__(self, city: Optional[str], operator: Optional[str]):
        self.city = city
        self.operator = operator


def _verify_license(license_file: str, machine_code: str, db: Session):
    """验签 → 定位授权记录。桌面端没有账号，这份签名许可就是它的身份。"""
    from app.models.database import DesktopLicense
    from app.services import desktop_signing
    from app.utils.machine_code import normalize_machine_code

    try:
        payload = desktop_signing.verify_license(license_file or "")
    except desktop_signing.LicenseInvalid as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(f"许可校验失败：{exc}"))

    license_id = payload.get("license_id")
    if not license_id:
        raise HTTPException(status_code=400, detail="该许可不支持数据共享，请重新在线激活")
    record = db.query(DesktopLicense).filter(DesktopLicense.id == int(license_id)).first()
    if record is None:
        raise HTTPException(status_code=404, detail="授权记录不存在，请联系管理员")
    if record.status == "disabled":
        raise HTTPException(status_code=403, detail="该授权已被禁用，请联系管理员")

    machine = normalize_machine_code(machine_code)
    if record.machine_code:
        stored = normalize_machine_code(record.machine_code)
        if stored and stored != machine:
            raise HTTPException(status_code=409, detail="许可与机器码不匹配")
    return record, payload


def _license_group(record):
    """桌面端所属数据组；未绑定 → None（客户端须上报自己的组来绑定）。"""
    if record.city and record.operator:
        return record.city, record.operator
    return None


def _owner_user(db: Session, record):
    """同步上来数据的归属用户：优先用授权绑定的网页端账号，其次才是影子账号。

    共享模式登录时桌面端用的就是真实账号，数据也应归到该账号名下
    （老授权没有绑定账号时才退回影子账号 `desktop-{license_id}`）。
    """
    from app.models.database import User

    if record.user_id:
        user = db.query(User).filter(User.id == record.user_id).first()
        if user is not None:
            return user
    return ensure_shadow_user(db, record)


@router.post("/data/session")
async def data_session(
    payload: SessionRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """同步握手：验签 → 确定组 → 返回服务器时间与组是否锁定。

    授权记录未绑定组时，把客户端上报的组写进授权记录（管理员可在桌面授权页改/解绑）；
    已绑定则以服务器为准并回传 group_locked=True，客户端必须纠正本地组。
    """
    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)

    group = _license_group(record)
    group_locked = group is not None
    if group is None:
        city = (payload.city or "").strip()
        operator = (payload.operator or "").strip()
        from app.services.data_group import validate_group

        error = validate_group(city, operator)
        if error:
            raise HTTPException(
                status_code=400, detail=_gbk_safe(f"尚未指定数据组，请先在本机选择地市与运营商（{error}）")
            )
        record.city = city
        record.operator = operator
        db.commit()
        group = (city, operator)
    else:
        city, operator = group

    owner = _owner_user(db, record)
    db.commit()

    return {
        "success": True,
        "data": {
            "license_id": record.id,
            "licensee": record.licensee_username,
            "group": {"city": city, "operator": operator},
            "group_locked": group_locked,
            "shadow_user_id": owner.id if owner else None,
            "server_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    }


def _collect_manifest(city: str, operator: str) -> List[Dict[str, Any]]:
    """列出该组的数据集清单（含删除墓碑），并为无记录的数据集补建初始修订号。"""
    from app.services import dataset_revision_service as revs
    from app.services.data_group import index_entry_visible
    from app.services.data_service import data_service

    # 先清残余条目（空目录/导入失败残留）：它们列在网页端删不干净，
    # 下发到桌面端又会每次打包失败 → 永久「同步异常」
    data_service.prune_residual_entries()

    group = _Group(city, operator)
    entries = {}
    for data_id, entry in data_service.index.items():
        if index_entry_visible(entry, group):
            entries[data_id] = entry

    rev_map = revs.ensure(
        {did: {"city": e.get("city"), "operator": e.get("operator")} for did, e in entries.items()}
    )

    items: List[Dict[str, Any]] = []
    for data_id, entry in entries.items():
        meta = entry.get("metadata") or {}
        items.append({
            "data_id": data_id,
            "name": entry.get("name") or "",
            "type": entry.get("type") or "",
            "file_type": entry.get("fileType") or "",
            "size": entry.get("size") or 0,
            "status": entry.get("status") or "",
            "layer_count": meta.get("layerCount") or 0,
            "updated_at": entry.get("uploadDate") or "",
            "rev": rev_map.get(data_id, 0),
            "deleted": False,
        })

    # 墓碑：服务器上已删除、客户端本地还留着镜像的数据集
    for row in revs.list_group(city, operator):
        if row.get("deleted") and row.get("data_id") not in entries:
            items.append({
                "data_id": row["data_id"],
                "rev": row.get("rev") or 0,
                "deleted": True,
            })
    return items


@router.post("/data/manifest")
async def data_manifest(
    payload: SyncCredential,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """该桌面端所属组的数据集清单（含修订号，客户端据此判断谁需要同步）。"""
    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")
    return {
        "success": True,
        "data": {
            "group": {"city": group[0], "operator": group[1]},
            "items": _collect_manifest(group[0], group[1]),
            "server_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    }


@router.get("/data/dataset/{data_id}/package")
async def download_dataset_package(
    data_id: str,
    license_file: str = Query(...),
    machine_code: str = Query(default=""),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """下载数据集整包（zip）。桌面端 pull 用；支持 Range 断点续传。"""
    from fastapi.responses import FileResponse, Response
    from starlette.concurrency import run_in_threadpool

    from app.services import dataset_revision_service as revs
    from app.services.desktop_dataset_packager import DatasetPackageError, build_package
    from app.services.data_group import index_entry_visible
    from app.services.data_service import data_service

    _rate_limit(f"pull:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(license_file, machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")

    entry = data_service.index.get(data_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="数据集不存在")
    if not index_entry_visible(entry, _Group(group[0], group[1])):
        # 跨组访问一律 404，不泄露数据是否存在
        raise HTTPException(status_code=404, detail="数据集不存在")

    try:
        package = await run_in_threadpool(build_package, data_id)
    except DatasetPackageError as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))

    # 只回写内容摘要、不推进修订号：pull 是读操作，bump 会让同组其它客户端反复重拉
    current_rev = revs.set_sha(
        data_id, package["sha256"], city=group[0], operator=group[1]
    ) or 0

    zip_path = package["path"]
    file_size = package["size"]
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(data_id)}.zip",
        "X-Dataset-Rev": str(current_rev),
    }
    # 打包产物在临时目录里，响应发出后清理（含临时根目录）
    cleanup = BackgroundTask(_remove_temp_tree, zip_path.parent)

    range_header = request.headers.get("range") if request else None
    if range_header:
        import re as _re

        match = _re.match(r"bytes=(\d+)-(\d*)", range_header)
        if not match:
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{file_size}"})
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else file_size - 1
        if start >= file_size or end < start:
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{file_size}"})
        end = min(end, file_size - 1)

        def _read_range() -> bytes:
            with open(zip_path, "rb") as f:
                f.seek(start)
                return f.read(end - start + 1)

        data = await run_in_threadpool(_read_range)
        return Response(
            content=data,
            status_code=206,
            media_type="application/zip",
            background=cleanup,
            headers={
                **headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(len(data)),
            },
        )

    return FileResponse(
        zip_path, media_type="application/zip", headers=headers, background=cleanup
    )


def _remove_temp_tree(path: Path) -> None:
    try:
        import shutil

        if path.exists() and path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass


@router.post("/data/dataset/{data_id}/package")
async def upload_dataset_package(
    data_id: str,
    license_file: str = Form(...),
    machine_code: str = Form(default=""),
    base_rev: Optional[int] = Form(default=None),
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """上传数据集整包（push）。桌面端贡献数据给同组的其它桌面端与网页端用户。

    base_rev 为乐观锁：服务器当前修订号与之不符 → 409 冲突，由客户端让用户选边。
    """
    from starlette.concurrency import run_in_threadpool

    from app.services import dataset_revision_service as revs
    from app.services.desktop_dataset_packager import DatasetPackageError, install_package
    from app.services.data_group import index_entry_visible
    from app.services.data_service import data_service

    _rate_limit(f"push:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(license_file, machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")
    city, operator = group

    import tempfile

    tmp_path = Path(tempfile.gettempdir()) / f"npt-push-{data_id}-{int(time.time())}.zip"
    try:
        with tmp_path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
    finally:
        await file.close()

    try:
        existing = data_service.index.get(data_id)
        if existing is not None and not index_entry_visible(existing, _Group(city, operator)):
            raise HTTPException(status_code=403, detail="不能覆盖其它数据组的数据集")

        current = revs.get(data_id)
        current_rev = int((current or {}).get("rev") or 0)
        # 数据集已在服务器且客户端基线落后 → 冲突（除非客户端本来就是新建）
        if base_rev is not None and current_rev and current_rev != int(base_rev):
            raise HTTPException(
                status_code=409,
                detail=_gbk_safe(
                    f"服务器上的「{existing.get('name') if existing else data_id}」已被更新"
                    f"（本地基线 rev={base_rev}，服务器 rev={current_rev}），"
                    "请先拉取最新或选择覆盖服务器版本"
                ),
            )

        owner = _owner_user(db, record)
        db.commit()
        try:
            await run_in_threadpool(
                install_package,
                tmp_path,
                user_id=owner.id,
                city=city,
                operator=operator,
                username=record.licensee_username,
            )
        except DatasetPackageError as exc:
            raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))

        # 必须推进修订号：否则同组其它桌面端比对 rev 无变化，永远拉不到这次改动
        new_rev = revs.bump(
            data_id, updated_by=record.licensee_username,
            deleted=False,  # 重新推上来要清掉墓碑，否则服务器仍当它已删除
            city=city, operator=operator,
        )
        return {
            "success": True,
            "data": {"data_id": data_id, "rev": int(new_rev or 0)},
            "message": "已同步到服务器",
        }
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


@router.delete("/data/dataset/{data_id}")
async def delete_dataset(
    data_id: str,
    payload: SyncCredential,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """删除服务器上的数据集（客户端侧删除的传播）。"""
    from app.services.data_group import index_entry_visible
    from app.services.data_service import data_service

    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")

    entry = data_service.index.get(data_id)
    if entry is not None:
        if not index_entry_visible(entry, _Group(group[0], group[1])):
            raise HTTPException(status_code=404, detail="数据集不存在")
        data_service.delete_data(data_id, force=True)
    from app.services import dataset_revision_service as revs

    revs.bump(data_id, deleted=True, sha256="", city=group[0], operator=group[1])
    return {"success": True, "message": "已在服务器删除"}


# ---------------------------------------------------------------- 同组任务历史（共享）

class SharedTaskUpload(BaseModel):
    """桌面端上行任务（同组共享）：元数据 + 完整结果。"""

    license_file: str
    machine_code: str = ""
    task: Dict[str, Any]
    result: Optional[Dict[str, Any]] = None


@router.post("/data/tasks/manifest")
async def data_tasks_manifest(
    payload: SyncCredential,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """同组共享的任务历史清单（只含元数据，结果查看时按需拉取）。"""
    from app.services.task_manager import task_manager

    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")
    return {
        "success": True,
        "data": {
            "group": {"city": group[0], "operator": group[1]},
            "items": task_manager.list_shared_tasks(group[0], group[1]),
        },
    }


@router.get("/data/tasks/{task_id}/result")
async def download_shared_task_result(
    task_id: str,
    license_file: str = Query(...),
    machine_code: str = Query(default=""),
    request: Request = None,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """组内任务结果（桌面端查看/导出时按需拉取，跨组一律 404）。"""
    from starlette.concurrency import run_in_threadpool

    from app.services.task_manager import task_manager

    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(license_file, machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")
    result = await run_in_threadpool(
        task_manager.get_shared_task_result, task_id, group[0], group[1]
    )
    if result is None:
        raise HTTPException(status_code=404, detail="任务结果不存在或不属于本组")
    return {"success": True, "data": {"task_id": task_id, "result": result}}


@router.post("/data/tasks/{task_id}")
async def upload_shared_task(
    task_id: str,
    payload: SharedTaskUpload,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """桌面端上行任务（新建或更新，同组共享；组以服务器授权记录为准）。"""
    from starlette.concurrency import run_in_threadpool

    from app.services.task_manager import task_manager

    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")

    task = dict(payload.task or {})
    task["task_id"] = task_id
    task["result"] = payload.result
    if not task.get("user_name"):
        task["user_name"] = record.username or record.licensee_username
    try:
        meta = await run_in_threadpool(
            task_manager.upsert_shared_task, task, city=group[0], operator=group[1]
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_gbk_safe(str(exc)))
    return {"success": True, "data": meta}


@router.post("/data/tasks/{task_id}/delete")
async def delete_shared_task(
    task_id: str,
    payload: SyncCredential,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """删除组内任务（桌面端删除的传播，幂等）。"""
    from starlette.concurrency import run_in_threadpool

    from app.services.task_manager import task_manager

    _rate_limit(f"sync:{_client_ip(request)}", limit=120, window=300)
    record, _ = _verify_license(payload.license_file, payload.machine_code, db)
    group = _license_group(record)
    if group is None:
        raise HTTPException(status_code=409, detail="尚未绑定数据组，请先调用 /data/session")
    removed = await run_in_threadpool(
        task_manager.delete_shared_task, task_id, group[0], group[1]
    )
    return {"success": True, "data": {"deleted": bool(removed)}}


# ---------------------------------------------------------------- OTA 版本

def _release_version_key(version: str) -> tuple:
    import re as _re

    key = []
    for part in _re.split(r"[.\-_+]", (version or "").strip()):
        key.append((0, int(part)) if part.isdigit() else (1, part))
    return tuple(key)


@router.get("/releases/latest")
async def latest_release(
    current: str = Query(default=""),
    channel: str = Query(default="stable"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """返回指定渠道的最新桌面版（公开）。update_available 由服务端按版本比较给出。"""
    from app.models.database import DesktopRelease

    channel = (channel or "stable").strip() or "stable"
    record = (
        db.query(DesktopRelease)
        .filter(DesktopRelease.channel == channel, DesktopRelease.is_latest == True)  # noqa: E712
        .order_by(DesktopRelease.id.desc())
        .first()
    )
    if record is None:
        record = (
            db.query(DesktopRelease)
            .filter(DesktopRelease.channel == channel)
            .order_by(DesktopRelease.id.desc())
            .first()
        )
    if record is None:
        return {"success": True, "data": None}

    update_available = True
    if current:
        update_available = _release_version_key(record.version) > _release_version_key(current)

    return {
        "success": True,
        "data": {
            "id": record.id,
            "version": record.version,
            "channel": record.channel,
            "file_size": record.file_size,
            "file_size_display": (
                f"{record.file_size / (1024 * 1024):.1f} MB" if record.file_size else "未知"
            ),
            "sha256": record.sha256,
            "mandatory": bool(record.mandatory),
            "release_notes": record.release_notes,
            "published_at": record.created_at,
            "update_available": update_available,
            "download_url": f"/api/v1/desktop-cloud/releases/download/{record.id}",
        },
    }


@router.get("/releases/download/{release_id}")
async def download_release(
    release_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    """安装包下载：支持 Range（客户端断点续传），仅完整 GET 计数。"""
    import re as _re
    from pathlib import Path

    from fastapi.responses import FileResponse, Response
    from starlette.concurrency import run_in_threadpool

    from app.models.database import DesktopRelease

    record = db.query(DesktopRelease).filter(DesktopRelease.id == release_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    path = Path(record.file_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="安装包文件不存在")

    file_size = path.stat().st_size
    range_header = request.headers.get("range")
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(record.filename)}",
    }

    if request.method == "GET" and not range_header:
        record.download_count = (record.download_count or 0) + 1
        db.commit()
        return FileResponse(path, media_type="application/octet-stream", headers=headers)

    if range_header:
        match = _re.match(r"bytes=(\d+)-(\d*)", range_header)
        if not match:
            return Response(
                status_code=416, headers={**headers, "Content-Range": f"bytes */{file_size}"}
            )
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else file_size - 1
        if start >= file_size or end < start:
            return Response(
                status_code=416, headers={**headers, "Content-Range": f"bytes */{file_size}"}
            )
        end = min(end, file_size - 1)

        def _read_range() -> bytes:
            with path.open("rb") as f:
                f.seek(start)
                return f.read(end - start + 1)

        data = await run_in_threadpool(_read_range)
        return Response(
            content=data,
            status_code=206,
            media_type="application/octet-stream",
            headers={
                **headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(len(data)),
            },
        )

    return FileResponse(path, media_type="application/octet-stream", headers=headers)
