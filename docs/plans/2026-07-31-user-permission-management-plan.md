# 用户细粒度权限管理 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为普通用户 PC 端数据管理页面增加 4 项细粒度权限（数据导入、数据删除、工参更新、新站录入），管理员在用户管理页面"编辑"弹窗中配置开关。默认全部关闭，无权限时按钮禁用置灰，前后端双重校验。

**Architecture:** 方案 A —— `User` 表新增 4 个布尔列（`can_data_import`/`can_data_delete`/`can_data_update`/`can_cell_entry`），沿用项目现有 `ALTER TABLE` 迁移模式。后端用 `require_permission(perm)` 依赖工厂校验（管理员自动绕过），前端在 DataPage 读取权限字段禁用对应操作点，管理员在 AdminUsersPage 编辑弹窗配置。权限变更"登录缓存 + 打开数据页时重拉 getMe"生效。

**Tech Stack:** FastAPI + SQLAlchemy + SQLite（后端）、React 18 + TypeScript + Zustand + Tailwind（前端）、pytest（后端测试）。

---

## 变更文件总览

| 文件 | 动作 | 说明 |
|------|------|------|
| `backend/app/models/database.py` | 修改 | User 模型加 4 列 + `to_dict()` 输出 |
| `backend/app/core/database.py` | 修改 | `init_db()` 迁移加 4 条 ALTER |
| `backend/app/models/schemas.py` | 修改 | `UserResponse`/`UserUpdate` 加 4 字段 |
| `backend/app/core/security.py` | 修改 | 新增 `require_permission` 工厂 + 4 个依赖 |
| `backend/app/api/v1/endpoints/data.py` | 修改 | 受控端点挂权限依赖（含新增依赖的端点） |
| `backend/app/services/auth_service.py` | 修改 | `update_user` 的 `allowed_fields` 加 4 字段 |
| `backend/tests/test_user_permissions.py` | 创建 | 权限校验 pytest |
| `shared/types.ts` | 修改 | `UserInfo` + `UserUpdateRequest` 加 4 字段 |
| `frontend/src/renderer/pages/AdminUsersPage.tsx` | 修改 | 编辑弹窗加 4 个权限开关 |
| `frontend/src/renderer/pages/DataPage.tsx` | 修改 | 4 个操作点禁用置灰 |
| `frontend/src/renderer/locales/zh.json` | 修改 | 权限文案 |
| `frontend/src/renderer/locales/en.json` | 修改 | 权限文案 |

---

## 后端任务

### Task 1: User 模型加 4 个权限列

**Files:**
- Modify: `backend/app/models/database.py`（User 类，约 31-66 行）
- Modify: `backend/app/core/database.py`（init_db 迁移列表，58-69 行）

**Step 1: 在 User 模型加 4 列**

在 `backend/app/models/database.py` 的 User 类中，`user_type` 列（47 行）之后、`sessions` 关系之前添加：

```python
    # 细粒度权限（PC 端数据管理页面操作权限，默认全部关闭，管理员自动拥有全部权限）
    can_data_import = Column(Boolean, default=False, nullable=False)
    can_data_delete = Column(Boolean, default=False, nullable=False)
    can_data_update = Column(Boolean, default=False, nullable=False)
    can_cell_entry = Column(Boolean, default=False, nullable=False)
```

**Step 2: 在 `to_dict()` 输出 4 个字段**

在 `to_dict()` 的 `"user_type": self.user_type` 后添加：

```python
            "can_data_import": self.can_data_import,
            "can_data_delete": self.can_data_delete,
            "can_data_update": self.can_data_update,
            "can_cell_entry": self.can_cell_entry,
```

**Step 3: 在 `init_db()` 迁移列表加 4 条 ALTER**

在 `backend/app/core/database.py` 的 `migrations` 列表（58-64 行）末尾追加：

```python
            ("can_data_import", "ALTER TABLE users ADD COLUMN can_data_import BOOLEAN NOT NULL DEFAULT 0"),
            ("can_data_delete", "ALTER TABLE users ADD COLUMN can_data_delete BOOLEAN NOT NULL DEFAULT 0"),
            ("can_data_update", "ALTER TABLE users ADD COLUMN can_data_update BOOLEAN NOT NULL DEFAULT 0"),
            ("can_cell_entry", "ALTER TABLE users ADD COLUMN can_cell_entry BOOLEAN NOT NULL DEFAULT 0"),
```

> 该迁移循环会自动检测列是否存在，仅对旧库执行 ALTER。SQLite 中 `BOOLEAN NOT NULL DEFAULT 0` 表示默认 `False`。

**Step 4: 验证**

Run: `cd backend && python -c "from app.core.database import init_db; init_db(); from app.models.database import User; print([c.name for c in User.__table__.columns])"`
Expected: 输出包含 `can_data_import`、`can_data_delete`、`can_data_update`、`can_cell_entry`

**Step 5: Commit**

```bash
git add backend/app/models/database.py backend/app/core/database.py
git commit -m "feat: User 模型新增 4 个数据管理权限字段"
```

---

### Task 2: Schema 增加权限字段

**Files:**
- Modify: `backend/app/models/schemas.py`（`UserResponse` 639-654 行、`UserUpdate` 665-673 行）

**Step 1: `UserResponse` 加 4 个字段**

在 `UserResponse` 的 `operator: Optional[str] = None` 之后添加：

```python
    can_data_import: bool = False
    can_data_delete: bool = False
    can_data_update: bool = False
    can_cell_entry: bool = False
```

**Step 2: `UserUpdate` 加 4 个可选字段**

在 `UserUpdate` 的 `operator: Optional[str] = None` 之后添加：

```python
    can_data_import: Optional[bool] = None
    can_data_delete: Optional[bool] = None
    can_data_update: Optional[bool] = None
    can_cell_entry: Optional[bool] = None
```

**Step 3: `auth_service.update_user` 的 allowed_fields 加 4 字段**

在 `backend/app/services/auth_service.py` 的 `update_user` 方法（132 行）中修改：

```python
        allowed_fields = {"is_active", "is_admin", "license_expiry", "must_change_password", "total_usage_seconds", "city", "operator",
                          "can_data_import", "can_data_delete", "can_data_update", "can_cell_entry"}
```

**Step 4: 验证**

Run: `cd backend && python -c "from app.models.schemas import UserResponse, UserUpdate; u=UserUpdate(can_data_import=True); assert u.can_data_import is True; print('ok')"`
Expected: `ok`

**Step 5: Commit**

```bash
git add backend/app/models/schemas.py backend/app/services/auth_service.py
git commit -m "feat: 用户 Schema 与更新服务支持权限字段"
```

---

### Task 3: 后端权限依赖工厂

**Files:**
- Modify: `backend/app/core/security.py`（`get_current_admin_user` 之后，80 行处）

**Step 1: 添加 `require_permission` 工厂和 4 个依赖**

在 `backend/app/core/security.py` 末尾（`get_current_admin_user` 函数之后）添加：

```python
def require_permission(perm: str):
    """权限校验依赖工厂：管理员自动通过，普通用户需对应权限位为 True"""
    async def checker(current_user=Depends(get_current_user)):
        if current_user.is_admin:
            return current_user
        if not getattr(current_user, perm, False):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="无此操作权限，请联系管理员",
            )
        return current_user
    return checker


require_data_import = require_permission("can_data_import")
require_data_delete = require_permission("can_data_delete")
require_data_update = require_permission("can_data_update")
require_cell_entry = require_permission("can_cell_entry")
```

**Step 2: 验证**

Run: `cd backend && python -c "from app.core.security import require_data_import, require_data_delete, require_data_update, require_cell_entry; print('ok')"`
Expected: `ok`

**Step 3: Commit**

```bash
git add backend/app/core/security.py
git commit -m "feat: 新增数据管理权限校验依赖"
```

---

### Task 4: 受控端点挂载权限依赖

**Files:**
- Modify: `backend/app/api/v1/endpoints/data.py`

**Step 1: 更新 import**

将 26 行的 `from app.core.security import get_current_user` 改为：

```python
from app.core.security import get_current_user, require_data_import, require_data_delete, require_data_update, require_cell_entry
```

**Step 2: 新站录入端点（3 处）**

- `add_cell`（165 行）：`current_user=Depends(get_current_user)` → `current_user=Depends(require_cell_entry)`
- `batch_add_cells`（201 行）：同上 → `Depends(require_cell_entry)`
- `check_cell_duplicates`（257 行）：此端点**当前无依赖**，添加 `current_user=Depends(require_cell_entry)`：

```python
async def check_cell_duplicates(
    request: CellBatchCreateRequest,
    current_user=Depends(require_cell_entry),
) -> Dict[str, Any]:
```

> 注意：`check_cell_duplicates` 和分片上传端点原本没有 `current_user` 参数，挂上依赖后参数会自动注入，不影响调用方。

**Step 3: 工参更新端点**

`update_parameters`（278 行）：`current_user=Depends(get_current_user)` → `current_user=Depends(require_data_update)`

**Step 4: 数据导入端点（4 处）**

- `upload_excel`（353 行）：→ `Depends(require_data_import)`
- `start_chunked_upload`（924 行）：**当前无依赖**，添加 `current_user=Depends(require_data_import)`：

```python
async def start_chunked_upload(
    filename: str = Form(...),
    total_chunks: int = Form(...),
    total_size: int = Form(...),
    current_user=Depends(require_data_import),
) -> Dict[str, Any]:
```

- `upload_chunk`（962 行）：**当前无依赖**，添加 `current_user=Depends(require_data_import)`
- `complete_chunked_upload`（986 行）：**当前无依赖**，添加 `current_user=Depends(require_data_import)`

**Step 5: 数据删除端点**

`delete_data`（497 行）：**当前无依赖**，添加 `current_user=Depends(require_data_delete)`：

```python
@router.delete("/{data_id}", response_model=Dict[str, Any])
async def delete_data(data_id: str, force: bool = False, current_user=Depends(require_data_delete)) -> Dict[str, Any]:
```

**Step 6: 验证**

Run: `cd backend && python -c "from app.api.v1.endpoints import data; print('routes:', [getattr(r, 'path', '') for r in data.router.routes])"`
Expected: 无报错，打印路由列表

**Step 7: Commit**

```bash
git add backend/app/api/v1/endpoints/data.py
git commit -m "feat: 数据管理受控端点挂载权限校验依赖"
```

---

### Task 5: 后端权限 pytest

**Files:**
- Create: `backend/tests/test_user_permissions.py`

**Step 1: 创建测试文件**

参照 `backend/tests/test_sqlite_storage.py` 的测试风格，创建 `backend/tests/test_user_permissions.py`：

```python
"""细粒度权限校验测试（直接调用依赖函数，无需 HTTP）"""
import pytest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException

from app.core.security import (
    require_data_import, require_data_delete, require_data_update, require_cell_entry,
)


class FakeUser:
    def __init__(self, is_admin=False, can_data_import=False, can_data_delete=False,
                 can_data_update=False, can_cell_entry=False):
        self.is_admin = is_admin
        self.can_data_import = can_data_import
        self.can_data_delete = can_data_delete
        self.can_data_update = can_data_update
        self.can_cell_entry = can_cell_entry


async def _call(checker, user):
    """模拟 FastAPI 注入调用依赖"""
    checker_fn = checker.__closure__[0].cell_contents if checker.__closure__ else None
    # 直接调用工厂返回的 checker（内部通过 Depends(get_current_user) 获取用户，这里 patch 掉）
    with patch("app.core.security.get_current_user", new=AsyncMock(return_value=user)):
        return await checker(user=user)


@pytest.mark.asyncio
@pytest.mark.parametrize("checker", [require_data_import, require_data_delete, require_data_update, require_cell_entry])
async def test_admin_bypasses_permissions(checker):
    """管理员调用任意权限校验均应通过"""
    result = await _call(checker, FakeUser(is_admin=True))
    assert result.is_admin is True


@pytest.mark.asyncio
async def test_normal_user_without_import_permission_denied():
    """普通用户无数据导入权限时被拒绝"""
    with pytest.raises(HTTPException) as exc:
        await _call(require_data_import, FakeUser())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_normal_user_with_import_permission_allowed():
    """普通用户有数据导入权限时通过"""
    user = FakeUser(can_data_import=True)
    result = await _call(require_data_import, user)
    assert result is user


@pytest.mark.asyncio
@pytest.mark.parametrize("attr,checker", [
    ("can_data_delete", require_data_delete),
    ("can_data_update", require_data_update),
    ("can_cell_entry", require_cell_entry),
])
async def test_each_permission_required(attr, checker):
    """每项权限：无权限拒绝 403，有权限通过"""
    denied_user = FakeUser()
    with pytest.raises(HTTPException) as exc:
        await _call(checker, denied_user)
    assert exc.value.status_code == 403

    allowed_user = FakeUser(**{attr: True})
    result = await _call(checker, allowed_user)
    assert result is allowed_user
```

**Step 2: 运行测试**

Run: `cd backend && python -m pytest tests/test_user_permissions.py -v`
Expected: 所有用例 PASS（若 pytest-asyncio 未安装，需先 `pip install pytest-asyncio`）

**Step 3: 修复测试问题直到通过**

> 如果 `require_permission` 的闭包实现导致测试 patch 不生效，可改为在 checker 内部直接注入：`checker(current_user=user)` 方式——即测试改为直接构造依赖调用。以实际运行结果为准，保证 403/200 逻辑被覆盖即可。

**Step 4: Commit**

```bash
git add backend/tests/test_user_permissions.py
git commit -m "test: 细粒度权限校验 pytest"
```

---

## 前端任务

### Task 6: 共享类型增加权限字段

**Files:**
- Modify: `shared/types.ts`（`UserInfo` 345 行、`UserUpdateRequest` 395 行）

**Step 1: `UserInfo` 加 4 个可选字段**

在 `UserInfo` 的 `user_type?: 'pc' | 'app'` 之后添加：

```typescript
  can_data_import?: boolean
  can_data_delete?: boolean
  can_data_update?: boolean
  can_cell_entry?: boolean
```

**Step 2: `UserUpdateRequest` 加 4 个可选字段**

在 `UserUpdateRequest` 的 `operator?: string | null` 之后添加：

```typescript
  can_data_import?: boolean
  can_data_delete?: boolean
  can_data_update?: boolean
  can_cell_entry?: boolean
```

**Step 3: 验证**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无 TS 错误

**Step 4: Commit**

```bash
git add shared/types.ts
git commit -m "feat: 共享类型增加用户权限字段"
```

---

### Task 7: 管理员编辑弹窗增加权限开关

**Files:**
- Modify: `frontend/src/renderer/pages/AdminUsersPage.tsx`

**Step 1: 添加表单状态**

在 form state 区域（55-61 行）添加 4 个状态：

```typescript
  const [formCanDataImport, setFormCanDataImport] = useState(false)
  const [formCanDataDelete, setFormCanDataDelete] = useState(false)
  const [formCanDataUpdate, setFormCanDataUpdate] = useState(false)
  const [formCanCellEntry, setFormCanCellEntry] = useState(false)
```

**Step 2: `openEdit` 初始化状态**

在 `openEdit`（112-121 行）中添加：

```typescript
    setFormCanDataImport(!!user.can_data_import)
    setFormCanDataDelete(!!user.can_data_delete)
    setFormCanDataUpdate(!!user.can_data_update)
    setFormCanCellEntry(!!user.can_cell_entry)
```

**Step 3: `handleEdit` 提交 4 个字段**

在 `handleEdit` 的 updateUser 调用（128-134 行）中，payload 对象添加：

```typescript
        can_data_import: formCanDataImport,
        can_data_delete: formCanDataDelete,
        can_data_update: formCanDataUpdate,
        can_cell_entry: formCanCellEntry,
```

**Step 4: `resetForm` 重置状态**

在 `resetForm`（211-222 行）中添加：

```typescript
    setFormCanDataImport(false)
    setFormCanDataDelete(false)
    setFormCanDataUpdate(false)
    setFormCanCellEntry(false)
```

**Step 5: 编辑弹窗 UI 添加"PC 端数据权限"分组**

在编辑弹窗中，"APP权限"提示块（501-507 行）之后、地市输入框之前插入：

```tsx
            <div className="p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-sm text-blue-400 mb-2">
                <span>🖥️ {t('admin.pcDataPermissions', 'PC端数据权限')}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{t('admin.permissionsApplyToDataPage', '控制该用户在数据管理页面的操作权限')}</p>
              {editUser?.is_admin && (
                <p className="text-xs text-amber-500 mb-2">{t('admin.adminNotRestricted', '管理员不受此限制，开关不生效')}</p>
              )}
              <div className="space-y-1.5">
                {[
                  { key: 'can_data_import', label: t('admin.permDataImport', '数据导入'), value: formCanDataImport, setter: setFormCanDataImport },
                  { key: 'can_data_delete', label: t('admin.permDataDelete', '数据删除'), value: formCanDataDelete, setter: setFormCanDataDelete },
                  { key: 'can_data_update', label: t('admin.permDataUpdate', '工参更新'), value: formCanDataUpdate, setter: setFormCanDataUpdate },
                  { key: 'can_cell_entry', label: t('admin.permCellEntry', '新站录入'), value: formCanCellEntry, setter: setFormCanCellEntry },
                ].map((p) => (
                  <label key={p.key} className={`flex items-center gap-2 cursor-pointer ${editUser?.is_admin ? 'opacity-50 pointer-events-none' : ''}`}>
                    <input
                      type="checkbox"
                      checked={p.value}
                      onChange={(e) => p.setter(e.target.checked)}
                      disabled={!!editUser?.is_admin}
                      className="rounded"
                    />
                    <span className="text-sm text-foreground">{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
```

**Step 6: 验证**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无 TS 错误

**Step 7: Commit**

```bash
git add frontend/src/renderer/pages/AdminUsersPage.tsx
git commit -m "feat: 用户编辑弹窗增加 PC 端数据权限开关"
```

---

### Task 8: DataPage 权限禁用

**Files:**
- Modify: `frontend/src/renderer/pages/DataPage.tsx`

**Step 1: 引入 authStore 和权限计算**

在文件顶部 import 区域（1-10 行）添加：

```typescript
import { useAuthStore } from '../store/authStore'
```

在 `DataPage` 组件内（`useTranslation` 之后，12-13 行）添加：

```typescript
  // 细粒度权限：管理员自动拥有全部权限
  const currentUser = useAuthStore((s) => s.user)
  const isAdmin = !!currentUser?.is_admin
  const permImport = isAdmin || !!currentUser?.can_data_import
  const permDelete = isAdmin || !!currentUser?.can_data_delete
  const permUpdate = isAdmin || !!currentUser?.can_data_update
  const permCellEntry = isAdmin || !!currentUser?.can_cell_entry
```

> 权限"准实时"感知：组件挂载时通过 `useAuthStore.fetchUser()` 刷新用户信息。在 `DataPage` 已有 `useEffect` 中追加：

```typescript
  // 打开数据页时刷新用户权限（感知管理员的最新权限配置）
  useEffect(() => {
    useAuthStore.getState().fetchUser()
  }, [])
```

**Step 2: 禁用"导入数据"区域（约 718 行）**

在导入区域容器 `<div className="bg-card p-3 rounded-lg border border-border">` 后、`<h2>` 前加条件：

```tsx
            {!permImport && (
              <p className="text-xs text-muted-foreground mb-2 bg-muted/40 px-2 py-1 rounded">
                {t('data.noPermission', '无权限，请联系管理员')}
              </p>
            )}
```

将导入区域的 `UploadArea` 的 `onUpload` 改为无权限时不触发，并给 3 个 `UploadArea` 包裹容器加禁用态。最小改动方式：给容器 div 加条件 class 和 pointer-events：

```tsx
            <div className={`space-y-2 ${permImport ? '' : 'opacity-50 pointer-events-none'}`}>
```

> 具体方式：找到导入区域最外层的 `<div className="space-y-2">`（约 721 行）改为带条件 class。拖拽/点击事件被 `pointer-events-none` 阻断。

**Step 3: 禁用"工参更新"区域（809 行）**

工参更新容器 `<div className="bg-card p-3 rounded-lg border border-border -mt-6">` 加条件 class：

```tsx
            <div className={`bg-card p-3 rounded-lg border border-border -mt-6 ${permUpdate ? '' : 'opacity-50 pointer-events-none'}`}>
```

并在 `<h2>` 下、`<div className="flex items-end gap-2">` 前加无权限提示（同 Step 2 的 `data.noPermission`）。

**Step 4: 禁用"新站录入"区域（849 行起）**

新站录入容器（849 行）加条件 class + 无权限提示。在 `renderCardContent` 的标题行（1646-1655 行）下、`hasFullParams` 检查前加：

```tsx
      {!permCellEntry && (
        <div className="px-3 py-2 bg-muted/40 border border-border rounded-lg text-xs text-muted-foreground mb-3">
          {t('data.noPermission', '无权限，请联系管理员')}
        </div>
      )}
```

新站录入容器外层 div 加 `opacity-50 pointer-events-none`（当 `!permCellEntry`）。

> 注意：`renderCardContent` 中需通过闭包访问 `permCellEntry`（该函数在组件作用域内定义，可直接引用）。

**Step 5: 禁用"删除"按钮（单条 + 批量）**

- 单条删除按钮（1097-1108 行）：`disabled` 条件追加 `!permDelete`，class 追加 `!permDelete ? 'text-red-500/30 cursor-not-allowed'`：

```tsx
                    <button
                      onClick={(e) => {
                        if (!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)) return
                        e.stopPropagation()
                        handleDelete(item)
                      }}
                      className={`p-2 rounded ${!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? 'text-red-500/30 cursor-not-allowed' : 'hover:bg-background text-red-500'}`}
                      disabled={!permDelete || loading || item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined)}
                      title={!permDelete ? (t('data.noPermission', '无权限，请联系管理员')) : (loading ? (t('data.loading') || '加载中...') : (item.excelSynced === false || (item.inplaceUpdated && item.excelSynced === undefined) ? (t('data.syncingDisabled') || '同步中不可删除') : (t('data.delete') || '删除')))}
                    >
```

- 批量删除按钮（874 行）：`handleBatchDelete` 内部开头加 `if (!permDelete) return`，按钮 `onClick` 前加无权限守卫：

```tsx
                    onClick={() => { if (!permDelete) return; handleBatchDelete() }}
```

**Step 6: 验证**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 无 TS 错误、无 lint 报错

**Step 7: Commit**

```bash
git add frontend/src/renderer/pages/DataPage.tsx
git commit -m "feat: 数据管理页面按用户权限禁用操作"
```

---

### Task 9: 多语言文案

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**Step 1: zh.json 添加文案**

在 `admin` 和 `data` 区块分别添加：

```json
  "admin.pcDataPermissions": "PC端数据权限",
  "admin.permissionsApplyToDataPage": "控制该用户在数据管理页面的操作权限",
  "admin.adminNotRestricted": "管理员不受此限制，开关不生效",
  "admin.permDataImport": "数据导入",
  "admin.permDataDelete": "数据删除",
  "admin.permDataUpdate": "工参更新",
  "admin.permCellEntry": "新站录入",
  "data.noPermission": "无权限，请联系管理员"
```

> 注意：`zh.json`/`en.json` 中的 key 按现有结构嵌套组织（如 `"admin": { "pcDataPermissions": ... }`），需按文件实际的嵌套层级插入，非扁平 key。

**Step 2: en.json 添加对应英文**

```json
  "admin.pcDataPermissions": "PC Data Permissions",
  "admin.permissionsApplyToDataPage": "Controls this user's operation permissions on the Data Management page",
  "admin.adminNotRestricted": "Admins are not restricted by these toggles",
  "admin.permDataImport": "Import Data",
  "admin.permDataDelete": "Delete Data",
  "admin.permDataUpdate": "Update Parameters",
  "admin.permCellEntry": "New Cell Entry",
  "data.noPermission": "No permission, please contact administrator"
```

**Step 3: 验证 JSON 有效性**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/renderer/locales/zh.json')); JSON.parse(require('fs').readFileSync('src/renderer/locales/en.json')); console.log('ok')"`
Expected: `ok`

**Step 4: Commit**

```bash
git add frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json
git commit -m "feat: 权限管理多语言文案"
```

---

## 验证清单（全部完成）

- [ ] `cd backend && python -c "from app.core.database import init_db; init_db()"` 迁移成功，users 表含 4 个新列
- [ ] `cd backend && python -m pytest tests/test_user_permissions.py -v` 全 PASS
- [ ] `cd frontend && npx tsc --noEmit` 无错误
- [ ] `cd frontend && npm run lint` 无报错
- [ ] 手动验证：管理员在编辑弹窗关闭某用户"数据导入"→ 该用户打开数据页，导入区域置灰不可点击
- [ ] 手动验证：普通用户直接调 `POST /data/upload/excel`（无权限）→ 返回 403
- [ ] 手动验证：管理员调 `POST /data/upload/excel` → 正常（绕过校验）
