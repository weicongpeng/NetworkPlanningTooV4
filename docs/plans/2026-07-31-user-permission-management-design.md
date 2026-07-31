# 用户细粒度权限管理设计

**日期**: 2026-07-31
**状态**: 已批准
**目标**: 为普通用户在 PC 端数据管理页面增加细粒度权限控制，管理员可在用户管理页面"操作"列的"编辑"弹窗中为每个用户配置数据导入、数据删除、工参更新、新站录入 4 项权限开关。

## 需求概述

1. 对**非管理员用户**在 PC 端添加权限管理
2. 设置入口：用户管理页面"操作"列的"编辑"按钮
3. 点击编辑按钮后弹窗提供针对该用户的权限开关
4. 可选权限（数据管理页面）：**数据导入、数据删除、工参更新、新站录入**
5. **除此之外的其他操作不限制**（只读操作如列表/预览/下载等不受影响）

## 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| 权限默认状态 | **默认全部关闭**（新用户和存量用户均默认无权限，管理员手动开启） |
| 无权限时界面呈现 | **禁用置灰**（按钮/区域可见但不可点击，提示"无权限"） |
| 校验层级 | **前后端双重校验**（前端置灰 + 后端 API 返回 403） |
| 权限变更生效机制 | **登录缓存 + 页面刷新**（后端实时查 DB，前端登录缓存 + 打开数据页时重拉） |
| 权限存储方案 | **方案 A：4 个独立布尔字段**（User 表加 4 列） |

## 架构设计

### 1. 权限模型与存储

**User 模型**（`backend/app/models/database.py`）新增 4 个布尔列，默认 `False`：

| 字段 | 对应数据页操作 | 相关 API 端点 |
|------|--------------|--------------|
| `can_data_import` | 数据导入 | `POST /data/upload/excel`、`POST /data/upload/start`、`POST /data/upload/{id}/chunk`、`POST /data/upload/{id}/complete` |
| `can_data_delete` | 数据删除 | `DELETE /data/{id}`（含 force）、前端批量删除 |
| `can_data_update` | 工参更新 | `POST /data/update-parameters` |
| `can_cell_entry` | 新站录入 | `POST /data/full-params/cells`、`POST /data/full-params/cells/batch`、`POST /data/full-params/cells/check-duplicates` |

**迁移**（`backend/app/core/database.py` 的 `init_db()`）：在现有 migrations 列表追加 4 条：

```sql
ALTER TABLE users ADD COLUMN can_data_import BOOLEAN NOT NULL DEFAULT 0
ALTER TABLE users ADD COLUMN can_data_delete BOOLEAN NOT NULL DEFAULT 0
ALTER TABLE users ADD COLUMN can_data_update BOOLEAN NOT NULL DEFAULT 0
ALTER TABLE users ADD COLUMN can_cell_entry BOOLEAN NOT NULL DEFAULT 0
```

（沿用项目现有 `ALTER TABLE` + `PRAGMA table_info` 检查的迁移模式。）

**Schema**（`backend/app/models/schemas.py`）：
- `UserResponse` 增加 4 个 `bool` 字段；`User.to_dict()` 同步输出
- `UserUpdate` 增加 4 个可选 `bool`（管理员编辑时提交）

### 2. 后端权限校验

**`backend/app/core/security.py`** 新增权限依赖工厂：

```python
def require_permission(perm: str):
    async def checker(current_user=Depends(get_current_user)):
        if current_user.is_admin:
            return current_user  # 管理员自动绕过细粒度校验
        if not getattr(current_user, perm, False):
            raise HTTPException(status_code=403, detail="无此操作权限，请联系管理员")
        return current_user
    return checker

require_data_import = require_permission("can_data_import")
require_data_delete = require_permission("can_data_delete")
require_data_update = require_permission("can_data_update")
require_cell_entry  = require_permission("can_cell_entry")
```

**挂载点**（`backend/app/api/v1/endpoints/data.py`）：受控端点将 `Depends(get_current_user)` 替换为对应权限依赖。

**只读端点不受影响**：`/list`、`/{id}`、`/{id}/preview`、`/{id}/download`、`/{id}/columns`、`/template`、`/cleanup/index` 等查询端点不挂权限。

### 3. 前端交互

**① 类型与状态**
- `shared/types.ts` 的 `UserInfo` 增加 4 个权限字段
- `authStore.user` 持久化于 localStorage（已含 `is_admin`），登录时缓存权限
- 数据管理页打开时重拉当前用户信息（调用 `getMe`），实现准实时感知权限变更

**② 管理员用户管理页 `AdminUsersPage.tsx`**
- 编辑弹窗新增"PC 端数据权限"分组，4 个开关：数据导入 / 数据删除 / 工参更新 / 新站录入
- 目标用户是**管理员**时，4 个开关置灰 + 提示"管理员不受此限制"（管理员自动绕过，开关不生效）
- 保存时随 `UserUpdate` 提交 4 个权限字段

**③ 数据管理页 `DataPage.tsx`** —— 4 个操作点按"禁用置灰"规则：

| 操作点 | 无权限时处理 |
|--------|-------------|
| 导入数据区域（上传按钮 + 拖拽区） | 置灰不可点击，提示"无权限，请联系管理员" |
| 删除按钮（单条、批量） | 置灰不可点击 |
| 工参更新区域（更新按钮） | 置灰不可点击 |
| 新站录入区域（录入表格 + 一键导入） | 整个区域禁用，按钮置灰 |

置灰统一用 Tailwind `disabled:opacity-50 disabled:cursor-not-allowed` + `title`/`aria-disabled` 提示。

**④ 多语言**：`zh.json` / `en.json` 同步新增权限相关文案 key。

### 4. 数据流

```
管理员在编辑弹窗改权限 → PUT /admin/users/{id}（含4个权限字段）
  → auth_service.update_user 写入4列
  → 目标用户下次打开数据管理页 → 前端重拉用户信息（getMe）→ 刷新权限缓存 → 界面即时更新
  → 若已停留在数据页 → 后端 403 兜底（前端拦截器统一提示）
```

**权限校验时序（前端 → 后端双保险）**
```
用户在数据页点击"导入" →
  ① 前端: 检查 can_data_import → 无则按钮已置灰（不可达）
  ② 若绕过前端（直接调 API）→ 后端 require_data_import → 403
  ③ 前端 Axios 拦截器捕获 403 → 弹出"无此操作权限，请联系管理员"
```

### 5. 错误处理

| 场景 | 处理 |
|------|------|
| 权限被中途收回，用户已在数据页操作 | 后端 403 → 前端全局提示"无此操作权限" |
| 管理员编辑弹窗保存失败 | 沿用现有 `formError` 展示逻辑 |
| 权限字段为 null（旧数据） | 后端读取时视为 `False`，前端 `Boolean()` 兜底 |
| 迁移时旧库无新列 | `init_db()` 的 `ALTER TABLE ... DEFAULT 0` 保证列存在 |

### 6. 测试

**后端**（pytest）：
- 非管理员无权限调受控端点 → 403
- 非管理员有权限调受控端点 → 200
- 管理员调受控端点 → 200（绕过校验）
- `PUT /admin/users/{id}` 更新 4 个权限字段生效

**前端**（type-check + lint）：
- `UserInfo` 类型同步，无 TS 错误
- 手动验证 4 个操作点置灰/启用逻辑

## 涉及文件清单

| 文件 | 改动 |
|------|------|
| `backend/app/models/database.py` | User 模型加 4 列；`to_dict()` 输出 |
| `backend/app/core/database.py` | `init_db()` 迁移加 4 条 ALTER |
| `backend/app/models/schemas.py` | `UserResponse`/`UserUpdate` 加 4 字段 |
| `backend/app/core/security.py` | 新增 `require_permission` 工厂 + 4 个依赖 |
| `backend/app/api/v1/endpoints/data.py` | 受控端点挂权限依赖 |
| `backend/app/services/auth_service.py` | `update_user` 的 allowed_fields 加 4 字段 |
| `shared/types.ts` | `UserInfo` 加 4 字段 |
| `frontend/src/renderer/pages/AdminUsersPage.tsx` | 编辑弹窗加 4 个开关 |
| `frontend/src/renderer/pages/DataPage.tsx` | 4 个操作点禁用置灰 |
| `frontend/src/renderer/locales/zh.json` / `en.json` | 权限文案 |
