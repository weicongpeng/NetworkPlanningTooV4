/**
 * 定位打点属性面板（3D / 2D 通用）。
 *
 * 对等 2D `OnlineMap` 里打点 marker 的 popup：
 * - 标签（重命名，失焦即生效）
 * - 经度 / 纬度（WGS84，可编辑；「确定」后把标记移到新位置）
 * - 复制属性（制表符分隔，可直接粘贴到 Excel）
 * - 删除
 *
 * 由地图组件在点击到打点标记时挂载，`onClose` 收起。
 */
import { useEffect, useRef, useState } from 'react'
import type { CapturePoint } from './cesium/CesiumMapTools'

export interface CapturePointPanelProps {
  point: CapturePoint
  /** 点击处的容器像素坐标 */
  position: { x: number; y: number }
  /** 地图容器矩形（用于把面板夹在可视区内） */
  viewportBounds: { width: number; height: number } | null
  onRename: (name: string) => void
  onMove: (lng: number, lat: number) => void
  onCopy: () => void
  onDelete: () => void
  onClose: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const PANEL_W = 236
const PANEL_H = 236

export function CapturePointPanel({
  point, position, viewportBounds, onRename, onMove, onCopy, onDelete, onClose, t,
}: CapturePointPanelProps) {
  const [name, setName] = useState(point.name)
  const [lng, setLng] = useState(point.lng.toFixed(6))
  const [lat, setLat] = useState(point.lat.toFixed(6))
  const [error, setError] = useState('')
  const copiedRef = useRef(false)
  const [copied, setCopied] = useState(false)

  // 切换到另一个打点时同步输入框
  useEffect(() => {
    setName(point.name)
    setLng(point.lng.toFixed(6))
    setLat(point.lat.toFixed(6))
    setError('')
    setCopied(false)
    copiedRef.current = false
  }, [point.id, point.name, point.lng, point.lat])

  const maxLeft = Math.max(0, (viewportBounds?.width ?? 800) - PANEL_W - 8)
  const maxTop = Math.max(0, (viewportBounds?.height ?? 600) - PANEL_H - 8)

  const applyMove = () => {
    const nLng = Number(lng)
    const nLat = Number(lat)
    if (!Number.isFinite(nLng) || !Number.isFinite(nLat)
      || nLng < -180 || nLng > 180 || nLat < -90 || nLat > 90) {
      setError(t('map.invalidCoordinate'))
      return
    }
    setError('')
    onMove(nLng, nLat)
  }

  const handleCopy = () => {
    onCopy()
    copiedRef.current = true
    setCopied(true)
    setTimeout(() => { if (copiedRef.current) setCopied(false) }, 1500)
  }

  return (
    <div
      className="absolute z-[1002] w-[236px] bg-card/95 border border-border rounded-lg shadow-lg p-3"
      style={{ left: Math.min(position.x + 12, maxLeft), top: Math.min(position.y + 12, maxTop) }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-foreground">
          {t('map.capturePoint') || '打点'}
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-sm leading-none px-1"
          aria-label={t('common.close') || '关闭'}
        >
          ×
        </button>
      </div>

      <label className="block text-[11px] text-muted-foreground mb-0.5">
        {t('map.labelName') || '标签'}
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onRename(name.trim() || point.name)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-full mb-2 px-2 py-1 text-xs rounded border border-border bg-background text-foreground"
      />

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="block text-[11px] text-muted-foreground mb-0.5">
            {t('map.longitude') || '经度'}
          </label>
          <input
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyMove() }}
            className="w-full px-2 py-1 text-xs rounded border border-border bg-background text-foreground"
          />
        </div>
        <div>
          <label className="block text-[11px] text-muted-foreground mb-0.5">
            {t('map.latitude') || '纬度'}
          </label>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyMove() }}
            className="w-full px-2 py-1 text-xs rounded border border-border bg-background text-foreground"
          />
        </div>
      </div>

      {!!error && (
        <div className="mb-2 text-[11px] text-destructive">{error}</div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          onClick={applyMove}
          className="px-2 py-1 text-[11px] rounded border border-border bg-background text-foreground hover:bg-muted"
        >
          {t('map.confirm') || '确定'}
        </button>
        <button
          onClick={handleCopy}
          className={`px-2 py-1 text-[11px] rounded border ${copied
            ? 'border-emerald-500 text-emerald-600'
            : 'border-border bg-background text-foreground hover:bg-muted'}`}
        >
          {copied ? (t('map.copied') || '已复制') : (t('map.copy') || '复制')}
        </button>
        <button
          onClick={onDelete}
          className="px-2 py-1 text-[11px] rounded border border-border bg-background text-destructive hover:bg-muted"
        >
          {t('map.delete') || '删除'}
        </button>
      </div>
    </div>
  )
}
