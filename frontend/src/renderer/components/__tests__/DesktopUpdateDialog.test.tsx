/**
 * DesktopUpdateDialog：跨版本更新提示 + 静默预下载回归。
 *
 * 回归点：
 * 1（历史事故）上次自动更新目标 0.0.37 安装失败后，服务器已推 0.0.39，
 *   弹窗不得再提示"可手动运行 0.0.37 安装包"——那是中间版本，安装包是完整安装，
 *   直接更新到最新版即可，不能引导用户先装中间版本再装新版本。
 *   只有失败目标 == 本次推送版本时，才保留手动安装提示。
 * 2 发现可更新且尚无下载任务时**静默自动下载**安装包（用户不必点「立即更新」），
 *   下载完成后由 DesktopUpdateReadyDialog 弹窗提示安装；已在下载/已就绪不重复启动。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import i18n from '../../i18n'

vi.mock('../../services/api', () => ({
  desktopUpdateApi: {
    status: vi.fn(),
    progress: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    background: vi.fn(),
  },
}))

// 桌面形态
const desktopModeState = { desktopMode: true }
vi.mock('../../store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel(desktopModeState),
}))
const storeState: Record<string, unknown> = {
  mainDialogVisible: false,
  requested: null,
  clearRequest: vi.fn(),
  setMainDialogVisible: vi.fn(),
}
vi.mock('../../store/desktopUpdateStore', () => ({
  useDesktopUpdateStore: (sel: (s: unknown) => unknown) => sel(storeState),
}))

import { DesktopUpdateDialog } from '../DesktopUpdateDialog'
import { desktopUpdateApi } from '../../services/api'

const MANUAL_HINT = i18n.t('desktopUpdate.manualInstallHint')

/** 走「系统设置 → 检查更新」的交接入口（store.requested），弹窗立即渲染，不必等 8 秒定时器 */
function openDialog(
  lastTargetVersion: string,
  releaseVersion: string,
  downloadPhase: 'idle' | 'downloading' | 'ready' = 'idle',
) {
  storeState.requested = {
    current: '0.0.36',
    channel: 'stable',
    update_available: true,
    release: {
      id: 1,
      version: releaseVersion,
      channel: 'stable',
      update_available: true,
      download_url: `/api/v1/desktop-cloud/releases/download/1`,
    },
    download: { phase: downloadPhase, downloaded: 0, total: 0 },
    last_result: {
      target_version: lastTargetVersion,
      current_version: '0.0.36',
      applied: false,
      needs_manual: true,
      setup_rc: '1',
      installer: `C:\\updates\\NetOpt Engine_Setup-${lastTargetVersion}.exe`,
    },
  }
  render(<DesktopUpdateDialog />)
}

describe('DesktopUpdateDialog 跨版本更新提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    storeState.requested = null
  })
  afterEach(() => cleanup())

  it('失败目标(0.0.37)比推送版本(0.0.39)旧：不提示中间版本安装包，直接更新到最新版', () => {
    openDialog('0.0.37', '0.0.39')
    // 新版本弹窗正常展示
    expect(screen.getByText('0.0.39')).toBeTruthy()
    // 中间版本的手动安装提示不再出现
    expect(screen.queryByText(MANUAL_HINT, { exact: false })).toBeNull()
    expect(
      screen.queryByText(i18n.t('desktopUpdate.installNotApplied', { target: '0.0.37', current: '0.0.36' }), {
        exact: false,
      })
    ).toBeNull()
  })

  it('失败目标就是本次推送版本：保留手动安装提示（用户可手动运行安装包）', () => {
    openDialog('0.0.39', '0.0.39')
    expect(screen.getByText(MANUAL_HINT, { exact: false })).toBeTruthy()
    expect(
      screen.getByText(i18n.t('desktopUpdate.installNotApplied', { target: '0.0.39', current: '0.0.36' }), {
        exact: false,
      })
    ).toBeTruthy()
  })

  it('发现更新且无下载任务：静默自动下载安装包', async () => {
    vi.mocked(desktopUpdateApi.download).mockResolvedValue({ success: true } as any)
    openDialog('0.0.37', '0.0.39')
    await waitFor(() => expect(desktopUpdateApi.download).toHaveBeenCalled())
    expect(desktopUpdateApi.download).toHaveBeenCalledWith('0.0.39')
  })

  it('已在下载/已就绪：不重复启动下载', async () => {
    vi.mocked(desktopUpdateApi.download).mockResolvedValue({ success: true } as any)
    openDialog('0.0.37', '0.0.39', 'downloading')
    await new Promise((r) => setTimeout(r, 20))
    expect(desktopUpdateApi.download).not.toHaveBeenCalled()
    cleanup()
    openDialog('0.0.37', '0.0.39', 'ready')
    await new Promise((r) => setTimeout(r, 20))
    expect(desktopUpdateApi.download).not.toHaveBeenCalled()
  })
})
