/**
 * 内嵌地图引擎挂载点：按地图源在 2D（OnlineMap）与 3D（CesiumMap）之间切换。
 * props / ref 与 OnlineMap 同构；CesiumMap 分包懒加载，仅在选择 3D 时下载。
 */
import { forwardRef, lazy, Suspense, type ComponentProps } from 'react'
import { Loader2 } from 'lucide-react'
import { OnlineMap, type OnlineMapRef } from './OnlineMap'
import { isCesiumSource } from '../../config/mapSources'

const LazyCesiumMap = lazy(() =>
  import('./cesium/CesiumMap').then((m) => ({ default: m.CesiumMap })),
)

type MapCanvasProps = Omit<ComponentProps<typeof OnlineMap>, 'ref'>

export const MapCanvas = forwardRef<OnlineMapRef, MapCanvasProps>((props, ref) => {
  const mapSource = props.mapSource ?? 'amap-vector'
  if (!isCesiumSource(mapSource)) {
    return <OnlineMap ref={ref} {...props} />
  }
  return (
    <Suspense
      fallback={
        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
          <Loader2 className="animate-spin" size={24} />
        </div>
      }
    >
      <LazyCesiumMap ref={ref} {...props} />
    </Suspense>
  )
})
MapCanvas.displayName = 'MapCanvas'
