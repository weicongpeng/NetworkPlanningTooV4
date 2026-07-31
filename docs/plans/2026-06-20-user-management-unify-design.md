# 用户管理整合与并发登录修复设计文档

**日期**: 2026-06-20  
**状态**: 已批准  

---

## 1. 背景

上一轮实现中引入了三个问题需要修复：

1. **手机 APP 和 PC 端同时登录相互排斥** — `end_other_ip_sessions()` 无差别踢出所有其他 IP 的会话
2. **PC/APP 用户区分不合理** — 新增的 `user_type` 字段将用户割裂为两类，但实际上手机端和 PC 端应共用同一账号
3. **用户管理页面分离** — `AdminUsersPage` 和 `AppUsersPage` 两个页面功能重复，需要整合

---

## 2. 方案设计

### 2.1 会话区分（解决并发登录）

**核心思路**：不在用户层面区分，而在会话层面区分。添加 `client_type` 字段标记会话来源。

#### UserSession 模型变更

```python
# user_sessions 表新增
client_type = Column(String(10), default='pc', nullable=False)  # 'pc' | 'app'
```

#### 登录请求变更

手机端登录请求体新增字段：
```json
POST /api/v1/auth/login
{
  "username": "xxx",
  "password": "xxx",
  "client_type": "app"
}
```

PC 端登录不传，默认 `client_type='pc'`。

#### 踢出逻辑调整

`end_other_ip_sessions()` 改为按 `client_type` 过滤，只踢同类型的旧会话：

| 场景 | 旧逻辑 | 新逻辑 |
|------|--------|--------|
| PC 端登录（IP 不同） | 踢所有其他 IP | 踢其他 PC 端会话，APP 会话保留 |
| APP 端登录（IP 不同） | 踢所有其他 IP | 不踢任何会话（同一账号多设备共存） |

#### IP 校验调整

`get_current_user` 中的 IP 校验只对 `client_type='pc'` 的会话执行，APP 会话跳过 IP 校验。

### 2.2 废弃 user_type 字段

**变更**：
- `User` 模型保留 `user_type` 字段（兼容已有数据），但不再用于业务逻辑
- 所有 API 端点移除 `user_type` 过滤
- 前端 `UserInfo` 类型保留 `user_type` 为可选字段
- 注册请求无需传 `user_type`，后端自动默认
- 所有用户默认拥有 PC 和 APP 使用权，`is_active` 统一控制

### 2.3 统一用户管理页面

**页面路径**：`/admin/users`（替换原有 AdminUsersPage）

**表格布局**：每个用户占两行

| 列 | 说明 |
|----|------|
| 用户名 | rowspan=2，公共 |
| 角色 | rowspan=2，公共 |
| 地市 | rowspan=2，公共 |
| 运营商 | rowspan=2，公共 |
| 许可证到期 | rowspan=2，公共 |
| 客户端 | PC / APP，区分行 |
| 状态 | 在线/离线，PC/APP 各自独立 |
| IP 地址 | PC/APP 各自显示各自的最后登录 IP |
| 注册时间 | rowspan=2，公共 |
| 最后登录 | PC/APP 各自显示各自的最后登录时间 |
| 使用时长 | PC/APP 各自累计各自的使用时长 |
| 操作 | rowspan=2，含编辑、重置密码、查看登录记录、删除 |

**编辑弹窗增强**：
- 保持原有编辑功能（角色、启用/禁用、地市、运营商、许可证）
- 新增"APP 权限"展示（由 `is_active` 统一控制）

**查看登录记录弹窗**：
- 从原 AppUsersPage 迁移过来
- 显示该用户的所有会话（PC + APP），按时间倒序
- 每条记录显示：登录时间、登出时间、IP 地址、客户端类型

---

## 3. 涉及的文件

### 后端
| 文件 | 变更 |
|------|------|
| `backend/app/models/database.py` | UserSession 新增 `client_type` 列，to_dict() 返回 |
| `backend/app/core/database.py` | 新增迁移 SQL |
| `backend/app/models/schemas.py` | UserLogin 新增 `client_type` 字段 |
| `backend/app/services/auth_service.py` | `end_other_ip_sessions` 改为同类型踢出；`record_session` 新增 `client_type`；`verify_session_ip` 跳过 app；`get_all_users` 移除 user_type |
| `backend/app/api/v1/endpoints/auth.py` | login 接收/透传 `client_type`，移除 `end_other_ip_sessions` 调用 |
| `backend/app/api/v1/endpoints/admin_users.py` | 移除 `user_type` 参数 |
| `backend/app/core/security.py` | IP 校验跳过 app 会话 |

### 前端
| 文件 | 变更 |
|------|------|
| `shared/types.ts` | UserSessionInfo 新增 `client_type`；LoginRequest 新增 `client_type` |
| `frontend/src/renderer/services/api.ts` | 移除 `listAppUsers`/`createAppUser`；adminUserApi 恢复原状 |
| `frontend/src/renderer/locales/zh.json` | 移除 APP 用户相关 key，新增 PC/APP 双行相关 key |
| `frontend/src/renderer/locales/en.json` | 同上 |
| `frontend/src/renderer/pages/AdminUsersPage.tsx` | **重写为统一页面**，支持双行布局 |
| `frontend/src/renderer/pages/AppUsersPage.tsx` | **删除** |
| `frontend/src/renderer/App.tsx` | 移除 `/admin/app-users` 路由 |
| `frontend/src/renderer/components/Layout/MainLayout.tsx` | 用户管理恢复为单个链接 |
| `frontend/src/renderer/store/authStore.ts` | login 方法新增 `client_type` 参数 |

---

## 4. 实施计划

### Stage 1: 数据库迁移
- UserSession 新增 `client_type` 列（默认 'pc'）
- 迁移 SQL

### Stage 2: 后端服务层改造
- AuthService: `record_session` 支持 `client_type`；`end_other_ip_sessions` 改为同类型踢出
- security.py: IP 校验跳过 app 会话

### Stage 3: API 端点改造
- auth.py: login 接收 `client_type`
- admin_users.py: 移除 `user_type` 参数

### Stage 4: 前端基础设施
- shared/types.ts 更新
- api.ts 恢复/调整
- authStore.ts login 支持 `client_type`
- 翻译文件调整

### Stage 5: 统一用户管理页面
- 重写 AdminUsersPage 为双行布局
- 删除 AppUsersPage
- 编辑弹窗增强 + 查看登录记录迁移

### Stage 6: 路由与导航
- App.tsx 移除 `/admin/app-users` 路由
- MainLayout.tsx 用户管理恢复为单链接
