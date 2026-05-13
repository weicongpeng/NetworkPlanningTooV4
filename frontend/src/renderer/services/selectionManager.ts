import L from 'leaflet'
import { RenderSectorData } from './mapDataService'

export type SelectionMode = 'none' | 'circle' | 'polygon' | 'point'

export interface SelectionState {
  mode: SelectionMode
  selectedFeatures: any[]
  selectedIds: Set<string>
  selectionPoints: L.LatLng[]
  circleCenter: L.LatLng | null
  circleRadius: number | null
}

export interface SelectionEventListener {
  (event: { type: string; data: any }): void
}

class SelectionManager {
  private state: SelectionState = {
    mode: 'none',
    selectedFeatures: [],
    selectedIds: new Set(),
    selectionPoints: [],
    circleCenter: null,
    circleRadius: null
  }

  private listeners: SelectionEventListener[] = []

  getState(): SelectionState {
    return { ...this.state }
  }

  getMode(): SelectionMode {
    return this.state.mode
  }

  setMode(mode: SelectionMode): void {
    const oldMode = this.state.mode
    this.state.mode = mode
    
    if (mode === 'none' && oldMode !== 'none') {
      this.clearSelection()
    }
    
    if (mode !== 'none' && oldMode === 'none') {
      this.clearSelection()
    }
    
    this.emit({ type: 'mode-changed', data: { mode, oldMode } })
  }

  getSelectedFeatures(): any[] {
    return [...this.state.selectedFeatures]
  }

  getSelectedIds(): Set<string> {
    return new Set(this.state.selectedIds)
  }

  setSelectedFeatures(features: any[]): void {
    this.state.selectedFeatures = features
    this.state.selectedIds = new Set(features.map(f => this.getFeatureId(f)))
    this.emit({ type: 'selection-changed', data: { features, ids: this.state.selectedIds } })
  }

  toggleFeatureSelection(feature: any): void {
    const id = this.getFeatureId(feature)
    const newIds = new Set(this.state.selectedIds)
    const newFeatures = [...this.state.selectedFeatures]
    
    if (newIds.has(id)) {
      newIds.delete(id)
      const index = newFeatures.findIndex(f => this.getFeatureId(f) === id)
      if (index !== -1) {
        newFeatures.splice(index, 1)
      }
    } else {
      newIds.add(id)
      newFeatures.push(feature)
    }
    
    this.state.selectedIds = newIds
    this.state.selectedFeatures = newFeatures
    this.emit({ type: 'selection-changed', data: { features: newFeatures, ids: newIds } })
  }

  clearSelection(): void {
    this.state.selectedFeatures = []
    this.state.selectedIds = new Set()
    this.state.selectionPoints = []
    this.state.circleCenter = null
    this.state.circleRadius = null
    this.emit({ type: 'selection-cleared', data: {} })
  }

  setSelectionPoints(points: L.LatLng[]): void {
    this.state.selectionPoints = points
    this.emit({ type: 'points-updated', data: { points } })
  }

  setCircleInfo(center: L.LatLng | null, radius: number | null): void {
    this.state.circleCenter = center
    this.state.circleRadius = radius
    this.emit({ type: 'circle-updated', data: { center, radius } })
  }

  private getFeatureId(feature: any): string {
    if (feature.id !== undefined) return String(feature.id)
    if (feature.siteId && feature.sectorId) return `${feature.siteId}_${feature.sectorId}`
    if (feature.name) return feature.name
    return String(Math.random())
  }

  getSectorsInCircle(
    sectors: RenderSectorData[],
    center: L.LatLng,
    radius: number
  ): RenderSectorData[] {
    const results: RenderSectorData[] = []
    
    for (const sector of sectors) {
      if (!sector.displayLat || !sector.displayLng) continue
      
      const distance = center.distanceTo([sector.displayLat, sector.displayLng])
      if (distance <= radius) {
        results.push(sector)
      }
    }
    
    return results
  }

  getSectorsInPolygon(
    sectors: RenderSectorData[],
    points: L.LatLng[]
  ): RenderSectorData[] {
    if (points.length < 3) return []
    
    const results: RenderSectorData[] = []
    const polygon = L.polygon(points)
    const bounds = polygon.getBounds()
    const polygonPoints = points.map(p => [p.lat, p.lng])
    
    for (const sector of sectors) {
      if (!sector.displayLat || !sector.displayLng) continue
      
      const latlng = L.latLng(sector.displayLat, sector.displayLng)
      if (bounds.contains(latlng)) {
        if (this.isPointInPolygon([sector.displayLat, sector.displayLng], polygonPoints)) {
          results.push(sector)
        }
      }
    }
    
    return results
  }

  private isPointInPolygon(point: number[], polygon: number[][]): boolean {
    const x = point[0], y = point[1]
    let inside = false
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1]
      const xj = polygon[j][0], yj = polygon[j][1]
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
      if (intersect) inside = !inside
    }
    
    return inside
  }

  formatFeaturesToTSV(features: any[]): string {
    if (features.length === 0) return ''
    
    const keys = new Set<string>()
    features.forEach(f => Object.keys(f).forEach(k => {
      if (!k.startsWith('_')) keys.add(k)
    }))
    
    const sortedKeys = Array.from(keys).sort()
    const header = sortedKeys.join('\t')
    
    const rows = features.map(f => {
      return sortedKeys.map(k => {
        const val = f[k]
        if (val === null || val === undefined) return ''
        let strVal = String(val)
        strVal = strVal.replace(/\t/g, ' ')
        strVal = strVal.replace(/\r?\n/g, ' ')
        strVal = strVal.replace(/\r/g, ' ')
        return strVal
      }).join('\t')
    })
    
    return [header, ...rows].join('\n')
  }

  async copyToClipboard(features: any[]): Promise<{ success: boolean; count: number; error?: string }> {
    if (features.length === 0) {
      return { success: false, count: 0, error: '没有选中的数据' }
    }
    
    const tsvContent = this.formatFeaturesToTSV(features)
    
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(tsvContent)
        return { success: true, count: features.length }
      }
      
      window.focus()
      const textarea = document.createElement('textarea')
      textarea.value = tsvContent
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      
      const successful = document.execCommand('copy')
      document.body.removeChild(textarea)
      
      if (successful) {
        return { success: true, count: features.length }
      } else {
        return { success: false, count: 0, error: '复制命令执行失败' }
      }
    } catch (err) {
      return { success: false, count: 0, error: String(err) }
    }
  }

  subscribe(listener: SelectionEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  private emit(event: { type: string; data: any }): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[SelectionManager] Listener error:', err)
      }
    }
  }
}

export const selectionManager = new SelectionManager()
