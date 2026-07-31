# 心跳检测与会话IP修复设计文档

**日期**: 2026-06-20  
**状态**: 已批准  

---

## 1. 背景

本轮修复三个问题：

1. **APP 列 IP 为空** — PC 端注册的用户登录 APP 后，用户管理页 APP 行 IP 列显示为空
2. **APP 空闲后状态自动变离线** — 登录后 10 多分钟未操作，`last_activity` 未更新导致后端判为离线
3. **PC 端同样问题** — PC 网页端空闲时同样状态不准确，只是不明显

---

## 2. 方案设计

### 2.1 新增心跳接口

**端点**: `POST /api/v1/auth/ping`

**请求**:
```
POST /api/v1/auth/ping
Authorization: Bearer <token>
Content-Type: application/json
```

**响应**:
```json
{
  "success": true,
  "last_activity": "2026-06-20T18:00:00Z"
}
```

**实现逻辑**:
- `get_current_user` 验证 JWT（已有）
- `auth_service.update_session_activity(db, jti)` — 更新 `last_activity` 为当前时间
- 只操作当前 token 对应的单条 `UserSession` 记录，无其他副作用
- 返回当前 `last_activity` 时间供客户端参考

### 2.2 前端心跳定时器

**PC 端**（本项目 `frontend/src/renderer`）：
- 在 `App.tsx` 或 `authStore.ts` 中添加心跳逻辑
- 已认证用户每 **4 分钟** 调用一次 `/auth/ping`
- 未认证或 token 无效时停止心跳
- 使用 `setInterval` + 页面可见性监听（`visibilitychange`），页面隐藏时暂停

**APP 端**（另外那台电脑改动）：
- 每 **5 分钟** 调用一次 `POST /api/v1/auth/ping`
- 退出登录时清除定时器

### 2.3 在线状态判断优化

现有 `is_user_online_by_client_type` 已经按 client_type 分别查询，逻辑正确无需改动：

```python
# 当前逻辑（正确）
def is_user_online_by_client_type(self, db, user_id, client_type):
    cutoff = now() - timedelta(minutes=5)
    session = query.filter(
        user_id=user_id,
        client_type=client_type,
        logout_time.is_(None),
        last_activity >= cutoff,
    ).first()
    return session is not None
```

加上心跳后，`last_activity` 每 4-5 分钟刷新一次，在线状态准确度大幅提升。

---

## 3. 涉及的文件

### 后端

| 文件 | 变更 |
|------|------|
| `backend/app/api/v1/endpoints/auth.py` | 新增 `ping` 端点 |
| `backend/app/services/auth_service.py` | `update_session_activity` 已有，无需变更 |

### 前端（PC 网页端）

| 文件 | 变更 |
|------|------|
| `frontend/src/renderer/services/api.ts` | 新增 `authApi.ping()` 方法 |
| `frontend/src/renderer/App.tsx` | 添加心跳定时器（4 分钟间隔） |

### APP 端（另外那台电脑）

| 文件 | 变更 |
|------|------|
| 注册请求 | 移除 `user_type` 字段（已废弃） |
| 登录请求 | 添加 `client_type: "app"` |
| 新增心跳 | 每 5 分钟调用 `POST /api/v1/auth/ping` |
| 退出登录 | 调用 `POST /api/v1/auth/logout` 让会话主动结束 |

---

## 4. 实施计划

### Task 1: 后端心跳端点
- `auth.py` 新增 `ping` 端点
- 已验证用户身份，更新 `last_activity`

### Task 2: 前端心跳
- `api.ts` 新增 `authApi.ping()`
- `App.tsx` 添加 4 分钟间隔定时器
- 页面隐藏时暂停，恢复时重启
