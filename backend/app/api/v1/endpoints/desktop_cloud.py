"""桌面版在线授权/OTA 客户端公开接口。

调用方是桌面客户端（经本机后端代理），不使用站点 JWT：
- 激活：凭证是激活码
- 续期：凭证是上一次签发的许可文件（Ed25519 验签）
- 申请：返回一次性 apply_token 轮询结果
- 版本：完全公开
统一做轻量内存限流，防暴力猜码。
"""
from __future__ import annotations

import time
import urllib.parse
from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.services.desktop_license_service import (
    DesktopLicenseError,
    desktop_license_service,
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
