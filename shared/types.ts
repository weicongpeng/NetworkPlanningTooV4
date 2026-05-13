// 通用API响应类型
export interface ApiResponse<T = any> {
  success: boolean
  data: T
  message?: string
  code?: number
}

// 许可证相关类型
export interface LicenseStatus {
  valid: boolean
  expiryDate: string
  licensee: string
  licenseKey?: string
  features?: string[]
}

export interface LicenseInfo {
  licenseKey: string
  licensee: string
  expiryDate: string
  features: string[]
  signature: string
}

// 数据管理相关类型
export interface DataItem {
  id: string
  name: string
  type: 'excel' | 'map'
  size: number
  uploadDate: string
  status: 'processing' | 'ready' | 'error'
  metadata?: Record<string, any>
  originalPath?: string
  fileType?: 'full_params' | 'current_params' | 'target_cells' | 'tac_layer' | 'mapinfo_layer' | 'geo_data' | 'default'
  geometryType?: 'point' | 'sector' | 'polygon'
  sourceType?: 'excel' | 'mapinfo'
  subType?: string
}

export interface UploadResponse {
  id: string
  name: string
  status: string
}

export interface SiteData {
  id: string
  name: string
  longitude: number
  latitude: number
  networkType: 'LTE' | 'NR'
  pci?: number
  earfcn?: number
  arfcn?: number
  sectors: SectorData[]
}

export interface SectorData {
  id: string
  siteId: string
  name: string
  longitude: number
  latitude: number
  azimuth: number
  beamwidth: number
  height: number
  pci?: number
  earfcn?: number
  arfcn?: number
  cell_cover_type?: number  // 小区覆盖类型: 1=室外小区, 4=室内小区
}

// PCI规划相关类型
export interface PCIRange {
  min: number
  max: number
}

export interface PCIConfig {
  networkType: 'LTE' | 'NR'
  distanceThreshold: number
  pciModulus: 3 | 30
  inheritModulus: boolean
  pciRange?: PCIRange
  enableTACPlanning?: boolean
  enableCollisionCheck?: boolean
  enableConfusionCheck?: boolean
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
  customRules?: PCIRule[]
}

export interface PCIRule {
  condition: string
  pciRange: [number, number]
  priority: number
}

export interface PCIResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  collisions: number
  confusions: number
  results: SitePCIResult[]
  startTime: string
  endTime?: string
}

export interface SitePCIResult {
  siteId: string
  siteName: string
  sectors: SectorPCIResult[]
  conflicts?: PCIConflict[]
}

export interface SectorPCIResult {
  sectorId: string
  sectorName: string
  originalPCI?: number
  newPCI: number
  originalMod?: number
  newMod?: number
  earfcn?: number
  longitude?: number
  latitude?: number
  assignmentReason?: string
  minReuseDistance?: number
  minDistanceSectorName?: string
  collisionCount?: number
  confusionCount?: number
  tac?: string | null
}

export interface PCIConflict {
  type: 'collision' | 'confusion'
  sector1: string
  sector2: string
  pci: number
}

// 邻区规划相关类型
export interface NeighborConfig {
  planningType: 'LTE-LTE' | 'NR-NR' | 'NR-LTE'
  maxDistance?: number  // 已弃用，改用覆盖圆算法
  maxNeighbors: number
  coverageDistanceFactor: number  // 覆盖圆距离系数
  coverageRadiusFactor: number    // 覆盖圆半径系数
  customRules?: NeighborRule[]
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
}

export interface NeighborRule {
  condition: string
  action: 'add' | 'remove'
  priority: number
}

export interface NeighborResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalSites: number
  totalSectors: number
  totalNeighbors: number
  avgNeighbors: number
  results: SiteNeighborResult[]
  startTime: string
  endTime?: string
}

export interface SiteNeighborResult {
  siteId: string
  siteName: string
  sectors: SectorNeighborResult[]
  totalNeighbors?: number
}

export interface SectorNeighborResult {
  sectorId: string
  sectorName: string
  neighbors: NeighborRelation[]
  neighborCount?: number
}

export interface NeighborRelation {
  sourceSector: string
  sourceSectorName?: string
  targetSector: string
  targetSectorName?: string
  targetSite: string
  targetSiteName?: string
  distance: number
  bearing?: number
  relationType: 'LTE-LTE' | 'LTE-NR' | 'NR-LTE' | 'NR-NR'
}

// TAC规划相关类型
export interface TACConfig {
  networkType: 'LTE' | 'NR'
  enableSingularityCheck?: boolean
  singularityConfig?: {
    searchRadius: number
    singularityThreshold: number
  }
  selectedCellIds?: string[]  // 选中的小区ID列表（格式：siteId_sectorId）
}

export interface TACResult {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  totalCells: number
  matchedCells: number
  unmatchedCells: number
  singularityCount?: number
  results: CellTACResult[]
  startTime: string
  endTime?: string
  error?: string
}

export interface CellTACResult {
  sectorId: string
  sectorName: string
  siteId: string
  siteName: string
  networkType: 'LTE' | 'NR'
  longitude: number
  latitude: number
  tac: string | null
  tacAreaName?: string
  existingTac?: string | null
  matched: boolean
  isSingularity?: boolean
  singularityDetails?: TACSingularityDetails
  firstGroup?: string
  suggestedTac?: string | null  // TAC建议值，对于插花小区取图层TAC值
}

export interface TACSingularityDetails {
  sectorId: string
  sectorName: string
  siteId: string
  siteName: string
  cellTAC: string
  dominantTac: string
  validNeighborCount: number
  异TAC占比: number
  dominantTacRatio: number
}

// 地图相关类型
export interface MapData {
  sites: SiteData[]
  bounds: MapBounds
  center: MapCenter
}

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export interface MapCenter {
  latitude: number
  longitude: number
}

export interface OnlineMapConfig {
  provider: 'openstreetmap' | 'gaode' | 'baidu'
  apiKey?: string
  style: string
}

export interface OfflineMapConfig {
  path: string
  format: 'mbtiles' | 'xyz'
  minZoom: number
  maxZoom: number
}

// 任务进度相关类型
export interface TaskProgress {
  taskId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  message?: string
  error?: string
}

// WebSocket消息类型
export interface WSMessage {
  type: 'task_progress' | 'task_complete' | 'task_error' | 'data_update'
  data: any
}

export interface TaskProgressMessage extends WSMessage {
  type: 'task_progress'
  data: TaskProgress
}

export interface TaskCompleteMessage extends WSMessage {
  type: 'task_complete'
  data: {
    taskId: string
    result: any
  }
}

export interface TaskErrorMessage extends WSMessage {
  type: 'task_error'
  data: {
    taskId: string
    error: string
  }
}

// 图层相关类型
export interface Layer {
  id: string
  name: string
  type: 'sites' | 'sectors' | 'coverage' | 'neighbors' | 'conflicts'
  visible: boolean
  opacity: number
  style?: LayerStyle
}

export interface LayerStyle {
  color: string
  fillColor: string
  strokeWidth: number
  radius?: number
}
