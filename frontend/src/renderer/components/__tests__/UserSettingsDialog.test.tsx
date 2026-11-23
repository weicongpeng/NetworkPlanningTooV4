/** 项目沟通左下角设置：桌面端显示本地存储卡片，网页端隐藏，路径与清理可操作。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  state: vi.fn(), setPath: vi.fn(), clean: vi.fn(), pick: vi.fn(),
  clearCache: vi.fn(), show: vi.fn(), refresh: vi.fn(),
  desktopMode: false,
}))

vi.mock('../../services/api', () => ({
  clearImAttachmentCache: mocks.clearCache,
  desktopLoginApi: {
    imStorageState: mocks.state,
    imStorageSetPath: mocks.setPath,
    imStorageClean: mocks.clean,
    imStoragePickDirectory: mocks.pick,
    deleteLastLogin: vi.fn().mockResolvedValue({ success: true }),
  },
  imApi: { updateNickname: vi.fn(), updateAvatar: vi.fn() },
}))
vi.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({
      user: { id: 1, username: 'alice', nickname: '小张' },
      get desktopMode() { return mocks.desktopMode },
      changePassword: vi.fn(), logout: vi.fn(),
    }),
    { getState: () => ({}) },
  ),
}))
vi.mock('../../store/imStore', () => ({
  useImStore: Object.assign(
    () => ({}),
    { getState: () => ({
      refreshConversations: mocks.refresh, refreshContacts: mocks.refresh,
    }) },
  ),
}))
vi.mock('../../store/toastStore', () => ({
  useToastStore: Object.assign(() => ({}), { getState: () => ({ show: mocks.show }) }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      let text = typeof fallback === 'string' ? fallback : key
      Object.entries(options || {}).forEach(([name, value]) => {
        text = text.split(`{{${name}}}`).join(String(value))
      })
      return text
    },
  }),
}))

import { UserSettingsDialog } from '../UserSettingsDialog'

const storageState = {
  path: 'D:\\NPT\\聊天附件', default_path: 'C:\\Users\\alice\\AppData\\NetworkPlanningTool\\uploads\\im',
  customized: true, profile: 'shared',
  usage: { attachments: { files: 2, bytes: 2048 }, open_temp: { files: 1, bytes: 512 },
           total_files: 3, total_bytes: 2560 },
}

describe('UserSettingsDialog 本地存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.desktopMode = false
    mocks.state.mockResolvedValue({ success: true, data: storageState })
    mocks.setPath.mockResolvedValue({ success: true, data: storageState })
    mocks.clean.mockResolvedValue({
      success: true, data: { deleted_files: 3, freed_bytes: 2560, errors: [] },
    })
  })

  it('网页端不显示本地存储卡片', async () => {
    render(<UserSettingsDialog open mode="im" onClose={vi.fn()} />)
    expect(screen.queryByText('本地存储与缓存')).toBeNull()
    await waitFor(() => expect(mocks.state).not.toHaveBeenCalled())
  })

  it('桌面端显示路径与占用，应用路径后清理内存缓存', async () => {
    mocks.desktopMode = true
    render(<UserSettingsDialog open mode="im" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByDisplayValue(storageState.path)).toBeTruthy())
    expect(screen.getByText(/可清理缓存：3 个文件/)).toBeTruthy()

    const input = screen.getByDisplayValue(storageState.path)
    fireEvent.change(input, { target: { value: 'D:\\NPT\\新目录' } })
    fireEvent.click(screen.getByText('应用并迁移'))
    await waitFor(() => expect(mocks.setPath).toHaveBeenCalledWith('D:\\NPT\\新目录'))
    expect(mocks.clearCache).toHaveBeenCalled()
  })

  it('点击清理调用本机端点并汇总释放结果', async () => {
    mocks.desktopMode = true
    render(<UserSettingsDialog open mode="im" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('清理')).toBeTruthy())
    fireEvent.click(screen.getByText('清理'))
    await waitFor(() => expect(mocks.clean).toHaveBeenCalled())
    await waitFor(() => expect(mocks.show).toHaveBeenCalledWith(
      expect.stringContaining('已清理 3 个文件')))
    expect(mocks.clearCache).toHaveBeenCalled()
  })
})
