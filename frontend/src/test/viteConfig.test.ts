/** 桌面 dev URL 开关：确保只在 serve 生效，build 与普通 dev 路径完全不变。 */
import { describe, expect, it } from 'vitest'
import { resolveViteDevOptions } from '../../viteDevOptions'

describe('桌面壳 dev URL 开关', () => {
  it('未设置开关时 serve 与 build 都保持原有 8000 路径', () => {
    const env = {}
    expect(resolveViteDevOptions('serve', env)).toEqual({
      desktopDev: false,
      backendPort: '8000',
      backendHttp: 'http://localhost:8000',
      backendWs: 'ws://localhost:8000',
      apiUrl: 'http://127.0.0.1:8000/api/v1',
    })
    expect(resolveViteDevOptions('build', { NPT_DESKTOP_DEV_URL: 'http://127.0.0.1:5173' }))
      .toEqual({
        desktopDev: false,
        backendPort: '8000',
        backendHttp: 'http://localhost:8000',
        backendWs: 'ws://localhost:8000',
        apiUrl: 'http://127.0.0.1:8000/api/v1',
      })
  })

  it('设置开关后 serve 代理到 launcher 端口并覆盖上传直连地址', () => {
    const options = resolveViteDevOptions('serve', {
      NPT_DESKTOP_DEV_URL: 'http://127.0.0.1:5173',
    })
    expect(options.desktopDev).toBe(true)
    expect(options.backendHttp).toBe('http://localhost:18789')
    expect(options.backendWs).toBe('ws://localhost:18789')
    expect(options.apiUrl).toBe('http://127.0.0.1:18789/api/v1')
  })

  it('端口可覆盖，显式 VITE_API_URL 优先于自动推导', () => {
    const options = resolveViteDevOptions('serve', {
      NPT_DESKTOP_DEV_URL: 'http://127.0.0.1:5173',
      NPT_DEV_BACKEND_PORT: '19000',
      VITE_API_URL: 'http://127.0.0.1:19001/api/v1',
    })
    expect(options.backendPort).toBe('19000')
    expect(options.backendHttp).toBe('http://localhost:19000')
    expect(options.apiUrl).toBe('http://127.0.0.1:19001/api/v1')
  })
})
