import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

// 提示音在 jsdom 里没有 Web Audio，静默 mock 掉（不影响气泡时序断言）
vi.mock('../../../utils/knockSound', () => ({
  playKnockSound: vi.fn(),
}))

// 登录态：只用到 getState().user?.id，避免拉起真实 store 的副作用
const { authState } = vi.hoisted(() => ({ authState: { user: null as { id: number } | null } }))
vi.mock('../../../store/authStore', () => ({
  useAuthStore: { getState: () => authState },
}))

import { UserOnlineBubble } from '../UserOnlineBubble'
import { usePresenceStore } from '../../../store/presenceStore'
import { USER_ONLINE_EVENT } from '../../../services/websocketService'

/** 模拟服务端 WebSocket 推送一条上线事件 */
function dispatchOnline(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(USER_ONLINE_EVENT, { detail }))
}

describe('UserOnlineBubble（用户上线气泡）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePresenceStore.setState({ notice: null })
    authState.user = null
    // seenEventIds 是模块级持久状态，各用例用不同 eventId 避免相互干扰
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('自身登录不弹气泡（前端兜底过滤上线者 id）', () => {
    authState.user = { id: 7 }
    render(<UserOnlineBubble />)
    act(() => {
      dispatchOnline({ eventId: 'self-1', userId: 7, text: '河源_电信 admin' })
    })
    expect(usePresenceStore.getState().notice).toBeNull()
    expect(screen.queryByText('河源_电信 admin')).toBeNull()
  })

  it('其他用户上线才弹气泡', () => {
    authState.user = { id: 7 }
    render(<UserOnlineBubble />)
    act(() => {
      dispatchOnline({ eventId: 'other-1', userId: 8, text: '梅州_移动 zhangsan' })
    })
    expect(screen.getByText('梅州_移动 zhangsan')).toBeTruthy()
  })

  it('展示上线文案', () => {
    usePresenceStore.setState({
      notice: { eventId: 'e1', text: '河源_电信 admin', userId: 1, username: 'admin' },
    })
    render(<UserOnlineBubble />)
    expect(screen.getByText('河源_电信 admin')).toBeTruthy()
  })

  it('停留 5 秒后才开始渐变消失', () => {
    usePresenceStore.setState({
      notice: { eventId: 'e2', text: '河源_电信 admin' },
    })
    render(<UserOnlineBubble />)
    const bubble = screen.getByText('河源_电信 admin').parentElement!.parentElement!

    // 4.9 秒时仍完全可见
    act(() => { vi.advanceTimersByTime(4900) })
    expect(bubble.style.opacity).toBe('1')

    // 到 5 秒开始渐变（opacity 交给 CSS transition 过渡）
    act(() => { vi.advanceTimersByTime(200) })
    expect(bubble.style.opacity).toBe('0')
  })

  it('5.5 秒后从 store 中清除', () => {
    usePresenceStore.setState({
      notice: { eventId: 'e3', text: '河源_电信 admin' },
    })
    render(<UserOnlineBubble />)

    act(() => { vi.advanceTimersByTime(4900) })
    expect(usePresenceStore.getState().notice).not.toBeNull()

    // 5s 渐变 + 0.5s 过渡后清空
    act(() => { vi.advanceTimersByTime(600) })
    expect(usePresenceStore.getState().notice).toBeNull()
  })

  it('没有提醒时不渲染任何内容', () => {
    const { container } = render(<UserOnlineBubble />)
    expect(container.firstChild).toBeNull()
  })
})
