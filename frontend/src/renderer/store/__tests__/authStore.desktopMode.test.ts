import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  authApi: {
    desktopSession: vi.fn(),
  },
  systemApi: {
    info: vi.fn(),
    desktopMode: vi.fn(),
  },
}))

import { useAuthStore } from '../authStore'
import { authApi, systemApi } from '../../services/api'

describe('authStore 桌面形态探测', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
      desktopMode: false,
      desktopProbed: false,
      token: null,
      user: null,
      isAuthenticated: false,
    })
  })

  it('专用探测接口返回 {success,data} 包裹时识别桌面形态', async () => {
    vi.mocked(systemApi.desktopMode).mockResolvedValue({
      success: true,
      data: { desktop_mode: true },
    } as any)

    await useAuthStore.getState().probeDesktopMode()
    expect(useAuthStore.getState().desktopMode).toBe(true)
    expect(useAuthStore.getState().desktopProbed).toBe(true)
  })

  it('/system/info 返回裸模型（无 success/data 包裹）时也能识别桌面形态', async () => {
    // 该接口同时给手机 APP 做服务发现，响应是裸模型；专用接口不可用时兜底解析
    vi.mocked(systemApi.desktopMode).mockRejectedValue(new Error('no route'))
    vi.mocked(systemApi.info).mockResolvedValue({
      version: '1.0.0',
      backend_ip: '127.0.0.1',
      backend_port: 8000,
      desktop_mode: true,
    } as any)

    await useAuthStore.getState().probeDesktopMode()
    expect(useAuthStore.getState().desktopMode).toBe(true)
    expect(useAuthStore.getState().desktopProbed).toBe(true)
  })

  it('服务器版没有 desktop_mode 时按网页版处理', async () => {
    vi.mocked(systemApi.info).mockResolvedValue({
      version: '1.0.0',
      backend_ip: '192.168.1.1',
      backend_port: 8000,
      desktop_mode: false,
    } as any)

    await useAuthStore.getState().probeDesktopMode()
    expect(useAuthStore.getState().desktopMode).toBe(false)
  })

  it('免登录会话写入登录态', async () => {
    vi.mocked(authApi.desktopSession).mockResolvedValue({
      success: true,
      data: { access_token: 'tok', user: { username: 'owner' } },
    } as any)

    await useAuthStore.getState().desktopAutoLogin()
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().token).toBe('tok')
  })

  it('免登录会话失败时保留桌面形态并暴露原因（不静默回落到登录页）', async () => {
    vi.mocked(authApi.desktopSession).mockRejectedValue({ message: '404 Not Found' })
    useAuthStore.setState({ desktopMode: true, desktopError: null })

    await expect(useAuthStore.getState().desktopAutoLogin()).rejects.toBeTruthy()
    // 关键：不能把 desktopMode 置 false，否则界面会静默变回登录页，用户无从排查
    expect(useAuthStore.getState().desktopMode).toBe(true)
    expect(useAuthStore.getState().desktopError).toContain('404')
  })

  it('探测接口两种形状都认（专用接口优先，裸模型兜底）', async () => {
    vi.mocked(systemApi.desktopMode).mockRejectedValue(new Error('no route'))
    vi.mocked(systemApi.info).mockResolvedValue({ desktop_mode: true } as any)

    await useAuthStore.getState().probeDesktopMode()
    expect(useAuthStore.getState().desktopMode).toBe(true)
  })
})
