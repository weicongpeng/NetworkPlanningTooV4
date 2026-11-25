/** 引用块里的图片/文件附件必须可点击打开，而不是只显示 [附件] 文本。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

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

describe('ImMessageItem 正文网址', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('网址渲染为链接，点击交给系统浏览器打开且不带尾部标点', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const url = 'https://github.com/weicongpeng/NetworkPlanningTooV4/releases/download/v0.0.91/NetOpt.Engine_Setup-0.0.91.exe'
    const textMessage: ImMessage = {
      ...message('image'), kind: 'text', reply_to: null, attachment: null,
      content_text: `安装包：${url}。`,
    }
    render(<ImMessageItem message={textMessage} isMine={false} onPreview={mocks.preview} />)

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(url)
    expect(link.textContent).toBe(url)
    expect(link.className).not.toContain('text-primary')
    fireEvent.click(link)
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    expect(link.previousSibling?.textContent).toBe('安装包：')
  })
})

describe('ImMessageItem 撤回占位', () => {
  const recalled = (contentText: string | null): ImMessage => ({
    ...message('image'), kind: 'text', reply_to: null, attachment: null,
    content_text: contentText, recalled: true,
  })

  it('自己撤回的消息仍显示原文，点击交给回填回调', () => {
    const edit = vi.fn()
    const item = recalled('撤回原文')
    render(<ImMessageItem message={item} isMine onPreview={mocks.preview} onEditRecalled={edit} />)
    fireEvent.click(screen.getByText('撤回原文'))
    expect(edit).toHaveBeenCalledWith(item)
  })

  it('自己撤回的非文本消息显示“你撤回了一条消息”', () => {
    const item: ImMessage = { ...recalled(null), kind: 'image' }
    render(<ImMessageItem message={item} isMine onPreview={mocks.preview} />)
    expect(screen.getByText('你撤回了一条消息')).toBeTruthy()
    expect(screen.queryByText('对方撤回了一条消息')).toBeNull()
  })

  it('对方撤回的消息只显示占位，不泄露正文', () => {
    render(<ImMessageItem message={recalled('对方原文')} isMine={false}
                          onPreview={mocks.preview} />)
    expect(screen.getByText('对方撤回了一条消息')).toBeTruthy()
    expect(screen.queryByText('对方原文')).toBeNull()
  })
})
