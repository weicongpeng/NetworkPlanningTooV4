# go.pengwc.asia — 入口检测跳板

## 作用

当用户访问 `go.pengwc.asia` 时，该 Worker 并发检测两个后端域名的健康状态，自动 302 跳转到可用的域名。

```
用户 → go.pengwc.asia
     → 检测 app.pengwc.asia 和 armbian.tail362392.ts.net
     → 跳转到可用的那个
```

## 部署

### 方式 A：Cloudflare Dashboard（推荐，无需安装）

1. 登录 https://dash.cloudflare.com
2. 进入 **Workers & Pages** → **创建 Worker**
3. 名称填 `entry-checker`
4. 删除默认代码，将 `src/index.js` 的内容完整粘贴进去
5. 点击 **部署**
6. 进入 **设置** → **触发器** → **添加自定义域**
7. 输入 `go.pengwc.asia` → 保存

全程约 2 分钟，无需安装任何工具。

### 方式 B：wrangler CLI（自动部署）

```bash
# 安装 Wrangler（首次需要）
npm install -g wrangler

# 登录 Cloudflare（浏览器验证）
wrangler login

# 部署
cd cloudflare/entry-checker
wrangler deploy
```

## 配置

打开 `src/index.js` 头部 `DOMAINS` 数组即可修改检测域名和优先级：

```javascript
const DOMAINS = [
  { name: 'app.pengwc.asia', protocol: 'https', priority: 1 },
  { name: 'armbian.tail362392.ts.net', protocol: 'https', priority: 2 },
];
```

- `priority` 越小优先级越高
- 两个都可用时跳 `priority: 1` 的域名

## 高级用法

| 用法 | 示例 |
|------|------|
| 手动指定域名 | `go.pengwc.asia?domain=armbian.tail362392.ts.net` |
| 浏览器输入 | 直接访问 `go.pengwc.asia` 自动检测跳转 |

## 工作原理

```
请求到达 Worker
  │
  ├─ 1. URL 参数 ?domain=xxx → 直接跳转
  │
  ├─ 2. Cookie 中存在 preferred_domain → 快速验证 Cookie 中的域名
  │    ├─ 可用 → 跳转（免检测，省时间）
  │    └─ 不可用 → 进入全量检测
  │
  ├─ 3. 并发检测所有域名（3 秒超时）
  │    ├─ 有可用 → 跳转 + 种 Cookie
  │    └─ 都不可用 → 显示降级页面（5 秒自动重试）
  │
  └─ 4. 降级页面展示各域名状态 + 手动访问链接
```

## 升级

编辑 `src/index.js` 后重新上传（Dashboard 直接粘贴，或 `wrangler deploy`）即可。
