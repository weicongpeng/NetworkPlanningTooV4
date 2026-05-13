# 移动端外场开发部署指南

## 整体架构

```
手机 App（外场）
    │
    ├── API 请求 ──→ https://apk.pengwc.asia ──→ Cloudflare Tunnel ──→ localhost:8000（你的Windows电脑）
    │
    └── 热更新 ──→ Expo Tunnel URL ──→ Cloudflare Edge ──→ Metro Bundler :8081（你的Windows电脑）
```

---

## 日常开发流程

### 第一步：启动后端

```powershell
cd D:\mycode\NetworkPlanningTooV3\backend
python main.py
```

确认启动成功：浏览器打开 `http://localhost:8000`，看到 API 信息。

### 第二步：启动 Cloudflare Tunnel

```powershell
cloudflared tunnel run pwctoos
```

看到 `Registered tunnel connection` 说明隧道连接成功。此时外网可通过 `https://apk.pengwc.asia` 访问你的后端。

### 第三步：启动 Expo Metro（开发服务器）

```powershell
cd D:\mycode\NetworkPlanningTooV3\mobile-app
npx expo start --tunnel
```

- `--tunnel` 参数让 Metro 使用 Cloudflare Tunnel 向外暴露，这样外网的手机也能加载 JS bundle
- 终端会显示一个二维码，以及一个 `tunnel://...` 地址

### 第四步：手机连接开发服务器

**方式 A — 扫描二维码：**
- 打开手机上的 Dev Client App（已构建好的那个）
- 点击 "Scan QR Code"
- 扫描终端上的二维码

**方式 B — 手动输入 URL：**
- 终端会显示 `exp://<xxx>.ngrok.io:80` 类似的地址
- 在 Dev Client 中输入这个地址

连接成功后，App 会加载当前代码。之后你修改任何 JS/TS 文件，**手机自动刷新热更新**。

### 第五步：切换到外网后端

1. 在 App 中切换到「设置」Tab
2. 输入后端地址：`https://apk.pengwc.asia`
3. 点击「测试连接」确认可达
4. 点击「保存」

后续请求自动走外网。回到办公室想切回内网：
- 在设置页点击「重置为自动发现模式」

---

## 首次构建 Dev Client APK

> 只需构建一次！以后修改代码只需热更新，无需重新构建。

### 前提条件

1. 注册 Expo 账号：https://expo.dev/signup
2. 安装 EAS CLI：
   ```powershell
   npm install -g eas-cli
   ```
3. 登录 Expo：
   ```powershell
   eas login
   ```

### 执行构建

```powershell
cd D:\mycode\NetworkPlanningTooV3\mobile-app
eas build --platform android --profile development
```

- 构建时间约 5-15 分钟（云端构建）
- 构建完成后会生成一个 `.apk` 或 `.aab` 文件的下载链接
- 在手机上打开链接下载安装

### 构建完成的验证

安装后启动 App，应该能看到：
1. App 首页正常显示地图
2. 切换到「设置」Tab，能看到当前后端地址
3. 点击「测试连接」检查连接状态

---

## 故障排查

### 后端无法访问

| 现象 | 原因 | 解决 |
|---|---|---|
| 浏览器打开 localhost:8000 没反应 | 后端没启动 | 运行 `python main.py` |
| 外网访问 https://apk.pengwc.asia 超时 | Tunnel 没启动 | 运行 `cloudflared tunnel run pwctoos` |
| Tunnel 报错连接失败 | cloudflared 没登录 | 运行 `cloudflared tunnel login` |
| 手机访问外网地址提示证书错误 | Cloudflare 自动管理 SSL | 确认 Cloudflare Dashboard 中 SSL/TLS 设为 "Full" |

### 手机无法连接 Metro（开发服务器）

| 现象 | 原因 | 解决 |
|---|---|---|
| 手机扫描二维码后一直 loading | Metro 没启动 | 确保在 mobile-app 目录下运行了 `npx expo start --tunnel` |
| 连接成功但修改代码不刷新 | 保存的文件不是 JS/TS | 确认修改的是 `src/` 或 `app/` 下的代码 |

### 构建 APK 失败

| 错误 | 解决 |
|---|---|
| `eas-cli 未找到` | 运行 `npm install -g eas-cli` |
| `未登录` | 运行 `eas login` |
| `构建超时` | 重新运行 `eas build`，构建排队是正常的 |

---

## 一键启动脚本

`scripts/start-dev.ps1` 提供了自动化启动功能（需以管理员身份运行）：

```powershell
powershell -ExecutionPolicy Bypass -File D:\mycode\NetworkPlanningTooV3\scripts\start-dev.ps1
```

脚本会自动启动：后端 FastAPI → Cloudflare Tunnel → Expo Metro Tunnel
