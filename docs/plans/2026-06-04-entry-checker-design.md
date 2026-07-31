# 双域名入口检测跳板设计

**日期**: 2026-06-04
**状态**: 已实现 ✅

---

## 问题

生产环境通过两个域名访问同一后端服务：
- `https://app.pengwc.asia`（Cloudflare Tunnel 入口）
- `https://armbian.tail362392.ts.net`（Tailscale 入口）

有时其中一个域名不可达（Tunnel 掉线 / Tailscale 网络波动），用户需要手动切换域名，体验不佳。

## 方案

新增一个 Cloudflare Worker 入口域名 `go.pengwc.asia`，用户访问该域名时，Worker 并发检测两个后端域名的健康状态，**自动 302 跳转到可用的域名**。

## 架构

```
用户浏览器 → go.pengwc.asia
           → Cloudflare Worker（全球边缘节点）
           → 并发健康检查（3 秒超时）：
               GET https://app.pengwc.asia/api/v1/system/status
               GET https://armbian.tail362392.ts.net/api/v1/system/status
           → 决策：
               ├─ 仅一个可用    → 302 跳转
               ├─ 两个都可用    → 按优先级选（app.pengwc.asia 优先）
               └─ 都不可用      → 降级页面 + 5 秒自动重试
```

## 核心设计

### 1. Cookie 粘性

跳转后在用户浏览器种一个 `preferred_domain` cookie（有效期 7 天），下次访问时先验证 Cookie 中的域名，命中则跳过全量检测，直接跳转。减少每个请求都等待检测的开销。

### 2. 手动指定域名

支持 URL 参数 `?domain=armbian.tail362392.ts.net` 直接跳转指定域名，方便用户在有偏好时使用。

### 3. 降级页面

两个域名都不可达时，返回一个样式简洁的 HTML 页面：
- 表格展示每个域名的状态（✅/❌）
- 提供手动点击访问的链接
- 5 秒后自动刷新重试

### 4. 健康检查端点

使用已有的 `GET /api/v1/system/status` 端点，返回 200 即视为可用。超时 3 秒算不可用。

## 文件结构

```
cloudflare/entry-checker/
├── src/index.js       # Worker 主逻辑（~130 行）
├── wrangler.toml      # Cloudflare Worker 配置
└── README.md          # 部署说明
```

## 部署

### Dashboard 部署（推荐，2 分钟）

1. Cloudflare Dashboard → Workers & Pages → 创建 Worker
2. 粘贴 `src/index.js` 代码 → 部署
3. 触发器 → 添加自定义域 `go.pengwc.asia`

### CLI 部署

```bash
cd cloudflare/entry-checker
wrangler deploy
```

## 后端新增 `/api/v1/system/status` 端点

在 `backend/app/api/v1/endpoints/system.py` 新增了一个轻量级健康检查端点：

```python
@router.get("/status")
async def health_check():
    return {"status": "ok"}
```

该端点无数据库查询、无复杂计算，返回开销极小，专为入口检测跳板设计。

## 对现有系统的影响

| 组件 | 影响 |
|------|------|
| `app.pengwc.asia` | 无影响，Tunnel 配置不变 |
| `armbian.tail362392.ts.net` | 无影响，Tailscale 配置不变 |
| 后端服务 | 无影响，只是多了一个健康的 GET 请求 |
| 用户 | 新增可用入口，原有入口继续有效 |

## 验证方法

部署后访问 `https://go.pengwc.asia`，应自动跳转到可用的后端服务域名。断开 Cloudflare Tunnel 后再次访问，应自动跳转到 Tailscale 域名。
