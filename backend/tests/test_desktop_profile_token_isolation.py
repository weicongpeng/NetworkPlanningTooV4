"""桌面两档 JWT 必须带档声明并互相隔离，避免残留 token 跨档认证。"""
from __future__ import annotations

import pytest

from app.core.config import settings
from app.services.auth_service import auth_service


def test_access_token_carries_profile():
    token, _ = auth_service.create_access_token(1, "alice", False, profile="shared")
    payload = auth_service.decode_token(token)
    assert payload is not None
    assert payload["profile"] == "shared"


def test_desktop_rejects_token_from_other_profile():
    import asyncio

    from app.core.security import get_current_user

    shared_token, _ = auth_service.create_access_token(1, "alice", False, profile="shared")
    old_token, _ = auth_service.create_access_token(1, "alice", False)  # 升级前无声明

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "DESKTOP_PROFILE", "standalone")
    try:
        class Credentials:
            def __init__(self, token: str):
                self.credentials = token

        for token in (shared_token, old_token):
            with pytest.raises(Exception) as exc:
                asyncio.run(get_current_user(Credentials(token), None))
            assert getattr(exc.value, "status_code", None) == 401
    finally:
        monkeypatch.undo()
