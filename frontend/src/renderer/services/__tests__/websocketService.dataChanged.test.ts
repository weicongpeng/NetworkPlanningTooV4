/**
 * 服务器「同组数据变更」推送（data_changed）的前端处理。
 *
 * 背景：桌面端/同组用户写入数据后，网页端此前必须手动刷新才能看到；
 * 服务器在数据集修订号推进时通过 WebSocket 向同组连接广播 data_changed，
 * 前端收到后走统一刷新（triggerDataRefresh，内部清小区列表缓存并广播事件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { triggerDataRefreshMock } = vi.hoisted(() => ({
  triggerDataRefreshMock: vi.fn(),
}))

vi.mock('../../store/dataStore', () => ({
  triggerDataRefresh: triggerDataRefreshMock,
}))

import { websocketService } from '../websocketService'

describe('WebSocket data_changed 事件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('收到 data_changed 时触发全量数据刷新', async () => {
    // 直接调用私有 handleMessage（不经真实连接），验证事件分发链路
    ;(websocketService as any).handleMessage({ type: 'data_changed', taskId: '', data: { dataId: 'ds-1' } })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(triggerDataRefreshMock).toHaveBeenCalledWith('full')
  })

  it('其他消息类型不触发数据刷新', async () => {
    ;(websocketService as any).handleMessage({ type: 'pong', taskId: '' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(triggerDataRefreshMock).not.toHaveBeenCalled()
  })
})
