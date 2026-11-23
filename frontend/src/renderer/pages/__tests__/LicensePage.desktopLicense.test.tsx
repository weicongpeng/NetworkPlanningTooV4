/** 系统设置：桌面端授权卡片已移除，页面只保留版本更新、语言、主题等设置。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

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
  desktopCloudApi: { getStatus: mocks.getCloudStatus },
  desktopUpdateApi: { status: vi.fn() },
}))

vi.mock('../../components/LLMConfigCard', () => ({ LLMConfigCard: () => null }))
vi.mock('../../components/DesktopUpdateReadyBanner', () => ({ DesktopUpdateReadyBanner: () => null }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh', changeLanguage: vi.fn() },
    t: (key: string, options?: any) => {
      const labels: Record<string, string> = {
        'license.title': '许可证与主题',
        'license.desktopTitle': '桌面端授权',
        'license.machineCodeLabel': '本机机器码',
        'desktopUpdate.versionTitle': '版本与更新',
        'language.title': '语言设置',
      }
      const text = labels[key] ?? key
      return options?.message ? text.replace('{{message}}', options.message) : text
    },
  }),
}))

import { LicensePage } from '../LicensePage'

describe('LicensePage 桌面端设置', () => {
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
  })

  it('桌面端不再渲染系统设置的桌面端授权卡片', async () => {
    render(<LicensePage />)

    await waitFor(() => expect(screen.getByText('版本与更新')).toBeTruthy())
    expect(screen.queryByText('桌面端授权')).toBeNull()
    expect(screen.queryByText('本机机器码')).toBeNull()
    expect(screen.queryByText('在线授权')).toBeNull()
    expect(screen.getByText('语言设置')).toBeTruthy()
  })
})
