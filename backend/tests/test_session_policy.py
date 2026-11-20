"""会话策略测试

覆盖「登录后连续空闲超过 3 小时才要求重新登录」的核心约定：
- 空闲结算（cleanup_stale_sessions）只累加使用时长，不注销会话；
- 空闲超时（is_session_idle_expired）判定需要重新登录；
- 主动登出 / 新设备登录互踢仍立即注销。
"""
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.core.database import SessionLocal, init_db
from app.models.database import UserSession
from app.services.auth_service import auth_service

TEST_USERNAME = "sess_policy_user"


def _create_test_user(db):
    existing = auth_service.get_user_by_username(db, TEST_USERNAME)
    if existing:
        auth_service.delete_user(db, existing.id)
    user, err = auth_service.create_user(db, TEST_USERNAME, "Test@12345")
    assert err is None, f"创建测试用户失败: {err}"
    return user


def _set_last_activity(db, jti: str, minutes_ago: float, login_minutes_ago: float | None = None):
    """把会话最后活动时间拨到 N 分钟前（模拟长时间无请求）。

    login_minutes_ago 用于同时前移登录时间，保证 last_activity >= login_time。
    """
    session = db.query(UserSession).filter(UserSession.token_jti == jti).first()
    assert session is not None
    now = datetime.now(timezone.utc)
    if login_minutes_ago is not None:
        session.login_time = now - timedelta(minutes=login_minutes_ago)
    session.last_activity = now - timedelta(minutes=minutes_ago)
    db.commit()
    return session


def test_cleanup_only_settles_usage_without_revoking():
    """空闲结算不再注销会话：6 分钟无活动后 JWT 依然有效，且时长只结算一次"""
    init_db()
    db = SessionLocal()
    try:
        user = _create_test_user(db)
        auth_service.record_session(db, user.id, "jti-policy-settle")
        session = _set_last_activity(db, "jti-policy-settle", minutes_ago=6, login_minutes_ago=30)

        auth_service.cleanup_stale_sessions(db, idle_minutes=5)
        db.refresh(session)
        assert session.logout_time is None, "空闲结算不应注销会话"
        assert not auth_service.is_token_revoked(db, "jti-policy-settle")
        assert session.usage_accounted_at is not None, "应结算使用时长"

        # 幂等：同一段空闲重复结算不得重复累加
        accounted = session.usage_accounted_at
        auth_service.cleanup_stale_sessions(db, idle_minutes=5)
        db.refresh(session)
        assert session.usage_accounted_at == accounted
    finally:
        existing = auth_service.get_user_by_username(db, TEST_USERNAME)
        if existing:
            auth_service.delete_user(db, existing.id)
        db.close()


def test_idle_expiry_requires_relogin():
    """连续空闲超过阈值才要求重新登录；恢复活动（心跳）后保持登录"""
    init_db()
    db = SessionLocal()
    try:
        user = _create_test_user(db)
        auth_service.record_session(db, user.id, "jti-policy-idle")

        _set_last_activity(db, "jti-policy-idle", minutes_ago=settings.SESSION_IDLE_TIMEOUT_MINUTES + 5)
        assert auth_service.is_session_idle_expired(db, "jti-policy-idle")

        # 阈值内不打扰
        _set_last_activity(db, "jti-policy-idle", minutes_ago=settings.SESSION_IDLE_TIMEOUT_MINUTES - 5)
        assert not auth_service.is_session_idle_expired(db, "jti-policy-idle")

        # 心跳/请求恢复活动后不再判定超时
        _set_last_activity(db, "jti-policy-idle", minutes_ago=settings.SESSION_IDLE_TIMEOUT_MINUTES + 5)
        auth_service.update_session_activity(db, "jti-policy-idle")
        assert not auth_service.is_session_idle_expired(db, "jti-policy-idle")

        # 无会话记录的旧 token 放行
        assert not auth_service.is_session_idle_expired(db, "jti-not-exist")
    finally:
        existing = auth_service.get_user_by_username(db, TEST_USERNAME)
        if existing:
            auth_service.delete_user(db, existing.id)
        db.close()


def test_logout_and_kick_still_revoke():
    """主动登出、新设备登录互踢仍立即注销（需要重新登录）"""
    init_db()
    db = SessionLocal()
    try:
        user = _create_test_user(db)
        auth_service.record_session(db, user.id, "jti-policy-logout", ip_address="1.1.1.1", client_type="pc")
        auth_service.record_session(db, user.id, "jti-policy-kick", ip_address="1.1.1.1", client_type="pc")

        auth_service.end_session(db, "jti-policy-logout")
        assert auth_service.is_token_revoked(db, "jti-policy-logout")

        ended = auth_service.end_other_ip_sessions(db, user.id, "2.2.2.2", "pc")
        assert ended == 1
        assert auth_service.is_token_revoked(db, "jti-policy-kick")
    finally:
        existing = auth_service.get_user_by_username(db, TEST_USERNAME)
        if existing:
            auth_service.delete_user(db, existing.id)
        db.close()
