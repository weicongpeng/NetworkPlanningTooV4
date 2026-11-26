# Linux / SSH 远程 Expo 开发与 APK 构建

本环境以 Docker 容器提供 Node 20 + JDK 17 + Android SDK，宿主只负责 SSH、Tailscale 路由和产物分发。业务 API 保持 `.env` 中的 `https://app.pengwc.asia`。

## 一次性准备（已完成）

- `pwc` 已加入 `docker` 组；`/etc/docker/daemon.json` 配置 `docker.m.daocloud.io` / `docker.1ms.run` 镜像源。
- 用户参考的 `51f0x/ubuntu-24.04-jdk-17-ndk-r27b` 不在国内镜像白名单，故用本地等价镜像 `npt-expo-build:local`（Node 20.20.2 / JDK 17 / SDK platform 34+35 / build-tools 34+35 / NDK 26.1.10909125 / CMake 3.22.1 / EAS CLI），Dockerfile 在 `docker/Dockerfile`：

```bash
sg docker -c 'docker build --network host -t npt-expo-build:local -f docker/Dockerfile docker'
```

> 新 SSH 会话里直接用 `sg docker -c 'docker ...'`，无需重新登录。

## 依赖安装

`node_modules` 必须从 Windows 迁移后的状态在 Linux 容器内重装：

```bash
cd /home/pwc/NetworkPlanningTooV3/mobile-app
sg docker -c 'docker run --rm --network host --user 1000:1000 \
  -e HOME=/home/pwc -e npm_config_registry=https://registry.npmmirror.com \
  -v "$PWD":/app -v /home/pwc/.gradle:/home/pwc/.gradle \
  -v /home/pwc/.npm:/home/pwc/.npm -v /home/pwc/.expo:/home/pwc/.expo \
  -w /app npt-expo-build:local npm ci'
```

## 远程调试（手机经 Tailscale）

1. 启动 Metro（容器 `--network host`，SSH 断开后仍运行）：

```bash
sg docker -c 'docker rm -f npt-metro >/dev/null 2>&1 || true; docker run -d --name npt-metro \
  --network host --user 1000:1000 \
  -e HOME=/home/pwc -e EXPO_NO_TELEMETRY=1 \
  -e REACT_NATIVE_PACKAGER_HOSTNAME=100.94.170.107 \
  -v /home/pwc/NetworkPlanningTooV3/mobile-app:/app \
  -v /home/pwc/.npm:/home/pwc/.npm -v /home/pwc/.expo:/home/pwc/.expo \
  -w /app npt-expo-build:local \
  npx expo start --dev-client --host lan --port 8081'
```

`--host` 只接受 `lan|tunnel|localhost`；Tailscale 地址由 `REACT_NATIVE_PACKAGER_HOSTNAME` 注入 manifest。核对：

```bash
curl -s 'http://100.94.170.107:8081/manifest?platform=android&dev=true&minify=false' | head -c 200
sg docker -c 'docker logs npt-metro'
```

2. 安装开发版客户端（首次或原生依赖变更时）：

```bash
sg docker -c 'docker run --rm --network host --user 1000:1000 \
  -e HOME=/home/pwc -e GRADLE_USER_HOME=/home/pwc/.gradle \
  -v /home/pwc/NetworkPlanningTooV3/mobile-app:/app \
  -v /home/pwc/.gradle:/home/pwc/.gradle -v /home/pwc/.npm:/home/pwc/.npm \
  -v /home/pwc/.expo:/home/pwc/.expo -w /app npt-expo-build:local \
  bash -c "cd android && ./gradlew assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx4096m"'

nohup python3 -m http.server 8082 --bind 100.94.170.107 \
  --directory /home/pwc/NetworkPlanningTooV3/mobile-app/android/app/build/outputs/apk/debug \
  > /tmp/npt-apk-server.log 2>&1 &
```

手机浏览器打开 `http://100.94.170.107:8082/app-debug.apk` 安装（需允许安装未知应用），然后从开发客户端打开：

```
exp+network-planning-mobile://expo-development-client/?url=http://100.94.170.107:8081
```

## 发行版 APK

```bash
cd /home/pwc/NetworkPlanningTooV3/mobile-app
sg docker -c 'docker run --rm --network host --user 1000:1000 \
  -e HOME=/home/pwc -e GRADLE_USER_HOME=/home/pwc/.gradle -e EXPO_NO_TELEMETRY=1 \
  -v "$PWD":/app -v /home/pwc/.gradle:/home/pwc/.gradle \
  -v /home/pwc/.npm:/home/pwc/.npm -v /home/pwc/.expo:/home/pwc/.expo \
  -w /app npt-expo-build:local \
  bash -c "cd android && ./gradlew assembleRelease --no-daemon -Dorg.gradle.jvmargs=-Xmx4096m"'
```

产物：`android/app/build/outputs/apk/release/app-release.apk`。校验：

```bash
sg docker -c 'docker run --rm \
  -v /home/pwc/NetworkPlanningTooV3/mobile-app/android/app/build/outputs/apk:/apk:ro \
  npt-expo-build:local bash -c "BT=/opt/android-sdk/build-tools/35.0.0; \
  \$BT/aapt dump badging /apk/release/app-release.apk | head -4; \
  \$BT/apksigner verify --print-certs /apk/release/app-release.apk"'
```

当前 `release` 复用 `debug.keystore`（CN=Android Debug），只适合内测安装。正式分发需在 `android/app/android.jks` 生成密钥（`*.jks` 已被 `.gitignore` 排除），并在 `android/app/build.gradle` 增加 `signingConfigs.release`，口令从环境变量注入，不要写进仓库或镜像。

## 故障排查

- `No variants exist` / 构建文件出现 `E:/mobile-app/...`：Windows 生成的 `android/build/generated/autolinking/autolinking.json` 残留；删除 `android/build`、`android/app/build`、`android/.gradle` 后重编（均为 gitignore 产物）。
- Gradle 尝试下载 `gradle-8.10.2-all.zip`：显式设置 `GRADLE_USER_HOME=/home/pwc/.gradle`，复用宿主已缓存的发行版。
- `EACCES: mkdir '/home/pwc/.expo'`：容器必须挂载 `-v /home/pwc/.expo:/home/pwc/.expo`；只挂 `.npm` 会让容器内 `/home/pwc` 变成 root 所有。
- `sdk directory is not writable`：SDK 按需预装所需版本（build-tools 34/35、platform 34/35、CMake 3.22.1、NDK 26.1），避免运行时以普通用户身份下载。
- Docker Hub 超时：使用镜像源；若目标镜像不在白名单，用 Dockerfile 自建等价镜像。
- 业务接口不通：确认 `.env` 为 `https://app.pengwc.asia`，App 设置页没有残留自定义地址；调试机需能访问公网。
