/** 移动端分发面板：APK 列表、目录自动登记提示、设最新走 app-versions 接口。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const i18n = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
}))

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}))

vi.mock('../../services/api', () => ({
  appVersionsApi: {
    list: apiMocks.list,
    update: apiMocks.update,
    delete: apiMocks.delete,
    upload: apiMocks.upload,
  },
}))
vi.mock('../../utils/parallelDownload', () => ({ parallelDownload: vi.fn() }))

import { MobileReleasesPage } from '../MobileReleasesPage'

describe('移动端分发面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.list.mockResolvedValue({
      success: true,
      data: {
        total: 1,
        items: [{
          id: 7,
          version: '1.2.0',
          changelog: '修复',
          apk_filename: 'app-1.2.0.apk',
          file_size: 1024,
          file_size_display: '1.0 KB',
          file_time: '2026-01-01T00:00:00+00:00',
          is_latest: false,
          download_count: 0,
          created_at: '2026-01-01T00:00:00Z',
        }],
      },
    })
    apiMocks.update.mockResolvedValue({})
  })

  it('加载 APK 列表并展示自动登记提示，设最新走 app-versions 接口', async () => {
    render(<MobileReleasesPage />)

    await waitFor(() => expect(screen.getByText('1.2.0')).toBeTruthy())
    expect(screen.getByText('versionManagement.timeColumn')).toBeTruthy()
    expect(screen.getByText('versionManagement.mobileImportHint')).toBeTruthy()

    fireEvent.click(screen.getByTitle('desktopReleases.setLatest'))
    await waitFor(() => expect(apiMocks.update).toHaveBeenCalledWith(7, { is_latest: true }))
  })

  it('自动加载的包版本号为空时提示用户配置', async () => {
    apiMocks.list.mockResolvedValueOnce({
      success: true,
      data: {
        total: 1,
        items: [{
          id: 8,
          version: '',
          changelog: '',
          apk_filename: 'app-release.apk',
          file_size: 1024,
          file_size_display: '1.0 KB',
          file_time: '2026-01-01T00:00:00+00:00',
          is_latest: true,
          download_count: 0,
          created_at: '2026-01-01T00:00:00Z',
        }],
      },
    })

    render(<MobileReleasesPage />)

    await waitFor(() => expect(screen.getByText('versionManagement.versionUnset')).toBeTruthy())
  })
})
