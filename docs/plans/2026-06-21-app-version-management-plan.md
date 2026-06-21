# APP 版本管理功能 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 APP 版本管理功能，PC 端可上传/管理 APK 版本，APP 端自动检查更新并下载安装。

**Architecture:** 后端新增 AppVersion ORM 模型和 6 个 REST API 端点，APK 文件存储在 `backend/apks/` 目录；PC 端在侧边栏新增「APP 版本管理」独立页面；APP 移动端启动时检查最新版本，发现新版本后在 APP 内下载并调用系统安装器安装。

**Tech Stack:** FastAPI + SQLAlchemy + SQLite（后端），React + TypeScript（PC 端），React Native Expo + expo-file-system + expo-sharing（移动端）

---

## 阶段 1：后端数据库模型

### Task 1.1：新增 AppVersion ORM 模型

**Files:**
- Modify: `backend/app/models/database.py` — 在文件末尾、`TaskResult` 模型之后添加新模型

**Step 1: 添加 AppVersion 模型**

在 `database.py` 末尾、`class TaskResult(Base):` 之后添加：

```python
class AppVersion(Base):
    """APP 版本记录"""
    __tablename__ = "app_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(String(20), nullable=False, index=True)
    changelog = Column(Text, nullable=True)
    apk_filename = Column(String(255), nullable=False)
    apk_path = Column(Text, nullable=False)
    file_size = Column(Integer, nullable=True)
    is_latest = Column(Boolean, default=False, nullable=False)
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "version": self.version,
            "changelog": self.changelog,
            "apk_filename": self.apk_filename,
            "apk_path": self.apk_path,
            "file_size": self.file_size,
            "is_latest": self.is_latest,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
```

**Step 2: 验证建表**

SQLAlchemy 的 `Base.metadata.create_all()` 会在应用启动时自动创建表（已在 `app/api/__init__.py` 的 `lifespan` 中调用），无需额外迁移命令。

---

### Task 1.2：创建 APK 存储目录

**Files:**
- Modify: `backend/app/api/__init__.py` — 在 `lifespan` 启动逻辑中创建 `backend/apks/` 目录

**Step 1: 添加目录创建逻辑**

在 `lifespan` 函数的启动代码中找到目录创建部分，添加：

```python
# 创建 APK 文件存储目录
apks_dir = BASE_DIR / "apks"
apks_dir.mkdir(parents=True, exist_ok=True)
```

**Step 2: 验证目录创建**

检查 `lifespan` 函数，确认启动时自动创建了 `backend/apks/`。

---

### Task 1.3：新增 Pydantic 模型

**Files:**
- Modify: `backend/app/models/schemas.py` — 在文件末尾添加版本管理相关模型

**Step 1: 添加 Pydantic 模型**

```python
class AppVersionCreate(BaseModel):
    """创建 APP 版本请求"""
    version: str = Field(min_length=1, max_length=20, description="版本号，如 1.2.0")
    changelog: Optional[str] = Field(default=None, description="更新说明")
    is_latest: bool = Field(default=False, description="是否标记为最新版本")


class AppVersionUpdate(BaseModel):
    """更新 APP 版本请求"""
    version: Optional[str] = Field(default=None, max_length=20)
    changelog: Optional[str] = None
    is_latest: Optional[bool] = None


class AppVersionOut(BaseModel):
    """APP 版本响应"""
    id: int
    version: str
    changelog: Optional[str] = None
    apk_filename: str
    file_size: Optional[int] = None
    is_latest: bool
    created_at: str
    updated_at: Optional[str] = None
```

---

### 阶段 1 提交

```bash
git add backend/app/models/database.py backend/app/api/__init__.py backend/app/models/schemas.py
git commit -m "feat: 新增 AppVersion ORM 模型和 APK 存储目录

- database.py: 新增 AppVersion 表（version/changelog/apk/is_latest）
- api/__init__.py: 启动时自动创建 apks/ 目录
- schemas.py: 新增 AppVersionCreate/Update/Out Pydantic 模型

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 2：后端 API 端点

### Task 2.1：创建 app_versions.py 端点文件

**Files:**
- Create: `backend/app/api/v1/endpoints/app_versions.py`
- Modify: `backend/app/api/v1/__init__.py` — 注册路由

**Step 1: 创建端点文件**

新建 `app_versions.py`，实现以下端点：

1. **`GET /app-versions`** — 管理员分页获取版本列表
   - 权限：`get_current_admin_user`
   - 参数：`page`(默认1), `page_size`(默认20)
   - 返回所有版本按 `created_at` 倒序
   - 字段包含 `download_url`（拼接下载链接）

2. **`GET /app-versions/latest`** — 公开获取最新版本
   - 无需认证
   - 查询 `is_latest=True` 且按 `created_at` 倒序取第一个
   - 返回 `AppVersionOut` + `download_url`

3. **`POST /app-versions`** — 管理员上传新版本
   - 权限：`get_current_admin_user`
   - 接收 `multipart/form-data`: `file`(APK文件), `version`(字符串), `changelog`(可选字符串), `is_latest`(可选bool)
   - 文件保存到 `backend/apks/{version}_{original_filename}`，文件名做安全处理（去空格、特殊字符）
   - 如果 `is_latest=True`，先将所有其他版本 `is_latest` 设为 `False`

4. **`PUT /app-versions/{id}`** — 管理员编辑版本
   - 权限：`get_current_admin_user`
   - 修改 `version`/`changelog`/`is_latest`
   - 如果 `is_latest=True`，先将所有其他版本 `is_latest` 设为 `False`
   - 如果修改了版本号，同时重命名 APK 文件

5. **`DELETE /app-versions/{id}`** — 管理员删除版本
   - 权限：`get_current_admin_user`
   - 删除数据库记录，同时删除对应的 APK 文件
   - 使用 `os.remove()` 删除文件，文件不存在时忽略

6. **`GET /app-versions/download/{id}`** — 公开下载 APK
   - 无需认证
   - 使用 `FileResponse` 返回 APK 文件
   - 设置 `Content-Disposition: attachment` 头
   - 设置 `media_type="application/vnd.android.package-archive"`

**Step 2: 注册路由**

在 `backend/app/api/v1/__init__.py` 中：

```python
from app.api.v1.endpoints import ... , app_versions
api_router.include_router(app_versions.router, prefix="/app-versions", tags=["APP版本管理"])
```

**Step 3: 验证 API**

启动后端后验证：
```bash
# 最新版本（无需认证）
curl http://localhost:8000/api/v1/app-versions/latest

# 需要管理员 token
curl -H "Authorization: Bearer <admin_token>" http://localhost:8000/api/v1/app-versions
```

---

### 阶段 2 提交

```bash
git add backend/app/api/v1/endpoints/app_versions.py backend/app/api/v1/__init__.py
git commit -m "feat: 实现 APP 版本管理 API 端点

新增 6 个端点：版本列表、最新版本查询、上传、编辑、删除、APK 下载
- 上传时自动处理文件命名和 is_latest 互斥逻辑
- 编辑时支持版本号变更后重命名 APK 文件
- 删除时同时清理 APK 文件
- /latest 和 /download 端点无需认证

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 3：PC 端版本管理页面

### Task 3.1：添加 API 调用函数

**Files:**
- Modify: `frontend/src/renderer/services/api.ts`

**Step 1: 添加版本管理 API 调用**

```typescript
// ==================== APP 版本管理 ====================

export interface AppVersion {
  id: number
  version: string
  changelog?: string
  apk_filename: string
  file_size?: number
  is_latest: boolean
  created_at: string
  updated_at?: string
  download_url?: string
}

export async function getAppVersions(page = 1, pageSize = 20): Promise<{total: number; items: AppVersion[]}> {
  const res = await apiClient.get('/app-versions', { params: { page, page_size: pageSize } })
  return res.data.data
}

export async function getLatestAppVersion(): Promise<AppVersion | null> {
  const res = await apiClient.get('/app-versions/latest')
  return res.data.data
}

export async function uploadAppVersion(formData: FormData): Promise<AppVersion> {
  const res = await uploadClient.post('/app-versions', formData)
  return res.data.data
}

export async function updateAppVersion(id: number, data: { version?: string; changelog?: string; is_latest?: boolean }): Promise<AppVersion> {
  const res = await apiClient.put(`/app-versions/${id}`, data)
  return res.data.data
}

export async function deleteAppVersion(id: number): Promise<void> {
  await apiClient.delete(`/app-versions/${id}`)
}

export function getAppVersionDownloadUrl(id: number): string {
  return `/api/v1/app-versions/download/${id}`
}
```

---

### Task 3.2：创建页面组件

**Files:**
- Create: `frontend/src/renderer/pages/AppVersionsPage.tsx`

**Step 1: 创建页面组件**

页面包含以下部分：

**数据结构**：
```typescript
interface AppVersion {
  id: number
  version: string
  changelog?: string
  apk_filename: string
  file_size?: number
  is_latest: boolean
  created_at: string
  updated_at?: string
  download_url?: string
}
```

**UI 组件**：

1. **页面 Header**：标题「APP 版本管理」+「上传 APK」按钮
2. **版本列表表格**：
   - 列：版本号、更新说明、文件大小（格式化显示，如 "45.2 MB"）、状态（最新/旧版标签）、上传时间、操作
   - 操作列：下载、编辑、删除图标按钮
3. **上传对话框**（模态）：
   - 文件选择器（accept=".apk"）
   - 版本号输入框
   - 更新说明文本框（多行）
   - 「标记为最新版本」复选框
4. **编辑对话框**（模态）：同上传对话框，但预填已有值
5. **删除确认对话框**

**样式**：参考现有页面（如 `AdminUsersPage.tsx`）的 Tailwind CSS 风格。

**翻译 key 在 Task 3.4 中添加**，页面内使用 `useTranslation()` 和 `t()`。

---

### Task 3.3：添加路由和侧边栏

**Files:**
- Modify: `frontend/src/renderer/App.tsx` — 添加路由
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx` — 侧边栏添加菜单项

**Step 1: 添加路由**

```tsx
// App.tsx 中
import AppVersionsPage from './pages/AppVersionsPage'

// 路由配置中
<Route path="/app-versions" element={<AppVersionsPage />} />
```

**Step 2: 侧边栏菜单项**

在侧边栏「应用」分组下添加菜单项，参考 `AdminUsersPage` 的菜单位置。

侧边栏配置：在菜单数组中新增：
```typescript
{
  key: 'app-versions',
  label: t('sidebar.appVersions'),
  icon: <Package />,  // 使用 lucide-react 的 Package 图标
  path: '/app-versions',
}
```

---

### Task 3.4：添加多语言翻译

**Files:**
- Modify: `frontend/src/renderer/locales/zh.json`
- Modify: `frontend/src/renderer/locales/en.json`

添加的翻译 key 见设计文档的「多语言」章节。

---

### 阶段 3 提交

```bash
git add frontend/src/renderer/pages/AppVersionsPage.tsx \
       frontend/src/renderer/services/api.ts \
       frontend/src/renderer/App.tsx \
       frontend/src/renderer/components/Layout/MainLayout.tsx \
       frontend/src/renderer/locales/zh.json \
       frontend/src/renderer/locales/en.json
git commit -m "feat: 新增 PC 端 APP 版本管理页面

- 新增 AppVersionsPage 页面：版本列表/上传/编辑/删除
- 路由 /app-versions + 侧边栏菜单
- 中英文翻译

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 阶段 4：APP 移动端版本检查

### Task 4.1：API 集成

**Files:**
- Modify: `mobile-app/src/services/api.ts`

**Step 1: 添加版本检查方法**

```typescript
interface AppVersionInfo {
  id: number
  version: string
  changelog?: string
  apk_filename: string
  file_size?: number
  created_at: string
  download_url?: string
}

async checkAppVersion(): Promise<AppVersionInfo | null> {
  const response = await this.client.get('/app-versions/latest')
  return response.data?.data || null
}

getAppDownloadUrl(versionId: number): string {
  return `${baseUrl}/api/v1/app-versions/download/${versionId}`
}
```

> 注意：`/app-versions/latest` 无需认证，APP 端可在启动时直接调用。

---

### Task 4.2：版本检查服务

**Files:**
- Create: `mobile-app/src/services/versionCheckService.ts`

**Step 1: 版本比较逻辑**

实现语义化版本比较（如 `"1.2.0" > "1.1.0"`）：

```typescript
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0
    const b = parts2[i] || 0
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}
```

**Step 2: 上次检查时间管理**

使用 `AsyncStorage` 记录上次检查时间，避免频繁请求：

```typescript
const STORAGE_KEY_LAST_CHECK = '@npt_version_last_check'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24 小时

async function shouldCheckVersion(): Promise<boolean> {
  const lastCheck = await AsyncStorage.getItem(STORAGE_KEY_LAST_CHECK)
  if (!lastCheck) return true
  return Date.now() - parseInt(lastCheck) > CHECK_INTERVAL_MS
}

async function markVersionChecked(): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY_LAST_CHECK, String(Date.now()))
}
```

---

### Task 4.3：下载与安装

**Files:**
- Modify: `mobile-app/src/services/api.ts` — 添加下载方法
- Modify: `mobile-app/app/(tabs)/profile.tsx` 或 `settings.tsx` — 添加更新 UI

**Step 1: 下载 APK**

使用 `expo-file-system` 下载 APK：

```typescript
import * as FileSystem from 'expo-file-system'
import { shareAsync } from 'expo-sharing'

async function downloadAndInstallApk(versionId: number, version: string): Promise<void> {
  const baseUrl = await getEffectiveApiBaseUrl()
  const downloadUrl = `${baseUrl}/api/v1/app-versions/download/${versionId}`
  const localUri = FileSystem.cacheDirectory + `npt-update-${version}.apk`

  const downloadResumable = FileSystem.createDownloadResumable(downloadUrl, localUri)
  const result = await downloadResumable.downloadAsync()

  if (result && result.uri) {
    // 调用系统安装器
    await shareAsync(result.uri, {
      mimeType: 'application/vnd.android.package-archive',
    })
  }
}
```

**Step 2: 更新弹框 UI**

创建一个版本更新提示组件，在发现新版本时弹出：

```tsx
// 模态框或 Alert 弹框
// 标题: "发现新版本 v{version}"
// 内容: changelog
// 按钮: "稍后再说" + "立即下载"
```

在 `profile.tsx`（用户/我的页面）或 `settings.tsx`（设置页面）中添加「检查更新」入口按钮和自动检查逻辑。

---

### Task 4.4：启动时自动检查

**Files:**
- Modify: `mobile-app/app/(tabs)/profile.tsx` — 添加自动检查逻辑

**Step 1: 添加 useEffect 自动检查**

在页面组件中使用 `useEffect` 在加载时自动检查版本：

```typescript
useEffect(() => {
  (async () => {
    const shouldCheck = await shouldCheckVersion()
    if (!shouldCheck) return

    try {
      const latest = await apiService.checkAppVersion()
      if (!latest) return

      const currentVersion = Constants.expoConfig?.version || '1.0.0'
      if (isNewerVersion(latest.version, currentVersion)) {
        // 显示更新通知弹框
        setShowUpdateModal(true)
        setUpdateInfo(latest)
      }

      await markVersionChecked()
    } catch (e) {
      console.log('版本检查失败:', e)
    }
  })()
}, [])
```

---

### 阶段 4 提交

```bash
git add mobile-app/src/services/api.ts \
       mobile-app/src/services/versionCheckService.ts \
       mobile-app/app/(tabs)/profile.tsx
git commit -m "feat: APP 移动端版本检查与下载安装

- 新增 checkAppVersion API 调用
- 实现语义化版本比较
- 使用 expo-file-system 下载 APK
- 使用 expo-sharing 调用系统安装器
- 启动时自动检查 + 手动检查入口
- 24 小时间隔避免频繁请求

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验证方案

### 后端验证
```bash
# 1. 启动后端
cd backend && python main.py

# 2. 测试最新版本接口（无需认证）
curl http://localhost:8000/api/v1/app-versions/latest
# 预期: {"success": true, "data": null}（无数据时）

# 3. 测试版本列表（需管理员 token）
curl -H "Authorization: Bearer <admin_token>" http://localhost:8000/api/v1/app-versions
# 预期: {"success": true, "data": {"total": 0, "items": []}}
```

### PC 端验证
1. 访问 `/app-versions` 路由，确认页面正常显示
2. 上传一个 APK 文件，确认版本出现在列表中
3. 编辑版本信息，确认修改生效
4. 删除版本，确认记录和文件都被删除
5. 确认「最新版本」标记互斥逻辑生效

### 移动端验证
1. 启动 APP，确认控制台有版本检查请求日志
2. 上传一个比当前版本号更高的版本，确认 APP 弹出更新通知
3. 点击「立即下载」，确认下载进度正常
4. 下载完成后确认系统安装器被调用
