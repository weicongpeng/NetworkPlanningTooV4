/** 历史消息右键菜单：五项操作 + 点击外部/Esc 关闭。 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}))

import { ImMessageContextMenu } from '../ImMessageContextMenu'
import type { ImMessage } from '../types'

const message: ImMessage = {
  id: 7, conversation_id: 1, sender_id: 2, sender_name: '张三',
  kind: 'text', content_text: '你好', attachment: null,
  client_msg_id: null, created_at: '2026-01-01T00:00:00Z',
}

describe('ImMessageContextMenu', () => {
  it('自己的消息提供复制 / 引用 / 多选 / 转发 / 删除五项并回调当前消息', () => {
    const actions = {
      onCopy: vi.fn(), onQuote: vi.fn(), onMultiSelect: vi.fn(),
      onForward: vi.fn(), onDelete: vi.fn(),
    }
    render(
      <ImMessageContextMenu
        state={{ message, x: 40, y: 60 }} onClose={vi.fn()} canDelete {...actions}
      />,
    )
    for (const label of ['复制', '引用', '多选', '转发', '删除']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    fireEvent.click(screen.getByText('引用'))
    fireEvent.click(screen.getByText('删除'))
    expect(actions.onQuote).toHaveBeenCalledWith(message)
    expect(actions.onDelete).toHaveBeenCalledWith(message)
  })

  it('对方的消息不显示删除项', () => {
    const onDelete = vi.fn()
    const noop = vi.fn()
    render(
      <ImMessageContextMenu
        state={{ message, x: 40, y: 60 }} onClose={vi.fn()} canDelete={false}
        onCopy={noop} onQuote={noop} onMultiSelect={noop} onForward={noop} onDelete={onDelete}
      />,
    )
    expect(screen.getByText('复制')).toBeTruthy()
    expect(screen.queryByText('删除')).toBeNull()
  })

  it('点击菜单外部或按 Esc 关闭', () => {
    const onClose = vi.fn()
    const noop = vi.fn()
    render(
      <ImMessageContextMenu
        state={{ message, x: 40, y: 60 }} onClose={onClose}
        onCopy={noop} onQuote={noop} onMultiSelect={noop} onForward={noop} onDelete={noop}
      />,
    )
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
