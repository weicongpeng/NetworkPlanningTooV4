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

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import DesktopLicense
from app.services import desktop_signing
from app.utils.machine_code import normalize_machine_code

# 激活码：去掉易混字符（0/O/1/I/L），16 位随机 + NPT 前缀，四位一组
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_CODE_BODY_LENGTH = 16
CODE_PREFIX = "NPT"

# 运行模式：共享模式（与网页端同账号同权限同组）/ 单机模式（单独授权、数据本机私有）
# 两种模式的权限位都与网页端一致，由管理员在「用户管理 → 编辑」设置
MODE_SHARED = "shared"
MODE_STANDALONE = "standalone"
DEFAULT_IDLE_LOGOUT_DAYS = 2


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


def _clean_group_value(value: Optional[str]) -> Optional[str]:
    """空串归一化为 None（组未指定 = 桌面端自选并在首次同步时绑定）。"""
    cleaned = (value or "").strip()
    return cleaned or None


def _shadow_username(license_id: int) -> str:
    return f"desktop-{license_id}"


def ensure_shadow_user(db: Session, record: DesktopLicense, *, create: bool = True):
    """取得（必要时创建）该桌面授权对应的服务器侧影子账号。

    桌面端是单用户形态、没有账号，服务器无法用 user_id 归属数据。
    影子账号只是数据归属载体：`is_active=False` 不能登录、`is_desktop_shadow=True`
    便于「用户管理」过滤掉。

    组信息以**授权记录**为准（为空时沿用现有值），管理员改组即级联到这里。
    """
    from app.models.database import User

    username = _shadow_username(record.id)
    user = db.query(User).filter(User.username == username).first()
    if user is not None:
        if record.city is not None and user.city != record.city:
            user.city = record.city
        if record.operator is not None and user.operator != record.operator:
            user.operator = record.operator
        user.is_desktop_shadow = True
        return user
    if not create:
        return None
    from app.services.auth_service import auth_service
    import uuid as _uuid

    user = User(
        username=username,
        password_hash=auth_service.hash_password(str(_uuid.uuid4())),  # 不可登录
        is_admin=False,
        is_active=False,
        is_desktop_shadow=True,
        must_change_password=False,
        license_expiry=None,
        city=record.city,
        operator=record.operator,
    )
    db.add(user)
    db.flush()
    return user


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
        mode: Optional[str] = None,
    ) -> Tuple[int, list]:
        query = db.query(DesktopLicense)
        if status:
            query = query.filter(DesktopLicense.status == status)
        if mode:
            query = query.filter(DesktopLicense.mode == mode)
        if keyword:
            like = f"%{keyword.strip()}%"
            query = query.filter(
                (DesktopLicense.licensee_username.like(like))
                | (DesktopLicense.username.like(like))
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
        city: Optional[str] = None,
        operator: Optional[str] = None,
        idle_logout_days: Optional[int] = None,
        username: Optional[str] = None,
    ) -> Tuple[DesktopLicense, str]:
        name = (licensee_username or "").strip()
        if not name:
            raise DesktopLicenseError(400, "被授权用户不能为空")
        if idle_logout_days is not None and int(idle_logout_days) <= 0:
            raise DesktopLicenseError(400, "无操作退出登录时长必须为正整数（天）")
        bound_username = (username or "").strip() or None
        user_id = None
        if bound_username:
            from app.models.database import User

            user = db.query(User).filter(User.username == bound_username).first()
            if user is None:
                raise DesktopLicenseError(404, f"账号不存在：{bound_username}")
            user_id = user.id
            name = name or bound_username
        record = DesktopLicense(
            licensee_username=name,
            organization=(organization or "").strip() or None,
            machine_code=_normalize_machine(machine_code) if machine_code else None,
            lease_days=int(lease_days or settings.NPT_DESKTOP_LEASE_DAYS or 30),
            note=(note or "").strip() or None,
            source="precreate",
            mode=MODE_STANDALONE,
            username=bound_username,
            user_id=user_id,
            status="issued",
            created_by=created_by,
            created_at=_iso(),
            updated_at=_iso(),
            city=_clean_group_value(city),
            operator=_clean_group_value(operator),
            idle_logout_days=int(idle_logout_days or DEFAULT_IDLE_LOGOUT_DAYS),
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
        city: Optional[str] = None,
        operator: Optional[str] = None,
        idle_logout_days: Optional[int] = None,
    ) -> DesktopLicense:
        record = self.get(db, license_id)
        if idle_logout_days is not None:
            if int(idle_logout_days) <= 0:
                raise DesktopLicenseError(400, "无操作退出登录时长必须为正整数（天）")
            record.idle_logout_days = int(idle_logout_days)
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
            new_lease = int(lease_days)
            # 租约变化 = 重签：到期日按「今天 + 新租约」重算，否则列表里的
            # 到期日期会一直停留在旧值（客户端也要等下次续期才拿到新期限）
            if new_lease != int(record.lease_days or 0):
                record.expire_date = (_now().date() + timedelta(days=new_lease)).isoformat()
            record.lease_days = new_lease
        if note is not None:
            record.note = note.strip() or None
        group_changed = False
        if city is not None:
            new_city = _clean_group_value(city)
            group_changed = group_changed or new_city != record.city
            record.city = new_city
        if operator is not None:
            new_operator = _clean_group_value(operator)
            group_changed = group_changed or new_operator != record.operator
            record.operator = new_operator
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        # 改组后同步影子账号：桌面端同步上来的数据才不会落进旧组而"消失"
        if group_changed:
            try:
                shadow = ensure_shadow_user(db, record)
                if shadow is not None:
                    db.commit()
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                raise DesktopLicenseError(500, f"同步影子账号失败：{exc}") from exc
        return record

    def approve(
        self,
        db: Session,
        license_id: int,
        lease_days: Optional[int] = None,
        note: Optional[str] = None,
        approved_by: Optional[str] = None,
        idle_logout_days: Optional[int] = None,
    ) -> Tuple[DesktopLicense, str]:
        record = self.get(db, license_id)
        if record.status not in ("pending", "issued"):
            raise DesktopLicenseError(409, f"当前状态不允许批准：{record.status}")
        if idle_logout_days is not None:
            if int(idle_logout_days) <= 0:
                raise DesktopLicenseError(400, "无操作退出登录时长必须为正整数（天）")
            record.idle_logout_days = int(idle_logout_days)
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
            # 运行模式与绑定的网页端账号：桌面端据此决定权限策略
            "mode": record.mode or MODE_STANDALONE,
            "username": record.username or "",
            "idle_logout_days": int(record.idle_logout_days or DEFAULT_IDLE_LOGOUT_DAYS),
            # 数据组：桌面端同步时据此确定自己属于哪一组（为空则由桌面端自选）
            "city": record.city or "",
            "operator": record.operator or "",
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

    def _login_payload(
        self, record: DesktopLicense, license_file: str, expire_date: str, user
    ) -> Dict[str, Any]:
        """登录响应：账号信息 + 授权信息（本机据此镜像账号与运行模式）。"""
        return {
            "license_file": license_file,
            "license_id": record.id,
            "licensee": record.licensee_username,
            "organization": record.organization,
            "machine_code": record.machine_code,
            "lease_days": record.lease_days,
            "expire_date": expire_date,
            "remaining_days": self.remaining_days(expire_date),
            "city": record.city,
            "operator": record.operator,
            "mode": record.mode,
            "username": record.username,
            "user_id": record.user_id,
            "idle_logout_days": record.idle_logout_days or DEFAULT_IDLE_LOGOUT_DAYS,
            "login_count": record.login_count or 0,
            "user": user.to_dict(),
        }

    def _ensure_shared_license(
        self,
        db: Session,
        user,
        machine: str,
        client_version: Optional[str],
        hostname: Optional[str],
    ) -> DesktopLicense:
        """共享模式：为该「账号 + 机器」自动签发（或复用）许可，作为数据同步凭证。

        共享模式不需要管理员批准——账号本身就是凭据，且组归属跟随账号，
        因此这里一律直接签发，同时保持服务器上的组与账号组一致。
        """
        record = (
            db.query(DesktopLicense)
            .filter(
                DesktopLicense.mode == MODE_SHARED,
                DesktopLicense.username == user.username,
                DesktopLicense.machine_code == machine,
            )
            .first()
        )
        if record is None:
            record = DesktopLicense(
                mode=MODE_SHARED,
                username=user.username,
                user_id=user.id,
                licensee_username=user.username,
                machine_code=machine,
                lease_days=int(settings.NPT_DESKTOP_LEASE_DAYS or 30),
                source="precreate",
                status="active",
                created_at=_iso(),
                created_by="desktop-login",
            )
            db.add(record)
        if record.status == "disabled":
            raise DesktopLicenseError(403, "该授权已被禁用，请联系管理员")
        record.licensee_username = user.username
        record.user_id = user.id
        record.city = user.city
        record.operator = user.operator
        record.status = "active"
        record.machine_bound_at = record.machine_bound_at or _iso()
        record.activated_at = _iso()
        record.client_version = (client_version or "").strip() or record.client_version
        record.hostname = (hostname or "").strip() or record.hostname
        db.flush()
        return record

    def _standalone_record(
        self,
        db: Session,
        user,
        machine: str,
        client_version: Optional[str],
        hostname: Optional[str],
    ) -> DesktopLicense:
        """单机模式：取（必要时创建待批准申请）该账号在本机的授权记录。

        管理员预建但未绑定机器码的授权也能被认领（machine_code 为空即待绑定）；
        未申请过 → 建 pending 申请单并由调用方返回「等待管理员批准」。
        """
        record = (
            db.query(DesktopLicense)
            .filter(
                DesktopLicense.mode == MODE_STANDALONE,
                DesktopLicense.username == user.username,
                or_(
                    DesktopLicense.machine_code == machine,
                    DesktopLicense.machine_code.is_(None),
                ),
            )
            .first()
        )
        if record is None:
            record = DesktopLicense(
                mode=MODE_STANDALONE,
                username=user.username,
                user_id=user.id,
                licensee_username=user.username,
                machine_code=machine,
                lease_days=int(settings.NPT_DESKTOP_LEASE_DAYS or 30),
                idle_logout_days=DEFAULT_IDLE_LOGOUT_DAYS,
                source="approve",
                status="pending",
                request_token=secrets.token_urlsafe(24),
                client_version=(client_version or "").strip() or None,
                hostname=(hostname or "").strip() or None,
                created_at=_iso(),
                updated_at=_iso(),
            )
            db.add(record)
            db.flush()
        return record

    def login(
        self,
        db: Session,
        username: str,
        password: str,
        mode: str,
        machine_code: str,
        client_version: Optional[str] = None,
        hostname: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """桌面端账号登录：与网页端同一套账号与权限，按模式决定是否需单独授权。

        返回 (result, payload)：
        - result="ok"：已签发许可，payload 含 license_file 与账号信息
        - result="pending"：单机模式尚未授权，payload 含 status（前端弹窗等待管理员批准）

        单机模式在授权有效期内可离线登录，因此每次联机登录都累加 login_count。
        共享模式不写服务器会话行，避免桌面端登录把网页端同账号踢下线。
        """
        from app.services.auth_service import auth_service

        name = (username or "").strip()
        if not name:
            raise DesktopLicenseError(400, "请输入用户名")
        user, error = auth_service.authenticate_user(db, name, password)
        if error:
            raise DesktopLicenseError(401, error)
        if user.is_desktop_shadow:
            raise DesktopLicenseError(403, "该账号不可用于桌面端登录")

        machine = _normalize_machine(machine_code)
        shared = str(mode).lower() == MODE_SHARED

        if shared:
            if not user.city or not user.operator:
                raise DesktopLicenseError(
                    400, "该账号未分配数据组（地市+运营商），请联系管理员分配后再使用共享模式"
                )
            record = self._ensure_shared_license(db, user, machine, client_version, hostname)
        else:
            record = self._standalone_record(db, user, machine, client_version, hostname)
            if record.status == "pending":
                record.updated_at = _iso()
                db.commit()
                db.refresh(record)
                return "pending", {
                    "status": "pending",
                    "mode": MODE_STANDALONE,
                    "username": user.username,
                    "license_id": record.id,
                    "message": "已提交授权申请，请等待管理员在「桌面授权」页面确认",
                }
            if record.status == "rejected":
                db.commit()
                raise DesktopLicenseError(403, "该账号的单机授权申请已被拒绝，请联系管理员")
            if record.status == "disabled":
                db.commit()
                raise DesktopLicenseError(403, "该账号的单机授权已被禁用，请联系管理员")
            if record.machine_code and record.machine_code != machine:
                db.commit()
                raise DesktopLicenseError(409, "该单机授权已绑定其它机器，换机请联系管理员解绑")
            record.machine_code = machine
            record.machine_bound_at = record.machine_bound_at or _iso()
            record.status = "active"
            record.activated_at = _iso()
            record.login_count = (record.login_count or 0) + 1
            record.last_login_at = _iso()
            record.client_version = (client_version or "").strip() or record.client_version
            record.hostname = (hostname or "").strip() or record.hostname
            if not record.city and user.city:
                record.city = user.city
            if not record.operator and user.operator:
                record.operator = user.operator

        license_file, expire_date = self._build_license(record)
        record.expire_date = expire_date
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return "ok", self._login_payload(record, license_file, expire_date, user)

    def poll_login(
        self, db: Session, username: str, machine_code: str
    ) -> Tuple[str, Dict[str, Any]]:
        """单机模式申请后轮询：管理员一批准就当场签发许可（无需再输密码）。"""
        from app.models.database import User

        name = (username or "").strip()
        machine = _normalize_machine(machine_code)
        user = db.query(User).filter(User.username == name).first()
        if user is None:
            raise DesktopLicenseError(404, "账号不存在")
        record = (
            db.query(DesktopLicense)
            .filter(
                DesktopLicense.mode == MODE_STANDALONE,
                DesktopLicense.username == name,
                or_(
                    DesktopLicense.machine_code == machine,
                    DesktopLicense.machine_code.is_(None),
                ),
            )
            .first()
        )
        if record is None:
            raise DesktopLicenseError(404, "没有待批准的授权申请")
        if record.status == "pending":
            return "pending", {
                "status": "pending",
                "mode": MODE_STANDALONE,
                "license_id": record.id,
                "message": "已提交授权申请，请等待管理员在「桌面授权」页面确认",
            }
        if record.status in ("rejected", "disabled"):
            return record.status, {
                "status": record.status,
                "message": record.review_note or "授权申请未通过，请联系管理员",
            }

        record.status = "active"
        record.activated_at = _iso()
        record.login_count = (record.login_count or 0) + 1
        record.last_login_at = _iso()
        license_file, expire_date = self._build_license(record)
        record.expire_date = expire_date
        record.updated_at = _iso()
        db.commit()
        db.refresh(record)
        return "ok", self._login_payload(record, license_file, expire_date, user)

    def report_offline_logins(self, db: Session, license_id: int, count: int) -> int:
        """补报离线期间的登录次数（单机模式断网登录时本机先记账）。"""
        if not license_id or count <= 0:
            return 0
        record = db.query(DesktopLicense).filter(DesktopLicense.id == int(license_id)).first()
        if record is None:
            raise DesktopLicenseError(404, "授权记录不存在，请重新登录")
        record.login_count = (record.login_count or 0) + int(count)
        db.commit()
        db.refresh(record)
        return record.login_count

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
