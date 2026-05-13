/**
 * 地图状态服务
 *
 * 管理地图的位置、缩放等状态，在页面切换时保持状态
 */

interface MapState {
  center: [number, number]
  zoom: number
  mapLayerType: 'roadmap' | 'satellite'
}

class MapStateService {
  private state: MapState = {
    center: [23.7433, 114.6974], // 河源市 GCJ02坐标
    zoom: 12,
    mapLayerType: 'roadmap'
  }

  private listeners: Set<(state: MapState) => void> = new Set()

  /**
   * 获取当前状态
   */
  getState(): MapState {
    return { ...this.state }
  }

  /**
   * 更新状态
   */
  setState(updates: Partial<MapState>): void {
    this.state = { ...this.state, ...updates }
    this.notifyListeners()
  }

  /**
   * 监听状态变化
   */
  subscribe(listener: (state: MapState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 重置为默认状态（河源市）
   */
  reset(): void {
    this.state = {
      center: [23.7433, 114.6974],
      zoom: 12,
      mapLayerType: 'roadmap'
    }
    this.notifyListeners()
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.getState()))
  }
}

export const mapStateService = new MapStateService()
