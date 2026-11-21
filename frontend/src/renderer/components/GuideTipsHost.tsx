import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Lightbulb, X } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import {
  GUIDE_TIPS,
  GUIDE_TIP_TRIGGER_DELAY_MS,
  GUIDE_TIP_DURATION_MS,
  sessionFingerprint,
  getSessionShown,
  markSessionShown,
  canShowTip,
  bumpTipShowCount,
  type GuideTip,
} from '../utils/guideTips'

const GAP = 10
const MARGIN = 12
const BUBBLE_WIDTH = 320

/** 页面必须可见且窗口在前台；被其它标签页或窗口遮挡时不累计停留时间 */
export function isGuideSurfaceActive(
  visibilityState: DocumentVisibilityState = document.visibilityState,
  focused: boolean = typeof document.hasFocus === 'function' ? document.hasFocus() : true,
): boolean {
  return visibilityState === 'visible' && focused
}

/** 锚点中心必须仍是最上层可交互元素，避免被弹窗/遮罩挡住时仍弹提示 */
export function isGuideAnchorUnobstructed(
  el: HTMLElement,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  topElementAt: (x: number, y: number) => Element | null =
    (x, y) => document.elementFromPoint(x, y),
): boolean {
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
  const top = topElementAt(x, y)
  if (!top) return false
  if (top === el || el.contains(top)) return true
  // 部分锚点是纯展示文案（pointer-events:none），命中结果会是其父容器；
  // 仅此场景允许父容器，避免把真正覆盖页面的祖先层误判为未遮挡。
  return top.contains(el) && getComputedStyle(el).pointerEvents === 'none'
}

interface VisibleAnchor {
  el: HTMLElement
  rect: DOMRect
}

/** 找到锚点并确认其当前可见：锚点只在对应「时机」才带 data-guide 属性 */
function visibleAnchor(id: string): VisibleAnchor | null {
  const el = document.querySelector<HTMLElement>(`[data-guide="${id}"]`)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  if (rect.bottom < MARGIN || rect.top > window.innerHeight - MARGIN) return null
  if (rect.right < MARGIN || rect.left > window.innerWidth - MARGIN) return null
  // 工具栏「更多」收纳项会保留在 DOM 里用 visibility:hidden 测宽，不能当成可见锚点
  const cs = getComputedStyle(el)
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null
  return { el, rect }
}

interface BubbleProps {
  tip: GuideTip
  text: string
  username: string
  /** 当前登录周期指纹（由令牌派生） */
  fp: string
  closeLabel: string
  /** 收起（关闭 / 超时 / 锚点长时间不可见跳过）后推进到下一条 */
  onDone: () => void
}

/**
 * 单条冒泡：portal 到 body，用 fixed 定位跟随锚点。
 * 触发条件为「页面处于前台且锚点连续可见、未被弹窗遮挡超过 3 秒」；
 * 触发瞬间才记一次累计次数并标记本登录周期已展示。
 * 失焦/切后台/被遮挡时暂停并保留本条；前台且锚点持续不存在才跳过，避免队列卡死。
 */
function Bubble({ tip, text, username, fp, closeLabel, onDone }: BubbleProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const arrowUpRef = useRef<HTMLDivElement>(null)
  const arrowDownRef = useRef<HTMLDivElement>(null)
  const phaseRef = useRef<'pending' | 'shown'>('pending')
  const anchorVisibleRef = useRef<boolean | null>(null)
  const anchorSinceRef = useRef(0)
  const shownAtRef = useRef<number | null>(null)
  const finishedRef = useRef(false)

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    onDone()
  }, [onDone])

  // 切到其它标签页/窗口或被遮挡后重新计时：rAF 在后台会被暂停，
  // 不能只靠下一帧比较时间，否则回来时会拿遮挡前的起点立即触发。
  useEffect(() => {
    const resetAnchorTimer = () => {
      anchorVisibleRef.current = null
      anchorSinceRef.current = Date.now()
    }
    window.addEventListener('blur', resetAnchorTimer)
    document.addEventListener('visibilitychange', resetAnchorTimer)
    return () => {
      window.removeEventListener('blur', resetAnchorTimer)
      document.removeEventListener('visibilitychange', resetAnchorTimer)
    }
  }, [])

  // rAF 逐帧跟随：地图展开/折叠等带过渡的布局变化也能保持箭头对准锚点
  useLayoutEffect(() => {
    let raf = 0
    const tick = () => {
      if (finishedRef.current) return
      const box = boxRef.current
      if (!box) { raf = requestAnimationFrame(tick); return }

      const now = Date.now()
      const surfaceActive = isGuideSurfaceActive()
      const anchor = surfaceActive ? visibleAnchor(tip.id) : null
      const r = anchor?.rect ?? null
      const unobstructed = !!anchor && isGuideAnchorUnobstructed(anchor.el, anchor.rect)
      const visible = surfaceActive && unobstructed
      // 可见状态切换即重置计时：要求「连续」停留，离开模块/失焦/被遮挡都重新计时
      if (anchorVisibleRef.current !== visible) {
        anchorVisibleRef.current = visible
        anchorSinceRef.current = now
      }
      const waited = now - anchorSinceRef.current

      if (phaseRef.current === 'pending') {
        box.style.visibility = 'hidden'
        // 窗口失焦/页面不可见或被弹窗遮挡时只暂停，不消耗候选队列
        if (!surfaceActive || (anchor && !unobstructed)) {
          raf = requestAnimationFrame(tick)
          return
        }
        if (waited >= GUIDE_TIP_TRIGGER_DELAY_MS) {
          // 页面在前台但锚点始终没出现（如结果尚未生成）→ 跳过本条
          if (!anchor) { finish(); return }
          // 队列创建后计数可能已被其它标签页/窗口推到上限，显示前必须再校验一次
          if (!canShowTip(username, tip.id)) { finish(); return }
          phaseRef.current = 'shown'
          shownAtRef.current = now
          bumpTipShowCount(username, tip.id)
          markSessionShown(username, fp, tip.id)
        }
      }

      if (phaseRef.current === 'shown') {
        // 触发后 2 分钟收起（即使中途锚点隐藏也照常计时）
        if (shownAtRef.current !== null && now - shownAtRef.current >= GUIDE_TIP_DURATION_MS) {
          finish()
          return
        }
        if (visible && r) {
          const w = box.offsetWidth || BUBBLE_WIDTH
          const h = box.offsetHeight
          let top = r.bottom + GAP
          let placeAbove = false
          if (top + h > window.innerHeight - MARGIN) {
            top = r.top - GAP - h
            placeAbove = true
          }
          top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))
          const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - MARGIN))

          box.style.visibility = 'visible'
          box.style.left = `${left}px`
          box.style.top = `${top}px`

          const arrowX = Math.max(12, Math.min(w - 12, r.left + r.width / 2 - left)) - 6
          if (arrowUpRef.current) {
            arrowUpRef.current.style.visibility = placeAbove ? 'hidden' : 'visible'
            arrowUpRef.current.style.left = `${arrowX}px`
          }
          if (arrowDownRef.current) {
            arrowDownRef.current.style.visibility = placeAbove ? 'visible' : 'hidden'
            arrowDownRef.current.style.left = `${arrowX}px`
          }
        } else {
          box.style.visibility = 'hidden'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tip.id, username, fp, finish])

  return createPortal(
    <div
      ref={boxRef}
      className="pointer-events-none fixed w-[320px] rounded-xl border border-primary/30 bg-card p-3 pr-8 shadow-xl"
      style={{ visibility: 'hidden', zIndex: 10000 }}
    >
      <div
        ref={arrowUpRef}
        className="absolute -top-[6px] h-3 w-3 rotate-45 border-l border-t border-primary/30 bg-card"
        style={{ visibility: 'hidden' }}
      />
      <div
        ref={arrowDownRef}
        className="absolute -bottom-[6px] h-3 w-3 rotate-45 border-b border-r border-primary/30 bg-card"
        style={{ visibility: 'hidden' }}
      />
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Lightbulb size={13} className="text-primary" />
        </div>
        <p className="flex-1 text-xs leading-relaxed text-foreground">{text}</p>
      </div>
      <button
        type="button"
        onClick={finish}
        className="pointer-events-auto absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        aria-label={closeLabel}
      >
        <X size={14} />
      </button>
    </div>,
    document.body,
  )
}

/**
 * 全局冒泡引导宿主：挂载在 MainLayout 内（AuthGuard 之下）。
 * 对所有登录用户生效；按「路由 + 登录周期去重 + 账号累计 30 次上限」算出候选队列，
 * 同一时刻只渲染队首一条（不并排弹多个），关闭/超时/跳过后推进下一条。
 */
export function GuideTipsHost() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const { pathname } = useLocation()
  const { t } = useTranslation()
  const [queue, setQueue] = useState<string[]>([])
  const [index, setIndex] = useState(0)

  const username = user?.username ?? ''
  const fp = sessionFingerprint(token)

  useEffect(() => {
    if (!username) {
      setQueue([])
      setIndex(0)
      return
    }
    const shown = getSessionShown(username, fp)
    setQueue(
      GUIDE_TIPS.filter(
        (tip) =>
          tip.routes.includes(pathname) &&
          !shown.includes(tip.id) &&
          canShowTip(username, tip.id),
      ).map((tip) => tip.id),
    )
    setIndex(0)
  }, [pathname, username, fp])

  const handleDone = useCallback(() => setIndex((i) => i + 1), [])

  const currentId = queue[index]
  const tip = currentId ? GUIDE_TIPS.find((x) => x.id === currentId) : undefined
  if (!username || !tip) return null

  return (
    <Bubble
      key={tip.id}
      tip={tip}
      text={t(tip.i18nKey)}
      username={username}
      fp={fp}
      closeLabel={t('guide.close') || '关闭'}
      onDone={handleDone}
    />
  )
}
