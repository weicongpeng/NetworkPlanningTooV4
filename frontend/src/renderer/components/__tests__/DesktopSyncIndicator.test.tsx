/** 桌面同步驱动器：跨档冻结旧改动时给出丢弃/恢复入口。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { desktopState, syncState, resolveFrozen } = vi.hoisted(() => ({
  desktopState: { desktopMode: true, isAuthenticated: true, desktopRunMode: 'shared' },
  syncState: { status: null as any, startPolling: vi.fn(), stopPolling: vi.fn() },
  resolveFrozen: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof desktopState) => unknown) => selector(desktopState),
    { getState: () => desktopState },
  ),
}))
vi.mock('../../store/desktopSyncStore', () => ({
  useDesktopSyncStore: Object.assign(
    (selector?: (s: typeof syncState) => unknown) => selector ? selector(syncState) : syncState,
    { getState: () => syncState },
  ),
}))
vi.mock('../../services/api', () => ({
  desktopLoginApi: {
    setWindowTitle: vi.fn().mockResolvedValue({ success: true }),
    resolveFrozenChanges: resolveFrozen,
  },
}))
vi.mock('../desktopStatusLabel', () => ({
  useDesktopStatusLabel: () => ({ title: '共享模式 · 已同步' }),
}))

import { DesktopSyncIndicator } from '../DesktopSyncIndicator'

describe('DesktopSyncIndicator', () => {
  beforeEach(() => {
    resolveFrozen.mockClear()
    syncState.status = null
  })

  it('无冻结改动时不渲染确认条', () => {
    const { container } = render(<DesktopSyncIndicator />)
    expect(container.firstChild).toBeNull()
  })

  it('冻结旧改动时显示确认条，可丢弃或恢复', async () => {
    syncState.status = {
      frozen_local_changes: {
        frozen_at: '2026-11-20T10:00:00', reason: '切换到共享模式',
        datasets: { ds1: {} }, pending_deletes: [],
      },
    }
    render(<DesktopSyncIndicator />)
    expect(screen.getByText(/切换模式前的未同步改动已暂停/)).toBeTruthy()

    fireEvent.click(screen.getByText('丢弃'))
    await waitFor(() => expect(resolveFrozen).toHaveBeenCalledWith('discard'))
    fireEvent.click(screen.getByText('恢复并上传'))
    await waitFor(() => expect(resolveFrozen).toHaveBeenCalledWith('restore'))
  })
})
