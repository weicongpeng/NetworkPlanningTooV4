/** 群内系统提示：结构化 payload → 本地化友好文案。 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: Record<string, unknown>) => {
      if (arg && typeof arg === 'object') {
        const values = arg as Record<string, unknown>
        return String(values.defaultValue ?? key).replace(
          /\{\{(\w+)\}\}/g, (_m: string, name: string) => String(values[name] ?? ''))
      }
      return key
    },
    i18n: { language: 'zh' },
  }),
}))

import { ImSystemNotice, systemNoticeText } from '../ImSystemNotice'
import { parseSystemMessage } from '../types'

const t = (key: string, options?: Record<string, unknown>) =>
  String(options?.defaultValue ?? key).replace(
    /\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''))

describe('系统提示文案', () => {
  it('parseSystemMessage 解析合法 JSON、忽略普通文本', () => {
    expect(parseSystemMessage('{"event":"members_added","actor":"张三","names":["李四"]}'))
      .toEqual({ event: 'members_added', actor: '张三', names: ['李四'] })
    expect(parseSystemMessage('普通消息')).toBeNull()
    expect(parseSystemMessage(null)).toBeNull()
    expect(parseSystemMessage('{"foo":1}')).toBeNull()
  })

  it('加人 / 移人 / 退群文案带成员名', () => {
    expect(systemNoticeText(
      { event: 'members_added', actor: '张三', names: ['李四', '王五'] }, t))
      .toBe('张三 邀请 李四、王五 加入了群聊')
    expect(systemNoticeText(
      { event: 'member_removed', actor: '张三', names: ['李四'] }, t))
      .toBe('张三 将 李四 移出了群聊')
    expect(systemNoticeText({ event: 'member_left', actor: '李四' }, t))
      .toBe('李四 退出了群聊')
  })

  it('组件渲染居中文案，非法 payload 不渲染', () => {
    render(<ImSystemNotice contentText='{"event":"member_left","actor":"李四"}' />)
    expect(screen.getByText('李四 退出了群聊')).toBeTruthy()
  })

  it('非法 payload 返回 null', () => {
    const { container } = render(<ImSystemNotice contentText='普通消息' />)
    expect(container.innerHTML).toBe('')
  })
})
