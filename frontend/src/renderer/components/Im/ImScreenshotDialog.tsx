/**
 * 截图对话框（应用级挂载）：网页端「打开即全屏 → 唤起原生应用窗口选择器 → 抓一帧」，
 * 桌面端「壳层取景产出 PNG → initialBlob 直接进编辑页」；两条链路之后完全一致：
 * 可缩放/平移/裁剪/标注 → 生成 File 并写入剪贴板 / 对话框。
 *
 * 设计要点：
 *  - 弹窗默认以居中的还原窗口显示（无标题、无底部栏，所有操作收进顶部单行工具栏）；
 *    按住工具栏空白区左键拖动可移动窗口，也可手动最大化。
 *  - captureMode='web'（默认，网页端）：点击剪刀按钮 / 快捷键打开弹窗时**自动**调用
 *    getDisplayMedia，直接弹出系统原生的「应用窗口」选择器（里面就是各个窗口的小图）。
 *    用户在列表里双击目标窗口缩略图即完成截图加载，随即进入编辑页。
 *  - captureMode='desktop'（Windows 桌面端）：绝不唤起 getDisplayMedia，改为等待 ImHost
 *    轮询壳层结果后传入 initialBlob。取景期间前端弹窗根本不打开，避免黑色遮罩被截进
 *    整屏快照；裁剪出的图仍走原有的 loadFrame / emit / queueScreenshot 流程。
 *  - 浏览器不允许 JS 枚举其它进程窗口，窗口缩略图列表由 getDisplayMedia 原生选择器
 *    提供；displaySurface:'window' + monitorTypeSurfaces:'exclude' 让它默认停在
 *    「应用窗口」并隐藏整屏选项，选中后只抓一帧。
 *  - 自动唤起若被取消 / 因全局热键无用户手势被拒 / 浏览器不支持，则停留在引导页，
 *    由用户点大图标按钮用手势重试；不会自动反复弹选择器。
 *  - 编辑页图片用 CSS transform 做自由缩放 / 平移；缩放平移施加在 img 与所有 overlay 的
 *    公共外层，pointFromEvent 基于 getBoundingClientRect 反算原图像素，故标注坐标始终正确。
 *  - 裁剪 / 标注 / 马赛克都以「原图像素」记录；先合成整图再按裁剪框复制，仅一次 toBlob。
 *  - 输出同时写入系统剪贴板并交给 onConfirm（由 ImHost 送到「协作沟通」输入框）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AppWindow, Circle, Crop, Download, Hand,
  Loader2, Maximize2, Minimize2, Monitor,
  Palette, RefreshCw, RotateCcw, RotateCw, Send, Slash, Square, Trash2, Type, Undo2, X,
  ZoomIn, ZoomOut,
} from 'lucide-react'

import { desktopLoginApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { useImStore } from '../../store/imStore'
import { useToastStore } from '../../store/toastStore'
import { ImForwardDialog } from './ImForwardDialog'
import { CAPTURE_FLAG } from './screenshotBus'
import {
  arrowPoints, arrowShaftEnd, clamp, composeFullImage, createMosaicTile, drawMosaicStrokes,
  fontFor, fontRangeFor, isEditableShape, isMosaic, mosaicRangeFor, mosaicSizeFor,
  moveShapeVertex, paintMosaicPoint, paintMosaicSegment, shapeHandleIndex, shapeHit,
  shapeSize, shapeVertices, strokeFor, textBounds, textLines, translateShape,
} from './screenshotAnnotation'
import type {
  Annotation, Crop as CropRect, MosaicAnnotation, MosaicPainter, Point, ShapeAnnotation,
  SourceImage, TextAnnotation, Tool,
} from './screenshotAnnotation'
import { IM_DIALOG_RESIZE_HANDLES, useImDialogGeometry } from './useImDialogGeometry'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: (file: File) => void
  /** 桌面端壳层取景产出的 PNG：直接进既有编辑页，跳过共享窗口选择器 */
  initialBlob?: Blob | null
  onInitialConsumed?: () => void
  /** desktop：等待壳层 initialBlob；image：编辑已有图片；web：保持窗口选择流程 */
  captureMode?: 'web' | 'desktop' | 'image'
  /** 桌面端编辑页「重新取景」：重新发起一次壳层截图会话 */
  onRecapture?: () => void
}

interface SourceItem extends SourceImage {
  id: string
  name: string
}

type CaptureResult = { blob: Blob } | { error: 'unsupported' | 'cancelled' | 'failed' }
/** editIndex 非 null 表示在修改已落图的文字，提交时替换而非追加 */
type TextDraft = Point & { value: string; key: number; editIndex: number | null }
interface Offset { x: number; y: number }

const PRESET_COLORS = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759',
  '#00c7be', '#007aff', '#af52de', '#ffffff', '#1c1c1e',
]

/**
 * 箭头工具图标：尾线与直线工具（Slash 的 M22 2 2 22）完全等长，只把末端换成折角箭头。
 * lucide 自带 ArrowUpRight 的尾线仅 14px（Slash 约 28px），视觉上明显短一截。
 */
function LongArrowIcon({ size = 16 }: { size?: string | number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
         className="lucide lucide-arrow-up-right" aria-hidden="true">
      <path d="M22 2 2 22" />
      <polygon points="22,2 11,5 19,13" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 马赛克图标：方框内 4×4 小点阵，直观表达「像素化」 */
function MosaicIcon({ size = 16 }: { size?: string | number }) {
  const dots: number[] = [7, 11, 15, 19]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round"
         className="lucide lucide-mosaic" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="2" />
      {dots.map(x => dots.map(y => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1" fill="currentColor" stroke="none" />
      )))}
    </svg>
  )
}

type ToolIcon = ComponentType<{ size?: string | number }>
const TOOL_ITEMS: { key: Tool; icon: ToolIcon; label: string; fallback: string }[] = [
  { key: 'crop', icon: Crop, label: 'im.screenshot.toolCrop', fallback: '裁剪' },
  { key: 'rect', icon: Square, label: 'im.screenshot.toolRect', fallback: '矩形' },
  { key: 'ellipse', icon: Circle, label: 'im.screenshot.toolEllipse', fallback: '圆形' },
  { key: 'line', icon: Slash, label: 'im.screenshot.toolLine', fallback: '直线' },
  { key: 'arrow', icon: LongArrowIcon, label: 'im.screenshot.toolArrow', fallback: '箭头' },
  { key: 'text', icon: Type, label: 'im.screenshot.toolText', fallback: '文字' },
  { key: 'mosaic', icon: MosaicIcon, label: 'im.screenshot.toolMosaic', fallback: '马赛克' },
]

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const ZOOM_STEP = 1.12

/**
 * 桌面端自绘标题栏（WindowTitleBar 的 h-8）高度。
 * 截图编辑层默认全屏铺满，桌面端需从标题栏下沿开始，否则单行编辑工具栏
 * 会被「共享模式 · 已同步」那一行盖住；剩余区域仍然铺满整个窗口。
 */
const DESKTOP_TITLEBAR_HEIGHT = 32

/** 工具栏图标按钮：只显示图标，title 做悬浮冒泡提示 */
function IconButton({ title, onClick, disabled, active, tone, children }: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  tone?: 'primary'
  children: ReactNode
}) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors
              disabled:cursor-not-allowed disabled:opacity-40
              ${active ? 'bg-primary/15 text-primary'
                : tone === 'primary'
                  ? 'text-primary hover:bg-primary/10'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'}
              ${disabled ? '' : 'cursor-pointer'}`}>
      {children}
    </button>
  )
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    try { canvas.toBlob(resolve, 'image/png') } catch { resolve(null) }
  })
}

/** 浏览器把非安全上下文（http://<非 localhost IP>）下的 mediaDevices 整个隐藏 */
function screenCaptureAvailable(): boolean {
  const media = navigator.mediaDevices as (MediaDevices & {
    getDisplayMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  }) | undefined
  return typeof media?.getDisplayMedia === 'function' && window.isSecureContext !== false
}

/** 只抓「应用窗口」一帧：把原生选择器锁在窗口列表，并排除整屏 / 标签页选项。 */
async function captureWindowFrame(): Promise<CaptureResult> {
  const media = navigator.mediaDevices as (MediaDevices & {
    getDisplayMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  }) | undefined
  if (typeof media?.getDisplayMedia !== 'function') return { error: 'unsupported' }

  let stream: MediaStream | null = null
  let video: HTMLVideoElement | null = null
  const stop = () => {
    stream?.getTracks().forEach(track => track.stop())
    stream = null
    if (video) {
      try { video.pause() } catch { /* jsdom / 部分浏览器未实现 */ }
      video.srcObject = null
      video.remove()
      video = null
    }
  }
  const refocus = () => { try { window.focus() } catch { /* 浏览器可能禁止脚本抢焦点 */ } }

  // 取景期间隐藏所有置顶浮层，让 getDisplayMedia 原生窗口缩略图、以及被共享窗口
  // 里露出的都是底下的页面/窗口内容，而不是盖在最上层的截图工具与协作沟通窗口。
  document.body.setAttribute(CAPTURE_FLAG, '')
  try {
    // 等浏览器合成一帧，确保上面的隐藏已生效后再让系统抓各窗口缩略图
    await new Promise<void>(resolve => window.setTimeout(resolve, 48))
    const videoConstraints: MediaTrackConstraints & {
      displaySurface?: string
      monitorTypeSurfaces?: 'include' | 'exclude'
    } = {
      displaySurface: 'window', frameRate: 1,
      monitorTypeSurfaces: 'exclude',
    }
    const constraints: MediaStreamConstraints & {
      surfaceSwitching?: 'include' | 'exclude'
      systemAudio?: 'include' | 'exclude'
    } = {
      video: videoConstraints,
      audio: false,
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    }

    stream = await media.getDisplayMedia(constraints)
    video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    // 离屏挂到 DOM：未挂载的 <video> 在 WebView2 / 部分浏览器里不解码，
    // 会一直等满 500ms 兜底甚至 videoWidth=0 判失败，导致「选完窗口不进编辑页」。
    video.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(video)
    await video.play()

    // 优先用「帧回调」在解出第一帧时立即抓；尺寸已就绪时直接跳过等待；
    // 两者都缺（部分 WebView2 不触发帧回调）时由 500ms 兜底，避免卡在引导页。
    await new Promise<void>(resolve => {
      if (video && video.videoWidth && video.videoHeight) { resolve(); return }
      let done = false
      let timeoutTimer = 0
      const finish = () => {
        if (done) return
        done = true
        window.clearTimeout(timeoutTimer)
        resolve()
      }
      timeoutTimer = window.setTimeout(finish, 500)
      const withFrameCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
      }
      if (typeof withFrameCallback.requestVideoFrameCallback === 'function') {
        withFrameCallback.requestVideoFrameCallback(finish)
      }
    })
    if (!video || !video.videoWidth || !video.videoHeight) return { error: 'failed' }

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return { error: 'failed' }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await canvasToPng(canvas)
    stop()
    refocus()
    return blob ? { blob } : { error: 'failed' }
  } catch (error: unknown) {
    const name = String((error as { name?: string } | null)?.name || '')
    if (['NotAllowedError', 'AbortError', 'NotFoundError', 'SecurityError'].includes(name)) {
      return { error: 'cancelled' }
    }
    return { error: 'failed' }
  } finally {
    stop()
    // 恢复浮层显示：编辑页马上接管，用户立即看到截图操作页而非停留在被选中的应用窗口
    document.body.removeAttribute(CAPTURE_FLAG)
    refocus()
  }
}

/** 图片写入系统剪贴板；非安全上下文没有 ClipboardItem，降级为富文本 <img> 复制 */
async function writeClipboardImage(blob: Blob): Promise<boolean> {
  const clipboard = navigator.clipboard as (Clipboard & {
    write?: (items: ClipboardItem[]) => Promise<void>
  }) | undefined
  if (typeof clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    try {
      await clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch { /* 权限 / 安全上下文限制，继续走 execCommand 降级 */ }
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('readAsDataURL failed'))
      reader.readAsDataURL(blob)
    })
    const previous = document.activeElement as HTMLElement | null
    const holder = document.createElement('div')
    holder.contentEditable = 'true'
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    const img = document.createElement('img')
    img.src = dataUrl
    holder.appendChild(img)
    document.body.appendChild(holder)
    const range = document.createRange()
    range.selectNodeContents(holder)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    selection?.removeAllRanges()
    holder.remove()
    previous?.focus?.()
    return ok
  } catch {
    return false
  }
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 文件名时间戳按北京时间（UTC+8）展示：toISOString() 取的是 UTC，
 * 直接拼接会比用户本地时间少 8 小时。北京无夏令时，固定偏移即可。
 */
function beijingStamp(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

function screenshotFileName(language: string): string {
  const stamp = beijingStamp()
  return `${language.startsWith('en') ? 'Screenshot' : '截图'}-${stamp}.png`
}

function ShapeNode({ shape, stroke, index }: {
  shape: Annotation; stroke: number; index: number
}) {
  if (shape.kind === 'mosaic') return null
  const common = { stroke: shape.color, strokeWidth: stroke, fill: 'none' }
  if (shape.kind === 'rect') {
    return <rect key={index} x={shape.x} y={shape.y} width={shape.w} height={shape.h} {...common} />
  }
  if (shape.kind === 'ellipse') {
    return <ellipse key={index} cx={shape.x + shape.w / 2} cy={shape.y + shape.h / 2}
                    rx={Math.abs(shape.w / 2)} ry={Math.abs(shape.h / 2)} {...common} />
  }
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const headSize = Math.max(stroke * 7, 16)
    const shaft = shape.kind === 'arrow'
      ? arrowShaftEnd(shape.x1, shape.y1, shape.x2, shape.y2, headSize)
      : { x: shape.x2, y: shape.y2 }
    return (
      <g key={index}>
        <line x1={shape.x1} y1={shape.y1} x2={shaft.x} y2={shaft.y} {...common} />
        {shape.kind === 'arrow' && (
          <polygon points={arrowPoints(shape.x1, shape.y1, shape.x2, shape.y2, headSize)}
                   fill={shape.color} />
        )}
      </g>
    )
  }
  if (shape.kind === 'text') {
    return (
      <text key={index} x={shape.x} y={shape.y} fill={shape.color} fontSize={shape.fontSize}
            dominantBaseline="hanging" style={{ fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif' }}>
        {textLines(shape).map((line, lineIndex) => (
          <tspan key={lineIndex} x={shape.x} dy={lineIndex === 0 ? 0 : shape.fontSize * 1.35}>
            {line}
          </tspan>
        ))}
      </text>
    )
  }
  return null
}

export function ImScreenshotDialog({
  open, onClose, onConfirm, initialBlob, onInitialConsumed,
  captureMode = 'web', onRecapture,
}: Props) {
  const { t, i18n: i18nInstance } = useTranslation()
  const desktopMode = useAuthStore(s => s.desktopMode)
  const conversations = useImStore(s => s.conversations)
  const { panelRef, maximized, size, toggleMaximize, startDrag, startResize, panelStyle } =
    useImDialogGeometry(open, desktopMode ? DESKTOP_TITLEBAR_HEIGHT : 0)
  const [source, setSource] = useState<SourceItem | null>(null)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [tool, setTool] = useState<Tool>('crop')
  const [color, setColor] = useState('#ff3b30')
  // null = 跟随图片分辨率的默认值；滑杆值（原图像素）由用户自由覆盖
  const [fontSize, setFontSize] = useState<number | null>(null)
  const [fontPopoverOpen, setFontPopoverOpen] = useState(false)
  const [mosaicSize, setMosaicSize] = useState<number | null>(null)
  const [mosaicPopoverOpen, setMosaicPopoverOpen] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)
  // 单击已落图形状后进入顶点编辑态：显示控制点，拖拽可改长短 / 形状
  const [selectedShapeIndex, setSelectedShapeIndex] = useState<number | null>(null)
  const [hoverShapeIndex, setHoverShapeIndex] = useState<number | null>(null)
  // 非编辑态下鼠标悬停的已落图文字；悬停时显示十字光标，只有此时才可拖动文字
  const [hoverTextIndex, setHoverTextIndex] = useState<number | null>(null)
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 })
  const [noticeKey, setNoticeKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [forwardOpen, setForwardOpen] = useState(false)
  const [forwardFile, setForwardFile] = useState<File | null>(null)
  // 视图：缩放 / 平移 / 抓手模式
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const [panMode, setPanMode] = useState(false)
  // 截图旋转角度（0/90/180/270）：施加在图片与所有标注的公共外层，
  // 输出时按同角度旋转合成画布，标注/裁剪坐标始终保存在「原图」坐标系。
  const [rotation, setRotation] = useState(0)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const mosaicCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const mosaicTileRef = useRef<HTMLCanvasElement | null>(null)
  const sourceElRef = useRef<HTMLImageElement | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragRef = useRef<Point | null>(null)
  const textDragRef = useRef<{
    index: number; start: Point; x: number; y: number; moved: boolean
  } | null>(null)
  const lastTextClickRef = useRef<{ index: number; time: number } | null>(null)
  const lastCropClickRef = useRef<number | null>(null)
  const vertexDragRef = useRef<{ index: number; vertex: number } | null>(null)
  const shapeDragRef = useRef<{
    index: number; start: Point; origin: ShapeAnnotation
  } | null>(null)
  const emitRef = useRef<((useCrop: boolean) => Promise<void>) | null>(null)
  const applyCropRef = useRef<(() => Promise<void>) | null>(null)
  const panDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const scaleRef = useRef(1)
  const activeRef = useRef(false)
  // 每次打开只自动唤起一次原生窗口选择器；取消 / 重新选择后改由用户手势点击重试
  const autoCaptureRef = useRef(false)
  const draftRef = useRef<Annotation | null>(null)
  const mosaicDraftRef = useRef<MosaicAnnotation | null>(null)
  const textDraftRef = useRef<TextDraft | null>(null)
  const visibilityHandlerRef = useRef<(() => void) | null>(null)
  const activateTimersRef = useRef<number[]>([])

  const textDraftKey = textDraft?.key ?? 0
  const sourceWidth = source?.width ?? 1200
  const fontRange = fontRangeFor(sourceWidth)
  const effectiveFontSize = clamp(fontSize ?? fontFor(sourceWidth), fontRange.min, fontRange.max)
  const mosaicRange = mosaicRangeFor(sourceWidth)
  const effectiveMosaicSize = clamp(
    mosaicSize ?? mosaicSizeFor(sourceWidth), mosaicRange.min, mosaicRange.max,
  )

  useEffect(() => { textDraftRef.current = textDraft }, [textDraft])

  // 字号 / 马赛克浮层点外部即收起；浮层自身 stopPropagation，避免触发工具栏拖窗
  useEffect(() => {
    if (!fontPopoverOpen && !mosaicPopoverOpen) return
    const onOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (fontPopoverOpen && !target?.closest('[data-font-size-control]')) setFontPopoverOpen(false)
      if (mosaicPopoverOpen && !target?.closest('[data-mosaic-size-control]')) setMosaicPopoverOpen(false)
    }
    document.addEventListener('pointerdown', onOutside)
    return () => document.removeEventListener('pointerdown', onOutside)
  }, [fontPopoverOpen, mosaicPopoverOpen])

  const setDraftShape = useCallback((shape: Annotation | null) => {
    draftRef.current = shape
    setDraft(shape)
  }, [])

  const applyScale = useCallback((next: number) => {
    const s = clamp(next, MIN_SCALE, MAX_SCALE)
    scaleRef.current = s
    setScale(s)
  }, [])

  const resetView = useCallback(() => {
    scaleRef.current = 1
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setPanMode(false)
    panDragRef.current = null
  }, [])

  /** 切换工具 / 重新选窗口前把未提交的马赛克笔画落库，避免半截笔迹凭空消失。 */
  const commitMosaicDraft = useCallback(() => {
    const stroke = mosaicDraftRef.current
    mosaicDraftRef.current = null
    if (stroke) setAnnotations(list => [...list, stroke])
  }, [])

  const resetEditor = useCallback(() => {
    commitMosaicDraft()
    setCrop(null)
    setAnnotations([])
    setDraftShape(null)
    setTextDraft(null)
    textDraftRef.current = null
    textDragRef.current = null
    lastTextClickRef.current = null
    vertexDragRef.current = null
    shapeDragRef.current = null
    lastCropClickRef.current = null
    setSelectedShapeIndex(null)
    setHoverTextIndex(null)
    setHoverShapeIndex(null)
    setTool('crop')
    setRotation(0)
    setFontPopoverOpen(false)
    setMosaicPopoverOpen(false)
    dragRef.current = null
    resetView()
  }, [commitMosaicDraft, setDraftShape, resetView])

  const releaseSource = useCallback(() => {
    if (source) URL.revokeObjectURL(source.url)
    sourceElRef.current = null
    mosaicTileRef.current = null
    setSource(null)
    resetEditor()
    setDisplaySize({ width: 0, height: 0 })
  }, [source, resetEditor])

  useEffect(() => {
    activeRef.current = open
    if (open) {
      // 新一轮打开：允许再次自动唤起原生窗口选择器
      autoCaptureRef.current = false
      setForwardOpen(false)
      setForwardFile(null)
    } else {
      dragRef.current = null
      mosaicDraftRef.current = null
      setNoticeKey(null)
      setBusy(false)
      setForwardOpen(false)
      setForwardFile(null)
      releaseSource()
    }
    return () => {
      activeRef.current = false
      // 万一取景被中途关闭，务必恢复被隐藏的浮层，避免协作沟通窗口消失
      document.body.removeAttribute(CAPTURE_FLAG)
      activateTimersRef.current.forEach(id => window.clearTimeout(id))
      activateTimersRef.current = []
      const visibilityHandler = visibilityHandlerRef.current
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler)
        visibilityHandlerRef.current = null
      }
      releaseSource()
    }
    // releaseSource 依赖 source，这里只在 open 变化时做整体重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 滚轮缩放：原生监听 passive:false 才能 preventDefault，避免页面跟着滚 */
  useEffect(() => {
    const el = viewportRef.current
    if (!open || !source || !el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      applyScale(scaleRef.current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open, source, applyScale])

  /**
   * 抓帧结束 / 编辑页渲染后把主窗口带回前台。
   *
   * 共享窗口结束后系统常把「被共享的应用窗口」留在最前，网页端 window.focus() 又常被
   * 浏览器忽略；桌面端 SetForegroundWindow 还容易被前台锁定拒绝。故用错开的多次
   * activate 兜底，并在编辑页真正挂载后再触发一次，避免「选完窗口停在那不跳转」。
   */
  const bringToFront = () => {
    activateTimersRef.current.forEach(id => window.clearTimeout(id))
    activateTimersRef.current = []
    try { window.focus() } catch { /* 浏览器可能禁止脚本抢焦点 */ }
    if (useAuthStore.getState().desktopMode) {
      activateTimersRef.current = [0, 150, 420].map(delay => window.setTimeout(() => {
        void desktopLoginApi.windowControl('activate').catch(() => { /* 网页端 403 属预期 */ })
      }, delay))
    } else if (document.hidden) {
      useToastStore.getState().show(t('im.screenshot.backToPageHint'))
      if (visibilityHandlerRef.current) {
        document.removeEventListener('visibilitychange', visibilityHandlerRef.current)
      }
      const onVisible = () => {
        if (document.hidden) return
        try { window.focus() } catch { /* 同上 */ }
        document.removeEventListener('visibilitychange', onVisible)
        visibilityHandlerRef.current = null
      }
      visibilityHandlerRef.current = onVisible
      document.addEventListener('visibilitychange', onVisible)
    }
  }

  /** 抓到一帧 → 缓存 HTMLImageElement 作为马赛克采样源 → 进入标注页 */
  const loadFrame = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const probe = new Image()
    probe.onload = () => {
      if (!activeRef.current) { URL.revokeObjectURL(url); return }
      if (!probe.naturalWidth || !probe.naturalHeight) {
        URL.revokeObjectURL(url)
        setNoticeKey('im.screenshot.invalidImage')
        return
      }
      const stamp = beijingStamp()
      sourceElRef.current = probe
      setSource({
        id: `win-${Date.now()}`, url,
        width: probe.naturalWidth, height: probe.naturalHeight,
        name: `${i18nInstance.language.startsWith('en') ? 'Window' : '应用窗口'}-${stamp}`,
      })
      resetEditor()
      setFontSize(fontFor(probe.naturalWidth))
      setMosaicSize(mosaicSizeFor(probe.naturalWidth))
      setNoticeKey(null)
    }
    probe.onerror = () => {
      URL.revokeObjectURL(url)
      if (activeRef.current) setNoticeKey('im.screenshot.invalidImage')
    }
    probe.src = url
  }, [i18nInstance.language, resetEditor])

  const onCapture = async (silentCancel = false) => {
    if (busy) return
    setBusy(true)
    setNoticeKey(null)
    const result = await captureWindowFrame()
    if (!activeRef.current) return
    setBusy(false)
    if ('blob' in result) {
      // 编辑页由 loadFrame 异步 setSource 后才渲染，抢前台交给下方 [source] effect
      loadFrame(result.blob)
      return
    }
    // 失败 / 取消没有编辑页，这里直接把窗口带回前台
    bringToFront()
    if (result.error === 'unsupported') setNoticeKey('im.screenshot.unsupported')
    else if (result.error === 'cancelled') {
      if (!silentCancel) setNoticeKey('im.screenshot.cancelled')
    } else setNoticeKey('im.screenshot.failed')
  }

  /** 编辑页一旦真实挂载就抢回前台：解决「选完窗口停在那、不马上跳编辑页」。
   *  只在 source 变化时触发，避免把 bringToFront 里尚未执行的重试定时器提前清掉。 */
  useEffect(() => {
    if (!open || !source) return
    bringToFront()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source])

  /** 打开即自动唤起原生窗口选择器（仅网页端；无手势时会回落引导页，不自动重弹） */
  useEffect(() => {
    if (!open || autoCaptureRef.current) return
    // 桌面端由壳层取景，绝不弹出「获取共享窗口」选择器，改为等待 initialBlob
    if (captureMode !== 'web') return
    if (!screenCaptureAvailable()) return
    autoCaptureRef.current = true
    const timer = window.setTimeout(() => { void onCapture(true) }, 30)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, captureMode])

  /** 桌面端壳层裁剪好的 PNG 直接进编辑页；之后的标注 / 剪贴板 / 附件流程完全不变 */
  useEffect(() => {
    if (!open || captureMode === 'web' || !initialBlob) return
    loadFrame(initialBlob)
    onInitialConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, captureMode, initialBlob])

  const openSecureVersion = () => {
    const url = `https://${window.location.host}${window.location.pathname}${window.location.search}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  /** 马赛克预览：全量重放已提交笔画；拖拽期间由 paintMosaicSegment 增量绘制 */
  useEffect(() => {
    const canvas = mosaicCanvasRef.current
    if (!canvas || !source) return
    canvas.width = source.width
    canvas.height = source.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, source.width, source.height)
    const image = sourceElRef.current
    if (!image) return
    if (!mosaicTileRef.current) mosaicTileRef.current = createMosaicTile()
    drawMosaicStrokes(
      {
        ctx, source: image, sourceWidth: source.width, sourceHeight: source.height,
        tile: mosaicTileRef.current,
      },
      annotations.filter(isMosaic),
    )
  }, [source, annotations])

  const mosaicPainter = (): MosaicPainter | null => {
    const canvas = mosaicCanvasRef.current
    const image = sourceElRef.current
    if (!canvas || !image || !source) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    if (!mosaicTileRef.current) mosaicTileRef.current = createMosaicTile()
    return {
      ctx, source: image, sourceWidth: source.width, sourceHeight: source.height,
      tile: mosaicTileRef.current,
    }
  }

  // 图片显示尺寸进入 state（含 ResizeObserver），裁剪框 / 文字框 / 预览共用一套换算
  useEffect(() => {
    const el = imgRef.current
    if (!source || !el) return
    const update = () => setDisplaySize({ width: el.clientWidth, height: el.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [source, maximized])

  useEffect(() => {
    if (!textDraftKey) return
    const frame = window.requestAnimationFrame(() => {
      textInputRef.current?.focus()
      textInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [textDraftKey])

  // Esc：标注页先退回引导页，再按一次才关弹窗
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      if (textDraftRef.current) { setTextDraft(null); return }
      if (source && captureMode !== 'image') { releaseSource(); return }
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, source])

  // Enter：有裁剪框时应用裁剪并覆盖原图；否则等同点击「完成」
  useEffect(() => {
    if (!open || !source) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      if (textDraftRef.current) return
      event.preventDefault()
      if (crop) void applyCropRef.current?.()
      else void emitRef.current?.(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, source, crop])

  // Ctrl/Cmd+Z 撤销最近一个标注（文字输入框内交给输入框自己处理）
  useEffect(() => {
    if (!open || !source) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        setAnnotations(list => list.slice(0, -1))
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, source])

  if (!open) return null

  const captureSupported = screenCaptureAvailable()
  const insecure = window.isSecureContext === false

  /** 事件坐标 → 原图像素：getBoundingClientRect 已含缩放/平移/旋转，先反旋再换算 */
  const pointFromEvent = (clientX: number, clientY: number): Point | null => {
    const rendered = imgRef.current
    if (!rendered || !source || !displaySize.width || !displaySize.height) return null
    const rect = rendered.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    // 旋转后 rect 是轴对齐包围盒；绕其中心反旋回图像自身坐标系（含 scale 的显示尺寸）
    const shownW = displaySize.width * scale
    const shownH = displaySize.height * scale
    const rad = -rotation * Math.PI / 180
    const dx = clientX - (rect.left + rect.width / 2)
    const dy = clientY - (rect.top + rect.height / 2)
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad)
    return {
      x: clamp((rx + shownW / 2) * source.width / shownW, 0, source.width),
      y: clamp((ry + shownH / 2) * source.height / shownH, 0, source.height),
    }
  }

  /** 自后向前命中已落图文字（含换行后的包围盒），用于再次编辑 / 拖动 */
  const findTextAt = (point: Point): number => {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const shape = annotations[index]
      if (shape.kind !== 'text') continue
      const box = textBounds(shape)
      const pad = Math.max(4, sourceWidth / 240)
      if (point.x >= box.x - pad && point.x <= box.x + box.w + pad
        && point.y >= box.y - pad && point.y <= box.y + box.h + pad) return index
    }
    return -1
  }

  /** 双击已落图文字：回填原文 / 颜色 / 字号，进入编辑态 */
  const openTextEditor = (index: number) => {
    const shape = annotations[index]
    if (!shape || shape.kind !== 'text') return
    setColor(shape.color)
    setFontSize(shape.fontSize)
    textDragRef.current = null
    lastTextClickRef.current = null
    vertexDragRef.current = null
    shapeDragRef.current = null
    setSelectedShapeIndex(null)
    setHoverTextIndex(null)
    setTextDraft({
      x: shape.x, y: shape.y, value: shape.text,
      key: Date.now(), editIndex: index,
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!source) return
    // 抓手模式或鼠标中键：拖拽平移视图
    if (panMode || event.button === 1) {
      event.preventDefault()
      panDragRef.current = {
        sx: event.clientX, sy: event.clientY, ox: offset.x, oy: offset.y,
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const point = pointFromEvent(event.clientX, event.clientY)
    if (!point) return
    if (tool === 'text') {
      event.preventDefault()
      // 已有草稿时本次点击只负责收尾，避免 blur 与新建同时发生导致索引错位
      if (textDraft) { commitText(Boolean(textDraft.value.trim())); return }
      const hit = findTextAt(point)
      if (hit >= 0) {
        // 双击才重新编辑；单击仅准备拖动，不在 pointerup 里打开输入框
        const last = lastTextClickRef.current
        const now = Date.now()
        if (last && last.index === hit && now - last.time < 400) {
          lastTextClickRef.current = null
          openTextEditor(hit)
          return
        }
        lastTextClickRef.current = { index: hit, time: now }
        const shape = annotations[hit] as TextAnnotation
        textDragRef.current = { index: hit, start: point, x: shape.x, y: shape.y, moved: false }
        // 捕获到图片容器，拖动过程中保留其十字光标（捕获到 viewport 会显示箭头）
        stageRef.current?.setPointerCapture?.(event.pointerId)
        return
      }
      lastTextClickRef.current = null
      setTextDraft({ ...point, value: '', key: Date.now(), editIndex: null })
      return
    }
    if (tool === 'mosaic') {
      event.preventDefault()
      // 捕获到图片容器，涂抹全程保留半透明圆形笔刷光标
      stageRef.current?.setPointerCapture?.(event.pointerId)
      const size = effectiveMosaicSize
      mosaicDraftRef.current = { kind: 'mosaic', points: [point], size }
      const painter = mosaicPainter()
      if (painter) paintMosaicPoint(painter, point, size)
      return
    }
    if (tool === 'crop' && crop && crop.w > 0 && crop.h > 0
      && point.x >= crop.x && point.x <= crop.x + crop.w
      && point.y >= crop.y && point.y <= crop.y + crop.h) {
      // 双击裁剪框内部直接完成裁剪；单击只保留当前框，不清除重画
      const now = Date.now()
      if (lastCropClickRef.current !== null && now - lastCropClickRef.current < 400) {
        lastCropClickRef.current = null
        event.preventDefault()
        void applyCrop()
        return
      }
      lastCropClickRef.current = now
      return
    }
    lastCropClickRef.current = null
    if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow') {
      const tolerance = Math.max(8, source.width / 120)
      const selected = selectedShapeIndex !== null ? annotations[selectedShapeIndex] : null
      if (selected && isEditableShape(selected)) {
        const vertex = shapeHandleIndex(selected, point, tolerance)
        if (vertex >= 0) {
          vertexDragRef.current = { index: selectedShapeIndex!, vertex }
          event.currentTarget.setPointerCapture?.(event.pointerId)
          return
        }
      }
      // 单击命中已有图形 → 选中并显示控制点；未命中则新建图形
      for (let index = annotations.length - 1; index >= 0; index -= 1) {
        const shape = annotations[index]
        if (!isEditableShape(shape) || !shapeHit(shape, point, tolerance)) continue
        setSelectedShapeIndex(index)
        // 按住图形本体拖动即整体平移（控制点拖动改形状，走上面的 vertexDrag 分支）
        shapeDragRef.current = { index, start: point, origin: { ...shape } }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        return
      }
      setSelectedShapeIndex(null)
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = point
    if (tool === 'crop') setCrop(null)
    else setDraftShape(null)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panDragRef.current
    if (pan) {
      setOffset({ x: pan.ox + (event.clientX - pan.sx), y: pan.oy + (event.clientY - pan.sy) })
      return
    }
    const textDrag = textDragRef.current
    if (textDrag && source) {
      const point = pointFromEvent(event.clientX, event.clientY)
      if (!point) return
      const dx = point.x - textDrag.start.x
      const dy = point.y - textDrag.start.y
      if (Math.hypot(dx, dy) > Math.max(4, source.width / 240)) textDrag.moved = true
      setAnnotations(list => list.map((shape, index) => {
        if (index !== textDrag.index || shape.kind !== 'text') return shape
        return {
          ...shape,
          x: clamp(textDrag.x + dx, 0, Math.max(0, source.width - shape.fontSize)),
          y: clamp(textDrag.y + dy, 0, Math.max(0, source.height - shape.fontSize)),
        }
      }))
      return
    }
    const shapeDrag = shapeDragRef.current
    if (shapeDrag) {
      const point = pointFromEvent(event.clientX, event.clientY)
      if (!point) return
      const dx = point.x - shapeDrag.start.x
      const dy = point.y - shapeDrag.start.y
      setAnnotations(list => list.map((shape, index) => (
        index === shapeDrag.index
          ? translateShape(shapeDrag.origin, dx, dy)
          : shape
      )))
      return
    }
    const vertexDrag = vertexDragRef.current
    if (vertexDrag) {
      const point = pointFromEvent(event.clientX, event.clientY)
      if (!point) return
      setAnnotations(list => list.map((shape, index) => (
        index === vertexDrag.index && isEditableShape(shape)
          ? moveShapeVertex(shape, vertexDrag.vertex, point)
          : shape
      )))
      return
    }
    if (tool === 'mosaic') {
      const stroke = mosaicDraftRef.current
      if (!stroke) return
      const point = pointFromEvent(event.clientX, event.clientY)
      if (!point) return
      const last = stroke.points[stroke.points.length - 1]
      if (Math.hypot(point.x - last.x, point.y - last.y) < 1) return
      const painter = mosaicPainter()
      if (!painter) return
      stroke.points.push(...paintMosaicSegment(painter, last, point, stroke.size))
      return
    }
    // 文字工具且未编辑时，悬停命中已落图文字才给出十字光标与可拖动提示
    if (tool === 'text' && !textDraft && !dragRef.current) {
      const point = pointFromEvent(event.clientX, event.clientY)
      const hit = point ? findTextAt(point) : -1
      setHoverTextIndex(hit >= 0 ? hit : null)
      return
    }
    // 形状工具下悬停已落图图形：与文字一致，显示十字光标提示可拖动 / 编辑
    if ((tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow')
      && !dragRef.current) {
      const point = pointFromEvent(event.clientX, event.clientY)
      const tolerance = source ? Math.max(8, source.width / 120) : 8
      let hit = -1
      if (point) {
        for (let index = annotations.length - 1; index >= 0; index -= 1) {
          const shape = annotations[index]
          if (isEditableShape(shape) && shapeHit(shape, point, tolerance)) { hit = index; break }
        }
      }
      setHoverShapeIndex(hit >= 0 ? hit : null)
      return
    }
    const start = dragRef.current
    if (!start) return
    const point = pointFromEvent(event.clientX, event.clientY)
    if (!point) return
    if (tool === 'crop') {
      setCrop({
        x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y),
      })
    } else if (tool === 'line' || tool === 'arrow') {
      setDraftShape({ kind: tool, x1: start.x, y1: start.y, x2: point.x, y2: point.y, color })
    } else if (tool === 'rect' || tool === 'ellipse') {
      setDraftShape({
        kind: tool,
        x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y), color,
      })
    }
  }

  const onPointerUp = () => {
    if (panDragRef.current) { panDragRef.current = null; return }
    if (vertexDragRef.current) { vertexDragRef.current = null; return }
    if (shapeDragRef.current) { shapeDragRef.current = null; return }
    if (textDragRef.current) {
      // 单击不进入编辑（双击才进入），这里只结束拖动状态
      textDragRef.current = null
      return
    }
    dragRef.current = null
    if (tool === 'mosaic') { commitMosaicDraft(); return }
    if (tool === 'crop') {
      setCrop(value => value && (value.w < 4 || value.h < 4) ? null : value)
      return
    }
    const shape = draftRef.current
    if (shape && shapeSize(shape) >= 4) setAnnotations(list => [...list, shape])
    setDraftShape(null)
  }

  const commitText = (submit: boolean) => {
    const current = textDraft
    if (!current || !source) return
    const value = current.value.trim()
    if (submit && value) {
      const size = effectiveFontSize
      // 自动换行宽度取图片宽度上限与「距右边界可用空间」的较小值
      const maxWidth = Math.max(size * 3, Math.min(source.width * 0.7, source.width - current.x - size))
      if (current.editIndex !== null) {
        setAnnotations(list => list.map((shape, index) => (
          index === current.editIndex && shape.kind === 'text'
            ? { ...shape, text: value, color, fontSize: size, maxWidth }
            : shape
        )))
      } else {
        setAnnotations(list => [...list, {
          kind: 'text', x: current.x, y: current.y, text: value, color,
          fontSize: size, maxWidth,
        }])
      }
    }
    textDraftRef.current = null
    setTextDraft(null)
  }

  /** 整图合成（原图 → 马赛克 → 标注）后按裁剪框复制到输出 canvas，只做一次 toBlob */
  const renderBlob = async (useCrop: boolean): Promise<Blob | null> => {
    if (!source) return null
    let image = sourceElRef.current
    if (!image) {
      image = new Image()
      image.src = source.url
      if (!image.complete) {
        await new Promise<void>(resolve => {
          image!.onload = () => resolve()
          image!.onerror = () => resolve()
        })
      }
      sourceElRef.current = image
    }
    const full = composeFullImage(image, source.width, source.height, annotations)
    if (!full) { setNoticeKey('im.screenshot.failed'); return null }
    const box = useCrop && crop
      ? {
          x: Math.round(clamp(crop.x, 0, source.width)),
          y: Math.round(clamp(crop.y, 0, source.height)),
          w: Math.round(clamp(crop.w, 1, source.width)),
          h: Math.round(clamp(crop.h, 1, source.height)),
        }
      : { x: 0, y: 0, w: source.width, h: source.height }
    const sw = Math.min(box.w, source.width - box.x)
    const sh = Math.min(box.h, source.height - box.y)
    if (sw <= 0 || sh <= 0) {
      full.width = 0; full.height = 0
      setNoticeKey('im.screenshot.invalidImage')
      return null
    }
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      full.width = 0; full.height = 0
      setNoticeKey('im.screenshot.failed')
      return null
    }
    ctx.drawImage(full, box.x, box.y, sw, sh, 0, 0, sw, sh)
    full.width = 0
    full.height = 0
    if (!rotation) return canvasToPng(canvas)
    // 输出按同角度旋转：90/270 交换宽高；标注/裁剪仍在原图坐标系，无需重算
    const turned = document.createElement('canvas')
    turned.width = rotation % 180 === 90 ? sh : sw
    turned.height = rotation % 180 === 90 ? sw : sh
    const tctx = turned.getContext('2d')
    if (!tctx) { setNoticeKey('im.screenshot.failed'); return null }
    tctx.translate(turned.width / 2, turned.height / 2)
    tctx.rotate(rotation * Math.PI / 180)
    tctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
    return canvasToPng(turned)
  }

  /**
   * 应用裁剪：把裁剪区域（含已有标注）合成为新图并覆盖当前原图，
   * 只结束本次裁剪、继续留在编辑页；真正复制到剪贴板 / 送到对话框由「完成」按钮负责。
   */
  const applyCrop = async () => {
    if (!source || !crop || busy) return
    setBusy(true)
    const blob = await renderBlob(true)
    setBusy(false)
    if (!blob) { setNoticeKey('im.screenshot.failed'); return }
    URL.revokeObjectURL(source.url)
    loadFrame(blob)
  }
  applyCropRef.current = applyCrop

  const emit = async (useCrop: boolean) => {
    if (!source || busy) return
    setBusy(true)
    const blob = await renderBlob(useCrop)
    setBusy(false)
    if (!blob) { setNoticeKey('im.screenshot.failed'); return }
    void writeClipboardImage(blob).then(ok => {
      if (!ok) useToastStore.getState().show(t('im.screenshot.clipboardWriteFailed'))
    })
    onConfirm(new File([blob], screenshotFileName(i18nInstance.language), { type: 'image/png' }))
    onClose()
  }
  emitRef.current = emit

  const onDownload = async () => {
    if (!source || busy) return
    setBusy(true)
    const blob = await renderBlob(Boolean(crop))
    setBusy(false)
    if (!blob) { setNoticeKey('im.screenshot.failed'); return }
    saveBlob(blob, screenshotFileName(i18nInstance.language))
  }

  const openForward = async () => {
    if (!source || busy) return
    setBusy(true)
    const blob = await renderBlob(Boolean(crop))
    setBusy(false)
    if (!blob) { setNoticeKey('im.screenshot.failed'); return }
    setForwardFile(new File([blob], screenshotFileName(i18nInstance.language), { type: 'image/png' }))
    setForwardOpen(true)
    if (!conversations.length) void useImStore.getState().refreshConversations().catch(() => {})
  }

  const confirmForward = async (conversationIds: number[]): Promise<boolean> => {
    if (!forwardFile) return false
    const result = await useImStore.getState().sendImageToConversations(forwardFile, conversationIds)
    if (result.failed === 0) {
      useToastStore.getState().show(t('im.screenshot.forwardSuccess',
        '已转发到 {{count}} 个会话', { count: result.sent }))
    } else if (result.sent > 0) {
      useToastStore.getState().show(t('im.screenshot.forwardPartial',
        '已转发 {{sent}} 个会话，{{failed}} 个失败', result))
    } else {
      useToastStore.getState().show(t('im.message.forwardFailed', '转发失败，请稍后重试'))
    }
    setForwardFile(null)
    return true
  }

  const scaleX = source && displaySize.width ? source.width / displaySize.width : 1
  const scaleY = source && displaySize.height ? source.height / displaySize.height : 1
  const notice = noticeKey ? (
    <p className="shrink-0 border-t border-border/60 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-500">
      {t(noticeKey)}
    </p>
  ) : null
  const overlayStyle = displaySize.width
    ? { width: displaySize.width, height: displaySize.height }
    : undefined

  /** 马赛克笔刷光标：半透明圆形，直径跟随笔刷实际显示尺寸（含视图缩放） */
  const mosaicCursor = (() => {
    if (!source) return 'default'
    const diameter = clamp(Math.round(effectiveMosaicSize * scale / scaleX), 10, 128)
    const radius = diameter / 2
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}"><circle cx="${radius}" cy="${radius}" r="${Math.max(1, radius - 1)}" fill="rgba(128,128,128,0.35)" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${radius} ${radius}, crosshair`
  })()

  const selectedShape = selectedShapeIndex !== null ? annotations[selectedShapeIndex] : null
  const editingShape = selectedShape && isEditableShape(selectedShape) ? selectedShape : null
  const shapeHandles = editingShape ? shapeVertices(editingShape) : []

  /** 光标只施加在图片容器上：空白蒙版区始终系统箭头；绘制工具也用传统箭头 */
  const imageCursor = panMode ? 'move'
    : tool === 'mosaic' ? mosaicCursor
      : tool === 'text'
        ? (textDraft || hoverTextIndex === null ? 'text' : 'move')
        : (hoverShapeIndex !== null ? 'move' : 'default')

  // 必须挂到 body：ImComposer 有 backdrop-blur、ImWindow 有 transform + overflow-hidden，
  // 都会给 position:fixed 创建新的包含块，导致遮罩只有输入框那么大且面板被裁掉。
  return (
    <>
      {createPortal(
    <div data-screenshot-overlay
         className="pointer-events-none fixed inset-0 z-[10000] flex"
         style={desktopMode ? { top: DESKTOP_TITLEBAR_HEIGHT } : undefined}>
      <div ref={panelRef} data-screenshot-panel
           className={`pointer-events-auto relative flex flex-col overflow-hidden bg-card shadow-[0_20px_70px_rgba(0,0,0,0.35)]
        ${maximized
          ? 'h-full w-full'
          : 'm-auto h-[88vh] w-[min(1100px,94vw)] rounded-2xl border border-border'}`}
           style={panelStyle}>

        {/* 单行工具栏：左侧编辑工具，右侧操作按钮 + 窗口控制；空白区左键拖动 */}
        <div data-screenshot-toolbar
             className={`flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border/60 px-2 py-1.5
               ${maximized ? '' : 'cursor-grab active:cursor-grabbing'}`}
             onPointerDown={startDrag}>
          {source && (
            <>
              {TOOL_ITEMS.map(item => {
                const Icon = item.icon
                const isFont = item.key === 'text'
                const isMosaic = item.key === 'mosaic'
                const button = (
                  <IconButton key={item.key} title={t(item.label, item.fallback)}
                              active={!panMode && tool === item.key}
                              onClick={() => {
                                commitMosaicDraft()
                                setPanMode(false)
                                setTool(item.key)
                                setTextDraft(null)
                                setDraftShape(null)
                                setHoverTextIndex(null)
                                setHoverShapeIndex(null)
                                setSelectedShapeIndex(null)
                                vertexDragRef.current = null
                                shapeDragRef.current = null
                                lastTextClickRef.current = null
                                // 字号 / 笔刷大小浮层直接挂在对应工具图标上
                                if (isFont) setFontPopoverOpen(value => !value)
                                if (isMosaic) setMosaicPopoverOpen(value => !value)
                              }}>
                    <Icon size={16} />
                  </IconButton>
                )
                if (!isFont && !isMosaic) return button
                const open = isFont ? fontPopoverOpen : mosaicPopoverOpen
                const labelKey = isFont ? 'im.screenshot.fontSize' : 'im.screenshot.toolMosaicSize'
                const label = t(labelKey, isFont ? '字体大小' : '马赛克大小')
                const range = isFont ? fontRange : mosaicRange
                const size = isFont ? effectiveFontSize : effectiveMosaicSize
                const setValue = isFont ? setFontSize : setMosaicSize
                return (
                  <div key={item.key}
                       data-font-size-control={isFont ? '' : undefined}
                       data-mosaic-size-control={isMosaic ? '' : undefined}
                       className="relative shrink-0"
                       onPointerDown={event => event.stopPropagation()}>
                    {button}
                    {open && (
                      <div className="absolute left-0 top-9 z-30 w-56 rounded-lg border border-border bg-card p-3 shadow-lg">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{label}</span>
                          <span className="tabular-nums text-foreground">{Math.round(size)} px</span>
                        </div>
                        <input type="range" aria-label={label}
                               min={range.min} max={range.max} step={1}
                               value={clamp(size, range.min, range.max)}
                               onChange={event => setValue(Number(event.target.value))}
                               className="w-full cursor-pointer accent-primary" />
                        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                          <span>{range.min}</span><span>{range.max}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <span className="mx-1 h-5 w-px shrink-0 bg-border/70" />
              <div className="flex shrink-0 items-center gap-1">
                {PRESET_COLORS.map(value => (
                  <button key={value} type="button" title={value} onClick={() => setColor(value)}
                          className={`h-4 w-4 shrink-0 rounded-full border border-black/20 cursor-pointer
                            ${color === value ? 'ring-2 ring-primary ring-offset-1' : ''}`}
                          style={{ backgroundColor: value }} />
                ))}
                <label title={t('im.screenshot.customColor', '自定义颜色')}
                       className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer">
                  <Palette size={16} />
                  <input type="color" value={color} onChange={event => setColor(event.target.value)}
                         className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                </label>
              </div>
              <span className="mx-1 h-5 w-px shrink-0 bg-border/70" />
              <IconButton title={t('im.screenshot.undo', '撤销')}
                          disabled={!annotations.length}
                          onClick={() => setAnnotations(list => list.slice(0, -1))}>
                <Undo2 size={16} />
              </IconButton>
              <IconButton title={t('im.screenshot.clearMarks', '清空标注')}
                          disabled={!annotations.length && !crop}
                          onClick={() => { setAnnotations([]); setCrop(null); setDraftShape(null) }}>
                <Trash2 size={16} />
              </IconButton>
              <span className="mx-1 h-5 w-px shrink-0 bg-border/70" />
              <IconButton title={t('im.screenshot.pan', '平移（或按住鼠标中键拖动）')}
                          active={panMode} onClick={() => setPanMode(value => !value)}>
                <Hand size={16} />
              </IconButton>
              <IconButton title={t('im.screenshot.zoomOut', '缩小')}
                          onClick={() => applyScale(scaleRef.current / ZOOM_STEP)}>
                <ZoomOut size={16} />
              </IconButton>
              <IconButton title={t('im.screenshot.zoomIn', '放大')}
                          onClick={() => applyScale(scaleRef.current * ZOOM_STEP)}>
                <ZoomIn size={16} />
              </IconButton>
              <IconButton title={t('im.screenshot.rotateLeft', '向左旋转 90°')}
                          onClick={() => setRotation(value => (value + 270) % 360)}>
                <RotateCcw size={16} />
              </IconButton>
              <IconButton title={t('im.screenshot.rotateRight', '向右旋转 90°')}
                          onClick={() => setRotation(value => (value + 90) % 360)}>
                <RotateCw size={16} />
              </IconButton>
              <IconButton title={t('im.message.forward', '转发')}
                          disabled={busy} onClick={() => void openForward()}>
                <Send size={16} />
              </IconButton>
              <button type="button" title={t('im.screenshot.addHint', '添加到对话框并复制到剪贴板')}
                      disabled={busy} onClick={() => void emit(Boolean(crop))}
                      className="flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
                {t('im.screenshot.done', '完成')}
              </button>
            </>
          )}

          <span className="min-w-2 flex-1" />

          {source && (
            <>
              {captureMode !== 'image' && (
                <IconButton title={captureMode === 'desktop'
                                  ? t('im.screenshot.recapture', '重新取景')
                                  : t('im.screenshot.reselect', '重新选择窗口')}
                            onClick={() => {
                              releaseSource()
                              if (captureMode === 'desktop') onRecapture?.()
                            }}>
                  <RefreshCw size={16} />
                </IconButton>
              )}
              <IconButton title={t('im.screenshot.downloadHint', '下载为 PNG')}
                          disabled={busy} onClick={() => void onDownload()}>
                <Download size={16} />
              </IconButton>
              <span className="mx-1 h-5 w-px shrink-0 bg-border/70" />
            </>
          )}
          <IconButton title={t(maximized ? 'im.screenshot.restore' : 'im.screenshot.maximize',
                              maximized ? '还原' : '最大化')}
                      onClick={toggleMaximize}>
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </IconButton>
          <IconButton title={t('im.common.close', '关闭')} onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>

        {/* 桌面端：壳层蒙层取景中；网页端：保留原有的窗口选择 / 重试引导页 */}
        {!source && (captureMode !== 'web' ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
            <Loader2 size={40} strokeWidth={1.4} className="animate-spin text-primary" />
            <p className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
              {captureMode === 'image'
                ? t('im.screenshot.loadingImage', '正在加载图片…')
                : t('im.screenshot.desktopHint',
                '正在取景：鼠标移到窗口上会高亮截取范围，单击即完成；按住拖拽可自由框选，ESC / 右键取消。')}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
            {captureSupported ? (
              <>
                <button type="button" disabled={busy}
                        onClick={() => void onCapture()}
                        title={t('im.screenshot.select', '重新选择窗口')}
                        className="flex h-40 w-56 flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-background/50 text-primary transition-colors hover:border-primary/60 hover:bg-primary/5 disabled:opacity-50 cursor-pointer">
                  <AppWindow size={64} strokeWidth={1.2} />
                </button>
                <p className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
                  {t('im.screenshot.windowHint',
                    '已为你打开应用窗口列表；在列表中双击目标窗口小图即完成截图。若列表未弹出或被取消，点上方按钮重新选择。')}
                </p>
              </>
            ) : (
              <>
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-500">
                  {t(insecure ? 'im.screenshot.unsupportedInsecure' : 'im.screenshot.unsupportedBrowser')}
                </p>
                {insecure && (
                  <IconButton title={t('im.screenshot.openHttps', '用 HTTPS 打开')}
                              onClick={openSecureVersion}>
                    <Monitor size={16} />
                  </IconButton>
                )}
              </>
            )}
          </div>
        ))}

        {/* 抓帧后的操作页：可缩放 / 平移 / 裁剪 / 标注 */}
        {source && (
          <div ref={viewportRef}
               onPointerDown={onPointerDown} onPointerMove={onPointerMove}
               onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
               onPointerLeave={() => { setHoverTextIndex(null); setHoverShapeIndex(null) }}
               className="relative flex min-h-0 flex-1 select-none items-center justify-center overflow-hidden bg-[#F7F7F7] p-3"
               style={{ touchAction: 'none', cursor: 'default' }}>
            <div ref={stageRef} className="relative inline-flex max-h-full max-w-full"
                 style={{
                   cursor: imageCursor,
                   transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
                   transformOrigin: 'center center',
                 }}>
              <img
                ref={imgRef} src={source.url} alt={t('im.screenshot.title', '截图')}
                draggable={false}
                onLoad={() => setDisplaySize({
                  width: imgRef.current?.clientWidth ?? 0,
                  height: imgRef.current?.clientHeight ?? 0,
                })}
                className="block max-w-full select-none object-contain"
                style={{
                  // 拖拽改尺寸后用实际像素高度，未拖拽时保持原默认视口高度
                  maxHeight: `calc(${maximized ? '100vh' : size ? `${size.h}px` : '88vh'} - ${84 + (desktopMode ? DESKTOP_TITLEBAR_HEIGHT : 0)}px)`,
                }}
              />
              <canvas ref={mosaicCanvasRef}
                      className="pointer-events-none absolute left-0 top-0 h-full w-full"
                      style={overlayStyle} />
              {crop && crop.w > 0 && crop.h > 0 && (
                <div className="pointer-events-none absolute rounded-sm border-2 border-white"
                     style={{
                       left: crop.x / scaleX, top: crop.y / scaleY,
                       width: crop.w / scaleX, height: crop.h / scaleY,
                       boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                     }} />
              )}
              <svg className="pointer-events-none absolute left-0 top-0 h-full w-full"
                   style={overlayStyle}
                   viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="none">
                {annotations.map((shape, index) => (
                  <ShapeNode key={index} shape={shape} stroke={strokeFor(source.width)} index={index} />
                ))}
                {draft && (
                  <ShapeNode shape={draft} stroke={strokeFor(source.width)} index={-1} />
                )}
                {editingShape && shapeHandles.map((vertex, index) => (
                  <circle key={`handle-${index}`} data-shape-handle={index}
                          cx={vertex.x} cy={vertex.y}
                          r={Math.max(strokeFor(source.width) * 2.5, 6)}
                          fill="#fff" stroke="#007aff"
                          strokeWidth={Math.max(strokeFor(source.width), 2)} />
                ))}
              </svg>
              {/* 点击任何非输入框区域都收尾：有内容落图，空内容丢弃草稿 */}
              {textDraft && (
                <textarea
                  ref={textInputRef} value={textDraft.value} rows={2}
                  placeholder={t('im.screenshot.textPlaceholder', '输入备注')}
                  onPointerDown={event => event.stopPropagation()}
                  onChange={event => setTextDraft({ ...textDraft, value: event.target.value })}
                  onKeyDown={event => {
                    event.stopPropagation()
                    // Enter 确认落图；Shift+Enter 手动换行（超宽文字另由 wrapText 自动折行）
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      commitText(true)
                    }
                  }}
                  onBlur={() => commitText(Boolean(textDraftRef.current?.value.trim()))}
                  className="absolute z-10 min-w-[160px] max-w-[70%] resize-none whitespace-pre-wrap rounded border border-primary bg-background/90 px-1 py-0.5 leading-tight outline-none"
                  style={{
                    left: clamp(textDraft.x / scaleX, 0, Math.max(0, displaySize.width - 170)),
                    top: clamp(textDraft.y / scaleY, 0, Math.max(0, displaySize.height - 48)),
                    color, fontSize: Math.max(12, effectiveFontSize / scaleX),
                  }}
                />
              )}
            </div>
          </div>
        )}
        {notice}
        {/* 最大化时隐藏，其余状态从四边四角拖拽改窗口尺寸 */}
        {!maximized && IM_DIALOG_RESIZE_HANDLES.map(handle => (
          <div key={handle.dir} data-screenshot-resize={handle.dir}
               className={`absolute z-20 ${handle.className}`}
               onPointerDown={event => startResize(event, handle.dir)} />
        ))}
      </div>
    </div>,
    document.body,
      )}
      <ImForwardDialog
        open={forwardOpen}
        conversations={conversations}
        count={1}
        onClose={() => { setForwardOpen(false); setForwardFile(null) }}
        onConfirm={confirmForward}
      />
    </>
  )
}
