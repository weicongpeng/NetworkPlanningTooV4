"""细粒度权限校验测试（直接调用依赖函数，无需 HTTP）"""
import pytest
from fastapi import HTTPException

from app.core.security import (
    require_data_import,
    require_data_delete,
    require_data_update,
    require_cell_entry,
    require_cell_query_update,
    require_assistant,
)


class FakeUser:
    def __init__(self, is_admin=False, can_data_import=False, can_data_delete=False,
                 can_data_update=False, can_cell_entry=False, can_cell_query_update=False,
                 can_assistant=False):
        self.is_admin = is_admin
        self.can_data_import = can_data_import
        self.can_data_delete = can_data_delete
        self.can_data_update = can_data_update
        self.can_cell_entry = can_cell_entry
        self.can_cell_query_update = can_cell_query_update
        self.can_assistant = can_assistant


@pytest.mark.asyncio
@pytest.mark.parametrize("checker", [
    require_data_import,
    require_data_delete,
    require_data_update,
    require_cell_entry,
    require_cell_query_update,
    require_assistant,
])
async def test_admin_bypasses_permissions(checker):
    """管理员调用任意权限校验均应通过"""
    result = await checker(current_user=FakeUser(is_admin=True))
    assert result.is_admin is True


@pytest.mark.asyncio
async def test_normal_user_without_import_permission_denied():
    """普通用户无数据导入权限时被拒绝"""
    with pytest.raises(HTTPException) as exc:
        await require_data_import(current_user=FakeUser())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_normal_user_with_import_permission_allowed():
    """普通用户有数据导入权限时通过"""
    user = FakeUser(can_data_import=True)
    result = await require_data_import(current_user=user)
    assert result is user


@pytest.mark.asyncio
@pytest.mark.parametrize("attr,checker", [
    ("can_data_delete", require_data_delete),
    ("can_data_update", require_data_update),
    ("can_cell_entry", require_cell_entry),
    ("can_cell_query_update", require_cell_query_update),
    ("can_assistant", require_assistant),
])
async def test_each_permission_required(attr, checker):
    """每项权限：无权限拒绝 403，有权限通过"""
    denied_user = FakeUser()
    with pytest.raises(HTTPException) as exc:
        await checker(current_user=denied_user)
    assert exc.value.status_code == 403

    allowed_user = FakeUser(**{attr: True})
    result = await checker(current_user=allowed_user)
    assert result is allowed_user
