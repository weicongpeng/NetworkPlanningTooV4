/** 桌面登录守卫：授权失效必须退出，网络离线不得误踢。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const { authState, sessionStatus, toastShow } = vi.hoisted(() => ({
  authState: {
    desktopMode: true,
    isAuthenticated: true,
    logout: vi.fn(),
    setDesktopOffline: vi.fn(),
    applyServerUser: vi.fn(),
  },
  sessionStatus: vi.fn(),
  toastShow: vi.fn(),
}))

vi.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}))

vi.mock('../../store/toastStore', () => ({
  useToastStore: { getState: () => ({ show: toastShow }) },
}))

vi.mock('../../services/api', () => ({
  desktopCloudApi: { getSessionStatus: sessionStatus },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: any) => {
      const text = typeof options === 'string'
        ? options
        : options?.defaultValue ?? _key
      return text.replace('{{message}}', options?.message ?? '')
    },
  }),
}))

import { DesktopSessionGuard } from '../DesktopSessionGuard'

describe('DesktopSessionGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('授权被禁用时提示并退出登录', async () => {
    sessionStatus.mockResolvedValue({
      success: true,
      data: { valid: true, license_error: '该授权已被禁用，请联系管理员' },
    })

    render(<DesktopSessionGuard />)

    await waitFor(() => expect(authState.logout).toHaveBeenCalledTimes(1))
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('该授权已被禁用'),
    )
  })

  it('本机会话失效时退出登录', async () => {
    sessionStatus.mockResolvedValue({
      success: true,
      data: { valid: false, reason: '该账号已在其它设备登录' },
    })

    render(<DesktopSessionGuard />)

    await waitFor(() => expect(authState.logout).toHaveBeenCalledTimes(1))
  })

  it('断网离线时保持登录', async () => {
    sessionStatus.mockResolvedValue({
      success: true,
      data: { valid: true, offline: true },
    })

    render(<DesktopSessionGuard />)

    await waitFor(() => expect(authState.setDesktopOffline).toHaveBeenCalledWith(true))
    expect(authState.logout).not.toHaveBeenCalled()
  })
})
