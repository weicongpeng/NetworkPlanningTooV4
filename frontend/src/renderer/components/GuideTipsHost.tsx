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

/** 找到锚点并确认其当前可见：锚点只在对应「时机」才带 data-guide 属性 */
function visibleAnchorRect(id: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-guide="${id}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  if (r.bottom < MARGIN || r.top > window.innerHeight - MARGIN) return null
  if (r.right < MARGIN || r.left > window.innerWidth - MARGIN) return null
  // 工具栏「更多」收纳项会保留在 DOM 里用 visibility:hidden 测宽，不能当成可见锚点
  const cs = getComputedStyle(el)
  if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null
  return r
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
 * 触发条件为「锚点连续可见超过 3 秒」；触发瞬间才记一次累计次数并标记本登录周期已展示。
 * 锚点连续不可见超过 3 秒则跳过本条，避免串行队列卡死。
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

  // rAF 逐帧跟随：地图展开/折叠等带过渡的布局变化也能保持箭头对准锚点
  useLayoutEffect(() => {
    let raf = 0
    const tick = () => {
      if (finishedRef.current) return
      const box = boxRef.current
      if (!box) { raf = requestAnimationFrame(tick); return }

      const now = Date.now()
      const r = visibleAnchorRect(tip.id)
      const visible = !!r
      // 可见状态切换即重置计时：要求「连续」停留，离开模块就重新计时
      if (anchorVisibleRef.current !== visible) {
        anchorVisibleRef.current = visible
        anchorSinceRef.current = now
      }
      const waited = now - anchorSinceRef.current

      if (phaseRef.current === 'pending') {
        box.style.visibility = 'hidden'
        if (waited >= GUIDE_TIP_TRIGGER_DELAY_MS) {
          if (!visible) { finish(); return }  // 长时间不在对应模块 → 跳过
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
        if (r) {
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
 * 对所有登录用户生效；按「路由 + 登录周期去重 + 30 次累计上限」算出候选队列，
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
