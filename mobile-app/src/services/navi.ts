/**
 * navi.ts - 导航服务（旧API兼容层）
 *
 * 保持向后兼容：startNavi / startNaviToCoord 依然可用，
 * 现在它们会将导航请求通过 store 的 pendingNavi 转发到新导航系统。
 */
import { useMapStore } from '../store/mapStore';

interface NaviParams {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  mode?: 'drive' | 'walk' | 'bus';
}

export async function startNavi(params: NaviParams): Promise<void> {
  const { endLat, endLng } = params;
  useMapStore.getState().setPendingNavi({
    lat: endLat,
    lng: endLng,
    name: '目的地',
  });
}

export async function startNaviToCoord(
  lat: number,
  lng: number,
  name?: string,
  _isWgs84?: boolean,
): Promise<void> {
  useMapStore.getState().setPendingNavi({
    lat,
    lng,
    name: name || '目的地',
  });
}
