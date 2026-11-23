"""桌面端「有人上线」提示音中继测试。

背景：敲门声 / 气泡的唯一触发来源是服务端 WebSocket 广播的 ``user_online``；
桌面壳内渲染进程连的是**本机后端**，云端广播到不了，于是「网页端有人登录会响，
桌面端完全没反应」。修复分两段，这里各测一段：

1. 云端 ``/desktop-cloud/presence/online`` 长轮询：按游标补发上线事件
2. 桌面本机 ``desktop_presence_relay``：把事件用 WebSocketManager 广播给渲染进程
"""
from __future__ import annotations

from app.services import presence_service
from app.services.presence_service import build_online_event

from .test_desktop_license_cloud import _activate, _create, cloud_env  # noqa: F401

MACHINE = "AAAA-BBBB-CCCC-DDDD"


def _issue(env) -> str:
    record = _create(env.client, name="上线提示测试")
    resp = _activate(env.client, record["activation_code"], machine=MACHINE)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["license_file"]


# ---------------------------------------------------------------- 云端长轮询


def test_presence_endpoint_requires_valid_license(cloud_env):  # noqa: F811
    """凭证仍是签名许可：伪造/缺失一律 400，避免在线名单被匿名拉走。"""
    resp = cloud_env.client.post(
        "/api/v1/desktop-cloud/presence/online",
        json={"license_file": "not-a-license", "machine_code": MACHINE, "wait_seconds": 0},
    )
    assert resp.status_code == 400


def test_presence_endpoint_returns_events_after_cursor(cloud_env):  # noqa: F811
    """按游标只下发新事件；游标推进后再取不会重复（避免桌面端重复敲门）。"""
    license_file = _issue(cloud_env)
    cred = {"license_file": license_file, "machine_code": MACHINE}

    baseline = cloud_env.client.post(
        "/api/v1/desktop-cloud/presence/online", json={**cred, "wait_seconds": 0}
    ).json()["data"]["seq"]

    event = presence_service.notify_user_online(
        build_online_event(user_id=21, username="zhangsan", city="河源", operator="电信")
    )

    data = cloud_env.client.post(
        "/api/v1/desktop-cloud/presence/online",
        json={**cred, "since": baseline, "wait_seconds": 0},
    ).json()["data"]
    assert data["seq"] >= baseline + 1
    ids = [item["eventId"] for item in data["events"]]
    assert event["eventId"] in ids
    assert data["events"][-1]["text"] == "河源_电信 zhangsan"

    again = cloud_env.client.post(
        "/api/v1/desktop-cloud/presence/online",
        json={**cred, "since": data["seq"], "wait_seconds": 0},
    ).json()["data"]
    assert again["events"] == []


# ---------------------------------------------------------------- 本机中继


def test_relay_once_broadcasts_locally(monkeypatch):
    """拉到事件后必须交回本机 WebSocketManager（渲染进程据此弹气泡 + 敲门声）。"""
    from app.services import desktop_cloud_client as cloud
    from app.services import desktop_presence_relay as relay

    sent = []

    class _Manager:
        @staticmethod
        def notify_user_online(payload):
            sent.append(payload)

    monkeypatch.setattr("app.services.websocket_manager.websocket_manager", _Manager, raising=True)
    event = build_online_event(user_id=31, username="lisi", city="梅州", operator="移动")
    monkeypatch.setattr(
        cloud,
        "wait_online_events",
        lambda since, timeout=25: {"seq": since + 1, "events": [event]},
        raising=True,
    )

    assert relay.relay_once(5, wait_seconds=0) == 6
    assert sent and sent[0]["text"] == "梅州_移动 lisi"
    assert sent[0]["eventId"] == event["eventId"]


def test_relay_baseline_aligns_cursor(monkeypatch):
    """启动先对齐游标：不重播本机启动前的历史事件（否则一开窗就咚咚咚）。"""
    from app.services import desktop_cloud_client as cloud
    from app.services import desktop_presence_relay as relay

    monkeypatch.setattr(
        cloud,
        "wait_online_events",
        lambda since, timeout=25: {"seq": 42, "events": []},
        raising=True,
    )
    assert relay.baseline() == 42


def test_relay_skips_malformed_events(monkeypatch):
    """没有文案的脏事件直接跳过，不能因为一条坏数据中断后续转发。"""
    from app.services import desktop_presence_relay as relay

    sent = []

    class _Manager:
        @staticmethod
        def notify_user_online(payload):
            sent.append(payload)

    monkeypatch.setattr("app.services.websocket_manager.websocket_manager", _Manager, raising=True)

    forwarded = relay.broadcast_locally([
        {}, {"text": ""}, "not-a-dict",
        {"text": "河源_电信 admin", "userId": 7, "eventId": "e-1"},
    ])
    assert forwarded == 1
    assert [item["eventId"] for item in sent] == ["e-1"]
