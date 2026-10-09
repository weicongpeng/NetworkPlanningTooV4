/**
 * 桌面端登录页「记住账号密码」：
 * - 勾选（默认）时按本机保存的凭据自动登录一次
 * - 取消勾选时只预填、不自动登录
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const { loginMock, getLastLoginMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  getLastLoginMock: vi.fn(),
}))

vi.mock('../../services/api', () => ({
  authApi: { getOptions: vi.fn(), login: vi.fn() },
  desktopLoginApi: {
    login: vi.fn(),
    options: vi.fn().mockResolvedValue({ success: true, data: { cities: [], operators: [] } }),
    getLastLogin: getLastLoginMock,
    deleteLastLogin: vi.fn(),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
}))

import { LoginModal } from '../LoginModal'
import { useAuthStore } from '../../store/authStore'

describe('LoginModal 记住账号密码', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useAuthStore.setState({
      desktopMode: true,
      desktopProbed: true,
      token: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      desktopRunMode: null,
      desktopOffline: false,
      lastDesktopLogin: null,
      login: loginMock as any,
    })
  })

  it('勾选「记住」时按保存的凭据自动登录一次', async () => {
    getLastLoginMock.mockResolvedValue({
      success: true,
      data: { username: 'alice', password: 'pwd123', mode: 'standalone' },
    })
    loginMock.mockResolvedValue(null)

    render(<LoginModal isOpen onClose={() => {}} />)

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1))
    expect(loginMock).toHaveBeenCalledWith('alice', 'pwd123', 'standalone', true)
  })

  it('取消勾选「记住」时不自动登录（仅预填）', async () => {
    localStorage.setItem('npt-desktop-remember', '0')
    getLastLoginMock.mockResolvedValue({
      success: true,
      data: { username: 'alice', password: 'pwd123', mode: 'shared' },
    })

    render(<LoginModal isOpen onClose={() => {}} />)

    await waitFor(() => expect(getLastLoginMock).toHaveBeenCalled())
    // 给自动登录留出窗口期，确认没有触发
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(loginMock).not.toHaveBeenCalled()
  })
})
