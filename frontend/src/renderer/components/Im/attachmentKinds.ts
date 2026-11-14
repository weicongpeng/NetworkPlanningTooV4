/** 聊天附件按文件名 / MIME 判定展示形态：视频内联播放、Office 文档双击打开。 */

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i
const OFFICE_EXT = /\.(doc|docx|xls|xlsx|xlsm|csv|et|ppt|pptx|pdf|txt|md|rtf|wps)$/i

export function isVideoFile(name: string, mime?: string): boolean {
  if ((mime || '').toLowerCase().startsWith('video/')) return true
  return VIDEO_EXT.test(name || '')
}

export function isOpenableDocument(name: string): boolean {
  return OFFICE_EXT.test(name || '')
}

/** 双击打开：桌面端交给系统默认应用，网页端退化为新标签页预览 / 下载。 */
export async function openReceivedFile(
  attachmentId: number,
  originalName: string,
  desktopMode: boolean,
  openDesktop: (id: number) => Promise<unknown>,
  blob: (id: number, thumb?: boolean) => Promise<Blob>,
): Promise<void> {
  if (desktopMode) {
    await openDesktop(attachmentId)
    return
  }
  const data = await blob(attachmentId)
  const url = URL.createObjectURL(data)
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  // 浏览器拦截弹窗时至少别把文件丢了
  if (!opened) {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = originalName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
