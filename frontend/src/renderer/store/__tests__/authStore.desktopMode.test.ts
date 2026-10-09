import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  desktopLoginApi: {
    login: vi.fn(),
  },
  systemApi: {
    info: vi.fn(),
    desktopMode: vi.fn(),
  },
}))

import { useAuthStore } from '../authStore'
import { desktopLoginApi, systemApi } from '../../services/api'

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

  it('桌面端账号登录写入登录态与运行模式', async () => {
    vi.mocked(desktopLoginApi.login).mockResolvedValue({
      success: true,
      data: { access_token: 'tok', user: { username: 'alice' }, mode: 'shared' },
    } as any)

    await useAuthStore.getState().login('alice', 'pwd', 'shared')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().token).toBe('tok')
    expect(useAuthStore.getState().desktopRunMode).toBe('shared')
  })

  it('单机模式未授权时进入待批准态（不写登录态）', async () => {
    vi.mocked(desktopLoginApi.login).mockResolvedValue({
      success: true,
      data: { result: 'pending', status: 'pending' },
    } as any)

    await useAuthStore.getState().login('alice', 'pwd', 'standalone')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().desktopPendingUsername).toBe('alice')
    expect(useAuthStore.getState().desktopRunMode).toBe('standalone')
  })

  it('桌面端登录默认「记住账号密码」，显式关闭时传 remember=false', async () => {
    vi.mocked(desktopLoginApi.login).mockResolvedValue({
      success: true,
      data: { access_token: 'tok', user: { username: 'alice' }, mode: 'shared' },
    } as any)

    await useAuthStore.getState().login('alice', 'pwd', 'shared')
    expect(vi.mocked(desktopLoginApi.login)).toHaveBeenLastCalledWith(
      expect.objectContaining({ remember: true }),
    )

    await useAuthStore.getState().login('alice', 'pwd', 'shared', false)
    expect(vi.mocked(desktopLoginApi.login)).toHaveBeenLastCalledWith(
      expect.objectContaining({ remember: false }),
    )
  })

  it('管理员批准后 applyDesktopLogin 直接建立登录态', () => {
    useAuthStore.getState().applyDesktopLogin({
      access_token: 'tok2',
      user: { username: 'alice' },
      mode: 'standalone',
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().token).toBe('tok2')
    expect(useAuthStore.getState().desktopPendingUsername).toBeNull()
  })

  it('探测接口两种形状都认（专用接口优先，裸模型兜底）', async () => {
    vi.mocked(systemApi.desktopMode).mockRejectedValue(new Error('no route'))
    vi.mocked(systemApi.info).mockResolvedValue({ desktop_mode: true } as any)

    await useAuthStore.getState().probeDesktopMode()
    expect(useAuthStore.getState().desktopMode).toBe(true)
  })
})
