/**
 * 地图工具栏组件 - 简化版，只保留模式切换
 */
import { MapPin, Layers } from 'lucide-react'

interface MapToolbarProps {
  viewMode: 'online' | 'offline'
  onViewModeChange: (mode: 'online' | 'offline') => void
}

export function MapToolbar({
  viewMode,
  onViewModeChange
}: MapToolbarProps) {
  return (
    <div className="absolute top-4 right-4 z-[1000]">
      {/* 视图模式切换 */}
      <div className="bg-card border border-border rounded-lg shadow-lg p-1">
        <button
          onClick={() => onViewModeChange('online')}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded transition-colors ${
            viewMode === 'online'
              ? 'bg-primary text-primary-foreground'
              : 'text-foreground hover:bg-muted hover:text-primary'
          }`}
        >
          <MapPin size={14} />
          在线地图
        </button>
        <button
          onClick={() => onViewModeChange('offline')}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded transition-colors mt-1 ${
            viewMode === 'offline'
              ? 'bg-primary text-primary-foreground'
              : 'text-foreground hover:bg-muted hover:text-primary'
          }`}
        >
          <Layers size={14} />
          离线地图
        </button>
      </div>
    </div>
  )
}
