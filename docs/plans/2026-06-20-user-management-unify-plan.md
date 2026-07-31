# 用户管理整合与并发登录修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复手机 APP 和 PC 端同时登录相互排斥的问题；废弃 PC/APP 用户区分；合并两个用户管理页面为一个统一页面。

**Architecture:** 在 `UserSession` 表新增 `client_type` 字段标记会话来源（pc/app）；踢出逻辑改为仅踢同类型会话；统一用户管理页面用双行布局展示每个用户的 PC 和 APP 状态。

**Tech Stack:** FastAPI + SQLAlchemy + SQLite (后端) / React + TypeScript + Zustand + Tailwind CSS (前端)

---

### Task 1: 数据库迁移 — UserSession 新增 client_type

**Files:**
- Modify: `backend/app/models/database.py:67-89`
- Modify: `backend/app/core/database.py:54-84`
- Modify: `shared/types.ts:402-411`

**Step 1: UserSession 模型新增 client_type 列**

在 `backend/app/models/database.py` 的 `UserSession` 类中 `ip_address` 列之后新增：

```python
class UserSession(Base):
    __tablename__ = "user_sessions"
    # ... 现有字段
    ip_address = Column(String(45), nullable=True)
    client_type = Column(String(10), default='pc', nullable=False)  # 新增
    login_time = Column(DateTime, default=_utcnow, nullable=False)
    # ...

    def to_dict(self):
        return {
            # ... 现有字段
            "ip_address": self.ip_address,
            "client_type": self.client_type,  # 新增
            "login_time": _serialize_dt(self.login_time),
            # ...
        }
```

**Step 2: 数据库迁移逻辑**

在 `backend/app/core/database.py` 的 `init_db()` 函数中，User 表迁移之后添加 user_sessions 表的迁移：

```python
# 迁移：user_sessions 表添加 client_type 列
us_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(user_sessions)").fetchall()]
if "client_type" not in us_cols:
    conn.exec_driver_sql("ALTER TABLE user_sessions ADD COLUMN client_type VARCHAR(10) NOT NULL DEFAULT 'pc'")
```

**Step 3: 更新 shared/types.ts — UserSessionInfo 新增 client_type**

```typescript
export interface UserSessionInfo {
  id: number
  user_id: number
  token_jti: string
  ip_address: string | null
  client_type: 'pc' | 'app'    // 新增
  login_time: string | null
  logout_time: string | null
  last_activity: string | null
}
```

**同时**更新 `UserInfo` 中 `user_type` 恢复为可选字段（兼容已有数据）：

```typescript
export interface UserInfo {
  // ... 现有字段
  user_type?: 'pc' | 'app'    // 改为可选
}
```

**Step 4: Commit**

```bash
git add backend/app/models/database.py backend/app/core/database.py shared/types.ts
git commit -m "feat: UserSession新增client_type字段区分PC/APP会话

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端服务层改造

**Files:**
- Modify: `backend/app/services/auth_service.py`
- Modify: `backend/app/core/security.py`
- Modify: `backend/app/models/schemas.py`

**Step 1: UserLogin schema 新增 client_type 字段**

在 `backend/app/models/schemas.py`：

```python
class UserLogin(BaseModel):
    """用户登录请求"""
    username: str = Field(min_length=1, description="用户名")
    password: str = Field(min_length=1, description="密码")
    client_type: str = Field(default='pc', description="客户端类型: pc/app")  # 新增
```

**Step 2: AuthService.record_session 新增 client_type 参数**

```python
def record_session(self, db: Session, user_id: int, token_jti: str, ip_address: Optional[str] = None, client_type: str = 'pc') -> UserSession:
    session = UserSession(user_id=user_id, token_jti=token_jti, ip_address=ip_address, client_type=client_type)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session
```

**Step 3: end_other_ip_sessions 改为同类型踢出**

```python
def end_other_ip_sessions(self, db: Session, user_id: int, current_ip: str, client_type: str = 'pc') -> int:
    """结束用户来自其他IP的同类型活跃会话，返回结束数量"""
    if not current_ip or client_type != 'pc':  # APP 端不踢出任何会话
        return 0
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
    sessions = db.query(UserSession).filter(
        UserSession.user_id == user_id,
        UserSession.logout_time.is_(None),
        UserSession.client_type == client_type,  # 只踢同类型
        UserSession.ip_address.isnot(None),
        UserSession.ip_address != current_ip,
        UserSession.last_activity >= cutoff,
    ).all()
    count = 0
    for s in sessions:
        s.logout_time = now
        s.last_activity = now
        count += 1
    if count > 0:
        db.commit()
    return count
```

**Step 4: verify_session_ip 跳过 app 会话**

```python
def verify_session_ip(self, db: Session, token_jti: str, current_ip: str) -> bool:
    if not current_ip or current_ip == "unknown":
        return True
    session = db.query(UserSession).filter(UserSession.token_jti == token_jti).first()
    if not session:
        return True
    if not session.ip_address:
        return True
    if session.client_type == 'app':  # APP 会话不校验 IP
        return True
    return session.ip_address == current_ip
```

**Step 5: get_all_users 移除 user_type 过滤**

```python
def get_all_users(
    self,
    db: Session,
    page: int = 1,
    page_size: int = 20,
    search: Optional[str] = None,
    is_active: Optional[bool] = None,
    # user_type 参数已移除
) -> Tuple[List[User], int]:
    query = db.query(User)
    if search:
        query = query.filter(User.username.ilike(f"%{search}%"))
    if is_active is not None:
        query = query.filter(User.is_active == is_active)
    # user_type 过滤已移除
    total = query.count()
    users = query.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return users, total
```

**Step 6: security.py 中 IP 校验调整**

```python
# get_current_user 中的 IP 校验部分
if jti and request is not None:
    current_ip = auth_service.get_client_ip(request)
    if not auth_service.verify_session_ip(db, jti, current_ip):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="账号已在其他设备登录，请重新登录",
        )
```
这个逻辑不用改，因为 `verify_session_ip` 内部已经跳过 app 会话的校验。

**Step 7: Commit**

```bash
git add backend/app/services/auth_service.py backend/app/core/security.py backend/app/models/schemas.py
git commit -m "feat: 后端服务层 - 按client_type区分踢出逻辑

- UserLogin schema 新增 client_type
- end_other_ip_sessions 仅踢同类型会话，APP端不踢
- verify_session_ip 跳过 APP 会话 IP 校验
- get_all_users 移除 user_type 过滤

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: API 端点改造

**Files:**
- Modify: `backend/app/api/v1/endpoints/auth.py`
- Modify: `backend/app/api/v1/endpoints/admin_users.py`

**Step 1: auth.py login 端点接收并透传 client_type**

```python
@router.post("/login")
async def login(data: UserLogin, request: Request, db: Session = Depends(get_db)):
    """用户登录"""
    user, error = auth_service.authenticate_user(db, data.username, data.password)
    if error:
        raise HTTPException(status_code=401, detail=error)

    client_ip = auth_service.get_client_ip(request)

    # 仅同类型客户端互踢（APP端不踢任何会话）
    ended_count = auth_service.end_other_ip_sessions(db, user.id, client_ip, data.client_type)

    auth_service.update_last_login(db, user, client_ip)

    token, jti = auth_service.create_access_token(user.id, user.username, user.is_admin)
    auth_service.record_session(db, user.id, jti, client_ip, data.client_type)

    result = {
        "success": True,
        "data": {
            "token": token,
            "access_token": token,
            "token_type": "bearer",
            "user": user.to_dict(),
        },
    }
    if ended_count > 0:
        result["warning"] = "该账号在另一设备上已退出登录"
    return result
```

**Step 2: auth.py register 端点移除 user_type 透传**

```python
@router.post("/register")
async def register(data: UserCreate, request: Request, db: Session = Depends(get_db)):
    user, error = auth_service.create_user(
        db=db,
        username=data.username,
        password=data.password,
        is_admin=data.is_admin,
        license_expiry=...,
        city=data.city,
        operator=data.operator,
        # user_type 已移除，不再区分
    )
```

同时移除 `UserCreate` schema 中的 `user_type` 字段（可选，也可保留但不用）。

**Step 3: admin_users.py 移除 user_type 参数**

```python
@router.get("/")
async def list_users(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    # user_type 参数已移除
    admin_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    users, total = auth_service.get_all_users(db, page, page_size, search, is_active)
    # ...
```

同时移除 `create_user` 中的 `user_type=data.user_type` 透传。

**Step 4: Commit**

```bash
git add backend/app/api/v1/endpoints/auth.py backend/app/api/v1/endpoints/admin_users.py
git commit -m "feat: API端点 - login接收client_type, 移除user_type

- login 端点接收并透传 client_type
- register 端点移除 user_type
- admin_users 列表和创建接口移除 user_type

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端基础设施

**Files:**
- Modify: `shared/types.ts` (LoginRequest 新增 client_type)
- Modify: `frontend/src/renderer/services/api.ts`
- Modify: `frontend/src/renderer/store/authStore.ts`
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

**Step 1: shared/types.ts — LoginRequest 新增 client_type**

```typescript
export interface LoginRequest {
  username: string
  password: string
  client_type?: 'pc' | 'app'    // 新增，可选
}
```

**Step 2: api.ts — 移除 APP 用户相关方法**

删除 `listAppUsers` 和 `createAppUser` 两个方法，`adminUserApi` 恢复为只有原有方法。

**Step 3: authStore.ts — login 方法新增 client_type 参数**

```typescript
login: async (username: string, password: string, clientType?: 'pc' | 'app') => {
  set({ isLoading: true })
  try {
    const result: any = await authApi.login({ username, password, client_type: clientType || 'pc' })
    // ... 后续不变
  }
}
```

**Step 4: 翻译文件调整**

`zh.json`:
- 移除：`appUser`, `pcUser`, `appUserManagement`, `addAppUser`, `createAppUserSuccess`, `viewSessions`, `sessionHistory`, `sessionCount`, `sessionTime`, `sessionIp`, `onlineCount`, `noAppUsers`, `appUserDeleteConfirm`
- 新增：双行表格相关 key（客户端类型、PC端、APP端等）

```json
{
  "admin": {
    "clientType": "客户端",
    "pcClient": "PC端",
    "appClient": "APP端",
    "viewLoginRecords": "查看登录记录",
    "loginRecordTime": "登录时间",
    "loginRecordIp": "IP地址",
    "loginRecordClient": "客户端",
    "noRecords": "暂无记录"
  }
}
```

`en.json` 对应新增英文翻译。

**Step 5: Commit**

```bash
git add shared/types.ts frontend/src/renderer/services/api.ts frontend/src/renderer/store/authStore.ts frontend/src/renderer/locales/*.json
git commit -m "feat: 前端基础设施 - 调整API和翻译

- shared/types LoginRequest 新增 client_type
- api.ts 移除 APP 用户专用方法
- authStore login 支持 client_type 参数
- 翻译文件调整

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 统一用户管理页面

**Files:**
- Rewrite: `frontend/src/renderer/pages/AdminUsersPage.tsx`
- Delete: `frontend/src/renderer/pages/AppUsersPage.tsx`

**核心设计：双行表格**

每个用户占 2 行 `<tr>`，公共字段使用 `rowSpan={2}`：

```tsx
// 简化的表头
<thead>
  <tr>
    <th rowSpan={2}>用户名</th>
    <th rowSpan={2}>角色</th>
    <th rowSpan={2}>地市</th>
    <th rowSpan={2}>运营商</th>
    <th rowSpan={2}>许可证到期</th>
    <th>客户端</th>
    <th>状态</th>
    <th>IP地址</th>
    <th>注册时间</th>
    <th>最后登录</th>
    <th>使用时长</th>
    <th rowSpan={2}>操作</th>
  </tr>
  <tr>
    {/* 注册行已在上方设置 rowSpan */}
    <th>PC/APP</th>
    <th>在线/离线</th>
    <th>IP</th>
    <th>注册时间（合并）</th>  {/* 客户端单独行列不显示 */}
    <th>最后登录时间</th>
    <th>使用时长</th>
  </tr>
</thead>
```

实际实现时不使用双行表头，而是直接在数据行中处理。每个用户生成两行，公共列用 `rowSpan`：

```tsx
{users.map((u) => (
  <React.Fragment key={u.id}>
    {/* PC 行 */}
    <tr className="border-t border-border hover:bg-muted/30">
      <td className="px-4 py-3 text-foreground font-medium" rowSpan={2}>{u.username}</td>
      <td className="px-4 py-3" rowSpan={2}>
        <RoleBadge is_admin={u.is_admin} />
      </td>
      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{u.city || '-'}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{u.operator || '-'}</td>
      <td className="px-4 py-3" rowSpan={2}>
        <LicenseCell license_expiry={u.license_expiry} />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">PC端</td>
      <td className="px-4 py-3"><OnlineDot is_online={u.is_online} /></td>
      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{u.last_login_ip || '-'}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs" rowSpan={2}>{formatDate(u.created_at)}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(u.last_login)}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{formatDuration(u.total_usage_seconds)}</td>
      <td className="px-4 py-3" rowSpan={2}>
        <ActionButtons user={u} ... />
      </td>
    </tr>
    {/* APP 行 */}
    <tr className="border-t border-border hover:bg-muted/30">
      <td className="px-4 py-3 text-xs text-muted-foreground">APP端</td>
      <td className="px-4 py-3"><OnlineDot is_online={/* APP 在线状态 */} /></td>
      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{/* APP IP */}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{/* APP 最后登录 */}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{/* APP 使用时长 */}</td>
    </tr>
  </React.Fragment>
))}
```

**关键数据问题**：当前 User 模型只存储了最后登录时间/IP/使用时长，且是 PC 和 APP 共用的。需要确认：
- 目前 `User` 表只有一组 `last_login`/`last_login_ip`/`total_usage_seconds`
- 这些字段是登录时更新的，PC 和 APP 登录都会修改同一组字段

**解决方案**：APP 行的数据从最近一条 `client_type='app'` 的会话记录中获取，而不是从 User 表读取。这样 APP 行显示的是 APP 的最后活跃情况。

**查看登录记录弹窗** — 从原 AppUsersPage 迁移：

```tsx
// 显示该用户所有会话（PC + APP），按登录时间倒序
{sessions.map((s) => (
  <div key={s.id} className="p-3 bg-muted/30 rounded-lg border border-border text-sm">
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">登录时间:</span>
      <span>{formatDate(s.login_time)}</span>
      <span className={`ml-auto px-1.5 py-0.5 rounded text-xs ${
        s.client_type === 'app' ? 'bg-green-500/10 text-green-400' : 'bg-blue-500/10 text-blue-400'
      }`}>
        {s.client_type === 'app' ? 'APP端' : 'PC端'}
      </span>
    </div>
    <div className="flex items-center gap-2 mt-1">
      <span className="text-muted-foreground">IP:</span>
      <span className="font-mono">{s.ip_address || '-'}</span>
    </div>
    {s.logout_time && (
      <div className="flex items-center gap-2 mt-1">
        <span className="text-muted-foreground">登出时间:</span>
        <span>{formatDate(s.logout_time)}</span>
      </div>
    )}
  </div>
))}
```

**Step 2: 删除 AppUsersPage.tsx**

```bash
rm frontend/src/renderer/pages/AppUsersPage.tsx
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/pages/AdminUsersPage.tsx
git rm frontend/src/renderer/pages/AppUsersPage.tsx
git commit -m "feat: 统一用户管理页面 - 双行布局

- 重写AdminUsersPage为统一管理页面
- 每个用户PC/APP各占一行，公共字段合并
- 查看登录记录弹窗迁移
- 删除AppUsersPage

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 路由与导航

**Files:**
- Modify: `frontend/src/renderer/App.tsx`
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx`

**Step 1: App.tsx 移除 /admin/app-users 路由**

删除 `AppUsersPage` 的 import 和对应路由。

**Step 2: MainLayout.tsx 用户管理恢复为单个链接**

```typescript
// 改回为单个链接（移除分组结构）
...(isAuthenticated && user?.is_admin ? [
  { type: 'link' as const, name: t('admin.title', '用户管理'), href: '/admin/users', icon: Users }
] : []),
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/App.tsx frontend/src/renderer/components/Layout/MainLayout.tsx
git commit -m "feat: 路由与导航恢复

- App.tsx 移除 /admin/app-users 路由
- MainLayout.tsx 用户管理恢复为单个链接

Co-Authored-By: Claude <noreply@anthropic.com>"
```
