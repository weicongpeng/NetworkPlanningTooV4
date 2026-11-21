/** 系统设置 → 桌面端授权：所有普通用户都能用授权码激活。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const auth = {
    user: { id: 2, username: 'alice', is_admin: false },
    fetchUser: vi.fn().mockResolvedValue(undefined),
    desktopMode: true,
  }
  return {
    auth,
    getMachineInfo: vi.fn(),
    getLicenseStatus: vi.fn(),
    getCloudStatus: vi.fn(),
    activate: vi.fn(),
  }
})

vi.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: typeof mocks.auth) => unknown) => selector ? selector(mocks.auth) : mocks.auth,
    { getState: () => mocks.auth },
  ),
}))

vi.mock('../../store/themeStore', () => ({
  useThemeStore: () => ({
    themeMode: 'dark',
    colorScheme: 'blue',
    setThemeMode: vi.fn(),
    setColorScheme: vi.fn(),
    applyTheme: vi.fn(),
  }),
  DARK_THEME_VARS: {},
  LIGHT_THEME_VARS: {},
  THEME_COLORS: { blue: {} },
  kebabCase: (value: string) => value,
}))

vi.mock('../../store/desktopUpdateStore', () => ({
  useDesktopUpdateStore: (selector: (s: { requestCheck: () => void }) => unknown) =>
    selector({ requestCheck: vi.fn() }),
}))

vi.mock('../../services/api', () => ({
  licenseApi: {
    getMachineInfo: mocks.getMachineInfo,
    getStatus: mocks.getLicenseStatus,
  },
  desktopCloudApi: {
    getStatus: mocks.getCloudStatus,
    activate: mocks.activate,
    renew: vi.fn(),
    apply: vi.fn(),
    pollApply: vi.fn(),
  },
  desktopUpdateApi: { status: vi.fn() },
}))

vi.mock('../../components/LLMConfigCard', () => ({ LLMConfigCard: () => null }))
vi.mock('../../components/DesktopUpdateReadyBanner', () => ({ DesktopUpdateReadyBanner: () => null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh', changeLanguage: vi.fn() },
    t: (key: string, options?: any) => {
      const labels: Record<string, string> = {
        'license.desktopTitle': '桌面端授权',
        'license.activationLabel': '授权码激活',
        'license.activationHint': '输入管理员发放的授权码后激活',
        'license.activationCodePlaceholder': '输入授权码（NPT-XXXX-XXXX-XXXX-XXXX）',
        'license.cloudActivateButton': '立即激活',
        'license.cloudLabel': '在线授权',
        'license.desktopStatusInactive': '未激活',
      }
      const text = labels[key] ?? key
      return options?.message ? text.replace('{{message}}', options.message) : text
    },
  }),
}))

import { LicensePage } from '../LicensePage'

describe('LicensePage 桌面端授权', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMachineInfo.mockResolvedValue({
      success: true,
      data: { machineCode: 'CFES-9784-FE67-013C', desktopMode: true },
    })
    mocks.getLicenseStatus.mockResolvedValue({ success: false })
    mocks.getCloudStatus.mockResolvedValue({
      success: true,
      data: {
        desktop: true,
        server_url: 'https://app.pengwc.asia',
        machine_code: 'CFES-9784-FE67-013C',
        version: '0.0.85',
        channel: 'stable',
        license: null,
        cloud: {},
      },
    })
    mocks.activate.mockResolvedValue({ success: true, message: '激活成功' })
  })

  it('普通用户不显示文件导入，改为授权码激活', async () => {
    const { container } = render(<LicensePage />)

    await waitFor(() => expect(screen.getByText('桌面端授权')).toBeTruthy())
    expect(screen.getByText('授权码激活')).toBeTruthy()
    expect(screen.getByText('输入管理员发放的授权码后激活')).toBeTruthy()
    expect(screen.queryByText('导入授权文件')).toBeNull()
    expect(container.querySelector('input[type="file"]')).toBeNull()
  })

  it('输入授权码后可提交激活', async () => {
    render(<LicensePage />)

    const input = await screen.findByPlaceholderText('输入授权码（NPT-XXXX-XXXX-XXXX-XXXX）')
    fireEvent.change(input, { target: { value: 'NPT-ABCD-EFGH-JKMN-PQRS' } })
    fireEvent.click(screen.getByRole('button', { name: /立即激活/ }))

    await waitFor(() =>
      expect(mocks.activate).toHaveBeenCalledWith('NPT-ABCD-EFGH-JKMN-PQRS'),
    )
    expect(await screen.findByText('激活成功')).toBeTruthy()
  })
})
