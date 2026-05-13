/**
 * 扇区渲染配置
 *
 * 定义扇区的视觉样式、性能目标和渲染行为
 */

import { frequencyColorMapper } from '../utils/frequencyColors'

/**
 * 网络类型
 */
export type NetworkType = 'LTE' | 'NR'

/**
 * 小区覆盖类型
 */
export type CellCoverType = 1 | 4  // 1=室外小区(扇形60m/40度), 4=室内小区(圆形30m)

/**
 * 扇区样式配置
 */
export interface SectorStyle {
  /** 填充颜色 */
  color: string
  /** 透明度 (0-1) */
  opacity: number
  /** 半径（米） */
  radius: number
  /** 夹角（度），正北为0度 */
  angle: number
  /** 边框颜色 */
  strokeColor?: string
  /** 边框宽度 */
  strokeWidth?: number
}

/**
 * 小区覆盖类型样式配置
 */
export interface CellCoverStyle {
  /** 半径（米） */
  radius: number
  /** 夹角（度），正北为0度（室内小区为0表示圆形） */
  angle: number
  /** 是否为圆形（忽略方位角） */
  isCircular: boolean
}

/**
 * LOD (Level of Detail) 渲染级别配置
 */
export interface LODLevel {
  /** 最小缩放级别 */
  minZoom: number
  /** 最大缩放级别 */
  maxZoom: number
  /** 该级别最大扇区数量 */
  maxSectors: number
  /** 简化因子 (1 = 不简化, 0.5 = 简化50%) */
  simplification: number
  /** 是否显示扇区轮廓 */
  showStroke: boolean
}

/**
 * 性能目标
 */
export interface PerformanceTarget {
  /** 初始渲染时间（毫秒） */
  initialRender: number
  /** 缩放渲染时间（毫秒） */
  zoomRender: number
  /** 拖拽渲染时间（毫秒） */
  panRender: number
  /** 目标帧率（FPS） */
  targetFPS: number
}

/**
 * 扇区渲染配置
 */
export const SECTOR_CONFIG: Record<NetworkType, SectorStyle> = {
  LTE: {
    color: '#3b82f6',      // 蓝色
    opacity: 1,            // 0%透明度（完全不透明）
    radius: 60,            // 60米（默认，会根据覆盖类型调整）
    angle: 40,             // 40度夹角（默认，会根据覆盖类型调整）
    strokeColor: '#000000',
    strokeWidth: 0.5
  },
  NR: {
    color: '#10b981',      // 绿色
    opacity: 1,            // 0%透明度（完全不透明）
    radius: 60,            // 60米（默认，会根据覆盖类型调整）
    angle: 40,             // 40度夹角（默认，会根据覆盖类型调整）
    strokeColor: '#000000',
    strokeWidth: 0.5
  }
} as const

/**
 * 小区覆盖类型渲染配置
 *
 * - cell_cover_type = 1: 室外小区，扇形
 *   - LTE: 半径60米，夹角40度
 *   - NR: 半径50米，夹角40度
 * - cell_cover_type = 4: 室内小区，圆形，半径22米
 */
export const CELL_COVER_CONFIG: Record<CellCoverType, CellCoverStyle> = {
  1: {  // 室外小区 - 扇形
    radius: 60,        // LTE室外小区半径60米
    angle: 20,         // LTE室外小区夹角20度
    isCircular: false  // 按方位角绘制扇形
  },
  4: {  // 室内小区 - 圆形
    radius: 22,        // 室分扇区半径22米
    angle: 0,          // 0度（圆形不需要夹角）
    isCircular: true   // 忽略方位角，绘制圆形
  }
} as const

/**
 * 根据小区覆盖类型和网络类型获取渲染样式
 * @param cellCoverType 小区覆盖类型
 * @param networkType 网络类型
 * @returns 小区覆盖样式
 */
export function getCellCoverStyle(cellCoverType?: number, networkType?: NetworkType): CellCoverStyle {
  // 默认为室外小区
  const type: CellCoverType = (cellCoverType === 4) ? 4 : 1;
  const baseStyle = CELL_COVER_CONFIG[type];

  if (type === 1) {
    // 室外小区（扇形）
    if (networkType === 'LTE') {
      // LTE室外小区：固定半径10米，夹角40度
      return {
        ...baseStyle,
        radius: 10,
        angle: 40
      };
    } else {
      // NR室外小区：固定半径10米，夹角40度
      return {
        ...baseStyle,
        radius: 10,
        angle: 40
      };
    }
  } else {
    // 室内小区（圆形）：固定半径10米，与室外小区大小一致
    return {
      ...baseStyle,
      radius: 10
    };
  }
}

/**
 * LOD 渲染级别配置
 *
 * 根据缩放级别调整渲染策略：
 * - zoom < 12: 只渲染主要站点，最大500扇区
 * - zoom 12-15: 中等细节，最大2000扇区
 * - zoom 15-17: 高细节，最大5000扇区（性能优化）
 * - zoom >= 17: 特写，最大8000扇区（激进优化，避免卡顿）
 */
export const LOD_LEVELS: LODLevel[] = [
  {
    minZoom: 0,
    maxZoom: 12,
    maxSectors: 500,
    simplification: 1,
    showStroke: false
  },
  {
    minZoom: 12,
    maxZoom: 15,
    maxSectors: 2000,
    simplification: 0.8,
    showStroke: true
  },
  {
    minZoom: 15,
    maxZoom: 17,
    maxSectors: 5000,
    simplification: 0.5,
    showStroke: true
  },
  {
    minZoom: 17,
    maxZoom: 20,
    maxSectors: 8000,
    simplification: 0,
    showStroke: true
  }
]

/**
 * 性能目标配置
 */
export const PERFORMANCE_TARGETS: PerformanceTarget = {
  initialRender: 200,    // 初始加载 < 200ms
  zoomRender: 100,       // 缩放响应 < 100ms
  panRender: 50,         // 拖拽响应 < 50ms
  targetFPS: 30          // 目标帧率 >= 30fps
} as const

/**
 * 获取指定缩放级别的配置
 */
export function getLODLevel(zoom: number): LODLevel {
  return LOD_LEVELS.find(level => zoom >= level.minZoom && zoom < level.maxZoom) || LOD_LEVELS[LOD_LEVELS.length - 1]
}

/**
 * 扇区数据验证配置
 *
 * 定义哪些字段是必需的，有效值的范围
 */
export const SECTOR_VALIDATION = {
  /** 必需字段 */
  requiredFields: ['latitude', 'longitude', 'azimuth'] as const,

  /** 纬度有效范围 */
  latitudeRange: { min: -90, max: 90 },

  /** 经度有效范围 */
  longitudeRange: { min: -180, max: 180 },

  /** 方位角有效范围 */
  azimuthRange: { min: 0, max: 360 },

  /** 方位角：正北为0度，顺时针增加 */
  azimuthStandard: '正北为0度，顺时针0-360度' as const
} as const

/**
 * 图层控制配置
 */
export const LAYER_CONTROL_CONFIG = {
  /** 控件位置 */
  position: 'bottomleft' as const,

  /** 距离边缘的距离 */
  offset: {
    x: 10,
    y: 10
  },

  /** 图层选项 */
  layers: [
    {
      id: 'lte-sectors',
      label: 'LTE扇区',
      type: 'lte' as NetworkType,
      defaultVisible: true,
      icon: '📡'
    },
    {
      id: 'nr-sectors',
      label: 'NR扇区',
      type: 'nr' as NetworkType,
      defaultVisible: true,
      icon: '📶'
    }
  ]
} as const

/**
 * 交互配置
 */
export const INTERACTION_CONFIG = {
  /** 点击扇区时的行为 */
  clickBehavior: {
    showPopup: true,
    highlight: true,
    zoomTo: false
  },

  /** 悬停行为 */
  hoverBehavior: {
    highlight: true,
    showTooltip: false
  },

  /** 属性信息显示字段 */
  infoFields: [
    'name',          // 小区名称
    'networkType',   // 网络类型
    'siteId',        // 基站ID
    'sectorId',      // 小区ID
    'pci',           // PCI
    'tac',           // TAC
    'frequency',     // 频点
    'height',        // 站高
    'azimuth',       // 方位角
    'beamwidth'      // 波束宽度
  ] as const
} as const

/**
 * 默认地图位置配置
 */
export const DEFAULT_MAP_LOCATIONS = {
  /** 河源市 */
  HEYUAN: {
    name: '河源市',
    center: [23.7433, 114.6974] as [number, number],  // WGS84坐标
    zoom: 12,
    bounds: {
      north: 24.1433,
      south: 23.3433,
      east: 115.2974,
      west: 114.0974
    }
  },
  /** 北京市（备用） */
  BEIJING: {
    name: '北京市',
    center: [39.9042, 116.4074] as [number, number],
    zoom: 12,
    bounds: {
      north: 40.0042,
      south: 39.8042,
      east: 116.5074,
      west: 116.3074
    }
  }
} as const

/** 当前使用的默认位置 */
export const DEFAULT_LOCATION = DEFAULT_MAP_LOCATIONS.HEYUAN

/**
 * 导出频点颜色映射器（用于图层控制等组件）
 */
export { frequencyColorMapper }

/**
 * 根据扇区数据获取颜色
 * 优先使用频点颜色，降级使用网络类型颜色
 * 
 * @param sector 扇区数据
 * @returns 颜色配置对象
 */
export function getSectorColor(sector: {
  frequency?: number
  networkType: NetworkType
}): { fillColor: string; strokeColor: string } {
  // 如果有频点信息，使用频点颜色
  if (sector.frequency && sector.frequency > 0) {
    const colorObj = frequencyColorMapper.getColor(sector.frequency, sector.networkType)
    return {
      fillColor: colorObj.color,
      strokeColor: colorObj.strokeColor
    }
  }

  // 降级：使用网络类型颜色
  const config = SECTOR_CONFIG[sector.networkType]
  return {
    fillColor: config.color,
    strokeColor: config.strokeColor || config.color
  }
}
