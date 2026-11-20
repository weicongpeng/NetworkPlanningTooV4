/**
 * 桌面壳 dev URL 开关的纯计算逻辑。单独成模块以便直接单测：
 * vite.config.ts 导入 vite 会连带 esbuild，在 jsdom 测试环境下无法加载。
 *
 * 只在 serve 阶段生效；build 与普通 dev 完全保持原有的 8000 路径。
 */
export interface ViteDevOptions {
  desktopDev: boolean
  backendPort: string
  backendHttp: string
  backendWs: string
  apiUrl: string
}

type Env = Record<string, string | undefined>

export function resolveViteDevOptions(
  command: 'serve' | 'build',
  env: Env,
): ViteDevOptions {
  const desktopDev = command === 'serve' && Boolean(env.NPT_DESKTOP_DEV_URL)
  const backendPort = desktopDev ? (env.NPT_DEV_BACKEND_PORT || '18789') : '8000'
  const backendHttp = `http://localhost:${backendPort}`
  const backendWs = `ws://localhost:${backendPort}`
  // uploadClient 在 dev 下直连后端而不走 proxy，也要指向同一个端口
  const apiUrl = env.VITE_API_URL || `http://127.0.0.1:${backendPort}/api/v1`
  return { desktopDev, backendPort, backendHttp, backendWs, apiUrl }
}
