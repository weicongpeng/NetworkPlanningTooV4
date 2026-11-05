/**
 * 视窗筛选工具 - 只渲染当前地图视窗内的点
 */

import RBush from 'rbush';
import { GeoJsonFeature } from '../types/data';

export interface ViewportBounds {
  west: number;   // 最小经度
  south: number;  // 最小纬度
  east: number;   // 最大经度
  north: number;  // 最大纬度
}

export interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: number;
  feature: GeoJsonFeature;
}

class ViewportFilter {
  private tree: RBush<SpatialItem> | null = null;
  private features: GeoJsonFeature[] = [];

  /**
   * 构建空间索引
   */
  buildIndex(features: GeoJsonFeature[]): void {
    this.features = features;
    this.tree = new RBush<SpatialItem>();

    const items: SpatialItem[] = features.map((f, index) => {
      const [lng, lat] = f.geometry.coordinates;
      return {
        minX: lng,
        minY: lat,
        maxX: lng,
        maxY: lat,
        id: index,
        feature: f,
      };
    });

    this.tree.load(items);
  }

  /**
   * 查询视窗内的点
   */
  queryViewport(bounds: ViewportBounds): GeoJsonFeature[] {
    if (!this.tree) return [];

    const items = this.tree.search({
      minX: bounds.west,
      minY: bounds.south,
      maxX: bounds.east,
      maxY: bounds.north,
    });

    return items.map(item => item.feature);
  }

  /**
   * 查询视窗内的点（带数量限制）
   */
  queryViewportWithLimit(
    bounds: ViewportBounds,
    maxResults: number = 1000
  ): GeoJsonFeature[] {
    if (!this.tree) return [];

    const items = this.tree.search({
      minX: bounds.west,
      minY: bounds.south,
      maxX: bounds.east,
      maxY: bounds.north,
    });

    // 如果结果太多，进行采样
    if (items.length > maxResults) {
      const step = Math.ceil(items.length / maxResults);
      const sampled: SpatialItem[] = [];
      for (let i = 0; i < items.length; i += step) {
        sampled.push(items[i]);
      }
      return sampled.map(item => item.feature);
    }

    return items.map(item => item.feature);
  }

  /**
   * 获取视窗内的点数量
   */
  countInViewport(bounds: ViewportBounds): number {
    if (!this.tree) return 0;

    return this.tree.search({
      minX: bounds.west,
      minY: bounds.south,
      maxX: bounds.east,
      maxY: bounds.north,
    }).length;
  }

  /**
   * 获取所有数据
   */
  getAllFeatures(): GeoJsonFeature[] {
    return this.features;
  }

  /**
   * 获取总数
   */
  getTotalCount(): number {
    return this.features.length;
  }

  /**
   * 清除索引
   */
  clear(): void {
    this.tree = null;
    this.features = [];
  }

  /**
   * 检查是否已构建索引
   */
  isIndexed(): boolean {
    return this.tree !== null;
  }
}

// 单例实例
let globalViewportFilter: ViewportFilter | null = null;

export function getViewportFilter(): ViewportFilter {
  if (!globalViewportFilter) {
    globalViewportFilter = new ViewportFilter();
  }
  return globalViewportFilter;
}

export function resetViewportFilter(): ViewportFilter {
  globalViewportFilter = new ViewportFilter();
  return globalViewportFilter;
}

export { ViewportFilter };
