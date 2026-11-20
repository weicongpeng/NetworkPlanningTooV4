/**
 * 自助修改密码弹窗回归点：
 * - 成功后 changePassword(旧, 新, 确认) 并 logout 回到登录页（用新密码重新登录）
 * - 桌面端额外清掉「记住账号密码」里已失效的旧密码，避免下次自动登录拿旧密码重试
 * - 旧密码错误等失败时展示错误、不退出登录
 * - 前端校验不通过时不发请求
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { changePasswordMock, logoutMock, deleteLastLoginMock } = vi.hoisted(() => ({
  changePasswordMock: vi.fn(),
  logoutMock: vi.fn(),
  deleteLastLoginMock: vi.fn(),
}))

vi.mock('../../services/api', () => ({
  authApi: { logout: vi.fn(), changePassword: vi.fn(), getMe: vi.fn() },
  desktopLoginApi: { deleteLastLogin: deleteLastLoginMock },
  systemApi: { desktopMode: vi.fn(), info: vi.fn() },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

import { ChangePasswordDialog } from '../ChangePasswordDialog'
import { useAuthStore } from '../../store/authStore'

function fillAndSubmit(oldPw: string, newPw: string, confirmPw: string) {
  const inputs = document.querySelectorAll('input[type="password"]')
  fireEvent.change(inputs[0], { target: { value: oldPw } })
  fireEvent.change(inputs[1], { target: { value: newPw } })
  fireEvent.change(inputs[2], { target: { value: confirmPw } })
  fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
}

describe('ChangePasswordDialog', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    changePasswordMock.mockResolvedValue(undefined)
    logoutMock.mockResolvedValue(undefined)
    deleteLastLoginMock.mockResolvedValue({ success: true, data: null })
    useAuthStore.setState({
      desktopMode: false,
      changePassword: changePasswordMock as any,
      logout: logoutMock as any,
    })
  })

  afterEach(() => cleanup())

  it('修改成功后退出登录回到登录页（网页端不动桌面凭据）', async () => {
    render(<ChangePasswordDialog open onClose={onClose} />)
    fillAndSubmit('old123', 'new456', 'new456')
    await waitFor(() => expect(changePasswordMock).toHaveBeenCalledWith('old123', 'new456', 'new456'))
    expect(logoutMock).toHaveBeenCalledTimes(1)
    expect(deleteLastLoginMock).not.toHaveBeenCalled()
  })

  it('桌面端修改成功后清除已失效的记住密码', async () => {
    useAuthStore.setState({ desktopMode: true })
    render(<ChangePasswordDialog open onClose={onClose} />)
    fillAndSubmit('old123', 'new456', 'new456')
    await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1))
    expect(deleteLastLoginMock).toHaveBeenCalledTimes(1)
  })

  it('旧密码错误时展示错误且不退出登录', async () => {
    changePasswordMock.mockRejectedValue(new Error('旧密码错误'))
    render(<ChangePasswordDialog open onClose={onClose} />)
    fillAndSubmit('wrong', 'new456', 'new456')
    await waitFor(() => expect(screen.queryByText('旧密码错误')).not.toBeNull())
    expect(logoutMock).not.toHaveBeenCalled()
  })

  it('新密码少于6位时不发请求', () => {
    render(<ChangePasswordDialog open onClose={onClose} />)
    fillAndSubmit('old123', '123', '123')
    expect(changePasswordMock).not.toHaveBeenCalled()
    expect(screen.queryByText('密码长度至少6位')).not.toBeNull()
  })
})
