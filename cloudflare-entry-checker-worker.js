/**
 * Cloudflare Worker — go.pengwc.asia Entry Checker
 *
 * 智能跳转：优先跳转到 app.pengwc.asia，不可用时降级到 Tailscale Funnel。
 *
 * 部署路径: go.pengwc.asia
 */
export default {
  async fetch(request) {
    const APP_DOMAIN   = 'https://app.pengwc.asia';
    const TAILSCALE_DOMAIN = 'https://pwc-battle-ax-z790m-plus-d5.tail362392.ts.net';
    const COOKIE_NAME  = 'preferred_domain';

    // 1) 如果用户已经有偏好的 cookie，直接用
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) {
      const preferred = match[1];
      if (preferred === TAILSCALE_DOMAIN || preferred === APP_DOMAIN) {
        return Response.redirect(preferred, 302);
      }
    }

    // 2) 健康探测：检查 app.pengwc.asia 是否可达（超时 3s）
    let appHealthy = false;
    try {
      const probe = await fetch(APP_DOMAIN, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      appHealthy = probe.ok || probe.status === 302 || probe.status === 301;
    } catch {
      // 网络错误 / 超时 → 认定不可达
    }

    // 3) 选择目标
    const target = appHealthy ? APP_DOMAIN : TAILSCALE_DOMAIN;

    // 4) 302 跳转 + 设置 cookie（记住选择，后续请求绕过探测）
    const redirect = Response.redirect(target, 302);
    redirect.headers.append(
      'Set-Cookie',
      `${COOKIE_NAME}=${target}; Path=/; Max-Age=604800; SameSite=Lax`
    );
    return redirect;
  },
};
