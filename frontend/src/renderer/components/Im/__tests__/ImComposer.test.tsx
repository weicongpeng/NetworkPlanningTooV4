/** 输入区交互：粘贴/选图/截图只入待发送队列，统一由发送按钮或 Enter 提交。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        return String(arg.defaultValue ?? key).replace(
          /\{\{(\w+)\}\}/g, (_match: string, name: string) => String(arg[name] ?? ''))
      }
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../../services/api', () => ({
  IM_CHUNK_SIZE: 512 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    uploadAttachment: vi.fn(), downloadAttachment: vi.fn(), attachmentBlob: vi.fn(),
  },
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: number } }) => unknown) =>
    selector({ user: { id: 1 } }),
}))

import { useImStore } from '../../../store/imStore'
import { ImComposer } from '../ImComposer'
import {
  applyScreenshotSettings, DEFAULT_SCREENSHOT_SETTINGS, getScreenshotSettings,
} from '../screenshotSettings'

function mockState() {
  return {
    activeConversationId: 7,
    draftFor: vi.fn(() => ''),
    setDraft: vi.fn(),
    sendText: vi.fn().mockResolvedValue(true),
    sendFiles: vi.fn().mockResolvedValue([]),
    clearError: vi.fn(),
    pendingScreenshot: null,
    takeScreenshot: vi.fn(() => null),
    sending: false, uploadProgress: null, error: null,
  }
}

const MEMBERS = [
  { id: 1, username: 'alice', is_online: true, city: '', operator: '', role: 'owner' },
  { id: 2, username: 'bob', is_online: true, city: '', operator: '', role: 'member' },
  { id: 3, username: 'carol', is_online: false, city: '', operator: '', role: 'member' },
]

function setGroup(kind: 'custom_group' | 'direct' = 'custom_group', myRole = 'member') {
  // setState 是 merge：只覆盖会话/成员相关字段，保留 beforeEach 里的 sendText 等 spy
  useImStore.setState({
    conversations: [{
      id: 7, kind, name: '协作群', group_key: null, other_user: null,
      member_count: 3, last_message: null, last_message_at: null, unread: 0, muted: false,
    }],
    membersByConversation: {
      7: MEMBERS.map(m => m.id === 1 ? { ...m, role: myRole } : m),
    },
    ensureMembers: vi.fn().mockResolvedValue(MEMBERS),
    invalidateMembers: vi.fn(),
  } as unknown as Partial<ReturnType<typeof useImStore.getState>>)
}

describe('协作沟通输入区', () => {
  let state: ReturnType<typeof mockState>

  beforeEach(() => {
    vi.clearAllMocks()
    state = mockState()
    useImStore.setState(state as unknown as Partial<ReturnType<typeof useImStore.getState>>)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => 'blob:mock'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, value: vi.fn(),
    })
  })

  it('粘贴图片只进入待发送列表，点「发送消息」后才提交', async () => {
    render(<ImComposer conversationId={7} />)
    const textarea = screen.getByPlaceholderText(/输入消息/)
    const file = new File(['img'], 'shot.png', { type: 'image/png' })

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    })
    expect(state.sendFiles).not.toHaveBeenCalled()
    expect(screen.getByText('待发送附件 · 1')).toBeTruthy()
    expect(screen.getByText('shot.png')).toBeTruthy()

    fireEvent.click(screen.getByTitle('发送消息'))
    await waitFor(() => expect(state.sendFiles).toHaveBeenCalledWith([file]))
    expect(screen.queryByText('待发送附件 · 1')).toBeNull()
  })

  it('输入 / 粘贴文字只留草稿，按 Enter 才发送', () => {
    render(<ImComposer conversationId={7} />)
    const textarea = screen.getByPlaceholderText(/输入消息/)
    fireEvent.change(textarea, { target: { value: '你好' } })
    expect(state.sendText).not.toHaveBeenCalled()
    expect(state.sendFiles).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(state.sendText).toHaveBeenCalledWith('你好')
  })

  it('点击剪刀按钮派发全局截图事件，输入框自身不渲染弹窗、不抓屏、不发送', () => {
    const getDisplayMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true, value: { getDisplayMedia },
    })
    const onScreenshot = vi.fn()
    window.addEventListener('npt:screenshot-open', onScreenshot)
    const { container } = render(<ImComposer conversationId={7} />)

    const button = screen.getByTitle(/截图（Alt\+Z）/)
    expect(button.querySelector('svg')).toBeTruthy()
    fireEvent.click(button)
    expect(onScreenshot).toHaveBeenCalledTimes(1)
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(state.sendFiles).not.toHaveBeenCalled()
    // 截图弹窗已提到 ImHost 应用级挂载，输入区不再自带 fixed 遮罩
    expect(container.querySelector('.fixed.inset-0')).toBeNull()
    window.removeEventListener('npt:screenshot-open', onScreenshot)
  })

  it('全局截图产出的 File 由 imStore 队列自动加载为待发送附件', async () => {
    const file = new File(['png'], 'screenshot.png', { type: 'image/png' })
    useImStore.setState({
      pendingScreenshot: file,
      takeScreenshot: vi.fn(() => file),
    } as unknown as Partial<ReturnType<typeof useImStore.getState>>)
    render(<ImComposer conversationId={7} />)
    expect(screen.getByText('待发送附件 · 1')).toBeTruthy()
    expect(screen.getByText('screenshot.png')).toBeTruthy()
    expect(state.sendFiles).not.toHaveBeenCalled() // 仍需用户点发送
  })

  it('群聊输入 @ 弹出成员候选并随键入过滤，且排除自己', () => {
    setGroup()
    render(<ImComposer conversationId={7} />)
    const textarea = screen.getByPlaceholderText(/输入消息/)

    fireEvent.change(textarea, { target: { value: '@' } })
    expect(screen.getByText('选择要 @ 的成员')).toBeTruthy()
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.getByText('carol')).toBeTruthy()
    expect(screen.queryByText('alice')).toBeNull()

    fireEvent.change(textarea, { target: { value: '@bo' } })
    expect(screen.getByText('bob')).toBeTruthy()
    expect(screen.queryByText('carol')).toBeNull()
  })

  it('回车选中候选只插入 @文本，再次回车才携带结构化 mentions 发送', async () => {
    setGroup()
    render(<ImComposer conversationId={7} />)
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '@bo' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(textarea.value).toBe('@bob ')
    expect(state.sendText).not.toHaveBeenCalled() // 选候选不误发消息

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    await waitFor(() => expect(state.sendText).toHaveBeenCalledWith(
      '@bob', { mentions: [2], mention_all: false }))
  })

  it('@所有人 仅群主/群管理员可见，普通成员看不到', () => {
    setGroup('custom_group', 'owner')
    const { unmount } = render(<ImComposer conversationId={7} />)
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '@所有' } })
    expect(screen.getByText('@所有人')).toBeTruthy()
    unmount()

    setGroup('custom_group', 'member')
    render(<ImComposer conversationId={7} />)
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '@所有' } })
    expect(screen.queryByText('@所有人')).toBeNull()
  })

  it('单聊不触发 @ 下拉', () => {
    setGroup('direct')
    render(<ImComposer conversationId={7} />)
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: '@' } })
    expect(screen.queryByText('选择要 @ 的成员')).toBeNull()
  })

  it('截图按钮下拉提供「隐藏窗口截图」与「设置」入口', () => {
    const onSettings = vi.fn()
    window.addEventListener('npt:screenshot-settings', onSettings)
    render(<ImComposer conversationId={7} />)
    expect(screen.queryByText('隐藏窗口截图')).toBeNull()

    fireEvent.click(screen.getByTitle('截图选项'))
    expect(screen.getByText('隐藏窗口截图')).toBeTruthy()
    expect(screen.getByText('截图设置')).toBeTruthy()

    fireEvent.click(screen.getByText('截图设置'))
    expect(onSettings).toHaveBeenCalledTimes(1)
    window.removeEventListener('npt:screenshot-settings', onSettings)
  })

  it('下拉切换「隐藏窗口截图」会持久化并同步勾选状态', async () => {
    applyScreenshotSettings(DEFAULT_SCREENSHOT_SETTINGS)
    render(<ImComposer conversationId={7} />)
    fireEvent.click(screen.getByTitle('截图选项'))
    const item = screen.getByText('隐藏窗口截图').closest('button') as HTMLButtonElement
    expect(item.querySelector('.lucide-check')).toBeNull()

    fireEvent.click(item)
    await waitFor(() => expect(getScreenshotSettings().hideImWindow).toBe(true))
    // 菜单点完即收起；重新展开时勾选状态仍与共享配置同步
    fireEvent.click(screen.getByTitle('截图选项'))
    expect(screen.getByText('隐藏窗口截图').closest('button')?.querySelector('.lucide-check'))
      .toBeTruthy()
    applyScreenshotSettings(DEFAULT_SCREENSHOT_SETTINGS)
  })
})
