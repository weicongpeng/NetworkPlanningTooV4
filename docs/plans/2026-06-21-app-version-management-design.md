# APP 版本管理设计方案

## 概述

为系统添加 APP 版本管理功能。PC 端管理页面可上传 APK 并记录版本信息，APP 端自动检查更新并在 APP 内下载后调用系统安装器安装。

---

## 一、数据库模型

在 `backend/app/models/database.py` 中新增 `AppVersion` ORM 模型：

```python
class AppVersion(Base):
    """APP 版本记录"""
    __tablename__ = "app_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(String(20), nullable=False, index=True)        # 版本号，如 "1.2.0"
    changelog = Column(Text, nullable=True)                         # 更新说明
    apk_filename = Column(String(255), nullable=False)              # APK 文件名
    apk_path = Column(Text, nullable=False)                         # 文件存储路径
    file_size = Column(Integer, nullable=True)                      # 文件大小（字节）
    is_latest = Column(Boolean, default=False, nullable=False)      # 是否标记为最新版本
    created_at = Column(String(30), nullable=False)
    updated_at = Column(String(30), nullable=True)
```

## 二、APK 文件存储

**目录结构**：
```
backend/apks/           # APK 文件根目录
├── 1.2.0_app-release.apk
├── 1.1.0_app-release.apk
└── 1.0.0_app-release.apk
```

后端启动时自动创建 `backend/apks/` 目录。文件命名规则：`{version}_{original_filename}`。

## 三、后端 API 端点

新建文件 `backend/app/api/v1/endpoints/app_versions.py`：

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| `GET` | `/api/v1/app-versions` | 版本列表（分页，按上传时间倒序） | 管理员 |
| `GET` | `/api/v1/app-versions/latest` | 获取最新版本信息 | 公开（无需认证） |
| `POST` | `/api/v1/app-versions` | 上传 APK + 版本号 + 更新说明（multipart） | 管理员 |
| `PUT` | `/api/v1/app-versions/{id}` | 修改版本号/更新说明/标记最新 | 管理员 |
| `DELETE` | `/api/v1/app-versions/{id}` | 删除版本（同时删除 APK 文件） | 管理员 |
| `GET` | `/api/v1/app-versions/download/{id}` | 下载 APK 文件 | 公开 |

**`/latest` 端点返回格式**：
```json
{
  "success": true,
  "data": {
    "id": 1,
    "version": "1.2.0",
    "changelog": "修复若干 bug\n优化地图加载速度\n新增收藏点导出功能",
    "apk_filename": "1.2.0_app-release.apk",
    "file_size": 47382910,
    "created_at": "2026-06-21T12:00:00"
  }
}
```

**路由注册**：在 `backend/app/api/v1/__init__.py` 中添加：
```python
api_router.include_router(app_versions.router, prefix="/app-versions", tags=["APP版本管理"])
```

## 四、PC 端管理页面

### 侧边栏入口

「应用」分组下新增「APP 版本管理」菜单项，路由 `/app-versions`。

### 页面功能

| 功能 | 说明 |
|------|------|
| **版本列表** | 表格展示所有版本，按上传时间倒序，字段：版本号、更新说明、文件大小、状态（最新/旧版）、上传时间 |
| **上传 APK** | 点击「上传」按钮 → 弹出对话框 → 选择 APK 文件 → 填写版本号和更新说明 → 提交 |
| **编辑** | 点击「编辑」图标 → 弹出编辑对话框 → 修改版本号/更新说明/标记最新 |
| **下载** | 点击「下载」图标 → 浏览器下载 APK |
| **删除** | 点击「删除」图标 → 确认对话框 → 删除记录及 APK 文件 |
| **标记最新** | 编辑时可勾选「标记为最新版本」；标记后其他版本自动取消最新标记 |

### 多语言

在 `zh.json` 和 `en.json` 中新增以下 key：

| key | zh | en |
|-----|----|----|
| sidebar.appVersions | APP 版本管理 | App Versions |
| appVersions.title | APP 版本管理 | App Version Management |
| appVersions.upload | 上传 APK | Upload APK |
| appVersions.version | 版本号 | Version |
| appVersions.changelog | 更新说明 | Changelog |
| appVersions.fileSize | 文件大小 | File Size |
| appVersions.status | 状态 | Status |
| appVersions.latest | 最新 | Latest |
| appVersions.old | 旧版 | Old |
| appVersions.createdAt | 上传时间 | Upload Time |
| appVersions.download | 下载 | Download |
| appVersions.edit | 编辑 | Edit |
| appVersions.delete | 删除 | Delete |
| appVersions.confirmDelete | 确定删除该版本？ | Confirm delete this version? |
| appVersions.markAsLatest | 标记为最新版本 | Mark as latest |
| appVersions.selectFile | 选择 APK 文件 | Select APK file |
| appVersions.uploadSuccess | 上传成功 | Upload successful |
| appVersions.editSuccess | 修改成功 | Update successful |
| appVersions.deleteSuccess | 删除成功 | Delete successful |

## 五、APP 移动端更新检查

### 当前版本获取

通过 `expo-constants` 获取：
```typescript
import Constants from 'expo-constants';
const currentVersion = Constants.expoConfig?.version || '1.0.0';
```

### API 集成

在 `mobile-app/src/services/api.ts` 中新增：
```typescript
async checkAppVersion(): Promise<AppVersionInfo | null> {
  const response = await this.client.get('/app-versions/latest');
  return response.data?.data || null;
}

async downloadApk(versionId: number, localPath: string): Promise<string> {
  const response = await this.client.get(`/app-versions/download/${versionId}`, {
    responseType: 'blob',  // 或 arraybuffer
  });
  // 写入本地文件系统
  await FileSystem.writeAsStringAsync(localPath, ...);
  return localPath;
}
```

### 版本检查流程

1. **APP 启动时**调用 `checkAppVersion()`
2. 比较返回的版本号与当前版本号（使用语义化版本比较）
3. 若返回版本 > 当前版本，弹框通知用户
4. 用户点击「立即下载」→ 使用 `expo-file-system` 下载 APK 到缓存目录
5. 下载完成后调用系统安装器安装

### 下载与安装（Android）

使用 `expo-file-system` 下载 APK 文件到设备缓存目录：
```typescript
import * as FileSystem from 'expo-file-system';
import { shareAsync } from 'expo-sharing';

const downloadUri = `${baseUrl}/api/v1/app-versions/download/${versionId}`;
const localUri = FileSystem.cacheDirectory + `app-${version}.apk`;

const download = FileSystem.createDownloadResumable(downloadUri, localUri);
const result = await download.downloadAsync();

// 调用系统安装器
await shareAsync(result.uri, { mimeType: 'application/vnd.android.package-archive' });
```

使用 `expo-sharing` 的 `shareAsync` 可以调用系统安装器打开 APK 文件（Android 支持分享 APK 到包安装器）。

### 检查时机

| 时机 | 说明 |
|------|------|
| APP 启动后 | 立即静默检查一次 |
| 每 24 小时 | 使用 AsyncStorage 记录上次检查时间，间隔 24h 再次检查 |
| 手动检查 | 在「我的」或「设置」页面增加「检查更新」按钮 |

### 通知弹框设计

```
┌─────────────────────────────────────┐
│                                     │
│     📦 发现新版本 v1.2.0            │
│                                     │
│     ┌─────────────────────────┐     │
│     │ 更新说明：                │     │
│     │ • 修复若干 bug           │     │
│     │ • 优化地图加载速度        │     │
│     │ • 新增收藏点导出功能      │     │
│     └─────────────────────────┘     │
│                                     │
│     [稍后再说]    [立即下载]        │
│                                     │
└─────────────────────────────────────┘
```

## 六、文件变更清单

### 后端（6 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/app/models/database.py` | 修改 | 新增 `AppVersion` 模型 |
| `backend/app/models/schemas.py` | 修改 | 新增 `AppVersionOut`、`AppVersionCreate` 等 Pydantic 模型 |
| `backend/app/api/v1/endpoints/app_versions.py` | 新建 | 版本管理所有端点 |
| `backend/app/api/v1/__init__.py` | 修改 | 注册 `app-versions` 路由 |
| `backend/app/core/config.py` | 可选 | 添加 APK 存储路径配置 |

### 前端（5 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `frontend/src/renderer/pages/AppVersionsPage.tsx` | 新建 | 版本管理页面组件 |
| `frontend/src/renderer/App.tsx` | 修改 | 新增路由 `/app-versions` |
| `frontend/src/renderer/components/Layout/MainLayout.tsx` | 修改 | 侧边栏新增菜单项 |
| `frontend/src/renderer/locales/zh.json` | 修改 | 添加中文翻译 |
| `frontend/src/renderer/locales/en.json` | 修改 | 添加英文翻译 |

### 移动端（2-3 个文件）

| 文件 | 操作 | 说明 |
|------|------|------|
| `mobile-app/src/services/api.ts` | 修改 | 新增 `checkAppVersion()`、`downloadApk()` |
| `mobile-app/app/(tabs)/profile.tsx` 或 `settings.tsx` | 修改 | 添加版本检查和下载安装逻辑 |
| `mobile-app/src/services/versionCheckService.ts` | 新建 | 版本检查、版本比较、通知展示等逻辑封装 |
