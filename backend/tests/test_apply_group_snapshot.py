"""
"应用到工参"任务组快照回归测试

回归背景：数据组隔离改造后，_find_full_params_item() 强制要求 city/operator，
但 PCI/TAC 的单个与批量应用任务工厂创建 Task 时均漏传组快照，
导致应用必然失败（"未找到全量工参数据"）或 0 命中时假成功。
"""

import logging
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.services.task_manager import TaskManager

COMPLETED = {"status": "completed", "results": []}


@pytest.fixture
def tm():
    manager = TaskManager()
    # 不落盘任务索引，不真正启动执行协程
    manager._persist_task = Mock()
    manager._run_task_with_slot = AsyncMock(return_value=None)
    return manager


class TestPCIApplyGroupSnapshot:
    @pytest.mark.asyncio
    async def test_single_apply_inherits_planning_group(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        tm.get_task_group = Mock(return_value=("河源", "电信"))

        task_id = await tm.create_apply_pci_to_params_task("plan-1")

        task = tm.tasks[task_id]
        assert task.city == "河源"
        assert task.operator == "电信"

    @pytest.mark.asyncio
    async def test_single_apply_missing_group_raises(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        tm.get_task_group = Mock(return_value=None)

        with pytest.raises(ValueError, match="数据组"):
            await tm.create_apply_pci_to_params_task("plan-1")

    @pytest.mark.asyncio
    async def test_batch_apply_inherits_common_group(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        tm.get_task_group = Mock(return_value=("河源", "电信"))

        task_id = await tm.create_apply_pci_batch_task(["plan-1", "plan-2"])

        task = tm.tasks[task_id]
        assert (task.city, task.operator) == ("河源", "电信")

    @pytest.mark.asyncio
    async def test_batch_apply_rejects_mixed_groups(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        groups = {
            "plan-1": ("河源", "电信"),
            "plan-2": ("梅州", "电信"),
        }
        tm.get_task_group = Mock(side_effect=lambda tid: groups[tid])

        with pytest.raises(ValueError, match="数据组不一致"):
            await tm.create_apply_pci_batch_task(["plan-1", "plan-2"])


class TestTACApplyGroupSnapshot:
    @pytest.mark.asyncio
    async def test_single_apply_inherits_planning_group(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        tm.get_task_group = Mock(return_value=("河源", "电信"))

        task_id = await tm.create_apply_tac_planning_to_params_task("plan-1")

        task = tm.tasks[task_id]
        assert (task.city, task.operator) == ("河源", "电信")

    @pytest.mark.asyncio
    async def test_batch_apply_rejects_mixed_groups(self, tm):
        tm.get_task_result = Mock(return_value=COMPLETED)
        groups = {
            "plan-1": ("河源", "电信"),
            "plan-2": ("河源", "联通"),
        }
        tm.get_task_group = Mock(side_effect=lambda tid: groups[tid])

        with pytest.raises(ValueError, match="数据组不一致"):
            await tm.create_apply_tac_planning_batch_task(["plan-1", "plan-2"])


class TestZeroHitGuard:
    """SQL 实际 0 命中时必须失败，禁止返回 success=True 假成功。"""

    PLANNING_RESULT = {
        "networkType": "LTE",
        "results": [
            {
                "siteId": "siteA",
                "sectors": [
                    {"sectorId": "1", "newPCI": 100},
                ],
            }
        ],
    }

    def _fake_session(self):
        session = Mock()
        # Site 行存在 → all_updates 非空，但 UPDATE 命中 0 行
        session.query.return_value.filter.return_value.all.return_value = [
            Mock(site_id="siteA", id=1)
        ]
        session.query.return_value.filter.return_value.update.return_value = 1
        session.execute.return_value = Mock(rowcount=0)
        session.commit = Mock()
        session.close = Mock()
        return session

    def test_pci_zero_hit_raises(self):
        tm = TaskManager()
        session = self._fake_session()
        with patch.object(tm, "_find_full_params_item",
                          return_value=Mock(id="wb1")), \
             patch("app.core.database.SessionLocal",
                   return_value=session):
            with pytest.raises(ValueError, match="0个小区更新"):
                tm._apply_pci_fast_sqlite_only(
                    self.PLANNING_RESULT, [35], logging.getLogger("test")
                )

    def test_tac_zero_hit_raises(self):
        tm = TaskManager()
        session = self._fake_session()
        planning_result = {
            "results": [
                {"matched": True, "siteId": "siteA",
                 "sectorId": "1", "tac": 33811}
            ]
        }
        with patch.object(tm, "_find_full_params_item",
                          return_value=Mock(id="wb1")), \
             patch("app.core.database.SessionLocal",
                   return_value=session):
            with pytest.raises(ValueError, match="0个小区更新"):
                tm._sync_apply_tac_planning_fast(
                    planning_result, [35], logging.getLogger("test")
                )
