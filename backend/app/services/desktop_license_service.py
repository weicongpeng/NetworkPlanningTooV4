"""桌面版在线授权服务（按用户授权 + 机器绑定 + 租约续期）。

服务端职责：
- 管理员侧：创建授权（precreate 生成激活码）/ 批准客户端申请 / 禁用 / 解绑换机 / 删除
- 客户端侧：用激活码激活、用旧许可续期（按服务器时间重新签发）、申请与轮询

状态机：pending（客户端已申请，待批准）→ issued（有激活码待激活）
        → active（已绑定机器）→ disabled（管理员禁用）
        rejected（管理员拒绝）；disabled 可恢复为 active。
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import DesktopLicense
from app.services import desktop_signing
from app.utils.machine_code import normalize_machine_code

# 激活码：去掉易混字符（0/O/1/I/L），16 位随机 + NPT 前缀，四位一组
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CODE_BODY_LENGTH = 16
CODE_PREFIX = "NPT"


class DesktopLicenseError(Exception):
    """业务错误（端点层映射为 HTTPException）。"""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: Optional[datetime] = None) -> str:
    return (moment or _now()).isoformat()


def _today_str() -> str:
    return _now().date().isoformat()


def generate_activation_code() -> str:
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_BODY_LENGTH))
    groups = [body[i : i + 4] for i in range(0, _CODE_BODY_LENGTH, 4)]
    return f"{CODE_PREFIX}-" + "-".join(groups)


def normalize_activation_code(value: Optional[str]) -> str:
    """归一化用户输入的激活码为规范格式；格式不符返回空串。"""
    if not value:
        return ""
    cleaned = "".join(ch for ch in value.upper() if ch.isalnum())
    if cleaned.startswith(CODE_PREFIX):
        cleaned = cleaned[len(CODE_PREFIX) :]
    if len(cleaned) != _CODE_BODY_LENGTH or any(ch not in _CODE_ALPHABET for ch in cleaned):
        return ""
    return f"{CODE_PREFIX}-" + "-".join(
        cleaned[i : i + 4] for i in range(0, _CODE_BODY_LENGTH, 4)
    )


def _normalize_machine(machine_code: Optional[str]) -> str:
    normalized = normalize_machine_code(machine_code)
    if not normalized or len(normalized) != 16:
        raise DesktopLicenseError(400, "机器码格式不正确（应为 16 位十六进制，四位一组）")
    return "-".join(normalized[i : i + 4] for i in range(0, 16, 4))


def _remaining_days(expire_date: Optional[str]) -> int:
    if not expire_date:
        return 0
    try:
        return max(0, (datetime.strptime(expire_date, "%Y-%m-%d").date() - _now().date()).days)
    except ValueError:
        return 0


class DesktopLicenseService:
    # ---------------- 管理员侧 ----------------

    def list_licenses(
        self,
        db: Session,
        page: int = 1,
        page_size: int = 20,
        status: Optional[str] = None,
        keyword: Optional[str] = None,
    ) -> Tuple[int, list]:
        query = db.query(DesktopLicense)
        if status:
            query = query.filter(DesktopLicense.status == status)
        if keyword:
            like = f"%{keyword.strip()}%"
            query = query.filter(
                (DesktopLicense.licensee_username.like(like))
                | (DesktopLicense.organization.like(like))
                | (DesktopLicense.machine_code.like(like))
                | (DesktopLicense.activation_code.like(like))
                | (DesktopLicense.hostname.like(like))
            )
        total = query.count()
        items = (
            query.order_by(DesktopLicense.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return total, items

    def get(self, db: Session, license_id: int) -> DesktopLicense:
        record = db.query(DesktopLicense).filter(DesktopLicense.id == license_id).first()
        if record is None:
            raise DesktopLicenseError(404, "授权记录不存在")
        return record

    def create(
        self,
        db: Session,
        licensee_username: str,
        organization: Optional[str] = None,
        machine_code: Optional[str] = None,
        lease_days: Optional[int] = None,
        note: Optional[str] = None,
        created_by: Optional[str] = None,
        with_code: bool = True,
    ) -> Tuple[DesktopLicense, str]:
        name = (licensee_username or "").strip()
        if not name:
            raise DesktopLicenseError(400, "被授权用户不能为空")
        record = DesktopLicense(
            licensee_username=name,
            organization=(organization or "").strip() or None,
            machine_code=_normalize_machine(machine_code) if machine_code else None,
            lease_days=int(lease_days or settings.NPT_DESKTOP_LEASE_DAYS or 30),
            note=(note or "").strip() or None,
            source="precreate",
            status="issued",
            created_by=created_by,
            created_at=_iso(),
            updated_at=_iso(),
        )
        code = ""
        if with_code:
            code = self._assign_unique_code(db, record)
        db.add(record)
        db.commit()
        db.refresh(record)
        return record, code

    def _assign_unique_code(self, db: Session, record: DesktopLicense) -> str:
        for _ in range(20):
            candidate = generate_activation_code()
            exists = (
                db.query(DesktopLicense)
                .filter(DesktopLicense.activation_code == candidate)
                .first()
            )
            if exists is None or exists is record:
                record.activation_code = candidate
                return candidate
        raise DesktopLicenseError(500, "激活码生成失败，请重试")

    def update(
        self,
        db: Session,
        license_id: int,
        licensee_username: Optional[str] = None,
        organization: Optional[str] = None,
        lease_days: Optional[int] = None,
        note: Optional[str] = None,
    ) -> DesktopLicense:
        record = self.get(db, license_id)
        if licensee_username is not None:
            name = licensee_username.strip()
            if not name:
                raise DesktopLicenseError(400, "被授权用户不能为空")
            record.licensee_username = name
        if organization is not None:
            record.organization = organization.strip() or None
        if lease_days is not None:
            if int(lease_days) <= 0:
                raise DesktopLicenseError(400, "租约天数必须为正整数")
            record.lease_days = int(lease_days)
        if note is not None:
            record.note = note.strip() or None
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record

    def approve(
        self,
        db: Session,
        license_id: int,
        lease_days: Optional[int] = None,
        note: Optional[str] = None,
        approved_by: Optional[str] = None,
    ) -> Tuple[DesktopLicense, str]:
        record = self.get(db, license_id)
        if record.status not in ("pending", "issued"):
            raise DesktopLicenseError(409, f"当前状态不允许批准：{record.status}")
        if lease_days is not None:
            if int(lease_days) <= 0:
                raise DesktopLicenseError(400, "租约天数必须为正整数")
            record.lease_days = int(lease_days)
        if not record.activation_code:
            self._assign_unique_code(db, record)
        record.status = "issued"
        record.approved_by = approved_by
        record.review_note = (note or "").strip() or None
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record, record.activation_code or ""

    def reject(
        self, db: Session, license_id: int, note: Optional[str] = None
    ) -> DesktopLicense:
        record = self.get(db, license_id)
        if record.status not in ("pending",):
            raise DesktopLicenseError(409, f"当前状态不允许拒绝：{record.status}")
        record.status = "rejected"
        record.review_note = (note or "").strip() or None
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record

    def disable(self, db: Session, license_id: int) -> DesktopLicense:
        record = self.get(db, license_id)
        if record.status == "disabled":
            return record
        record.status = "disabled"
        record.disabled_at = _iso()
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record

    def enable(self, db: Session, license_id: int) -> DesktopLicense:
        record = self.get(db, license_id)
        if record.status != "disabled":
            raise DesktopLicenseError(409, f"当前状态不是已禁用：{record.status}")
        record.status = "active" if record.machine_code else "issued"
        record.disabled_at = None
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record

    def unbind(self, db: Session, license_id: int) -> DesktopLicense:
        """解绑机器（换机场景）：保留激活码与租约设置，回到 issued 待激活。"""
        record = self.get(db, license_id)
        record.machine_code = None
        record.machine_bound_at = None
        record.status = "issued"
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record

    def regenerate_code(self, db: Session, license_id: int) -> Tuple[DesktopLicense, str]:
        record = self.get(db, license_id)
        if record.status == "disabled":
            raise DesktopLicenseError(409, "已禁用的授权不能重发激活码")
        code = self._assign_unique_code(db, record)
        if record.status in ("pending", "rejected"):
            record.status = "issued"
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return record, code

    def delete(self, db: Session, license_id: int) -> None:
        record = self.get(db, license_id)
        db.delete(record)
        db.commit()

    # ---------------- 客户端侧 ----------------

    def _build_license(self, record: DesktopLicense) -> Tuple[str, str]:
        """签发许可，返回 (license_file, expire_date)。"""
        expire_date = (_now().date() + timedelta(days=int(record.lease_days or 30))).isoformat()
        payload: Dict[str, Any] = {
            "v": 1,
            "license_id": record.id,
            "subject": record.licensee_username,
            "org": record.organization or "",
            "licensee": record.organization or record.licensee_username,
            "machine_code": record.machine_code,
            "lease_days": int(record.lease_days or 30),
            "renew_count": int(record.renewal_count or 0),
            "issued_via": "online",
            "issued_at": _now().strftime("%Y-%m-%d %H:%M:%S"),
            "expire_date": expire_date,
            "features": ["all"],
        }
        try:
            license_file = desktop_signing.sign_license(payload)
        except desktop_signing.SigningNotConfigured as exc:
            raise DesktopLicenseError(503, str(exc)) from exc
        return license_file, expire_date

    def activate(
        self,
        db: Session,
        activation_code: str,
        machine_code: str,
        client_version: Optional[str] = None,
        hostname: Optional[str] = None,
    ) -> Tuple[DesktopLicense, str, str]:
        normalized_code = normalize_activation_code(activation_code)
        if not normalized_code:
            raise DesktopLicenseError(400, "激活码格式不正确")
        machine = _normalize_machine(machine_code)

        record = (
            db.query(DesktopLicense)
            .filter(DesktopLicense.activation_code == normalized_code)
            .first()
        )
        if record is None:
            raise DesktopLicenseError(404, "激活码无效，请核对后重试")
        if record.status == "disabled":
            raise DesktopLicenseError(403, "该授权已被禁用，请联系管理员")
        if record.status == "pending":
            raise DesktopLicenseError(403, "该授权尚待管理员批准")
        if record.status == "rejected":
            raise DesktopLicenseError(403, "该授权申请已被拒绝，请联系管理员")
        if record.machine_code and record.machine_code != machine:
            raise DesktopLicenseError(409, "该授权已绑定其它机器，换机请联系管理员解绑")

        record.machine_code = machine
        record.machine_bound_at = record.machine_bound_at or _iso()
        record.status = "active"
        record.activated_at = _iso()
        record.client_version = (client_version or "").strip() or record.client_version
        record.hostname = (hostname or "").strip() or record.hostname
        record.updated_at = _iso()

        license_file, expire_date = self._build_license(record)
        record.expire_date = expire_date
        db.commit()
        db.refresh(record)
        return record, license_file, expire_date

    def renew(
        self,
        db: Session,
        license_text: str,
        machine_code: str,
        client_version: Optional[str] = None,
    ) -> Tuple[DesktopLicense, str, str]:
        try:
            payload = desktop_signing.verify_license(license_text)
        except desktop_signing.LicenseInvalid as exc:
            raise DesktopLicenseError(400, f"许可文件校验失败：{exc}") from exc

        license_id = payload.get("license_id")
        if not license_id:
            raise DesktopLicenseError(400, "该许可不是在线授权许可，无法在线续期")
        record = (
            db.query(DesktopLicense).filter(DesktopLicense.id == int(license_id)).first()
        )
        if record is None:
            raise DesktopLicenseError(404, "授权记录不存在，请联系管理员")
        if record.status == "disabled":
            raise DesktopLicenseError(403, "该授权已被禁用，请联系管理员")

        machine = _normalize_machine(machine_code)
        if record.machine_code and record.machine_code != machine:
            raise DesktopLicenseError(409, "许可与本机机器码不匹配")
        if payload.get("machine_code") and payload.get("machine_code") != machine:
            raise DesktopLicenseError(409, "许可文件与本机机器码不匹配")

        record.machine_code = record.machine_code or machine
        record.status = "active"
        record.renewal_count = (record.renewal_count or 0) + 1
        record.last_renewed_at = _iso()
        record.client_version = (client_version or "").strip() or record.client_version
        record.updated_at = _iso()

        license_file, expire_date = self._build_license(record)
        record.expire_date = expire_date
        db.commit()
        db.refresh(record)
        return record, license_file, expire_date

    def apply(
        self,
        db: Session,
        machine_code: str,
        applicant_name: str,
        organization: Optional[str] = None,
        note: Optional[str] = None,
        client_version: Optional[str] = None,
        hostname: Optional[str] = None,
    ) -> DesktopLicense:
        if (settings.NPT_DESKTOP_ACTIVATION_MODE or "precreate").lower() != "approve":
            raise DesktopLicenseError(
                403, "当前服务器未开启申请模式，请联系管理员获取激活码"
            )
        name = (applicant_name or "").strip()
        if not name:
            raise DesktopLicenseError(400, "请填写申请人/单位名称")
        machine = _normalize_machine(machine_code)

        existing = (
            db.query(DesktopLicense)
            .filter(DesktopLicense.machine_code == machine)
            .filter(DesktopLicense.status.in_(("pending", "issued", "active")))
            .first()
        )
        if existing is not None:
            if existing.status == "pending":
                return existing
            raise DesktopLicenseError(409, "该机器已有有效授权，无需重复申请")

        record = DesktopLicense(
            licensee_username=name,
            organization=(organization or "").strip() or None,
            machine_code=machine,
            applied_note=(note or "").strip() or None,
            lease_days=int(settings.NPT_DESKTOP_LEASE_DAYS or 30),
            source="approve",
            status="pending",
            request_token=secrets.token_urlsafe(24),
            client_version=(client_version or "").strip() or None,
            hostname=(hostname or "").strip() or None,
            created_at=_iso(),
            updated_at=_iso(),
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record

    def poll(self, db: Session, request_id: int, token: str) -> Dict[str, Any]:
        record = (
            db.query(DesktopLicense).filter(DesktopLicense.id == int(request_id)).first()
        )
        if record is None or not token or record.request_token != token:
            raise DesktopLicenseError(404, "申请不存在或凭证无效")
        result: Dict[str, Any] = {"status": record.status, "message": record.review_note}
        if record.status == "issued" and record.activation_code:
            result["activation_code"] = record.activation_code
        return result

    def status_summary(self, record: DesktopLicense) -> Dict[str, Any]:
        return {
            "license_id": record.id,
            "licensee": record.licensee_username,
            "organization": record.organization,
            "status": record.status,
            "machine_code": record.machine_code,
            "lease_days": record.lease_days,
            "expire_date": record.expire_date,
            "remaining_days": _remaining_days(record.expire_date),
        }

    @staticmethod
    def remaining_days(expire_date: Optional[str]) -> int:
        return _remaining_days(expire_date)


desktop_license_service = DesktopLicenseService()
