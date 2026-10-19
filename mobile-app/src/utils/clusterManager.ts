/**
 * 点聚类管理器 - 使用Supercluster优化大量点的渲染
 */

import Supercluster from 'supercluster';
import { GeoJsonFeature } from '../types/data';

export interface ClusterOptions {
  radius?: number;      // 聚类半径（像素）
  maxZoom?: number;     // 最大缩放级别（超过此级别显示单点）
  minPoints?: number;   // 最小聚类点数
  extent?: number;      // 瓦片范围（默认512）
  nodeSize?: number;    // KD-Tree节点大小
}

export interface ClusterPoint {
  type: 'cluster' | 'point';
  id: string | number;
  coordinates: [number, number]; // [lng, lat]
  count?: number;       // 聚类中的点数
  properties?: Record<string, any>;
  clusterId?: number;   // 聚类ID（用于展开）
}

class ClusterManager {
  private index: Supercluster | null = null;
  private features: GeoJsonFeature[] = [];
  private options: Required<ClusterOptions>;

  constructor(options: ClusterOptions = {}) {
    this.options = {
      radius: options.radius ?? 60,
      maxZoom: options.maxZoom ?? 16,
      minPoints: options.minPoints ?? 2,
      extent: options.extent ?? 512,
      nodeSize: options.nodeSize ?? 64,
    };
  }

  /**
   * 加载数据并构建索引
   */
  loadData(features: GeoJsonFeature[]): void {
    this.features = features;

    // 转换为Supercluster需要的格式
    const points = features.map((f, index) => ({
      type: 'Feature' as const,
      properties: { ...f.properties, _index: index },
      geometry: f.geometry,
    }));

    // 创建索引
    this.index = new Supercluster({
      radius: this.options.radius,
      maxZoom: this.options.maxZoom,
      minPoints: this.options.minPoints,
      extent: this.options.extent,
      nodeSize: this.options.nodeSize,
    });

    this.index.load(points);
  }

  /**
   * 获取当前视窗内的聚类/点
   */
  getClusters(
    bounds: [number, number, number, number], // [west, south, east, north]
    zoom: number
  ): ClusterPoint[] {
    if (!this.index) return [];

    const clusters = this.index.getClusters(bounds, Math.floor(zoom));

    return clusters.map(cluster => {
      const [lng, lat] = cluster.geometry.coordinates;

      if (cluster.properties.cluster) {
        // 这是一个聚类
        return {
          type: 'cluster',
          id: cluster.id as number,
          coordinates: [lng, lat] as [number, number],
          count: cluster.properties.point_count,
          clusterId: cluster.id as number,
          properties: cluster.properties,
        };
      } else {
        // 这是一个单点
        return {
          type: 'point',
          id: cluster.properties._index ?? cluster.id,
          coordinates: [lng, lat] as [number, number],
          properties: cluster.properties,
        };
      }
    });
  }

  /**
   * 展开聚类获取其中的所有点
   */
  getClusterPoints(clusterId: number): GeoJsonFeature[] {
    if (!this.index) return [];

    const leaves = this.index.getLeaves(clusterId, Infinity);
    return leaves.map(leaf => ({
      type: 'Feature',
      geometry: leaf.geometry,
      properties: leaf.properties,
    }));
  }

  /**
   * 获取推荐的最大缩放级别
   */
  getMaxZoom(): number {
    return this.options.maxZoom;
  }

  /**
   * 获取数据总数
   */
  getTotalCount(): number {
    return this.features.length;
  }

  /**
   * 清除数据
   */
  clear(): void {
    this.index = null;
    this.features = [];
  }

  /**
   * 检查是否已加载数据
   */
  isLoaded(): boolean {
    return this.index !== null;
  }
}

// 单例实例
let globalClusterManager: ClusterManager | null = null;

export function getClusterManager(options?: ClusterOptions): ClusterManager {
  if (!globalClusterManager) {
    globalClusterManager = new ClusterManager(options);
  }
  return globalClusterManager;
}

export function resetClusterManager(options?: ClusterOptions): ClusterManager {
  globalClusterManager = new ClusterManager(options);
  return globalClusterManager;
}

export { ClusterManager };
