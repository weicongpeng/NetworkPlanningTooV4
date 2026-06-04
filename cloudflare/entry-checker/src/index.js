/**
 * go.pengwc.asia — 多域名入口检测跳板
 *
 * 当用户访问该 Worker 时，并发检测两个后端域名的健康状态，
 * 自动 302 跳转到可用的域名。两个都挂了则显示降级页面。
 *
 * 部署方式:
 *   方式 A: 复制代码到 Cloudflare Dashboard → Workers & Pages → 创建 Worker
 *   方式 B: npx wrangler deploy（需 API Token）
 */

// ====== 配置区（按需修改）======

const DOMAINS = [
  {
    name: 'app.pengwc.asia',
    protocol: 'https',
    priority: 1, // 数字越小优先级越高
  },
  {
    name: 'armbian.tail362392.ts.net',
    protocol: 'https',
    priority: 2,
  },
];

const HEALTH_PATH = '/api/v1/system/status';
const CHECK_TIMEOUT_MS = 3000; // 单个健康检查超时
const COOKIE_NAME = 'preferred_domain';

// ====== 主逻辑 ======

export default {
  async fetch(request) {
    // 1. 检查 URL 参数 ?domain=xxx 手动指定
    const url = new URL(request.url);
    const manualDomain = url.searchParams.get('domain');
    if (manualDomain) {
      const matched = DOMAINS.find((d) => d.name === manualDomain);
      if (matched) {
        return redirectTo(`${matched.protocol}://${matched.name}`);
      }
    }

    // 2. 检查 Cookie 中的首选域名
    const cookie = request.headers.get('Cookie') || '';
    const preferredMatch = cookie.match(
      new RegExp(`${COOKIE_NAME}=([^;]+)`)
    );
    if (preferredMatch) {
      const cached = DOMAINS.find((d) => d.name === preferredMatch[1]);
      if (cached && (await healthCheck(cached))) {
        return redirectTo(`${cached.protocol}://${cached.name}`);
      }
    }

    // 3. 并发检测所有域名
    const results = await checkAllDomains();

    // 4. 选择最佳可用域名
    const available = results
      .filter((r) => r.ok)
      .sort((a, b) => a.priority - b.priority);

    if (available.length > 0) {
      const best = available[0];
      const response = redirectTo(
        `${best.protocol}://${best.name}`
      );
      // 种 cookie 记住（有效期 7 天）
      response.headers.set(
        'Set-Cookie',
        `${COOKIE_NAME}=${best.name}; Path=/; Max-Age=604800; SameSite=Lax`
      );
      return response;
    }

    // 5. 全部不可用 → 降级页面
    return new Response(
      renderFallbackPage(results),
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  },
};

// ====== 工具函数 ======

/**
 * 向一个域名发起健康检查
 */
async function healthCheck(domain) {
  const url = `${domain.protocol}://${domain.name}${HEALTH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'go.pengwc.asia-health-checker/1.0' },
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发检测所有域名，返回结果数组
 */
async function checkAllDomains() {
  const tasks = DOMAINS.map(async (d) => {
    const ok = await healthCheck(d);
    return {
      name: d.name,
      protocol: d.protocol,
      priority: d.priority,
      ok,
    };
  });

  return Promise.all(tasks);
}

/**
 * 生成 302 跳转响应
 */
function redirectTo(target) {
  return Response.redirect(target, 302);
}

/**
 * 所有域名都挂了时显示的降级页面
 */
function renderFallbackPage(results) {
  const rows = results
    .map(
      (r) => `
    <tr>
      <td>${r.protocol}://${r.name}</td>
      <td style="color:${r.ok ? 'green' : 'red'}">
        ${r.ok ? '✅ 正常' : '❌ 不可达'}
      </td>
      <td><a href="${r.protocol}://${r.name}" target="_blank">手动访问</a></td>
    </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>网络规划工具 — 入口检测</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 640px;
      margin: 60px auto;
      padding: 20px;
      text-align: center;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 40px 32px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #666; font-size: 14px; }
    table {
      width: 100%;
      margin: 24px 0;
      border-collapse: collapse;
      text-align: left;
      font-size: 14px;
    }
    th, td { padding: 10px 12px; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #333; }
    .retry-msg { font-size: 13px; color: #999; margin-top: 16px; }
    .retry-msg a { color: #1a73e8; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ 服务暂时不可用</h1>
    <p>所有后端服务均无法连接，请稍后再试</p>

    <table>
      <thead>
        <tr><th>域名</th><th>状态</th><th></th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="retry-msg">
      5 秒后将自动重试 · <a href="javascript:location.reload()">立即重试</a>
    </div>
  </div>

  <script>
    setTimeout(() => location.reload(), 5000);
  </script>
</body>
</html>`;
}
