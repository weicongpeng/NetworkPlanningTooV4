/** 群主添加成员：候选列表可按昵称/账号/地市/运营商搜索并添加。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const conversation = {
    id: 10,
    kind: 'custom_group',
    name: '测试群',
    group_key: null,
    avatar: null,
    owner_id: 1,
    my_role: 'owner',
    other_user: null,
    is_self: false,
    member_count: 2,
    last_message: null,
    last_message_at: null,
    unread: 0,
    muted: false,
  }
  const members = [
    { id: 1, username: 'owner', nickname: '群主', city: '广州', operator: '移动', is_online: true, role: 'owner' },
    { id: 2, username: 'existing', nickname: '已有成员', city: '广州', operator: '移动', is_online: true, role: 'member' },
  ]
  const contacts = {
    users: [
      ...members.map(({ role: _role, ...user }) => user),
      { id: 3, username: 'bob', nickname: '小博', city: '广州', operator: '移动', is_online: true },
      { id: 4, username: 'charlie', nickname: '查理', city: '深圳', operator: '电信', is_online: false },
    ],
  }
  return {
    conversation,
    state: {
      membersByConversation: { 10: members },
      contacts,
      ensureMembers: vi.fn().mockResolvedValue(true),
      invalidateMembers: vi.fn(),
      removeMember: vi.fn().mockResolvedValue(true),
      addGroupMembers: vi.fn().mockResolvedValue(true),
      leaveGroup: vi.fn().mockResolvedValue(true),
      dissolveGroup: vi.fn().mockResolvedValue(true),
      updateGroupAvatar: vi.fn().mockResolvedValue(true),
    },
  }
})

vi.mock('../../../store/imStore', () => ({
  useImStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: number; im_user_id: number } }) => unknown) =>
    selector({ user: { id: 1, im_user_id: 1 } }),
}))

vi.mock('../../../store/toastStore', () => ({
  useToastStore: { getState: () => ({ show: vi.fn() }) },
}))

vi.mock('../ImAvatar', () => ({ ImAvatar: () => <span /> }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      const text = typeof options === 'string' ? options : options?.defaultValue ?? key
      return Object.entries(options || {}).reduce(
        (result, [name, value]) => result.replaceAll(`{{${name}}}`, String(value)),
        text,
      )
    },
  }),
}))

import { ImGroupMembersDialog } from '../ImGroupMembersDialog'

describe('ImGroupMembersDialog 添加成员搜索', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('可按昵称、地市筛选候选成员并提示无匹配', async () => {
    render(<ImGroupMembersDialog conversation={mocks.conversation as any} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTitle('添加成员'))

    const search = screen.getByPlaceholderText('搜索成员（昵称 / 账号 / 地市 / 运营商）')
    expect(screen.getByText('小博')).toBeTruthy()
    expect(screen.getByText('查理')).toBeTruthy()

    fireEvent.change(search, { target: { value: '小博' } })
    expect(screen.getByText('小博')).toBeTruthy()
    expect(screen.queryByText('查理')).toBeNull()

    fireEvent.change(search, { target: { value: '深圳' } })
    expect(screen.getByText('查理')).toBeTruthy()
    expect(screen.queryByText('小博')).toBeNull()

    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByText('没有匹配的成员')).toBeTruthy()
  })

  it('搜索后勾选成员并提交添加', async () => {
    render(<ImGroupMembersDialog conversation={mocks.conversation as any} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTitle('添加成员'))

    const search = screen.getByPlaceholderText('搜索成员（昵称 / 账号 / 地市 / 运营商）')
    fireEvent.change(search, { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: /小博/ }))
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expect(mocks.state.addGroupMembers).toHaveBeenCalledWith(10, [3]),
    )
  })
})
