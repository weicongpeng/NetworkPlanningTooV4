/** 通讯录群可见性与窄窗口切换回归。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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
  IM_CHUNK_SIZE: 512 * 1024,
  imApi: {
    conversations: vi.fn(), contacts: vi.fn(), messages: vi.fn(), send: vi.fn(),
    markRead: vi.fn(), createConversation: vi.fn(), createGroup: vi.fn(),
    members: vi.fn(), uploadAttachment: vi.fn(), downloadAttachment: vi.fn(),
  },
}))

import { useImStore } from '../../../store/imStore'
import { ImSidebar } from '../ImSidebar'
import type { ImContactsData, ImGroup } from '../types'

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

function contacts(): ImContactsData {
  return {
    users: [], groups: [joinedGroup, unjoinedGroup, autoGroup],
    online_count: 0, server_time: '',
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

describe('协作沟通通讯录', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useImStore.getState().stopPolling()
    resetStore()
  })

  it('只渲染已加入的群，未加入的群与「查看」入口都不出现', () => {
    render(<ImSidebar onSelectConversation={vi.fn()} />)
    expect(screen.getByText('三网沟通群')).toBeTruthy()
    expect(screen.getByText('河源 · 电信 协作群')).toBeTruthy()
    expect(screen.queryByText('别人的群')).toBeNull()
    expect(screen.queryByText('查看')).toBeNull()
  })

  it('群成员数按服务端返回的真实值展示', () => {
    render(<ImSidebar onSelectConversation={vi.fn()} />)
    expect(screen.getByText('3 位成员')).toBeTruthy()
    expect(screen.getByText('13 位成员')).toBeTruthy()
  })

  it('点击已加入的群成功后通知窄窗口切换到聊天面板', async () => {
    const onSelectConversation = vi.fn()
    render(<ImSidebar onSelectConversation={onSelectConversation} />)
    fireEvent.click(screen.getByText('三网沟通群'))
    await waitFor(() => expect(onSelectConversation).toHaveBeenCalledWith(6))
  })

  it('openGroup 被拒时不通知切换视图', async () => {
    const openGroup = vi.fn().mockResolvedValue(false)
    resetStore(openGroup)
    const onSelectConversation = vi.fn()
    render(<ImSidebar onSelectConversation={onSelectConversation} />)
    fireEvent.click(screen.getByText('三网沟通群'))
    await waitFor(() => expect(openGroup).toHaveBeenCalledWith(6))
    expect(onSelectConversation).not.toHaveBeenCalled()
  })
})
