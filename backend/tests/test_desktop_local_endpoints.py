"""桌面版本机接口（在线激活/续期/申请）测试：真实许可校验 + 桩化云端调用。"""
from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.security import get_current_admin_user, get_current_user


@pytest.fixture()
def desktop_local(tmp_path, monkeypatch):
    from app.api.v1.endpoints import desktop_local as endpoint_module
    from app.core.config import settings
    from app.services import desktop_cloud_client as cloud
    from app.services.desktop_signing import sign_license
    from app.utils.machine_code import get_machine_code

    private_key = Ed25519PrivateKey.generate()
    public_hex = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        .hex()
    )
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv("NPT_LICENSE_PUBLIC_KEY_HEX", public_hex)
    # 仅测试用：本用例需要现场"签发"许可（真实客户端不持有私钥）
    monkeypatch.setenv("NPT_LICENSE_PRIVATE_KEY", private_pem)
    monkeypatch.setattr(settings, "NPT_DESKTOP", True)
    monkeypatch.setattr(settings, "LICENSE_DIR", tmp_path)
    monkeypatch.setattr(settings, "NPT_SERVER_URL", "https://example.invalid")
    monkeypatch.setattr(settings, "NPT_DESKTOP_VERSION", "0.0.0-test")

    machine = get_machine_code()

    def make_license(days: int = 30, issued_via: str = "online") -> str:
        return sign_license(
            {
                "v": 1,
                "license_id": 7,
                "subject": "张三",
                "org": "某市网优中心",
                "licensee": "某市网优中心",
                "machine_code": machine,
                "lease_days": days,
                "renew_count": 1,
                "issued_via": issued_via,
                "issued_at": "2026-01-01 00:00:00",
                "expire_date": (date.today() + timedelta(days=days)).isoformat(),
                "features": ["all"],
            }
        )

    app = FastAPI()
    app.include_router(endpoint_module.router, prefix="/api/v1/desktop")
    admin = SimpleNamespace(username="admin", is_admin=True)
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[get_current_admin_user] = lambda: admin
    # 窗口控制/状态查询走「只验 JWT 签名」的轻量依赖，测试里同样桩掉
    app.dependency_overrides[endpoint_module._require_desktop_window_user] = lambda: None

    yield SimpleNamespace(
        client=TestClient(app),
        cloud=cloud,
        endpoint_module=endpoint_module,
        make_license=make_license,
        settings=settings,
        monkeypatch=monkeypatch,
        machine=machine,
    )


def test_activate_writes_license(desktop_local):
    license_file = desktop_local.make_license(30)
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": license_file, "expire_date": "x"},
    )
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["license"]["valid"] is True
    assert data["license"]["issued_via"] == "online"
    assert data["license"]["subject"] == "张三"
    assert 28 <= data["license"]["remaining_days"] <= 30
    assert (desktop_local.settings.LICENSE_DIR / "license.nptlic").is_file()


def test_app_version_uses_server_absolute_url(desktop_local):
    """桌面端不分发 APK：取服务器最新版本，且下载/二维码地址必须是服务器绝对地址。"""
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "app_version",
        lambda: {
            "version": "1.2.0",
            "download_url": "/api/v1/app-versions/download/9",
            "file_size_display": "85.0 MB",
        },
    )
    resp = desktop_local.client.get("/api/v1/desktop/app-version")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["version"] == "1.2.0"
    assert data["download_url"] == "https://example.invalid/api/v1/app-versions/download/9"


def test_session_status_reports_kicked(desktop_local):
    """账号在别处登录后，本机登录态接口要报失效（前端据此退出到登录页）。"""
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud, "session_check", lambda jti: {"valid": True}
    )
    resp = desktop_local.client.get("/api/v1/desktop/session-status")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["valid"] is True

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "session_check",
        lambda jti: {"valid": False, "reason": "该账号已在其它设备登录"},
    )
    desktop_local.cloud.save_state(session_jti="jti-1", local_jti="local-1")
    resp2 = desktop_local.client.get("/api/v1/desktop/session-status")
    assert resp2.json()["data"]["valid"] is False
    assert "其它设备" in (resp2.json()["data"].get("reason") or "")


def test_window_title_forwarded_to_shell(desktop_local):
    """窗口标题由前端拼好、后端只转发给桌面壳（用于标注运行模式 + 实时同步状态）。"""
    from app import desktop_bridge

    seen: list[str] = []
    desktop_bridge.set_title_handler(seen.append)
    try:
        resp = desktop_local.client.post(
            "/api/v1/desktop/window-title", json={"title": "网优引擎 - 共享模式 · 已同步 11:28"}
        )
        assert resp.status_code == 200, resp.text
        assert seen == ["网优引擎 - 共享模式 · 已同步 11:28"]
    finally:
        desktop_bridge.set_title_handler(None)


def test_window_title_without_shell_returns_403(desktop_local):
    """非桌面壳（未注入回调）必须 403，网页端据此静默忽略。"""
    from app import desktop_bridge

    desktop_bridge.set_title_handler(None)
    resp = desktop_local.client.post(
        "/api/v1/desktop/window-title", json={"title": "网优引擎 - 单机模式"}
    )
    assert resp.status_code == 403


def test_window_title_rejects_blank(desktop_local):
    from app import desktop_bridge

    desktop_bridge.set_title_handler(lambda _t: None)
    try:
        resp = desktop_local.client.post("/api/v1/desktop/window-title", json={"title": "   "})
        assert resp.status_code == 400
    finally:
        desktop_bridge.set_title_handler(None)


def test_fullscreen_forwarded_to_shell(desktop_local):
    """地图「全屏」由桌面壳把主窗口切成系统级全屏（WebView2 的 HTML Fullscreen 占不满屏幕）。"""
    from app import desktop_bridge

    seen: list[bool] = []
    desktop_bridge.set_fullscreen_handler(seen.append)
    try:
        enter = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": True})
        assert enter.status_code == 200, enter.text
        assert enter.json()["data"]["fullscreen"] is True

        leave = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": False})
        assert leave.status_code == 200, leave.text
        assert seen == [True, False]
    finally:
        desktop_bridge.set_fullscreen_handler(None)


def test_fullscreen_without_shell_returns_403(desktop_local):
    """非桌面壳必须 403：前端据此回退浏览器 Fullscreen API。"""
    from app import desktop_bridge

    desktop_bridge.set_fullscreen_handler(None)
    resp = desktop_local.client.post("/api/v1/desktop/fullscreen", json={"fullscreen": True})
    assert resp.status_code == 403


def test_window_control_forwarded_to_shell(desktop_local):
    """自绘标题栏动作逐条转发给壳层 handler（resize-edge 透传缩放方向）。"""
    from app import desktop_bridge

    seen: list = []

    def handler(action, params):
        seen.append((action, params))
        return {"maximized": action == "toggle-maximize"}

    desktop_bridge.set_window_control_handler(handler)
    try:
        for body in [
            {"action": "minimize"},
            {"action": "toggle-maximize"},
            {"action": "close"},
            {"action": "resize-edge", "direction": "nw"},
            {"action": "activate"},
        ]:
            resp = desktop_local.client.post("/api/v1/desktop/window-control", json=body)
            assert resp.status_code == 200, resp.text
            assert resp.json()["success"] is True
        assert seen == [
            ("minimize", {}),
            ("toggle-maximize", {}),
            ("close", {}),
            ("resize-edge", {"direction": "nw"}),
            ("activate", {}),
        ]
    finally:
        desktop_bridge.set_window_control_handler(None)


def test_window_control_without_shell_returns_403(desktop_local):
    from app import desktop_bridge

    desktop_bridge.set_window_control_handler(None)
    resp = desktop_local.client.post("/api/v1/desktop/window-control", json={"action": "minimize"})
    assert resp.status_code == 403


def test_window_control_validates_payload(desktop_local):
    from app import desktop_bridge

    desktop_bridge.set_window_control_handler(lambda action, params: {})
    try:
        bad_action = desktop_local.client.post(
            "/api/v1/desktop/window-control", json={"action": "shuffle"}
        )
        assert bad_action.status_code == 422  # Literal 白名单在 Pydantic 层拒绝

        resize_without_dir = desktop_local.client.post(
            "/api/v1/desktop/window-control", json={"action": "resize-edge"}
        )
        assert resize_without_dir.status_code == 400
    finally:
        desktop_bridge.set_window_control_handler(None)


def test_window_state_forwarded_to_shell(desktop_local):
    """窗口状态查询读壳层缓存（maximized/fullscreen），供标题栏聚焦时校准图标。"""
    from app import desktop_bridge

    desktop_bridge.set_window_control_handler(
        lambda action, params: {"maximized": True, "fullscreen": False}
    )
    try:
        resp = desktop_local.client.get("/api/v1/desktop/window-state")
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["maximized"] is True
    finally:
        desktop_bridge.set_window_control_handler(None)


def test_window_state_without_shell_returns_403(desktop_local):
    """非桌面壳 403：前端据此静默跳过校准。"""
    from app import desktop_bridge

    desktop_bridge.set_window_control_handler(None)
    resp = desktop_local.client.get("/api/v1/desktop/window-state")
    assert resp.status_code == 403


def test_window_control_fast_path_dependencies_are_async():
    """窗口控制/状态/热键轮询的依赖必须全是 async。

    同步依赖（含 get_current_user → 同步 generator get_db）会被 Starlette 丢进
    anyio 线程池申请 token；IM 慢 relay 占满 40 个 token 时，按钮点按会排队几十秒。
    """
    import inspect

    from app.api.v1.endpoints import desktop_local

    assert inspect.iscoroutinefunction(desktop_local._require_desktop_fast)
    assert inspect.iscoroutinefunction(desktop_local._require_desktop_window_user)
    # 两个端点都不能再挂同步 DB 依赖（router 里的路径未带 /api/v1/desktop 前缀）
    for path in ("/window-control", "/window-state"):
        route = next(
            r for r in desktop_local.router.routes if getattr(r, "path", None) == path
        )
        assert not any(
            getattr(getattr(d, "call", None), "__name__", "") == "get_current_user"
            for d in route.dependant.dependencies
        )


def test_activate_error_maps_status(desktop_local):
    def boom(code, hostname=None):
        raise desktop_local.cloud.CloudError(403, "该授权已被禁用，请联系管理员")

    desktop_local.monkeypatch.setattr(desktop_local.cloud, "activate", boom)
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-XXXX-XXXX-XXXX-XXXX"}
    )
    assert resp.status_code == 403
    assert "禁用" in resp.json()["detail"]


def test_cloud_unreachable_maps_502(desktop_local):
    def boom(code, hostname=None):
        raise desktop_local.cloud.CloudError(0, "无法连接授权服务器")

    desktop_local.monkeypatch.setattr(desktop_local.cloud, "activate", boom)
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-XXXX-XXXX-XXXX-XXXX"}
    )
    assert resp.status_code == 502


def test_renew_updates_license(desktop_local):
    # 先激活
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": desktop_local.make_license(5)},
    )
    desktop_local.client.post(
        "/api/v1/desktop/cloud-activate", json={"activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"}
    )

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "renew_remote",
        lambda license_file, **kwargs: {
            "license_file": desktop_local.make_license(30),
            "expire_date": "future",
        },
    )
    resp = desktop_local.client.post("/api/v1/desktop/cloud-renew")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["license"]["remaining_days"] >= 29


def test_apply_poll_auto_activates(desktop_local):
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "apply_license",
        lambda name, org=None, note=None: {"request_id": 11, "status": "pending"},
    )
    resp = desktop_local.client.post(
        "/api/v1/desktop/cloud-apply", json={"applicant_name": "李四", "organization": "某单位"}
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "pending"

    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "poll_apply",
        lambda: {"status": "issued", "activation_code": "NPT-ABCD-EFGH-JKMN-PQRS"},
    )
    desktop_local.monkeypatch.setattr(
        desktop_local.cloud,
        "activate",
        lambda code, hostname=None: {"license_file": desktop_local.make_license(30)},
    )
    resp = desktop_local.client.get("/api/v1/desktop/cloud-apply")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["activated"] is True
    assert data["status_detail"]["license"]["valid"] is True


def test_status_without_license(desktop_local):
    resp = desktop_local.client.get("/api/v1/desktop/cloud-status")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["desktop"] is True
    assert data["machine_code"] == desktop_local.machine
    assert data["license"] is None


def test_endpoints_404_outside_desktop(desktop_local):
    desktop_local.monkeypatch.setattr(desktop_local.settings, "NPT_DESKTOP", False)
    for method, path, payload in (
        ("get", "/api/v1/desktop/cloud-status", None),
        ("post", "/api/v1/desktop/cloud-renew", None),
        ("get", "/api/v1/desktop/cloud-apply", None),
        ("post", "/api/v1/desktop/fullscreen", {"fullscreen": True}),
    ):
        call = getattr(desktop_local.client, method)
        resp = call(path, json=payload) if payload is not None else call(path)
        assert resp.status_code == 404, (method, path, resp.status_code)


def test_offline_license_not_renewed_by_policy(desktop_local):
    from app.services import desktop_cloud_client as cloud

    assert cloud.should_renew({"valid": True, "issued_via": "offline", "remaining_days": 3}, {}) is False
    # 离线导入许可没有在线记录：即使已过期也不能续期
    assert cloud.should_renew({"valid": False, "issued_via": "offline"}, {}) is False


def test_expired_online_license_renewed_by_policy(desktop_local):
    """过期的在线许可仍要尝试续期：联网后服务器重签，客户端无需重登即可恢复。"""
    from app.services import desktop_cloud_client as cloud

    assert cloud.should_renew({"valid": False, "issued_via": "online"}, {}) is True


def test_renewal_policy_by_remaining_days(desktop_local):
    from app.services import desktop_cloud_client as cloud

    info = {"valid": True, "issued_via": "online", "remaining_days": 5}
    assert cloud.should_renew(info, {}) is True
    info["remaining_days"] = 25
    assert cloud.should_renew(info, {"last_renew_at": "2026-01-01T00:00:00"}) is True  # 距上次超过 7 天


# ------------------------------------------------------------------ 取景截图端点

def _screenshot_settings_root(desktop_local, tmp_path):
    root = tmp_path / "shot-settings"
    desktop_local.monkeypatch.setattr(desktop_local.settings, "DATA_ROOT", root)
    return root


def test_screenshot_capture_status_image_and_cancel(desktop_local, tmp_path):
    """发起 / 轮询 / 取二进制 PNG / 取消逐条转发给壳层，图像不经 JSON 膨胀。"""
    from app import desktop_bridge

    _screenshot_settings_root(desktop_local, tmp_path)
    seen: list = []
    png = b"\x89PNG\r\n\x1a\nfake-frame"

    def handler(action, params):
        seen.append((action, params))
        if action == "start":
            return {"started": True, "busy": False, "unsupported": False, "seq": 3}
        if action == "status":
            return {"seq": 4, "ready": True, "cancelled": False, "pending": False}
        if action == "image":
            return {"png": png}
        if action == "cancel":
            return {"cancelled": True}
        return {}

    desktop_bridge.set_screenshot_handler(handler)
    try:
        start = desktop_local.client.post(
            "/api/v1/desktop/screenshot-capture",
            json={"hide_im_window": True, "frame_ready": True},
        )
        assert start.status_code == 200, start.text
        assert start.json()["data"]["seq"] == 3

        status = desktop_local.client.get("/api/v1/desktop/screenshot-result?after=3")
        assert status.status_code == 200, status.text
        assert status.json()["data"]["ready"] is True

        image = desktop_local.client.get("/api/v1/desktop/screenshot-image")
        assert image.status_code == 200
        assert image.headers["content-type"].startswith("image/png")
        assert image.content == png

        cancel = desktop_local.client.post("/api/v1/desktop/screenshot-cancel")
        assert cancel.json()["data"]["cancelled"] is True
        assert seen == [
            ("start", {"hideImWindow": True, "frameReady": True}),
            ("status", {"after": 3}),
            ("image", {}),
            ("cancel", {}),
        ]
    finally:
        desktop_bridge.set_screenshot_handler(None)


def test_screenshot_capture_claims_hotkey_round_and_defaults_frame_ready(
    desktop_local, tmp_path
):
    """旧前端不带 frame_ready 时默认 false；POST 会撤销壳层 watchdog 的待取景轮次。"""
    from app import desktop_bridge

    _screenshot_settings_root(desktop_local, tmp_path)
    seen: list = []

    def handler(action, params):
        seen.append((action, params))
        return {"started": True, "busy": False, "unsupported": False, "seq": 1}

    desktop_bridge.set_screenshot_handler(handler)
    try:
        desktop_bridge.notify_screenshot_hotkey()  # 模拟一次全局热键登记
        resp = desktop_local.client.post(
            "/api/v1/desktop/screenshot-capture", json={"hide_im_window": False}
        )
        assert resp.status_code == 200, resp.text
        assert seen == [("start", {"hideImWindow": False, "frameReady": False})]
        # 前端已接管：watchdog 再 claim 应失败，不会重复铺蒙层
        assert desktop_bridge.claim_screenshot_round() is False
    finally:
        desktop_bridge.set_screenshot_handler(None)


def test_screenshot_capture_without_shell_returns_403(desktop_local, tmp_path):
    """桥接未注入（网页端 / 旧壳）：端点统一 403，前端据此降级。"""
    from app import desktop_bridge

    _screenshot_settings_root(desktop_local, tmp_path)
    desktop_bridge.set_screenshot_handler(None)
    for resp in (
        desktop_local.client.post("/api/v1/desktop/screenshot-capture", json={}),
        desktop_local.client.get("/api/v1/desktop/screenshot-result"),
        desktop_local.client.get("/api/v1/desktop/screenshot-image"),
        desktop_local.client.post("/api/v1/desktop/screenshot-cancel"),
    ):
        assert resp.status_code == 403, resp.text


def test_screenshot_settings_default_and_validation(desktop_local, tmp_path):
    from app.services import desktop_screenshot_settings as cfg

    root = _screenshot_settings_root(desktop_local, tmp_path)
    resp = desktop_local.client.get("/api/v1/desktop/screenshot-settings")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["settings"] == cfg.default_settings()
    assert data["hotkey"]["display"] == "Alt+Z"

    bad = desktop_local.client.put(
        "/api/v1/desktop/screenshot-settings",
        json={"hotkey": {"modifiers": [], "key": "Z"}, "hideImWindow": False},
    )
    assert bad.status_code == 400
    assert cfg.load_settings(root) == cfg.default_settings()


def test_screenshot_settings_conflict_rolls_back(desktop_local, tmp_path):
    """RegisterHotKey 1409：配置回滚到上一次可用值，并向前端回报 conflict。"""
    from app import desktop_bridge
    from app.services import desktop_screenshot_settings as cfg

    root = _screenshot_settings_root(desktop_local, tmp_path)
    seen: list = []

    def handler(action, params):
        seen.append(action)
        if action == "apply":
            return {"conflict": True, "registered": False, "error": 1409}
        return {"registered": True}

    desktop_bridge.set_screenshot_handler(handler)
    try:
        resp = desktop_local.client.put("/api/v1/desktop/screenshot-settings", json={
            "hotkey": {"modifiers": ["ctrl", "shift"], "key": "F5"},
            "hideImWindow": False,
        })
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["conflict"] is True
        assert data["reverted"] is True
        assert data["settings"] == cfg.default_settings()
        # 落盘也必须是回滚后的配置，不能留下冲突组合键
        assert cfg.load_settings(root) == cfg.default_settings()
        # 一次尝试 + 一次按旧配置重注册
        assert seen.count("apply") == 2
    finally:
        desktop_bridge.set_screenshot_handler(None)


def test_screenshot_settings_hide_toggle_does_not_reregister_hotkey(desktop_local, tmp_path):
    """只切换「隐藏窗口截图」开关时不重注册热键，避免无关的冲突回滚。"""
    from app import desktop_bridge
    from app.services import desktop_screenshot_settings as cfg

    root = _screenshot_settings_root(desktop_local, tmp_path)
    seen: list = []

    def handler(action, params):
        seen.append(action)
        return {"registered": True, "conflict": False}

    desktop_bridge.set_screenshot_handler(handler)
    try:
        resp = desktop_local.client.put("/api/v1/desktop/screenshot-settings", json={
            "hotkey": {"modifiers": ["alt"], "key": "Z"},
            "hideImWindow": True,
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["settings"]["hideImWindow"] is True
        assert "apply" not in seen
        assert cfg.load_settings(root)["hideImWindow"] is True
    finally:
        desktop_bridge.set_screenshot_handler(None)


def test_screenshot_hotkey_round_is_claimed_once():
    """热键登记 → 前端与 watchdog 竞争，只可能有一方抢到取景轮次。"""
    from app import desktop_bridge

    before = desktop_bridge.screenshot_hotkey_seq()
    seq = desktop_bridge.notify_screenshot_hotkey()
    assert seq == before + 1
    assert desktop_bridge.screenshot_hotkey_seq() == seq
    assert desktop_bridge.claim_screenshot_round() is True
    assert desktop_bridge.claim_screenshot_round() is False


def test_cloud_ws_config_disabled_when_flag_off(desktop_local):
    desktop_local.monkeypatch.setattr(
        desktop_local.settings, "NPT_IM_CLOUD_WS_ENABLED", False
    )
    resp = desktop_local.client.get("/api/v1/desktop/cloud-ws-config")
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["enabled"] is False


def test_cloud_ws_config_disabled_outside_shared(desktop_local):
    from app.services import im_desktop_proxy

    desktop_local.monkeypatch.setattr(
        desktop_local.settings, "NPT_IM_CLOUD_WS_ENABLED", True
    )
    desktop_local.monkeypatch.setattr(
        im_desktop_proxy, "is_shared_desktop", lambda: False
    )
    resp = desktop_local.client.get("/api/v1/desktop/cloud-ws-config")
    assert resp.json()["data"]["enabled"] is False


def test_cloud_ws_config_returns_license_credentials(desktop_local):
    """共享模式返回 wss 地址与许可凭证；凭证只经本机端点下发，不进 URL。"""
    from app.services import im_desktop_proxy

    mp = desktop_local.monkeypatch
    mp.setattr(desktop_local.settings, "NPT_IM_CLOUD_WS_ENABLED", True)
    mp.setattr(desktop_local.settings, "NPT_SERVER_URL", "https://app.example.test")
    mp.setattr(im_desktop_proxy, "is_shared_desktop", lambda: True)
    mp.setattr(desktop_local.cloud, "_license_file_text", lambda: "signed-license")

    resp = desktop_local.client.get("/api/v1/desktop/cloud-ws-config")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["enabled"] is True
    assert data["url"] == "wss://app.example.test/api/v1/ws/tasks?kind=license"
    assert data["license_file"] == "signed-license"
    assert data["machine_code"]
    assert len(data["license_fingerprint"]) == 16
    assert data["auth_timeout_ms"] > 0


def test_mirrored_user_keeps_server_im_identity_and_avatar(tmp_path, monkeypatch):
    """桌面镜像账号的本地 id 与服务器 id 不同：IM 身份必须用 im_user_id，头像要一起镜像。"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api.v1.endpoints import desktop_local as endpoint_module
    from app.core.database import Base
    from app.core.config import settings
    from app.models.database import User

    monkeypatch.setattr(settings, "DATA_ROOT", tmp_path)
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()
    try:
        incoming = {
            "id": 27, "username": "alice", "is_admin": False,
            "avatar": "data:image/png;base64,AAAA", "nickname": "小张",
        }
        row = endpoint_module._mirror_local_user(db, incoming, "shared", "pwd123")
        assert row.id != 27  # 本机 SQLite 自分配的 id，与服务器 id 不同
        payload = endpoint_module.auth_service.user_payload(row)
        assert payload["im_user_id"] == 27
        assert payload["avatar"] == incoming["avatar"]
        assert payload["nickname"] == "小张"

        # 服务器改了头像/昵称后，心跳同步要覆盖旧的镜像值
        incoming.update({"avatar": "data:image/png;base64,BBBB", "nickname": "小李"})
        row2 = endpoint_module._mirror_local_user(db, incoming, "shared", "pwd123")
        assert row2.im_user_id == 27
        assert endpoint_module.auth_service.user_payload(row2)["avatar"].endswith("BBBB")
    finally:
        db.close()
