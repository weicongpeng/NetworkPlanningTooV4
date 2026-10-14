/**
 * DesktopUpdateReadyBanner：OTA 安装包下载完成后，「系统设置 → 版本」栏要出现
 * 「更新已就绪，重启后完成更新」提示与「立即重启」按钮（点击 = 拉起升级脚本并退出重启）。
 *
 * 回归点：
 * - 只有后端 phase='ready' 才出现（其它状态不出现，避免误报）
 * - 点「立即重启」调用 POST /desktop/update/install（与更新弹窗同一后端动作）
 * - 安装启动失败要出提示；而 code===0（连接被切断，应用正在退出）不算失败
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import i18n from '../../i18n'

vi.mock('../../services/api', () => ({
  desktopUpdateApi: {
    progress: vi.fn(),
    install: vi.fn(),
    status: vi.fn(),
    download: vi.fn(),
    background: vi.fn(),
  },
}))

import { DesktopUpdateReadyBanner } from '../DesktopUpdateReadyBanner'
import { desktopUpdateApi } from '../../services/api'

const READY_TEXT = i18n.t('desktopUpdate.updateReady')
const RESTART_TEXT = i18n.t('desktopUpdate.restartNow')

describe('DesktopUpdateReadyBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => cleanup())

  it('未下载完成（phase=idle / downloading）时不出现', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'downloading', downloaded: 1, total: 2 },
    } as any)
    render(<DesktopUpdateReadyBanner />)
    // 首轮同步完成后再断言（避免"还没查询就已经通过"的假阴性）
    await waitFor(() => expect(desktopUpdateApi.progress).toHaveBeenCalled())
    expect(screen.queryByText(READY_TEXT)).toBeNull()
    expect(screen.queryByText(RESTART_TEXT)).toBeNull()
  })

  it('phase=ready → 显示提示文案、目标版本与「立即重启」', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', version: '0.0.28', downloaded: 10, total: 10 },
    } as any)
    render(<DesktopUpdateReadyBanner />)

    expect(await screen.findByText(READY_TEXT)).toBeTruthy()
    expect(screen.getByText('0.0.28')).toBeTruthy()
    expect(screen.getByText(RESTART_TEXT)).toBeTruthy()
  })

  it('点击「立即重启」→ 调用 install（同一个"拉起升级脚本并退出"后端动作）', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', version: '0.0.28' },
    } as any)
    vi.mocked(desktopUpdateApi.install).mockResolvedValue({
      success: true, data: { exiting: true, message: '即将退出并安装新版本' },
    } as any)
    render(<DesktopUpdateReadyBanner />)

    fireEvent.click(await screen.findByText(RESTART_TEXT))
    await waitFor(() => expect(desktopUpdateApi.install).toHaveBeenCalledTimes(1))
    // 后端返回的提示原样展示，让用户知道应用即将退出
    expect(await screen.findByText('即将退出并安装新版本')).toBeTruthy()
  })

  it('安装启动失败（真实错误码）→ 显示错误提示，按钮恢复可用', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', version: '0.0.28' },
    } as any)
    vi.mocked(desktopUpdateApi.install).mockRejectedValue({ code: 500, message: '安装包校验失败' } as any)
    render(<DesktopUpdateReadyBanner />)

    fireEvent.click(await screen.findByText(RESTART_TEXT))
    expect(await screen.findByText('安装包校验失败')).toBeTruthy()
    expect((screen.getByText(RESTART_TEXT).closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('code===0（连接被切断＝应用正在退出安装）不算失败', async () => {
    vi.mocked(desktopUpdateApi.progress).mockResolvedValue({
      success: true, data: { phase: 'ready', version: '0.0.28' },
    } as any)
    vi.mocked(desktopUpdateApi.install).mockRejectedValue({ code: 0, message: 'Network Error' } as any)
    render(<DesktopUpdateReadyBanner />)

    fireEvent.click(await screen.findByText(RESTART_TEXT))
    await waitFor(() => expect(desktopUpdateApi.install).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Network Error')).toBeNull()
  })
})
