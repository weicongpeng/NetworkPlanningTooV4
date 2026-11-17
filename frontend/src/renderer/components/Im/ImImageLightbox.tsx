/**
 * 图片 / 附件预览灯箱：自己持有 objectURL 的完整生命周期（创建 → 关闭时 revoke），
 * 与消息气泡缩略图的 objectURL 彻底解耦，修掉「第一次打开正常、再次点击空白」。
 *
 * - 收到的图片：按 attachmentId 拉全图（非缩略图），滚轮自由缩放 + 拖拽平移。
 * - 输入框里复制/拖拽的图片、文件：直接给本地 File，双击即可打开预览。
 * - 非图片文件：展示文件卡片，可在新标签页打开或下载。
 * - 所有按钮只留图标 + title 悬浮提示。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, FileIcon, Loader2,
  RotateCcw, RotateCw, X, ZoomIn, ZoomOut,
} from 'lucide-react'

import { imApi } from '../../services/api'
import { useAuthStore } from '../../store/authStore'
import { formatBytes } from './types'
import type { ImLightboxSource } from './types'

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const ZOOM_STEP = 1.15

/**
 * 桌面端自绘标题栏（WindowTitleBar 的 h-8）高度。
 * 灯箱 portal 到 body，若不避开标题栏，顶部缩放/下载/关闭工具条会被
 * 「共享模式 · 已同步」那一行盖住；桌面端从标题栏下沿开始铺满窗口其余区域。
 */
const DESKTOP_TITLEBAR_HEIGHT = 32

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

interface Props {
  source: ImLightboxSource
  onClose: () => void
}

/** 单张预览时复用空数组，避免每次 render 新建引用导致键盘监听反复注册 */
const EMPTY_GALLERY: ImLightboxSource[] = []

export function ImImageLightbox({ source, onClose }: Props) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore(s => s.desktopMode)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rotation, setRotation] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // 画廊 = 当前会话已加载的全部图片。灯箱自己持有当前项，翻页不回写 store，
  // 这样输入框待发送附件预览（无 gallery）仍是单张、不受影响。
  const gallery = source.gallery ?? EMPTY_GALLERY
  const [current, setCurrent] = useState<ImLightboxSource>(source)
  useEffect(() => { setCurrent(source) }, [source])
  const matchedIndex = gallery.findIndex(item =>
    item.attachmentId != null && item.attachmentId === current.attachmentId)
  const currentIndex = matchedIndex >= 0
    ? matchedIndex
    : Math.min(Math.max(0, source.galleryIndex ?? 0), Math.max(0, gallery.length - 1))
  const canNavigate = gallery.length > 1
  const isImage = current.mime.startsWith('image/')

  const goTo = (index: number) => {
    if (!canNavigate || index < 0 || index >= gallery.length || index === currentIndex) return
    setCurrent(gallery[index])
  }

  // 灯箱独享 objectURL：来源变化时重建，关闭 / 卸载时 revoke，不借用任何外部 URL
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setUrl(null)
    setFailed(false)

    const load = async () => {
      try {
        let blob: Blob
        if (current.file) {
          blob = current.file
        } else if (current.attachmentId != null) {
          blob = await imApi.attachmentBlob(current.attachmentId, false)
        } else {
          throw new Error('missing source')
        }
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [current, retryCount])

  // 换一张图复位视图（含旋转），避免上一张的角度带到下一张
  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setRotation(0)
  }, [current])

  // 原生 wheel 监听（passive:false 才能 preventDefault，避免页面一起滚动）
  useEffect(() => {
    const node = stageRef.current
    if (!node || !isImage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      setScale(prev => {
        const next = clampScale(prev * factor)
        if (next <= 1) setOffset({ x: 0, y: 0 })
        return next
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [isImage])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (!canNavigate) return
      event.preventDefault()
      event.stopPropagation()
      const next = currentIndex + (event.key === 'ArrowRight' ? 1 : -1)
      if (next >= 0 && next < gallery.length) setCurrent(gallery[next])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, canNavigate, currentIndex, gallery])

  const resetView = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y })
  }
  const onPointerUp = () => { dragRef.current = null }

  const saveUrl = (href: string, filename: string, revoke = false) => {
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    if (revoke) window.setTimeout(() => URL.revokeObjectURL(href), 2000)
  }

  const download = () => {
    if (!url) return
    const image = imageRef.current
    if (!rotation || !image?.naturalWidth) {
      saveUrl(url, current.name)
      return
    }
    // 旋转后下载：按最终朝向重建 PNG，避免下载下来还是原方向
    const canvas = document.createElement('canvas')
    canvas.width = rotation % 180 === 0 ? image.naturalWidth : image.naturalHeight
    canvas.height = rotation % 180 === 0 ? image.naturalHeight : image.naturalWidth
    const context = canvas.getContext('2d')
    if (!context) { saveUrl(url, current.name); return }
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate((rotation * Math.PI) / 180)
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
    canvas.toBlob(blob => {
      if (blob) saveUrl(URL.createObjectURL(blob), current.name, true)
      else saveUrl(url, current.name)
    }, 'image/png')
  }
  const openFile = () => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  const zoomBy = (factor: number) => setScale(prev => {
    const next = clampScale(prev * factor)
    if (next <= 1) setOffset({ x: 0, y: 0 })
    return next
  })

  return createPortal(
    <div data-im-lightbox
         className="fixed inset-0 z-[10000] flex flex-col bg-black/85 backdrop-blur-sm"
         style={desktopMode ? { top: DESKTOP_TITLEBAR_HEIGHT } : undefined}
         onClick={onClose}>
      {/* 顶部工具条：图标 + title 悬浮提示 */}
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-3 py-2"
           onClick={event => event.stopPropagation()}>
        <span className="mr-auto min-w-0 truncate pr-3 text-xs text-white/80">{current.name}</span>
        {canNavigate && (
          <span data-im-lightbox-counter
                className="mr-2 shrink-0 text-[11px] tabular-nums text-white/60">
            {currentIndex + 1} / {gallery.length}
          </span>
        )}
        {isImage && (
          <>
            <span className="mr-1 w-11 text-right text-[11px] tabular-nums text-white/60">
              {Math.round(scale * 100)}%
            </span>
            <IconButton title={t('im.lightbox.zoomOut', '缩小')} onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <ZoomOut size={18} />
            </IconButton>
            <IconButton title={t('im.lightbox.zoomIn', '放大')} onClick={() => zoomBy(ZOOM_STEP)}>
              <ZoomIn size={18} />
            </IconButton>
            <IconButton title={t('im.lightbox.rotateLeft', '向左旋转 90°')}
                        onClick={() => setRotation(value => (value + 270) % 360)}>
              <RotateCcw size={18} />
            </IconButton>
            <IconButton title={t('im.lightbox.rotateRight', '向右旋转 90°')}
                        onClick={() => setRotation(value => (value + 90) % 360)}>
              <RotateCw size={18} />
            </IconButton>
          </>
        )}
        {url && (
          <IconButton title={t('im.lightbox.download', '下载')} onClick={download}>
            <Download size={18} />
          </IconButton>
        )}
        <IconButton title={t('im.common.close', '关闭')} onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>

      {/* 舞台：滚轮缩放 + 拖拽平移 + 双击复位 */}
      <div ref={stageRef}
           className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden
             ${isImage && scale > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
           onClick={event => event.stopPropagation()}
           onDoubleClick={resetView}>
        {canNavigate && (
          <>
            <button type="button" data-im-lightbox-prev
                    title={t('im.lightbox.prev', '上一张')}
                    disabled={currentIndex <= 0}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); goTo(currentIndex - 1) }}
                    className="absolute left-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/85 shadow-lg transition-colors hover:bg-black/70 hover:text-white disabled:cursor-not-allowed disabled:opacity-25 cursor-pointer">
              <ChevronLeft size={24} />
            </button>
            <button type="button" data-im-lightbox-next
                    title={t('im.lightbox.next', '下一张')}
                    disabled={currentIndex >= gallery.length - 1}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); goTo(currentIndex + 1) }}
                    className="absolute right-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/85 shadow-lg transition-colors hover:bg-black/70 hover:text-white disabled:cursor-not-allowed disabled:opacity-25 cursor-pointer">
              <ChevronRight size={24} />
            </button>
          </>
        )}
        {failed ? (
          <button type="button"
                  onClick={() => setRetryCount(value => value + 1)}
                  className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/80 hover:bg-white/20 cursor-pointer">
            <RotateCcw size={14} /> {t('im.message.imageFailed', '图片加载失败，重试')}
          </button>
        ) : !url ? (
          <Loader2 size={28} className="animate-spin text-white/60" />
        ) : isImage ? (
          <img
            ref={imageRef}
            src={url}
            alt={current.name}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
            }}
          />
        ) : (
          <div className="flex w-[280px] flex-col items-center gap-3 rounded-2xl border border-white/15 bg-white/5 px-6 py-7 text-white">
            <FileIcon size={40} strokeWidth={1.3} className="text-white/70" />
            <p className="w-full truncate text-center text-xs">{current.name}</p>
            {current.file && (
              <p className="text-[11px] text-white/60">{formatBytes(current.file.size)}</p>
            )}
            <button type="button" onClick={openFile}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:brightness-110 cursor-pointer">
              <ExternalLink size={13} />
              {t('im.lightbox.openFile', '在新标签页打开')}
            </button>
          </div>
        )}
      </div>

      {isImage && (
        <p className="shrink-0 pb-3 text-center text-[11px] text-white/50">
          {canNavigate
            ? t('im.lightbox.hintGallery', '滚轮缩放 · 拖拽平移 · 旋转 · 双击复位 · ← → 切换图片')
            : t('im.lightbox.hint', '滚轮缩放 · 拖拽平移 · 旋转 · 双击复位')}
        </p>
      )}
    </div>,
    document.body,
  )
}

function IconButton({ title, onClick, children }: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" title={title} onClick={onClick}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white cursor-pointer">
      {children}
    </button>
  )
}
