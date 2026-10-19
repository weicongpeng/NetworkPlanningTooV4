"""桌面端「登录优先」门控：后台重活必须等首次登录后才放行。

背景：桌面形态下 lifespan 会启动一批非关键后台重活（索引对账、图层缓存预热、
大表统计、旧索引拆分、首次数据同步）。它们是纯 Python / GDAL 线程、持 GIL，
若与用户点登录同时起跑，会明显拖慢登录与首屏。
"""
from __future__ import annotations

import threading
import time

import pytest

from app.core import startup_gate


@pytest.fixture(autouse=True)
def _reset_gate():
    startup_gate.reset_for_tests()
    yield
    startup_gate.reset_for_tests()


def test_wait_blocks_until_login_marked():
    """未打标时不得放行；打标后立刻放行。"""
    released = threading.Event()

    def worker():
        startup_gate.wait_for_login(timeout=30)
        released.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    time.sleep(0.3)
    assert not released.is_set(), "登录前就放行了后台重活"

    startup_gate.mark_login_completed()
    assert released.wait(timeout=5), "打标后没有放行"
    thread.join(timeout=5)


def test_wait_times_out_when_never_logged_in():
    """用户始终不登录时按 timeout 兜底放行，维护不能永远不跑。"""
    started = time.monotonic()
    assert startup_gate.wait_for_login(timeout=0.3) is False
    assert time.monotonic() - started >= 0.3


def test_mark_is_idempotent_and_visible():
    assert startup_gate.is_login_completed() is False
    startup_gate.mark_login_completed()
    startup_gate.mark_login_completed()
    assert startup_gate.is_login_completed() is True
    assert startup_gate.wait_for_login(timeout=0.1) is True
