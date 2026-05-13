/**
 * 离线地图组件
 */
import { useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import { Icon, LatLngBounds } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-defaulticon-compatibility/dist/leaflet-defaulticon-compatibility.css'
import 'leaflet-defaulticon-compatibility'

interface SiteData {
  id: string
  name: string
  longitude: number
  latitude: number
}

interface OfflineMapProps {
  data: {
    sites: SiteData[]
    center: {
      latitude: number
      longitude: number
    }
  }
  offlinePath: string
}

export function OfflineMap({ data, offlinePath }: OfflineMapProps) {
  const [error, setError] = useState<string | null>(null)

  if (!offlinePath) {
    return (
      <div className="flex items-center justify-center h-full bg-muted">
        <p className="text-muted-foreground">请先配置离线地图路径</p>
      </div>
    )
  }

  // 尝试加载本地瓦片
  const tileUrl = offlinePath.replace('{z}', '{z}').replace('{x}', '{x}').replace('{y}', '{y}')

  return (
    <div className="h-full w-full">
      {error ? (
        <div className="flex items-center justify-center h-full bg-destructive/10">
          <p className="text-destructive">{error}</p>
        </div>
      ) : (
        <MapContainer
          center={[data.center.latitude, data.center.longitude]}
          zoom={12}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            url={tileUrl}
            error={() => setError('无法加载离线地图，请检查路径配置')}
          />
          {data.sites.map(site => (
            <Marker
              key={site.id}
              position={[site.latitude, site.longitude]}
            >
              <Popup>{site.name}</Popup>
            </Marker>
          ))}
        </MapContainer>
      )}
    </div>
  )
}
