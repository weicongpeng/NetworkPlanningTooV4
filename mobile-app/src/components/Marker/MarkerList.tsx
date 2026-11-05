import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useMapStore, MarkerPoint } from '../../store/mapStore';

interface MarkerListProps {
  onMarkerSelect?: (marker: MarkerPoint) => void;
}

export default function MarkerList({ onMarkerSelect }: MarkerListProps) {
  const { markers, favorites, removeMarker, addFavorite, measureMode, markerMode, setEditingMarker } = useMapStore();
  const setPendingNavi = useMapStore(s => s.setPendingNavi);

  if (markers.length === 0 || measureMode) return null;

  const handleFavorite = (marker: MarkerPoint) => {
    if (favorites.some(f => f.id === marker.id)) {
      Alert.alert('提示', '该标记点已收藏');
      return;
    }
    addFavorite(marker);
    Alert.alert('收藏成功', `"${marker.name || '未命名'}" 已添加到收藏`);
  };

  const handleNavigate = (marker: MarkerPoint) => {
    setPendingNavi({ lat: marker.lat, lng: marker.lng, name: marker.name || '标记点' });
  };

  const handleEdit = (marker: MarkerPoint) => {
    setEditingMarker(marker);
  };

  const isFavorited = (id: string) => favorites.some(f => f.id === id);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>标记点 ({markers.length})</Text>
        <TouchableOpacity onPress={() => useMapStore.getState().clearMarkers()}>
          <Text style={styles.clearBtn}>清除全部</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={markers}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={styles.markerItem}>
            <TouchableOpacity style={styles.markerMain} onPress={() => handleEdit(item)}>
              <Text style={styles.markerIndex}>{index + 1}</Text>
              <View style={styles.markerInfo}>
                <Text style={styles.markerName}>{item.name || '未命名'}</Text>
                <Text style={styles.markerCoord}>{item.lat.toFixed(6)}, {item.lng.toFixed(6)}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.markerActions}>
              <TouchableOpacity
                style={[styles.favBtn, isFavorited(item.id) && styles.favBtnActive]}
                onPress={() => handleFavorite(item)}
              >
                <Text style={[styles.favBtnText, isFavorited(item.id) && styles.favBtnTextActive]}>
                  {isFavorited(item.id) ? '★' : '☆'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.naviBtn} onPress={() => handleNavigate(item)}>
                <Text style={styles.naviBtnText}>导航</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removeMarker(item.id)}>
                <Text style={styles.deleteBtn}>×</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 50,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 8,
    padding: 10,
    maxHeight: 260,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 14, fontWeight: 'bold' },
  clearBtn: { fontSize: 12, color: '#007AFF' },
  markerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  markerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  markerIndex: { width: 24, fontSize: 12, color: '#666' },
  markerInfo: { flex: 1 },
  markerName: { fontSize: 13, fontWeight: '600' },
  markerCoord: { fontSize: 11, color: '#999' },
  markerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  favBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFE082',
    justifyContent: 'center',
    alignItems: 'center',
  },
  favBtnActive: {
    backgroundColor: '#FFB300',
    borderColor: '#FF8F00',
  },
  favBtnText: { fontSize: 16, color: '#FFB300' },
  favBtnTextActive: { color: '#fff' },
  naviBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#E3F2FD',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#90CAF9',
  },
  naviBtnText: { fontSize: 11, color: '#1976D2', fontWeight: '600' },
  deleteBtn: { fontSize: 20, color: '#999', paddingHorizontal: 6 },
});
