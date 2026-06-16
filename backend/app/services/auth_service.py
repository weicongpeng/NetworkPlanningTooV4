"""
认证服务
处理用户注册、登录、密码管理、JWT令牌、会话管理
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Tuple

from passlib.context import CryptContext
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import User, UserSession

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class AuthService:
    """认证服务（单例模式）"""

    # ---- 密码 ----

    def hash_password(self, password: str) -> str:
        return pwd_context.hash(password)

    def verify_password(self, plain: str, hashed: str) -> bool:
        return pwd_context.verify(plain, hashed)

    # ---- JWT ----

    def create_access_token(self, user_id: int, username: str, is_admin: bool) -> Tuple[str, str]:
        """创建JWT令牌，返回 (token, jti)"""
        jti = str(uuid.uuid4())
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
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
        if user.license_expiry:
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
        allowed_fields = {"is_active", "is_admin", "license_expiry", "must_change_password", "total_usage_seconds", "city", "operator"}
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
    ) -> Tuple[List[User], int]:
        """获取用户列表（分页+搜索+筛选），返回 (users, total_count)"""
        query = db.query(User)
        if search:
            query = query.filter(User.username.ilike(f"%{search}%"))
        if is_active is not None:
            query = query.filter(User.is_active == is_active)
        total = query.count()
        users = query.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
        return users, total

    # ---- 会话管理 ----

    def record_session(self, db: Session, user_id: int, token_jti: str, ip_address: Optional[str] = None) -> UserSession:
        session = UserSession(user_id=user_id, token_jti=token_jti, ip_address=ip_address)
        db.add(session)
        db.commit()
        db.refresh(session)
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

    def end_other_ip_sessions(self, db: Session, user_id: int, current_ip: str) -> int:
        """结束用户来自其他IP的所有活跃会话，返回结束数量"""
        if not current_ip:
            return 0
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
        sessions = db.query(UserSession).filter(
            UserSession.user_id == user_id,
            UserSession.logout_time.is_(None),
            UserSession.ip_address.isnot(None),
            UserSession.ip_address != current_ip,
            UserSession.last_activity >= cutoff,
        ).all()
        count = 0
        for s in sessions:
            s.logout_time = now
            s.last_activity = now
            count += 1
        if count > 0:
            db.commit()
        return count

    def end_session(self, db: Session, token_jti: str) -> bool:
        """结束会话，累加使用时长"""
        session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
        if not session:
            return False
        now = datetime.now(timezone.utc)
        session.logout_time = now
        session.last_activity = now

        # 累加使用时长 (SQLite 可能丢失时区信息, 确保比较时类型一致)
        login_time = session.login_time
        if login_time.tzinfo is None:
            login_time = login_time.replace(tzinfo=timezone.utc)
        duration = (now - login_time).total_seconds()
        user = db.query(User).filter(User.id == session.user_id).first()
        if user:
            user.total_usage_seconds += int(duration)

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
        """检查令牌是否已注销"""
        session = db.query(UserSession).filter(
            UserSession.token_jti == token_jti,
            UserSession.logout_time.isnot(None),
        ).first()
        return session is not None

    def verify_session_ip(self, db: Session, token_jti: str, current_ip: str) -> bool:
        """验证请求IP是否与会话记录IP一致"""
        if not current_ip or current_ip == "unknown":
            return True  # 无法获取IP时放行
        session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
        if not session:
            return True  # 会话不存在时放行（由其他逻辑处理）
        if not session.ip_address:
            return True  # 旧会话没有IP记录，放行
        return session.ip_address == current_ip

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

    def delete_user(self, db: Session, user_id: int) -> bool:
        """硬删除用户及其会话记录"""
        user = self.get_user_by_id(db, user_id)
        if not user:
            return False
        db.query(UserSession).filter(UserSession.user_id == user_id).delete()
        db.delete(user)
        db.commit()
        return True


# 模块级单例
auth_service = AuthService()
