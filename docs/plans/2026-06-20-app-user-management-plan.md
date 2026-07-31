# APP 用户管理功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有用户管理页面内增加"APP用户管理"页面，支持列表查看、启用/禁用、登录历史、密码重置、删除等基础管理功能。

**Architecture:** 在现有 `users` 表新增 `user_type` 字段区分 PC/APP 用户；后端复用 `admin_users.py` API 端点，增加 `user_type` 过滤参数；前端新建 `AppUsersPage` 页面（路由 `/admin/app-users`），复用 AdminUsersPage 的 UI 模式和组件。

**Tech Stack:** FastAPI + SQLAlchemy + SQLite (后端) / React + TypeScript + Zustand + Tailwind CSS (前端)

---

### Task 1: 数据库迁移 + User 模型 + shared types 更新

**Files:**
- Modify: `backend/app/core/database.py:54-84`
- Modify: `backend/app/models/database.py:31-64`
- Modify: `shared/types.ts:343-357`

**Step 1: User 模型新增 user_type 字段**

修改 `backend/app/models/database.py`，在 User 类的 `is_shared` 列之后新增 `user_type` 列，并将 `user_type` 包含到 `to_dict()` 返回值中。

```python
# 在 operator 列之后新增
user_type = Column(String(10), default='pc', nullable=False)

# to_dict() 返回值新增
"user_type": self.user_type,
```

同时需要在 User model 上方导入中确认没有额外依赖需要添加（String 和 Column 已经导入）。

**Step 2: 数据库迁移逻辑**

修改 `backend/app/core/database.py` 的 `init_db()` 函数，在已有 migrations 列表中添加 `user_type` 列的迁移：

```python
migrations = [
    ("city", "ALTER TABLE users ADD COLUMN city VARCHAR(100)"),
    ("operator", "ALTER TABLE users ADD COLUMN operator VARCHAR(50)"),
    ("last_login_ip", "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45)"),
    ("ip_address", "ALTER TABLE user_sessions ADD COLUMN ip_address VARCHAR(45)"),
    ("user_type", "ALTER TABLE users ADD COLUMN user_type VARCHAR(10) NOT NULL DEFAULT 'pc'"),  # 新增
]
```

**Step 3: 更新 shared/types.ts**

在 `UserInfo` 接口中新增 `user_type` 字段：

```typescript
export interface UserInfo {
  // ... 现有字段
  city: string | null
  operator: string | null
  user_type: 'pc' | 'app'  // 新增
}
```

**Step 4: Commit**

```bash
git add backend/app/models/database.py backend/app/core/database.py shared/types.ts
git commit -m "feat: User模型新增user_type字段区分PC/APP用户

- User ORM 模型新增 user_type 列
- database.py 添加迁移 SQL（ALTER TABLE）
- shared/types.ts UserInfo 新增 user_type 类型

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: AuthService 改造

**Files:**
- Modify: `backend/app/services/auth_service.py:101-128` (create_user)
- Modify: `backend/app/services/auth_service.py:130-141` (update_user)
- Modify: `backend/app/services/auth_service.py:167-183` (get_all_users)
- Modify: `backend/app/models/schemas.py:568-582` (UserCreate)

**Step 1: get_all_users 新增 user_type 过滤**

```python
def get_all_users(
    self,
    db: Session,
    page: int = 1,
    page_size: int = 20,
    search: Optional[str] = None,
    is_active: Optional[bool] = None,
    user_type: Optional[str] = None,  # 新增
) -> Tuple[List[User], int]:
    query = db.query(User)
    if search:
        query = query.filter(User.username.ilike(f"%{search}%"))
    if is_active is not None:
        query = query.filter(User.is_active == is_active)
    if user_type:  # 新增
        query = query.filter(User.user_type == user_type)
    total = query.count()
    users = query.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return users, total
```

**Step 2: create_user 新增 user_type 参数**

```python
def create_user(
    self,
    db: Session,
    username: str,
    password: str,
    is_admin: bool = False,
    license_expiry: Optional[datetime] = None,
    city: Optional[str] = None,
    operator: Optional[str] = None,
    user_type: str = 'pc',  # 新增
) -> Tuple[Optional[User], Optional[str]]:
    ...
    user = User(
        ...
        user_type=user_type,  # 新增
    )
    ...
```

**Step 3: update_user 允许更新 user_type**

```python
def update_user(self, db: Session, user_id: int, updates: dict) -> Optional[User]:
    allowed_fields = {"is_active", "is_admin", "license_expiry", "must_change_password", "total_usage_seconds", "city", "operator", "user_type"}  # 新增 user_type
    ...
```

**Step 4: UserCreate schema 新增 user_type**

```python
class UserCreate(BaseModel):
    ...
    operator: Optional[str] = Field(default=None, max_length=50, description="运营商")
    user_type: str = Field(default='pc', description="用户类型: pc/app")  # 新增
```

**Step 5: Commit**

```bash
git add backend/app/services/auth_service.py backend/app/models/schemas.py
git commit -m "feat: AuthService新增user_type支持

- get_all_users 支持 user_type 过滤
- create_user/update_user 支持 user_type 参数
- UserCreate schema 新增 user_type 字段

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: API 端点改造

**Files:**
- Modify: `backend/app/api/v1/endpoints/admin_users.py:24-46`

**Step 1: list_users 新增 user_type 查询参数**

```python
@router.get("/")
async def list_users(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    user_type: str | None = Query(default=None),  # 新增
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    users, total = auth_service.get_all_users(db, page, page_size, search, is_active, user_type)
    ...
```

**Step 2: create_user 新增 user_type 字段接收**

前端 createAppUser 会传 `user_type: 'app'`，后端已经在 auth_service 层面接收，需要确保 admin_users.py 中传参时透传。创建用户的 schema 中已有 `user_type` 字段，`data.user_type` 可直接使用。

```python
@router.post("/")
async def create_user(
    data: UserCreate,
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    ...
    user, error = auth_service.create_user(
        db=db,
        username=data.username,
        password=data.password,
        is_admin=data.is_admin,
        license_expiry=license_expiry,
        city=data.city,
        operator=data.operator,
        user_type=data.user_type,  # 新增：透传 user_type
    )
    ...
```

**Step 3: Commit**

```bash
git add backend/app/api/v1/endpoints/admin_users.py
git commit -m "feat: admin_users API新增user_type参数

- list_users 新增 user_type 查询参数
- create_user 透传 user_type 字段

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端基础设施 — 翻译文件 + API 服务

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`
- Modify: `frontend/src/renderer/services/api.ts:964-991`

**Step 1: 翻译文件新增 APP 用户相关 key**

在 `zh.json` 的 `admin` 段落中新增：

```json
{
  "admin": {
    "appUser": "APP用户",
    "appUserManagement": "APP用户管理",
    "addAppUser": "添加APP用户",
    "createAppUserSuccess": "APP用户创建成功",
    "viewSessions": "查看登录记录",
    "sessionHistory": "登录历史",
    "sessionCount": "共 {count} 条登录记录",
    "sessionTime": "登录时间",
    "sessionIp": "登录IP",
    "onlineCount": "在线用户",
    "pcUser": "PC用户",
    "noAppUsers": "暂无APP用户",
    "appUserDeleteConfirm": "确定要删除APP用户 \"{username}\" 吗？"
  }
}
```

在 `en.json` 对应新增：

```json
{
  "admin": {
    "appUser": "APP User",
    "appUserManagement": "APP User Management",
    "addAppUser": "Add APP User",
    "createAppUserSuccess": "APP user created successfully",
    "viewSessions": "View Login History",
    "sessionHistory": "Login History",
    "sessionCount": "{count} login records",
    "sessionTime": "Login Time",
    "sessionIp": "Login IP",
    "onlineCount": "Online",
    "pcUser": "PC User",
    "noAppUsers": "No APP users yet",
    "appUserDeleteConfirm": "Are you sure to delete APP user \"{username}\"?"
  }
}
```

**Step 2: API 服务新增 listAppUsers / createAppUser**

在 `frontend/src/renderer/services/api.ts` 的 `adminUserApi` 对象中新增：

```typescript
export const adminUserApi = {
  // ... 现有方法

  listAppUsers: async (page: number = 1, pageSize: number = 20, search?: string): Promise<ApiResponse<UserListResponse>> => {
    const params: any = { page, page_size: pageSize, user_type: 'app' }
    if (search) params.search = search
    return apiClient.get('/admin/users/', { params }) as any
  },

  createAppUser: async (data: { username: string; password: string; confirm_password: string }): Promise<ApiResponse<UserInfo>> => {
    return apiClient.post('/admin/users/', { ...data, user_type: 'app', is_admin: false }) as any
  },
}
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/locales/zh.json frontend/src/renderer/locales/en.json frontend/src/renderer/services/api.ts
git commit -m "feat: 前端基础设施 - 翻译文件+API服务

- zh.json/en.json 新增APP用户管理相关翻译key
- api.ts 新增 listAppUsers / createAppUser 方法

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: AppUsersPage 页面组件

**Files:**
- Create: `frontend/src/renderer/pages/AppUsersPage.tsx`

**Step 1: 创建 AppUsersPage.tsx**

复制 `AdminUsersPage.tsx` 的 UI 模式并做以下调整：

**UI 差异点：**

| AdminUsersPage | AppUsersPage |
|----------------|--------------|
| 列：用户名、角色、状态、地市、运营商、IP、注册时间、最后登录、使用时长、许可证到期、操作 | 列：用户名、状态、IP、注册时间、最后登录、操作 |
| 添加用户：含管理员/许可证/地市/运营商 | 添加用户：仅用户名+密码 |
| 编辑弹窗含管理员/启用/许可证 | 不设编辑弹窗，仅有启用/禁用切换 |
| 操作：编辑、切换启用、重置密码、删除 | 操作：切换启用、重置密码、**查看登录记录**、删除 |
| 无会话查看 | 新增"查看登录记录"按钮 → 弹窗显示会话列表 |

**核心代码结构：**

```typescript
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Users, UserPlus, Search, Loader2, Pencil, Trash2,
  RefreshCw, ChevronLeft, ChevronRight, Key, X, Circle, Ban, History
} from 'lucide-react'
import { adminUserApi } from '../services/api'
import type { UserInfo, UserSessionInfo } from '@shared/types'

export function AppUsersPage() {
  const { t } = useTranslation()
  // ... 状态管理（精简版，不含地市/运营商等字段）
  // ... 列表获取、搜索、分页
  // ... 启用/禁用切换（同 AdminUsersPage）
  // ... 重置密码（同 AdminUsersPage）
  // ... 删除（同 AdminUsersPage）
  // ... 添加 APP 用户（简化版，仅用户名+密码）
  // ... 查看登录记录（新功能，调用 adminUserApi.getUser 获取 sessions）
}
```

**补充：查看登录记录功能：**

```typescript
const [sessionUser, setSessionUser] = useState<UserInfo | null>(null)
const [sessions, setSessions] = useState<UserSessionInfo[]>([])
const [showSessionModal, setShowSessionModal] = useState(false)
const [sessionLoading, setSessionLoading] = useState(false)

const openSessions = async (user: UserInfo) => {
  setSessionUser(user)
  setSessionLoading(true)
  setShowSessionModal(true)
  try {
    const result = await adminUserApi.getUser(user.id)
    if (result.success && result.data) {
      setSessions(result.data.sessions || [])
    }
  } catch {
    setSessions([])
  } finally {
    setSessionLoading(false)
  }
}
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/pages/AppUsersPage.tsx
git commit -m "feat: 新增AppUsersPage APP用户管理页面

- 提供APP用户列表(用户名/状态/IP/注册时间/最后登录/操作)
- 支持启用/禁用、重置密码、查看登录历史、删除
- 简化版添加APP用户(仅用户名+密码)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 路由注册 + 侧边栏导航

**Files:**
- Modify: `frontend/src/renderer/App.tsx:90-99`
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx:32-58`

**Step 1: App.tsx 新增路由**

```typescript
import { AppUsersPage } from './pages/AppUsersPage'

// 在 Routes 中的 /admin/users 路由之后新增
<Route
  path="/admin/app-users"
  element={
    <ProtectedRoute requireAdmin>
      <AppUsersPage />
    </ProtectedRoute>
  }
/>
```

**Step 2: MainLayout.tsx 侧边栏改为分组结构**

将现有"用户管理"从单个 link 项改为 group 项，包含"PC用户"和"APP用户"两个子项：

```typescript
// 替换现有代码：
// ...(isAuthenticated && user?.is_admin ? [
//   { type: 'link' as const, name: t('admin.title', '用户管理'), href: '/admin/users', icon: Users }
// ] : []),

// 改为：
...(isAuthenticated && user?.is_admin ? [
  {
    type: 'group' as const,
    name: t('admin.title', '用户管理'),
    icon: Users,
    children: [
      { type: 'link', name: t('admin.pcUser', 'PC用户'), href: '/admin/users' },
      { type: 'link', name: t('admin.appUser', 'APP用户'), href: '/admin/app-users' },
    ],
  },
] : []),
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/App.tsx frontend/src/renderer/components/Layout/MainLayout.tsx
git commit -m "feat: 注册APP用户管理路由和侧边栏导航

- App.tsx 新增 /admin/app-users 路由
- MainLayout.tsx 用户管理改为分组结构

Co-Authored-By: Claude <noreply@anthropic.com>"
```
