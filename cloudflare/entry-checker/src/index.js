/**
 * go.pengwc.asia — 多域名入口检测跳板
 *
 * 并发检测两个后端域名的健康状态，自动 302 跳转到可用域名。
 * 都挂了则显示降级页面。
 */

// ====== 配置区 ======
const DOMAINS = [
  { name: 'app.pengwc.asia', protocol: 'https', priority: 1 },
  { name: 'armbian.tail362392.ts.net', protocol: 'https', priority: 2 },
];

const HEALTH_PATH = '/api/v1/system/status';
const CHECK_TIMEOUT_MS = 3000;
const COOKIE_NAME = 'preferred_domain';
const COOKIE_MAX_AGE = 604800; // 7 天

// ====== 入口 ======
export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (err) {
      // 兜底：代码异常时返回降级页面，不暴露错误详情
      return new Response(
        renderFallbackPage(null, err),
        {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }
  },
};

// ====== 主逻辑 ======
async function handleRequest(request) {
  const url = new URL(request.url);

  // 1. 手动指定 ?domain=xxx
  const manualDomain = url.searchParams.get('domain');
  if (manualDomain) {
    const matched = DOMAINS.find((d) => d.name === manualDomain);
    if (matched) {
      return doRedirect(`${matched.protocol}://${matched.name}`);
    }
  }

  // 2. Cookie 缓存命中验证
  const cookie = request.headers.get('Cookie') || '';
  const preferredMatch = cookie.match(
    new RegExp(`${COOKIE_NAME}=([^;]+)`)
  );
  if (preferredMatch) {
    const cached = DOMAINS.find((d) => d.name === preferredMatch[1]);
    if (cached) {
      const ok = await healthCheck(cached);
      if (ok) return doRedirect(`${cached.protocol}://${cached.name}`);
    }
  }

  // 3. 并发检测所有域名
  const results = await checkAllDomains();

  // 4. 选最佳可用域名
  const available = results
    .filter((r) => r.ok)
    .sort((a, b) => a.priority - b.priority);

  if (available.length > 0) {
    const best = available[0];
    return doRedirect(`${best.protocol}://${best.name}`, best.name);
  }

  // 5. 全部不可用 → 降级页面
  return new Response(
    renderFallbackPage(results, null),
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

// ====== 工具函数 ======

async function healthCheck(domain) {
  const url = `${domain.protocol}://${domain.name}${HEALTH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'go.pengwc.asia-health-checker/1.0' },
      // 避免 Worker 重复走 Cloudflare 代理导致的回环问题
      redirect: 'manual',
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
 * 使用 302 + Location 头手动跳转（避免 Response.redirect 在 CF Worker 中的潜在兼容问题）
 * 同时通过 Set-Cookie 记录首选域名
 */
function doRedirect(target, preferredName) {
  const headers = new Headers();
  headers.set('Location', target);
  headers.set('Cache-Control', 'no-store');

  if (preferredName) {
    headers.set(
      'Set-Cookie',
      `${COOKIE_NAME}=${preferredName}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`
    );
  }

  return new Response(null, {
    status: 302,
    headers,
  });
}

/**
 * 降级页面 / 错误页面
 */
function renderFallbackPage(results, error) {
  let rows = '';
  if (results && results.length > 0) {
    rows = results
      .map(
        (r) => `
    <tr>
      <td>${r.protocol}://${r.name}</td>
      <td style="color:${r.ok ? 'green' : 'red'}">${r.ok ? '✅ 正常' : '❌ 不可达'}</td>
      <td><a href="${r.protocol}://${r.name}" target="_blank" rel="noopener">手动访问</a></td>
    </tr>`
      )
      .join('');
  }

  const errorHint = error
    ? '（检测过程出现异常，请稍后重试）'
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>网络规划工具 — 入口检测</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 40px 32px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      max-width: 520px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p.sub { color: #666; font-size: 14px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; text-align: left; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #333; }
    .retry { margin-top: 20px; font-size: 13px; color: #999; }
    .retry a { color: #1a73e8; text-decoration: none; }
    .error-hint { color: #999; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ 服务暂时不可用</h1>
    <p class="sub">所有后端服务均无法连接${errorHint}，请稍后再试</p>
    ${rows ? `<table><thead><tr><th>域名</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <div class="retry">5 秒后将自动重试 · <a href="javascript:location.reload()">立即重试</a></div>
  </div>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`;
}
