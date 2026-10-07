"""
认证服务
处理用户注册、登录、密码管理、JWT令牌、会话管理
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Tuple

from passlib.context import CryptContext
from jose import jwt, JWTError
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import User, UserSession, UserSettings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class AuthService:
    """认证服务（单例模式）"""

    # ---- 密码 ----

    def hash_password(self, password: str) -> str:
        return pwd_context.hash(password)

    def verify_password(self, plain: str, hashed: str) -> bool:
        return pwd_context.verify(plain, hashed)

    # ---- JWT ----

    def create_access_token(
        self,
        user_id: int,
        username: str,
        is_admin: bool,
        expires_delta: Optional[timedelta] = None,
    ) -> Tuple[str, str]:
        """创建JWT令牌，返回 (token, jti)。

        expires_delta 省略时用默认有效期；桌面免登录会话传入超长有效期
        （桌面没有登录入口可重新签发，过期即死锁）。
        """
        jti = str(uuid.uuid4())
        delta = expires_delta if expires_delta is not None else timedelta(
            minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES
        )
        expire = datetime.now(timezone.utc) + delta
        payload = {
            "sub": str(user_id),
            "username": username,
            "is_admin": is_admin,
            "jti": jti,
            "exp": expire,
            "iat": datetime.now(timezone.utc),
        }
        token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
        return token, jti

    def decode_token(self, token: str) -> Optional[dict]:
        """解码JWT令牌，失败返回 None"""
        try:
            payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
            return payload
        except JWTError:
            return None

    # ---- 用户认证 ----

    def authenticate_user(self, db: Session, username: str, password: str) -> Tuple[Optional[User], Optional[str]]:
        """验证用户凭据。返回 (user, error_message)"""
        user = db.query(User).filter(User.username == username).first()
        if not user:
            return None, "用户名或密码错误"
        if not self.verify_password(password, user.password_hash):
            return None, "用户名或密码错误"
        if not user.is_active:
            return None, "账号已被禁用，请联系管理员"
        if user.license_expiry and not settings.NPT_DESKTOP:
            # 服务器模式：按用户的 license_expiry 作登录闸门（管理员分配）
            # 桌面模式跳过：未激活时会把全体用户镜像为过去日期，若在此拦截，
            # 管理员将无法登录去激活（鸡生蛋）；桌面端由签名授权文件 + 前端门禁约束
            now = datetime.now(timezone.utc)
            expiry = user.license_expiry
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry < now:
                return None, "授权已过期，请联系管理员"
        return user, None

    @staticmethod
    def get_client_ip(request) -> str:
        """获取客户端真实IP，优先从 Cloudflare / X-Forwarded-For 头获取"""
        cf_ip = request.headers.get("CF-Connecting-IP")
        if cf_ip:
            return cf_ip.strip()
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def update_last_login(self, db: Session, user: User, ip_address: Optional[str] = None):
        """更新最后登录时间和IP"""
        user.last_login = datetime.now(timezone.utc)
        if ip_address:
            user.last_login_ip = ip_address
        db.commit()

    # ---- 用户 CRUD ----

    def get_user_by_id(self, db: Session, user_id: int) -> Optional[User]:
        return db.query(User).filter(User.id == user_id).first()

    def get_user_by_username(self, db: Session, username: str) -> Optional[User]:
        return db.query(User).filter(User.username == username).first()

    def create_user(
        self,
        db: Session,
        username: str,
        password: str,
        is_admin: bool = False,
        license_expiry: Optional[datetime] = None,
        city: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> Tuple[Optional[User], Optional[str]]:
        """创建用户，返回 (user, error_message)"""
        existing = self.get_user_by_username(db, username)
        if existing:
            return None, "用户名已存在"
        user = User(
            username=username,
            password_hash=self.hash_password(password),
            is_admin=is_admin,
            is_active=True,
            must_change_password=False,
            license_expiry=license_expiry,
            city=city,
            operator=operator,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user, None

    def update_user(self, db: Session, user_id: int, updates: dict) -> Optional[User]:
        """更新用户字段（不含密码）"""
        allowed_fields = {"is_active", "is_admin", "license_expiry", "must_change_password", "total_usage_seconds", "city", "operator",
                          "can_data_import", "can_data_delete", "can_data_update", "can_cell_entry", "can_cell_query_update",
                          "can_assistant"}
        user = self.get_user_by_id(db, user_id)
        if not user:
            return None
        for key, value in updates.items():
            if key in allowed_fields:
                setattr(user, key, value)
        db.commit()
        db.refresh(user)
        return user

    def reset_password(self, db: Session, user_id: int, new_password: str) -> bool:
        """管理员重置密码"""
        user = self.get_user_by_id(db, user_id)
        if not user:
            return False
        user.password_hash = self.hash_password(new_password)
        user.must_change_password = True
        db.commit()
        return True

    def change_password(self, db: Session, user_id: int, old_password: str, new_password: str) -> Tuple[bool, Optional[str]]:
        """用户修改密码。返回 (success, error_message)"""
        user = self.get_user_by_id(db, user_id)
        if not user:
            return False, "用户不存在"
        if not self.verify_password(old_password, user.password_hash):
            return False, "旧密码错误"
        user.password_hash = self.hash_password(new_password)
        user.must_change_password = False
        db.commit()
        return True, None

    # ---- 用户列表 ----

    def get_all_users(
        self,
        db: Session,
        page: int = 1,
        page_size: int = 20,
        search: Optional[str] = None,
        is_active: Optional[bool] = None,
    ) -> Tuple[List[User], int, dict]:
        """获取用户列表（分页+搜索+筛选），在线用户优先置顶。

        返回 (page_users, total_count, online_stats)。
        online_stats 为全量（跨所有页）在线统计：{online, online_pc, online_app}。
        """
        query = db.query(User)
        # 服务器为桌面端创建的影子账号（不可登录，仅承载同步数据归属）不进用户列表
        query = query.filter(User.is_desktop_shadow == False)  # noqa: E712
        if search:
            query = query.filter(User.username.ilike(f"%{search}%"))
        if is_active is not None:
            query = query.filter(User.is_active == is_active)

        all_users = query.order_by(User.created_at.desc()).all()
        total = len(all_users)

        # 最近 5 分钟内的活跃会话（一次性查出，避免逐用户查询）
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        active_rows = db.query(UserSession.user_id, UserSession.client_type).filter(
            UserSession.logout_time.is_(None),
            UserSession.last_activity >= cutoff,
        ).all()
        online_pc_ids = {uid for uid, ct in active_rows if ct == 'pc'}
        online_app_ids = {uid for uid, ct in active_rows if ct == 'app'}
        online_any_ids = online_pc_ids | online_app_ids

        online_stats = {
            "online": len(online_any_ids),
            "online_pc": len(online_pc_ids),
            "online_app": len(online_app_ids),
        }

        # 在线用户优先置顶，其次按注册时间倒序
        all_users.sort(
            key=lambda u: (
                0 if u.id in online_any_ids else 1,
                -(u.created_at.timestamp() if u.created_at else 0),
            )
        )

        start = (page - 1) * page_size
        page_users = all_users[start:start + page_size]
        return page_users, total, online_stats

    # ---- 会话管理 ----

    def record_session(self, db: Session, user_id: int, token_jti: str, ip_address: Optional[str] = None, client_type: str = 'pc') -> UserSession:
        session = UserSession(user_id=user_id, token_jti=token_jti, ip_address=ip_address, client_type=client_type)
        db.add(session)
        db.commit()
        db.refresh(session)
        # 结算其他超时会话的使用时长（不注销，避免打断仍在有效期内的登录态）
        self.cleanup_stale_sessions(db, idle_minutes=6)
        return session

    def get_active_session_from_other_ip(self, db: Session, user_id: int, current_ip: str) -> Optional[UserSession]:
        """检查用户是否有来自其他IP的活跃会话"""
        if not current_ip:
            return None
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
        return db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.logout_time.is_(None),
            UserSession.ip_address.isnot(None),
            UserSession.ip_address != current_ip,
            UserSession.last_activity >= cutoff,
        ).first()

    def end_other_ip_sessions(self, db: Session, user_id: int, current_ip: str, client_type: str = 'pc') -> int:
        """结束用户来自其他IP的同类型活跃会话，返回结束数量。APP端不踢出任何会话。"""
        if not current_ip or client_type != 'pc':
            return 0
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
        sessions = db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.logout_time.is_(None),
            UserSession.client_type == client_type,
            UserSession.ip_address.isnot(None),
            UserSession.ip_address != current_ip,
            UserSession.last_activity >= cutoff,
        ).all()
        count = 0
        for s in sessions:
            self._accumulate_session_duration(db, s, now)
            s.logout_time = now
            s.last_activity = now
            count += 1
        if count > 0:
            db.commit()
        return count

    def revoke_other_sessions(
        self, db: Session, user_id: int, keep_jti: str,
        client_types: Optional[tuple] = ("pc", "desktop"),
    ) -> int:
        """注销该用户的其它会话：网页端与桌面端互踢，以最后登录为准。

        同一账号不允许在网页端与桌面端同时在线：任一端的新登录都会把同账号的
        其它 pc/desktop 登录踢下线，被踢方下次请求即 401（前端提示并回到登录页）。
        client_types 限定被踢的会话类型（APP 端登录不参与互踢，保持既有行为）。
        返回被注销的会话数量。
        """
        now = datetime.now(timezone.utc)
        query = db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.logout_time.is_(None),
            UserSession.token_jti != keep_jti,
        )
        if client_types:
            query = query.filter(UserSession.client_type.in_(list(client_types)))
        sessions = query.all()
        count = 0
        for s in sessions:
            self._accumulate_session_duration(db, s, now)
            s.logout_time = now
            s.last_activity = now
            count += 1
        if count > 0:
            db.commit()
        return count

    def _accumulate_session_duration(self, db: Session, session: UserSession, end_time: Optional[datetime] = None):
        """增量累加指定会话的使用时长到用户记录（从上次结算点算到 end_time）"""
        if end_time is None:
            end_time = datetime.now(timezone.utc)
        if end_time.tzinfo is None:
            end_time = end_time.replace(tzinfo=timezone.utc)
        last_end = session.usage_accounted_at or session.login_time
        if last_end.tzinfo is None:
            last_end = last_end.replace(tzinfo=timezone.utc)
        duration = (end_time - last_end).total_seconds()
        if duration > 0:
            user = db.query(User).filter(User.id == session.user_id).first()
            if user:
                user.total_usage_seconds += int(duration)
            session.usage_accounted_at = end_time

    def cleanup_stale_sessions(self, db: Session, idle_minutes: int = 5) -> int:
        """结算超过 N 分钟无活动会话的使用时长（只结算，不注销会话）。

        解决直接关闭浏览器/APP 不调登出接口导致使用时长统计为 0 的问题。
        注意：不再把这些会话置为已登出——否则 JWT 仍在有效期内的用户会被
        频繁打断、被迫重新登录；是否要求重新登录由空闲超时策略决定
        （见 is_session_idle_expired）。返回结算的会话数量。
        """
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=idle_minutes)
        stale_sessions = db.query(UserSession).filter(
            UserSession.logout_time.is_(None),
            UserSession.last_activity < cutoff,
            or_(
                UserSession.usage_accounted_at.is_(None),
                UserSession.usage_accounted_at < UserSession.last_activity,
            ),
        ).all()
        for s in stale_sessions:
            end_time = s.last_activity
            if end_time.tzinfo is None:
                end_time = end_time.replace(tzinfo=timezone.utc)
            self._accumulate_session_duration(db, s, end_time)
        if stale_sessions:
            db.commit()
        return len(stale_sessions)

    def end_session(self, db: Session, token_jti: str) -> bool:
        """结束会话，累加使用时长"""
        session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
        if not session:
            return False
        now = datetime.now(timezone.utc)
        session.logout_time = now
        session.last_activity = now

        self._accumulate_session_duration(db, session, now)

        db.commit()
        return True

    def update_session_activity(self, db: Session, token_jti: str) -> bool:
        """更新会话最后活动时间"""
        session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
        if not session:
            return False
        session.last_activity = datetime.now(timezone.utc)
        db.commit()
        return True

    def is_token_revoked(self, db: Session, token_jti: str) -> bool:
        """检查令牌是否已注销（主动登出或被其他设备登录踢出）"""
        session = db.query(UserSession).filter(
            UserSession.token_jti == token_jti,
            UserSession.logout_time.isnot(None),
        ).first()
        return session is not None

    def is_session_idle_expired(
        self, db: Session, token_jti: str, idle_minutes: Optional[int] = None
    ) -> bool:
        """检查会话是否空闲超时（连续无操作超过阈值才要求重新登录）。

        idle_minutes 覆盖全局阈值（桌面单机模式按管理员设定的天数是 2 天起）。
        会话记录不存在时放行（历史 token 无会话记录，交由其他逻辑处理）。
        """
        session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
        if not session or not session.last_activity:
            return False
        last_activity = session.last_activity
        if last_activity.tzinfo is None:
            last_activity = last_activity.replace(tzinfo=timezone.utc)
        idle = datetime.now(timezone.utc) - last_activity
        minutes = settings.SESSION_IDLE_TIMEOUT_MINUTES
        if idle_minutes:
            minutes = int(idle_minutes)
        return idle > timedelta(minutes=minutes)

    def get_user_sessions(self, db: Session, user_id: int) -> list:
        return db.query(UserSession).filter(UserSession.user_id == user_id).order_by(UserSession.login_time.desc()).all()

    def is_user_online(self, db: Session, user_id: int) -> bool:
        """检查用户当前是否在线（最近5分钟内有活跃会话）"""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        session = db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.logout_time.is_(None),
            UserSession.last_activity >= cutoff,
        ).first()
        return session is not None

    def is_user_online_by_client_type(self, db: Session, user_id: int, client_type: str) -> bool:
        """按客户端类型检查用户在线状态"""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
        session = db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.client_type == client_type,
            UserSession.logout_time.is_(None),
            UserSession.last_activity >= cutoff,
        ).first()
        return session is not None

    def delete_user(self, db: Session, user_id: int) -> bool:
        """硬删除用户及其会话/设置。

        注意：业务数据（Workbook/Site/Sector/GeoFile/Layer/TaskResult）不归用户所有，
        而是归（地市+运营商）组所有，不随成员删除而级联删除。
        """
        user = self.get_user_by_id(db, user_id)
        if not user:
            return False
        # 仅级联删除用户私有数据（会话与个性化设置）
        db.query(UserSession).filter(UserSession.user_id == user_id).delete()
        db.query(UserSettings).filter(UserSettings.user_id == user_id).delete()
        db.delete(user)
        db.commit()
        return True


# 模块级单例
auth_service = AuthService()
