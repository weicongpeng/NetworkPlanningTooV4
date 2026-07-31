# APP 用户管理功能设计文档

**日期**: 2026-06-20  
**状态**: 已批准  
**负责人**: @weicongpeng  

---

## 1. 背景与目标

手机端 APP 已能正常使用（通过同一套 JWT API 认证），但管理后台缺乏对 APP 用户的管理能力。需要在现有用户管理页面内增加"APP 用户管理"页面，用于管理手机 APP 用户数据、权限、状态、登录 IP 等功能。

### 核心目标

- 在现有 `users` 表上通过 `user_type` 字段区分 PC/APP 用户
- 新建 APP 用户管理前端页面，提供列表、启用/禁用、登录历史查看、密码重置、删除等基础管理功能
- 手机端不需要改造，继续使用原有 `/api/v1/auth/login` 认证

---

## 2. 方案选型

采用 **方案一：同一张表 + 类型过滤 + 独立前端页面**

| 维度 | 选择理由 |
|------|----------|
| 数据模型 | 同一张 `users` 表，`user_type` 字段区分 |
| 后端 API | 复用 `admin_users.py`，增加 `user_type` 过滤参数 |
| 前端 | 新增独立页面 `/admin/app-users`，复用 AdminUsersPage 的 UI 模式 |
| 权限模型 | 仅启用/禁用控制，无需细分角色 |

---

## 3. 数据库设计

### User 表新增字段

```python
user_type = Column(String(10), default='pc', nullable=False)  # 'pc' | 'app'
```

### 迁移 SQL

```sql
ALTER TABLE users ADD COLUMN user_type VARCHAR(10) NOT NULL DEFAULT 'pc';
```

### 影响范围

- 现有 PC 用户自动获得 `user_type='pc'`，无需迁移数据
- `to_dict()` 返回值新增 `user_type` 字段
- 前端 `UserInfo` 类型新增 `user_type: 'pc' | 'app'`

---

## 4. 后端 API 设计

### 现有端点改造 (`/api/v1/admin/users/`)

| 端点 | 方法 | 改动 |
|------|------|------|
| `GET /` | 列表 | 新增 `user_type` 查询参数（可选），默认不限制 |
| `POST /` | 创建 | 新增 `user_type` 字段，APP 用户强制 `is_admin=False` |
| `GET /{id}` | 详情 | 不变（含会话历史） |
| `PUT /{id}` | 更新 | 不变 |
| `DELETE /{id}` | 删除 | 不变 |
| `POST /{id}/reset-password` | 重置密码 | 不变 |

### AuthService 变更

- `get_all_users()` 新增 `user_type` 过滤参数
- `create_user()` 新增 `user_type` 参数
- `update_user()` 允许更新的字段列表新增 `user_type`

### 前端 API

```typescript
adminUserApi.listAppUsers(page, pageSize, search)
adminUserApi.createAppUser(data)
```

---

## 5. 前端 UI 设计

### 路由

```
/admin/users       → PC用户管理 (AdminUsersPage)
/admin/app-users   → APP用户管理 (AppUsersPage)  <-- 新增
```

### 侧边栏

"用户管理"从单个链接改为分组结构：
```
▸ 用户管理
    PC用户
    APP用户
```

### AppUsersPage 页面

- **列**: 用户名、状态（在线/离线图标）、IP 地址、注册时间、最后登录时间、操作
- **操作**: 切换启用/禁用、重置密码、查看登录历史（弹窗）、删除
- **顶部**: 搜索框 + 刷新 + 添加 APP 用户按钮
- **统计摘要**: 总用户数、在线用户数

### 差异点

| 功能 | PC 用户管理 | APP 用户管理 |
|------|------------|-------------|
| 创建用户 | 可设管理员、许可证、地市、运营商 | 仅有用户名+密码 |
| 角色列 | 管理员/普通用户徽标 | 不展示（均为普通用户） |
| 会话查看 | 不常用 | 可直接弹窗查看登录历史/IP |

---

## 6. 错误处理与边界情况

- **迁移**: `user_type` 列默认 `'pc'`，历史数据无需改动
- **兼容**: 手机端继续使用同一 `/auth/login`，注册时自动标记 `user_type='app'`
- **安全**: 创建 APP 用户时强制 `is_admin=False`，无管理员权限风险
- **空状态**: 无 APP 用户时显示"暂无 APP 用户"
- **禁用时**: 手机端下次 API 请求被 `get_current_user` 中 `is_active` 校验拦截

---

## 7. 实施计划

### Stage 1: 数据库迁移 + 模型更新
- `database.py`: 添加 `user_type` 列迁移 SQL
- `models/database.py`: User 类新增 `user_type` 字段
- `shared/types.ts`: `UserInfo` 新增 `user_type` 类型

### Stage 2: AuthService 改造
- `services/auth_service.py`: `get_all_users`/`create_user`/`update_user` 新增 `user_type` 支持

### Stage 3: API 端点改造
- `api/v1/endpoints/admin_users.py`: 列表接口新增 `user_type` 参数，创建接口新增 `user_type` 字段

### Stage 4: 前端基础设施
- 翻译文件 `zh.json`/`en.json` 新增 APP 用户相关 key
- `services/api.ts` 新增 `listAppUsers`/`createAppUser` 方法

### Stage 5: AppUsersPage 页面组件
- 新增 `pages/AppUsersPage.tsx`，复用 AdminUsersPage 的 UI 模式

### Stage 6: 路由与导航
- `App.tsx` 新增 `/admin/app-users` 路由
- `MainLayout.tsx` 侧边栏改为分组结构
