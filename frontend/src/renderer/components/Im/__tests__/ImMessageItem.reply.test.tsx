/** 引用块里的图片/文件附件必须可点击打开，而不是只显示 [附件] 文本。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ preview: vi.fn(), openFile: vi.fn() }))

vi.mock('../../../services/api', () => ({ imApi: {} }))
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ desktopMode: false }),
}))
vi.mock('../../../utils/messageSound', () => ({
  playImMessageSound: vi.fn(), playImMentionSound: vi.fn(),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}))
vi.mock('../attachmentKinds', async () => {
  const actual = await vi.importActual<typeof import('../attachmentKinds')>('../attachmentKinds')
  return { ...actual, openReceivedFile: mocks.openFile }
})

import { ImMessageItem } from '../ImMessageItem'
import type { ImMessage } from '../types'

const attachment = {
  id: 42, original_name: '现场照片.png', mime: 'image/png', size_bytes: 1024, has_thumb: true,
}

const message = (kind: 'image' | 'file'): ImMessage => ({
  id: 9, conversation_id: 7, sender_id: 2, sender_name: '对方',
  kind: 'text', content_text: '这是什么', attachment: null,
  client_msg_id: null, created_at: '2026-11-17T08:39:00Z',
  reply_to: {
    id: 8, sender_id: 2, sender_name: '对方', kind,
    preview: `[附件] ${attachment.original_name}`, attachment,
  },
})

describe('ImMessageItem 引用附件', () => {
  beforeEach(() => vi.clearAllMocks())

  it('引用图片点击后打开灯箱预览', () => {
    render(<ImMessageItem message={message('image')} isMine={false}
                          onPreview={mocks.preview} />)
    fireEvent.click(screen.getByTitle('打开引用的附件'))
    expect(mocks.preview).toHaveBeenCalledWith(42, '现场照片.png', 'image/png')
  })

  it('引用文件点击后按网页/桌面方式打开原文件', () => {
    mocks.openFile.mockResolvedValue(undefined)
    const fileMsg = message('file')
    if (fileMsg.reply_to?.attachment) {
      fileMsg.reply_to.attachment = { ...attachment, mime: 'application/pdf', original_name: '方案.pdf' }
      fileMsg.reply_to.preview = '[附件] 方案.pdf'
    }
    render(<ImMessageItem message={fileMsg} isMine={false} onPreview={mocks.preview} />)
    fireEvent.click(screen.getByTitle('打开引用的附件'))
    expect(mocks.openFile).toHaveBeenCalledWith(
      42, '方案.pdf', false, expect.any(Function), expect.any(Function))
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
