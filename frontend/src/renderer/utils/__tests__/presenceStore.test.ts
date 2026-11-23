import { describe, it, expect, beforeEach } from 'vitest'
import { usePresenceStore } from '../../store/presenceStore'

describe('presenceStore（用户上线提醒）', () => {
  beforeEach(() => {
    usePresenceStore.setState({ notice: null })
  })

  it('show 写入提醒并保留文案', () => {
    usePresenceStore.getState().show({
      eventId: 'e1',
      text: '河源_电信 admin',
      userId: 1,
      username: 'admin',
    })
    const notice = usePresenceStore.getState().notice
    expect(notice).not.toBeNull()
    expect(notice!.text).toBe('河源_电信 admin')
    expect(notice!.eventId).toBe('e1')
  })

  it('同一 eventId 重复 show 只生效一次（登录响应 + WS 广播去重）', () => {
    const { show } = usePresenceStore.getState()
    show({ eventId: 'same-id', text: '河源_电信 admin' })
    const first = usePresenceStore.getState().notice
    expect(first).not.toBeNull()

    // 模拟服务端广播把同一事件再推一次
    show({ eventId: 'same-id', text: '河源_电信 admin' })
    const second = usePresenceStore.getState().notice
    // 仍是同一条（引用未变），说明第二次被忽略，没有重新触发动画
    expect(second).toBe(first)
  })

  it('不同 eventId 会覆盖为新提醒', () => {
    const { show } = usePresenceStore.getState()
    show({ eventId: 'e1', text: '河源_电信 admin' })
    show({ eventId: 'e2', text: '梅州_移动 zhangsan' })
    expect(usePresenceStore.getState().notice!.text).toBe('梅州_移动 zhangsan')
  })

  it('clear 清空提醒', () => {
    usePresenceStore.getState().show({ eventId: 'e3', text: '河源_电信 admin' })
    usePresenceStore.getState().clear()
    expect(usePresenceStore.getState().notice).toBeNull()
  })
})
