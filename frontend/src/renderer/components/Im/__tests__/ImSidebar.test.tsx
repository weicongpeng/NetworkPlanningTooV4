/** 通讯录群可见性与窄窗口切换回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        const values = arg as Record<string, unknown>
        return String(values.defaultValue ?? key).replace(
          /\{\{(\w+)\}\}/g, (_match: string, name: string) => String(values[name] ?? ''))
      }
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../../services/api', () => ({
  IM_CHUNK_SIZE: 2 * 1024 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    members: vi.fn(), uploadAttachment: vi.fn(), downloadAttachment: vi.fn(),
  },
}))

import { useImStore } from '../../../store/imStore'
import { ImSidebar } from '../ImSidebar'
import type { ImContactsData, ImGroup, ImUser } from '../types'

const joinedGroup: ImGroup = {
  id: 6, kind: 'custom_group', name: '三网沟通群', member_count: 3,
  is_auto: false, city: '', operator: '', joined: true,
}
const unjoinedGroup: ImGroup = {
  ...joinedGroup, id: 8, name: '别人的群', member_count: 5, joined: false,
}
const autoGroup: ImGroup = {
  id: 1, kind: 'auto_group', name: '河源 · 电信 协作群', member_count: 13,
  is_auto: true, city: '河源', operator: '电信', joined: true,
}
const contactUser: ImUser = {
  id: 11, username: 'zhangsan', nickname: '张三', is_online: true,
  city: '河源', operator: '电信',
}

function contacts(users: ImUser[] = []): ImContactsData {
  return {
    users, groups: [joinedGroup, unjoinedGroup, autoGroup],
    online_count: users.length, server_time: '',
  }
}

function resetStore(openGroup: () => Promise<boolean> = async () => true) {
  useImStore.setState({
    activeTab: 'contacts',
    activeConversationId: null,
    conversations: [],
    contacts: contacts(),
    online: {},
    openDirect: async () => 2,
    openGroup,
    setGroupDialog: () => {},
  } as unknown as Partial<ReturnType<typeof useImStore.getState>>)
}

/** 永不返回的 Promise：用来证明点击后不再等待网络请求 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

describe('协作沟通通讯录', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useImStore.getState().stopPolling()
    resetStore()
  })

  it('只渲染已加入的群，未加入的群与「查看」入口都不出现', () => {
    render(<ImSidebar onOpenChat={vi.fn()} />)
    expect(screen.getByText('三网沟通群')).toBeTruthy()
    expect(screen.getByText('河源 · 电信 协作群')).toBeTruthy()
    expect(screen.queryByText('别人的群')).toBeNull()
    expect(screen.queryByText('查看')).toBeNull()
  })

  it('群成员数按服务端返回的真实值展示', () => {
    render(<ImSidebar onOpenChat={vi.fn()} />)
    expect(screen.getByText('3 位成员')).toBeTruthy()
    expect(screen.getByText('13 位成员')).toBeTruthy()
  })

  it('点击群立即切到聊天面板并交给 store 打开，不等会话请求返回', () => {
    const onOpenChat = vi.fn()
    const openGroup = vi.fn(() => never<boolean>())
    resetStore(openGroup)
    render(<ImSidebar onOpenChat={onOpenChat} />)
    fireEvent.click(screen.getByText('三网沟通群'))
    expect(onOpenChat).toHaveBeenCalledTimes(1)
    expect(openGroup).toHaveBeenCalledWith(6)
  })

  it('点击通讯录用户立即切到聊天面板，不等发起会话返回', () => {
    const onOpenChat = vi.fn()
    const openDirect = vi.fn(() => never<number | null>())
    useImStore.setState({
      activeTab: 'contacts',
      contacts: contacts([contactUser]),
      openDirect,
    } as unknown as Partial<ReturnType<typeof useImStore.getState>>)
    render(<ImSidebar onOpenChat={onOpenChat} />)
    fireEvent.click(screen.getByText('张三'))
    expect(onOpenChat).toHaveBeenCalledTimes(1)
    expect(openDirect).toHaveBeenCalledWith(11)
  })
})
