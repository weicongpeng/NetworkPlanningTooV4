/** 版本管理页：两个页签独立呈现；移动端分发走 app-versions 接口且保留自动登记提示。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const i18n = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
}))

const panels = vi.hoisted(() => ({
  desktop: vi.fn(() => null),
  mobile: vi.fn(() => null),
}))

vi.mock('../DesktopReleasesPage', () => ({ DesktopReleasesPage: () => panels.desktop() }))
vi.mock('../MobileReleasesPage', () => ({ MobileReleasesPage: () => panels.mobile() }))

import { VersionManagementPage } from '../VersionManagementPage'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <VersionManagementPage />
    </MemoryRouter>,
  )
}

describe('版本管理页签', () => {
  beforeEach(() => {
    panels.desktop.mockClear()
    panels.mobile.mockClear()
  })

  it('默认显示桌面端分发', () => {
    renderAt('/version-management')
    expect(screen.getByRole('tab', { name: 'versionManagement.desktopTab' }).getAttribute('aria-selected')).toBe('true')
    expect(panels.desktop).toHaveBeenCalled()
    expect(panels.mobile).not.toHaveBeenCalled()
  })

  it('tab=mobile 直接进入移动端分发', () => {
    renderAt('/version-management?tab=mobile')
    expect(screen.getByRole('tab', { name: 'versionManagement.mobileTab' }).getAttribute('aria-selected')).toBe('true')
    expect(panels.mobile).toHaveBeenCalled()
    expect(panels.desktop).not.toHaveBeenCalled()
  })

  it('点击页签切换面板', () => {
    renderAt('/version-management')
    fireEvent.click(screen.getByRole('tab', { name: 'versionManagement.mobileTab' }))
    expect(panels.mobile).toHaveBeenCalled()
  })
})
