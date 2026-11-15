/**
 * 截图对话框：打开即自动唤起原生窗口选择器、全屏铺满、单行图标工具栏、
 * 可缩放/平移、标注（含马赛克）/裁剪/下载/复制剪贴板/桌面端回焦、取消后引导页重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { desktopState, windowControl } = vi.hoisted(() => ({
  desktopState: { desktopMode: false },
  windowControl: vi.fn().mockResolvedValue({ success: true, data: {} }),
}))

const LABELS: Record<string, string> = {
  'im.screenshot.unsupportedInsecure': '当前是 http:// 非安全地址，浏览器禁用了屏幕捕获',
  'im.screenshot.unsupportedBrowser': '当前浏览器未提供屏幕捕获接口',
  'im.screenshot.clipboardWriteFailed': '复制剪贴板失败',
  'im.screenshot.invalidImage': '无法读取该图片',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: string | Record<string, unknown>) => {
      if (typeof arg === 'string') return arg
      if (arg && typeof arg === 'object') {
        return String(arg.defaultValue ?? key).replace(
          /\{\{(\w+)\}\}/g, (_match: string, name: string) => String(arg[name] ?? ''))
      }
      return LABELS[key] ?? key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../../services/api', () => ({
  desktopLoginApi: { windowControl },
}))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof desktopState) => unknown) => selector(desktopState),
    { getState: () => desktopState },
  ),
}))

import { ImScreenshotDialog } from '../ImScreenshotDialog'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 800
  naturalHeight = 600
  complete = true
  private _src = ''
  get src() { return this._src }
  set src(value: string) {
    this._src = value
    queueMicrotask(() => this.onload?.())
  }
}

const ctx = {
  drawImage: vi.fn(), strokeRect: vi.fn(), ellipse: vi.fn(), beginPath: vi.fn(),
  stroke: vi.fn(), fill: vi.fn(), closePath: vi.fn(), clearRect: vi.fn(),
  fillRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), fillText: vi.fn(),
  save: vi.fn(), restore: vi.fn(),
  imageSmoothingEnabled: true,
  strokeStyle: '', fillStyle: '', lineWidth: 1, lineJoin: '', lineCap: '',
  font: '', textBaseline: '',
}

function setSecure(value: boolean, mediaDevices: unknown = {}) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices })
}

/** jsdom 没有 PointerEvent，用带坐标的 MouseEvent 触发 React 的 onPointer* 处理 */
function pointerEvent(type: string, x: number, y: number, pointerId: number) {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
  })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

function drag(target: HTMLElement, id: number, from: [number, number], to: [number, number]) {
  fireEvent(target, pointerEvent('pointerdown', from[0], from[1], id))
  fireEvent(target, pointerEvent('pointermove', to[0], to[1], id))
  fireEvent(target, pointerEvent('pointerup', to[0], to[1], id))
}

const annotationLayer = 'svg.pointer-events-none.absolute'

/** 模拟用户在原生选择器里双击窗口缩略图后返回的共享流 */
function resolvedStream() {
  return { getTracks: () => [{ stop: vi.fn() }] }
}
/** 模拟自动唤起被取消 / 无用户手势 */
function denied() {
  return Object.assign(new Error('denied'), { name: 'NotAllowedError' })
}

describe('协作沟通截图对话框', () => {
  let onClose: ReturnType<typeof vi.fn>
  let onConfirm: ReturnType<typeof vi.fn>
  let write: ReturnType<typeof vi.fn>
  let downloadCount: number

  beforeEach(() => {
    vi.clearAllMocks()
    desktopState.desktopMode = false
    downloadCount = 0
    onClose = vi.fn()
    onConfirm = vi.fn()
    windowControl.mockResolvedValue({ success: true, data: {} })
    write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true, value: vi.fn(() => 'blob:mock'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true, value: vi.fn(),
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { write, read: vi.fn() },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true, get: () => 400,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true, get: () => 300,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      ((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' }))) as never,
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      downloadCount += 1
    })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLVideoElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true, value: 800,
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true, value: 600,
    })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true, value: (cb: () => void) => { cb(); return 1 },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderDialog = () => render(
    <ImScreenshotDialog open onClose={onClose} onConfirm={onConfirm} />,
  )

  /** 打开即自动抓一帧进入编辑页（无任何点击） */
  async function captureFrame(): Promise<{ getDisplayMedia: ReturnType<typeof vi.fn>; img: HTMLImageElement }> {
    const getDisplayMedia = vi.fn().mockResolvedValue(resolvedStream())
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(screen.getByTitle('矩形')).toBeTruthy())
    return { getDisplayMedia, img: document.body.querySelector('img') as HTMLImageElement }
  }

  const stage = () => (document.body.querySelector('img') as HTMLImageElement).parentElement as HTMLElement

  it('打开即自动唤起原生「应用窗口」选择器，只调用一次 getDisplayMedia', async () => {
    const getDisplayMedia = vi.fn().mockResolvedValue(resolvedStream())
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(1))
    expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({
      surfaceSwitching: 'exclude', audio: false,
      video: { displaySurface: 'window', monitorTypeSurfaces: 'exclude' },
    })
  })

  it('自动抓帧成功后进入编辑页：工具栏出现、引导页文案消失、无多余文字标签', async () => {
    await captureFrame()
    expect(document.body.querySelector('img')).toBeTruthy()
    expect(screen.queryByText(/已为你打开应用窗口列表/)).toBeNull()
    // 需求 4：按钮只留图标 + title 悬浮提示，不再有可见文字标签
    expect(screen.getByTitle('矩形')).toBeTruthy()
    expect(screen.getByTitle('撤销')).toBeTruthy()
    expect(screen.queryByText('裁剪')).toBeNull()
    expect(screen.queryByText('矩形')).toBeNull()
    expect(screen.queryByText('撤销')).toBeNull()
    // 需求 1：cropHint 文案已删
    expect(screen.queryByText(/裁剪工具拖框选区/)).toBeNull()
    // 需求 3：底部尺寸标记、顶部标题、footer 文字按钮都删除
    expect(screen.queryByText('截图')).toBeNull()
    expect(screen.queryByText('使用全图')).toBeNull()
    expect(screen.queryByText('添加到对话框')).toBeNull()
    expect(document.body.querySelector('footer')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('自动唤起被取消 / 无手势时停留引导页，点大图标按钮用手势重试', async () => {
    const getDisplayMedia = vi.fn()
      .mockRejectedValueOnce(denied())
      .mockResolvedValue(resolvedStream())
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(screen.getByTitle('重新选择窗口')).toBeTruthy())
    // 引导页没有编辑工具栏
    expect(screen.queryByTitle('放大')).toBeNull()
    expect(screen.queryByText('读取剪贴板图片')).toBeNull()
    expect(screen.queryByText('选择图片文件')).toBeNull()
    expect(document.body.querySelector('input[type="file"]')).toBeNull()

    fireEvent.click(screen.getByTitle('重新选择窗口'))
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTitle('矩形')).toBeTruthy())
  })

  it('桌面端抓帧后调用 activate 把主窗口拉回前台', async () => {
    desktopState.desktopMode = true
    await captureFrame()
    await waitFor(() => expect(windowControl).toHaveBeenCalledWith('activate'))
  })

  it('桌面端从自绘标题栏下方铺满窗口，编辑工具栏不被状态栏遮挡', async () => {
    desktopState.desktopMode = true
    const { img } = await captureFrame()
    const overlay = document.body.querySelector('[data-screenshot-overlay]') as HTMLElement
    expect(overlay.style.top).toBe('32px')
    expect(overlay.className).toContain('z-[10000]')
    // 图片显示高度同步扣掉标题栏，不会被容器裁切
    expect(img.style.maxHeight).toBe('calc(100vh - 116px)')
  })

  it('需求 1：抓帧成功、编辑页挂载后重试 activate（前台锁定也不停留在被选窗口）', async () => {
    desktopState.desktopMode = true
    const getDisplayMedia = vi.fn().mockResolvedValue(resolvedStream())
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(screen.getByTitle('矩形')).toBeTruthy())
    await waitFor(() => expect(windowControl.mock.calls.filter(c => c[0] === 'activate').length).toBeGreaterThanOrEqual(1))
  })

  it('需求 2：取景期间给 body 打标记隐藏置顶浮层，抓帧结束后恢复', async () => {
    const flags: boolean[] = []
    const getDisplayMedia = vi.fn().mockImplementation(() => {
      flags.push(document.body.hasAttribute('data-npt-capturing'))
      return Promise.resolve(resolvedStream())
    })
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(screen.getByTitle('矩形')).toBeTruthy())
    // getDisplayMedia 调用时正在取景：浮层已被隐藏，底下窗口内容才能被截到
    expect(flags[0]).toBe(true)
    // 进入编辑页后标记必须清除，否则协作沟通窗口 / 悬浮图标会一直消失
    expect(document.body.hasAttribute('data-npt-capturing')).toBe(false)
  })

  it('需求 2：取景被取消 / 失败时也会恢复浮层，不残留标记', async () => {
    const getDisplayMedia = vi.fn().mockRejectedValue(denied())
    setSecure(true, { getDisplayMedia })
    renderDialog()
    await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.body.hasAttribute('data-npt-capturing')).toBe(false))
  })

  it('非安全上下文给出 HTTPS 引导，不自动唤起', () => {
    const getDisplayMedia = vi.fn()
    setSecure(false, { getDisplayMedia })
    renderDialog()
    expect(screen.getByText(/非安全地址/)).toBeTruthy()
    expect(screen.getByTitle('用 HTTPS 打开')).toBeTruthy()
    expect(screen.queryByTitle('放大')).toBeNull()
    expect(getDisplayMedia).not.toHaveBeenCalled()
  })

  it('编辑页「重新选择窗口」返回引导页，且不会自动再弹选择器', async () => {
    const { getDisplayMedia } = await captureFrame()
    fireEvent.click(screen.getByTitle('重新选择窗口'))
    await waitFor(() => expect(screen.queryByTitle('矩形')).toBeNull())
    expect(screen.getByTitle('重新选择窗口')).toBeTruthy()
    expect(getDisplayMedia).toHaveBeenCalledTimes(1)
  })

  it('需求 2：放大/缩小/复位按钮与滚轮缩放', async () => {
    await captureFrame()
    expect(stage().style.transform).toContain('scale(1)')
    fireEvent.click(screen.getByTitle('放大'))
    expect(stage().style.transform).toContain('scale(1.12)')
    fireEvent.click(screen.getByTitle('缩小'))
    expect(stage().style.transform).toContain('scale(1)')
    fireEvent.click(screen.getByTitle('放大'))
    fireEvent.click(screen.getByTitle('复位视图（100%）'))
    expect(stage().style.transform).toContain('scale(1)')
    expect(stage().style.transform).toContain('translate(0px, 0px)')
    // 滚轮缩放（原生 wheel 监听）
    const viewport = stage().parentElement as HTMLElement
    fireEvent.wheel(viewport, { deltaY: -100 })
    expect(stage().style.transform).toContain('scale(1.12)')
  })

  it('需求 2：抓手工具拖拽可平移视图', async () => {
    const { img } = await captureFrame()
    fireEvent.click(screen.getByTitle(/平移/))
    drag(img, 9, [40, 40], [140, 100])
    await waitFor(() => expect(stage().style.transform).toContain('translate(100px, 60px)'))
  })

  it('文字备注：立即 blur 空内容不销毁输入框，输入后回车可提交', async () => {
    const { img } = await captureFrame()
    fireEvent.click(screen.getByTitle('文字'))
    fireEvent(img, pointerEvent('pointerdown', 120, 120, 2))
    const note = await screen.findByPlaceholderText('输入备注后回车')
    fireEvent.blur(note)
    expect(screen.getByPlaceholderText('输入备注后回车')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('输入备注后回车'), {
      target: { value: '需核查' },
    })
    fireEvent.keyDown(screen.getByPlaceholderText('输入备注后回车'), { key: 'Enter' })
    expect(document.body.querySelector(`${annotationLayer} text`)?.textContent)
      .toContain('需核查')
  })

  it('箭头工具绘制带三角形头部的线段；马赛克画笔逐点采样且可撤销', async () => {
    const { img } = await captureFrame()
    fireEvent.click(screen.getByTitle('箭头'))
    drag(img, 3, [10, 10], [100, 80])
    expect(document.body.querySelector(`${annotationLayer} line`)).toBeTruthy()
    expect(document.body.querySelector(`${annotationLayer} polygon`)).toBeTruthy()

    ctx.drawImage.mockClear()
    ctx.clearRect.mockClear()
    fireEvent.click(screen.getByTitle('马赛克'))
    fireEvent(img, pointerEvent('pointerdown', 30, 30, 4))
    fireEvent(img, pointerEvent('pointermove', 90, 30, 4))
    fireEvent(img, pointerEvent('pointermove', 150, 30, 4))
    fireEvent(img, pointerEvent('pointerup', 150, 30, 4))
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThanOrEqual(6)

    fireEvent.click(screen.getByTitle('撤销'))
    await waitFor(() => expect(ctx.clearRect).toHaveBeenCalled())
  })

  it('需求 3：默认全屏铺满，最大化/还原按钮在工具栏行切换窗口尺寸', async () => {
    await captureFrame()
    const panel = document.body.querySelector('.shadow-2xl') as HTMLElement
    expect(panel.className).toContain('w-full')
    // 默认全屏时图标为「还原」
    fireEvent.click(screen.getByTitle('还原'))
    expect(panel.className).toContain('rounded-2xl')
    fireEvent.click(screen.getByTitle('最大化'))
    expect(panel.className).toContain('w-full')
  })

  it('标注矩形与文字、下载 PNG、添加到对话框同时复制剪贴板', async () => {
    const { img } = await captureFrame()

    fireEvent.click(screen.getByTitle('矩形'))
    fireEvent.click(screen.getByTitle('#34c759'))
    drag(img, 1, [10, 10], [100, 80])
    expect(document.body.querySelector(`${annotationLayer} rect`)?.getAttribute('stroke'))
      .toBe('#34c759')

    fireEvent.click(screen.getByTitle('文字'))
    fireEvent(img, pointerEvent('pointerdown', 120, 120, 2))
    const note = await screen.findByPlaceholderText('输入备注后回车')
    fireEvent.change(note, { target: { value: '需核查' } })
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(document.body.querySelector(`${annotationLayer} text`)?.textContent).toContain('需核查')

    fireEvent.click(screen.getByTitle('下载为 PNG'))
    await waitFor(() => expect(downloadCount).toBe(1))
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('添加到对话框并复制到剪贴板'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    const file = onConfirm.mock.calls[0][0] as File
    expect(file.type).toBe('image/png')
    expect(file.name).toContain('截图')
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
