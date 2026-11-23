"""用户上线提醒（气泡 + 敲门声）测试

覆盖：
- 上线事件负载的文案组装（「地市_运营商 用户名」，缺项时退化）
- eventId 唯一且可复用于「本端登录响应 + 服务端广播」两条路径的去重
- WebSocketManager 只向已鉴权的连接广播（匿名连接不泄露在线名单）
- 广播失败绝不影响登录流程
"""
import asyncio

from app.services.presence_service import (
    build_online_event,
    notify_user_online,
    notify_user_online_from_payload,
    notify_user_online_from_user,
)


class _FakeWebSocket:
    """最小 WebSocket 替身：只记录 send_json 的内容"""

    def __init__(self, fail: bool = False):
        self.sent = []
        self.fail = fail

    async def send_json(self, message):
        if self.fail:
            raise RuntimeError("连接已断开")
        self.sent.append(message)


def _install_fake_manager(monkeypatch):
    """把 WebSocketManager 单例替换成记录型替身"""
    notified = []

    class _Patched:
        @staticmethod
        def notify_user_online(payload):
            notified.append(payload)

    monkeypatch.setattr(
        "app.services.websocket_manager.websocket_manager", _Patched, raising=True
    )
    return notified


# ---------------------------------------------------------------- 文案组装


def test_online_event_text_is_city_operator_username():
    """文案形如「河源_电信 admin」"""
    event = build_online_event(
        user_id=1, username="admin", city="河源", operator="电信", is_admin=True
    )
    assert event["text"] == "河源_电信 admin"
    assert event["username"] == "admin"
    assert event["isAdmin"] is True


def test_online_event_text_degrades_when_group_incomplete():
    """组信息缺失时不出现多余的下划线"""
    event = build_online_event(user_id=2, username="zhangsan", city="", operator="移动")
    assert event["text"] == "移动 zhangsan"
    assert "_" not in event["text"]

    event = build_online_event(user_id=3, username="lisi", city="梅州", operator="")
    assert event["text"] == "梅州 lisi"

    event = build_online_event(user_id=4, username="wangwu", city="", operator="")
    assert event["text"] == "wangwu"


def test_online_event_has_unique_event_id():
    """每次上线事件都有唯一 eventId（供前端去重）"""
    a = build_online_event(user_id=1, username="admin", city="河源", operator="电信")
    b = build_online_event(user_id=1, username="admin", city="河源", operator="电信")
    assert a["eventId"] and b["eventId"]
    assert a["eventId"] != b["eventId"]


def test_online_event_id_can_be_reused():
    """同一 eventId 可显式指定：本端登录响应与服务端广播共用一份"""
    event = build_online_event(
        user_id=1, username="admin", city="河源", operator="电信", event_id="fixed-id"
    )
    assert event["eventId"] == "fixed-id"


# ---------------------------------------------------------------- 广播


def test_notify_user_online_broadcasts_payload(monkeypatch):
    """广播时把事件负载交给 WebSocketManager"""
    notified = _install_fake_manager(monkeypatch)
    event = build_online_event(user_id=1, username="admin", city="河源", operator="电信")
    result = notify_user_online(event)
    assert result["eventId"] == event["eventId"]
    assert notified and notified[-1]["text"] == "河源_电信 admin"


def test_notify_from_user_and_payload(monkeypatch):
    """从 User 对象 / user_payload 字典两种入口都能广播"""
    notified = _install_fake_manager(monkeypatch)

    class _User:
        id = 7
        username = "admin"
        city = "河源"
        operator = "电信"
        is_admin = True

    notify_user_online_from_user(_User(), "pc")
    notify_user_online_from_payload(
        {"id": 8, "username": "zhangsan", "city": "梅州", "operator": "移动"},
        "desktop",
    )

    assert notified[0]["text"] == "河源_电信 admin"
    assert notified[0]["clientType"] == "pc"
    assert notified[1]["text"] == "梅州_移动 zhangsan"
    assert notified[1]["clientType"] == "desktop"


def test_notify_user_online_never_raises(monkeypatch):
    """广播异常必须被吞掉：绝不影响登录流程"""

    def _boom(_payload):
        raise RuntimeError("WS 挂了")

    monkeypatch.setattr(
        "app.services.websocket_manager.websocket_manager.notify_user_online",
        _boom,
        raising=True,
    )
    # 不抛异常即通过
    notify_user_online(build_online_event(username="admin"))


# ---------------------------------------------------------------- 事件日志（桌面端中继）
#
# 桌面壳内渲染进程只连本机后端 WS，收不到这里的广播，靠事件日志按游标补齐：
# 因此「入日志」必须发生在广播之前 / 独立于广播成功与否。


def test_event_log_serves_desktop_relay_by_cursor(monkeypatch):
    from app.services import presence_service

    _install_fake_manager(monkeypatch)
    baseline = presence_service.events_since(0)["seq"]

    first = notify_user_online(
        build_online_event(user_id=11, username="a1", city="河源", operator="电信")
    )
    second = notify_user_online(
        build_online_event(user_id=12, username="a2", city="河源", operator="联通")
    )

    batch = presence_service.events_since(baseline)
    assert batch["seq"] >= baseline + 2
    ids = [item["eventId"] for item in batch["events"]]
    assert first["eventId"] in ids and second["eventId"] in ids
    assert ids.index(first["eventId"]) < ids.index(second["eventId"])
    # 用最新游标再取一次：不重复下发（否则桌面端会重复敲门）
    assert presence_service.events_since(batch["seq"])["events"] == []


def test_event_log_records_even_when_broadcast_fails(monkeypatch):
    """WS 广播失败不该让桌面端漏掉这次上线。"""
    from app.services import presence_service

    def _boom(_payload):
        raise RuntimeError("WS 挂了")

    monkeypatch.setattr(
        "app.services.websocket_manager.websocket_manager.notify_user_online",
        _boom,
        raising=True,
    )
    baseline = presence_service.events_since(0)["seq"]
    event = notify_user_online(build_online_event(user_id=13, username="a3"))

    ids = [item["eventId"] for item in presence_service.events_since(baseline)["events"]]
    assert event["eventId"] in ids


def test_event_log_is_bounded_but_cursor_moves(monkeypatch):
    """环形日志有上限（不无限增长），但游标照常推进，客户端不会卡住。"""
    from app.services import presence_service

    _install_fake_manager(monkeypatch)
    baseline = presence_service.events_since(0)["seq"]
    for index in range(presence_service.EVENT_LOG_MAX + 5):
        notify_user_online(build_online_event(user_id=100 + index, username=f"u{index}"))

    batch = presence_service.events_since(baseline, limit=0)
    assert batch["seq"] == baseline + presence_service.EVENT_LOG_MAX + 5
    assert len(batch["events"]) <= presence_service.EVENT_LOG_MAX


def test_events_since_tolerates_bad_cursor():
    """客户端传了脏游标（None/负/非数字）按 0 处理，不抛异常。"""
    from app.services import presence_service

    assert presence_service.events_since(None)["seq"] >= 0
    assert presence_service.events_since(-5)["seq"] >= 0
    assert presence_service.events_since("abc")["seq"] >= 0


# ---------------------------------------------------------------- 连接鉴权


def test_broadcast_only_reaches_authenticated_connections():
    """只推给已鉴权的连接：登录页上的匿名连接收不到在线提醒"""
    from app.services import websocket_manager as wm_module

    manager = wm_module.WebSocketManager()
    # 隔离单例状态，避免污染其它测试
    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}

    anon = _FakeWebSocket()
    authed = _FakeWebSocket()
    manager.connections["anon"] = anon
    manager.connections["authed"] = authed
    manager.register_client_auth("authed", 1)

    asyncio.run(
        manager.broadcast_authenticated(
            {"type": "user_online", "data": {"text": "河源_电信 admin"}}
        )
    )

    assert authed.sent, "已鉴权连接应收到上线提醒"
    assert not anon.sent, "匿名连接不应收到上线提醒"

    # 复原单例状态
    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}


def test_disconnect_clears_auth_registration():
    """断开连接后要清掉鉴权标记"""
    from app.services import websocket_manager as wm_module

    manager = wm_module.WebSocketManager()
    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}

    ws = _FakeWebSocket()
    manager.connections["c1"] = ws
    manager.register_client_auth("c1", 42)
    assert "c1" in manager.client_authed
    assert manager.client_user_ids["c1"] == 42

    asyncio.run(manager.disconnect("c1"))
    assert "c1" not in manager.client_authed
    assert "c1" not in manager.client_user_ids

    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}


def test_broadcast_excludes_login_user_connections():
    """自身登录：该用户的所有连接（含其它标签页）都不收到上线提醒"""
    from app.services import websocket_manager as wm_module

    manager = wm_module.WebSocketManager()
    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}
    try:
        self_tab1 = _FakeWebSocket()
        self_tab2 = _FakeWebSocket()
        other_user = _FakeWebSocket()
        manager.connections = {
            "self1": self_tab1, "self2": self_tab2, "other": other_user,
        }
        manager.register_client_auth("self1", 7)
        manager.register_client_auth("self2", 7)
        manager.register_client_auth("other", 8)

        msg = {"type": "user_online", "data": {"text": "河源_电信 admin", "userId": 7}}
        asyncio.run(manager.broadcast_authenticated(msg, exclude_user_id=7))

        assert not self_tab1.sent, "上线者本人的标签页不应收到提醒"
        assert not self_tab2.sent, "上线者本人的其它标签页也不应收到提醒"
        assert other_user.sent, "其他用户端应收到上线提醒"
    finally:
        manager.connections = {}
        manager.client_authed = set()
        manager.client_user_ids = {}


def test_notify_user_online_uses_payload_user_id_as_exclusion():
    """notify_user_online 从事件负载里取 userId 作为排除依据"""
    from app.services import websocket_manager as wm_module

    manager = wm_module.WebSocketManager()
    manager.connections = {}
    manager.client_authed = set()
    manager.client_user_ids = {}
    captured = {}

    async def fake_broadcast(message, exclude_user_id=None):
        captured["exclude_user_id"] = exclude_user_id
        captured["message"] = message

    original = manager.broadcast_authenticated
    manager.broadcast_authenticated = fake_broadcast
    try:
        async def scenario():
            manager.loop = asyncio.get_running_loop()
            manager.notify_user_online(build_online_event(user_id=99, username="admin"))
            await asyncio.sleep(0.05)

        asyncio.run(scenario())
        assert captured.get("exclude_user_id") == 99
        assert captured["message"]["type"] == "user_online"
    finally:
        manager.broadcast_authenticated = original
        manager.loop = None
        manager.connections = {}
        manager.client_authed = set()
        manager.client_user_ids = {}
