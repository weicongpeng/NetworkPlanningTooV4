/**
 * 地图源切换下拉——与地图工具页共用 MAP_SOURCE_OPTIONS 和 store 真源。
 * 供参数规划/参数核查等内嵌地图的工具栏使用。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Globe, Map as MapIcon, Satellite, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MAP_SOURCE_OPTIONS, type MapSource } from '../../config/mapSources'
import { useMapStore } from '../../store/mapStore'

export function MapSourceSwitch() {
  const { t } = useTranslation()
  const mapSource = useMapStore((s) => s.mapSettings.mapSource)
  const setMapSource = useMapStore((s) => s.setMapSource)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const mapSourceIcon: Record<MapSource, ReactNode> = {
    'amap-vector': <MapIcon size={14} />,
    'amap-satellite': <Satellite size={14} />,
    'tdt-vector': <MapIcon size={14} />,
    'tdt-satellite': <Satellite size={14} />,
    cesium: <Globe size={14} />,
    none: <Square size={14} />,
  }
  const mapSourceLabel: Record<MapSource, string> = {
    'amap-vector': t('map.sourceAmapVector') || '高德矢量图',
    'amap-satellite': t('map.sourceAmapSatellite') || '高德卫星图',
    'tdt-vector': t('map.sourceTdtVector') || '天地图矢量图',
    'tdt-satellite': t('map.sourceTdtSatellite') || '天地图卫星图',
    cesium: t('map.sourceCesium3d') || '3D地图',
    none: t('map.sourceNone') || '空地图',
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs ${
          open ? 'text-primary border-primary/40' : ''
        }`}
        title={t('map.switchMapSource') || '切换地图源'}
      >
        {mapSourceIcon[mapSource]}
        <span className="whitespace-nowrap">{mapSourceLabel[mapSource]}</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-0.5 opacity-60">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-[3000] bg-card border border-border rounded-lg shadow-lg w-40 overflow-hidden">
          {MAP_SOURCE_OPTIONS.map((src) => (
            <button
              key={src}
              onClick={() => {
                setMapSource(src)
                setOpen(false)
              }}
              className={`w-full text-left px-2 py-1.5 text-xs transition-colors flex items-center gap-1.5 ${
                src === mapSource
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted hover:text-primary'
              }`}
            >
              {mapSourceIcon[src]}
              <span className="truncate">{mapSourceLabel[src]}</span>
              {src === mapSource && <Check size={12} className="ml-auto shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
