# 心跳检测与会话IP修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增心跳接口 `/auth/ping`，让 APP 和 PC 端定时刷新会话活跃时间，解决空闲超时离线问题。

**Architecture:** 后端新增轻量 ping 端点，更新当前 session 的 `last_activity`；PC 前端（本项目）添加 4 分钟心跳定时器；APP 端（另外电脑）需要登录时传 `client_type: "app"` 并每 5 分钟调 ping。

**Tech Stack:** FastAPI + SQLAlchemy (后端) / React + TypeScript (前端)

---

### Task 1: 后端心跳端点 /auth/ping

**Files:**
- Modify: `backend/app/api/v1/endpoints/auth.py`
- Modify: `frontend/src/renderer/services/api.ts`

**Step 1: 在 auth.py 新增 ping 端点**

在 `logout` 端点之后新增：

```python
from datetime import datetime, timezone

@router.post("/ping")
async def ping(
    current_user: User = Depends(get_current_user),
    jti: str | None = Depends(get_token_jti),
    db: Session = Depends(get_db),
):
    """
    心跳检测：更新当前会话的 last_activity，延长在线状态。
    APP 和 PC 端应定时（4-5分钟）调用此接口。
    """
    if jti:
        auth_service.update_session_activity(db, jti)
    return {
        "success": True,
        "last_activity": datetime.now(timezone.utc).isoformat(),
    }
```

注意：`update_session_activity` 方法在 `auth_service.py:255` 已存在，直接调用即可。

**Step 2: api.ts 新增 ping 方法**

```typescript
// authApi 新增
ping: async (): Promise<ApiResponse<{ last_activity: string }>> => {
  return apiClient.post('/auth/ping') as any
},
```

**Step 3: 验证后端**

```bash
cd backend && python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.auth_service import auth_service
print('update_session_activity exists:', hasattr(auth_service, 'update_session_activity'))
print('OK')
"
```

预期：`update_session_activity exists: True`

**Step 4: Commit**

```bash
git add backend/app/api/v1/endpoints/auth.py frontend/src/renderer/services/api.ts
git commit -m "feat: 新增 /auth/ping 心跳检测端点

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端心跳定时器

**Files:**
- Modify: `frontend/src/renderer/App.tsx`
- Modify: (authStore.ts 或独立的 hook)

**Step 1: 创建心跳 hook**

在 `frontend/src/renderer/hooks/` 目录（或直接在 App.tsx 中）添加心跳逻辑。为了保持代码干净，新建 `useHeartbeat.ts`：

```typescript
// frontend/src/renderer/hooks/useHeartbeat.ts
import { useEffect, useRef } from 'react'
import { useAuthStore } from '../store/authStore'
import { authApi } from '../services/api'

const HEARTBEAT_INTERVAL = 4 * 60 * 1000  // 4 分钟

export function useHeartbeat() {
  const { isAuthenticated } = useAuthStore()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibleRef = useRef(true)

  useEffect(() => {
    const doPing = async () => {
      try {
        await authApi.ping()
      } catch {
        // ping 失败静默处理（如 token 过期）
      }
    }

    const startHeartbeat = () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = setInterval(doPing, HEARTBEAT_INTERVAL)
      // 立即执行一次
      doPing()
    }

    const stopHeartbeat = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    // 页面可见性变化时暂停/恢复心跳
    const onVisibilityChange = () => {
      if (document.hidden) {
        visibleRef.current = false
        stopHeartbeat()
      } else {
        visibleRef.current = true
        if (isAuthenticated) {
          startHeartbeat()
        }
      }
    }

    if (isAuthenticated) {
      startHeartbeat()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopHeartbeat()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [isAuthenticated])
}
```

**Step 2: 在 App.tsx 中调用 hook**

在 App 组件内添加：

```typescript
import { useHeartbeat } from './hooks/useHeartbeat'

export default function App() {
  useHeartbeat()
  
  // ... 原有代码
}
```

**Step 3: 验证 TypeScript 类型检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -E "useHeartbeat|App.tsx" | head -5
```

预期：无输出（零错误）

**Step 4: Commit**

```bash
git add frontend/src/renderer/hooks/useHeartbeat.ts frontend/src/renderer/App.tsx
git commit -m "feat: 前端心跳定时器(4分钟间隔)

- 新建 useHeartbeat hook
- App.tsx 集成心跳
- 页面隐藏时暂停，恢复时重启

Co-Authored-By: Claude <noreply@anthropic.com>"
```
