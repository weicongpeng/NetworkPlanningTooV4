/**
 * 地图类型切换组件
 * 支持平面地图和卫星地图切换
 */

import { useState } from 'react'
import { Layers, Satellite } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OnlineMapRef } from './OnlineMap'

type MapLayerType = 'roadmap' | 'satellite'

interface MapTypeSwitchProps {
  mapRef: React.RefObject<OnlineMapRef | null>
}

export function MapTypeSwitch({ mapRef }: MapTypeSwitchProps) {
  const { t } = useTranslation()
  const [mapType, setMapType] = useState<MapLayerType>('roadmap')

  const handleToggle = () => {
    const newType: MapLayerType = mapType === 'roadmap' ? 'satellite' : 'roadmap'
    setMapType(newType)
    mapRef.current?.setMapType(newType)
  }

  return (
    <button
      onClick={handleToggle}
      className="flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted/80 transition-colors text-xs"
      title={mapType === 'roadmap' ? t('map.switchToSatelliteMap') : t('map.switchToVectorMap')}
    >
      {mapType === 'roadmap' ? (
        <>
          <Layers size={14} />
          <span className="whitespace-nowrap">{t('map.vectorMap')}</span>
        </>
      ) : (
        <>
          <Satellite size={14} />
          <span className="whitespace-nowrap">{t('map.satelliteMap')}</span>
        </>
      )}
    </button>
  )
}
