/**
 * NavControl - 收藏和导航控制按钮
 *
 * 点击收藏后将位置存入 favorites（AsyncStorage 持久化），点击导航打开导航面板。
 * 
 * 坐标系说明：
 * - 传入的 latitude/longitude 是 GCJ-02（高德地图坐标系）
 * - 收藏存储使用 WGS84（标准 GPS 坐标系），确保地理化显示准确
 * - 导航时将 WGS84 转换为 GCJ-02 供导航面板使用
 */
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { useMapStore } from '../../store/mapStore';
import { gcj02ToWgs84 } from '../../utils/coordinate';

interface NavControlProps {
  latitude: number;   // 目的地纬度 (GCJ-02，来自高德地图)
  longitude: number;  // 目的地经度 (GCJ-02)
  name?: string;      // 目的地名称
}

export default function NavControl({ latitude, longitude, name }: NavControlProps) {
  const setPendingNavi = useMapStore(s => s.setPendingNavi);
  const addFavorite = useMapStore(s => s.addFavorite);
  const favorites = useMapStore(s => s.favorites);

  // 统一转换为 WGS84 用于内部比较和存储
  const [wgsLat, wgsLng] = gcj02ToWgs84(latitude, longitude);

  // 检查当前位置是否已收藏（使用 WGS84 坐标比较）
  const isFavorited = favorites.some(f =>
    Math.abs(f.lat - wgsLat) < 0.00001 && Math.abs(f.lng - wgsLng) < 0.00001
  );

  const handleFavorite = () => {
    const marker = {
      id: `fav-${wgsLat}-${wgsLng}-${Date.now()}`,
      lat: wgsLat,
      lng: wgsLng,
      name: name || `收藏点`,
      createdAt: Date.now(),
    };
    addFavorite(marker);
  };

  const handleRemoveFavorite = () => {
    const toRemove = favorites.find(f =>
      Math.abs(f.lat - wgsLat) < 0.00001 && Math.abs(f.lng - wgsLng) < 0.00001
    );
    if (toRemove) {
      useMapStore.getState().removeFavorite(toRemove.id);
    }
  };

  const handleOpenNavi = () => {
    setPendingNavi({ lat: wgsLat, lng: wgsLng, name: name || '目的地' });
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.button, isFavorited ? styles.buttonFavorited : styles.buttonFavorite]}
        onPress={isFavorited ? handleRemoveFavorite : handleFavorite}
        activeOpacity={0.7}
      >
        <Text style={styles.buttonText}>{isFavorited ? '已收藏' : '收藏'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.buttonNavi} onPress={handleOpenNavi} activeOpacity={0.7}>
        <Text style={styles.buttonText}>导航到这里</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
    padding: 8,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  button: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
  },
  buttonFavorite: {
    backgroundColor: '#FF9500',
  },
  buttonFavorited: {
    backgroundColor: '#888',
  },
  buttonNavi: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    backgroundColor: '#007AFF',
  },
  buttonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 20,
  },
});
