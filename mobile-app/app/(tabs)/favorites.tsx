import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Clipboard, Modal, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useMapStore, MarkerPoint } from '../../src/store/mapStore';
import { wgs84ToGcj02 } from '../../src/utils/coordinate';

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { favorites, removeFavorite, clearFavorites, setFocusLocation, setSearchMarker, updateMarkerName } = useMapStore();

  // 编辑名称弹框状态
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingItem, setEditingItem] = useState<MarkerPoint | null>(null);
  const [editNameInput, setEditNameInput] = useState('');

  const handleDelete = (id: string) => {
    Alert.alert(
      '删除确认',
      '确定要删除这个收藏点吗？',
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => removeFavorite(id) },
      ]
    );
  };

  const handleClearAll = () => {
    if (favorites.length === 0) return;
    Alert.alert(
      '清空确认',
      '确定要清空所有收藏点吗？',
      [
        { text: '取消', style: 'cancel' },
        { text: '清空', style: 'destructive', onPress: () => clearFavorites() },
      ]
    );
  };

  const setPendingNavi = useMapStore(s => s.setPendingNavi);

  const handleNavigate = (item: MarkerPoint) => {
    // 设置导航触发状态，然后跳转到地图页面
    setPendingNavi({ lat: item.lat, lng: item.lng, name: item.name || '收藏点' });
    // 跳转到地图页面（navigation 已通过 useNavigation 获取）
    if (navigation) {
      navigation.navigate('map');
    }
  };

  const handleLocation = (item: MarkerPoint) => {
    // 收藏点存储为 WGS84，转换为 GCJ-02 用于高德地图定位
    const [gcjLat, gcjLng] = wgs84ToGcj02(item.lat, item.lng);
    setFocusLocation({ lat: gcjLat, lng: gcjLng });
    setSearchMarker({ lat: gcjLat, lng: gcjLng, name: item.name || '收藏点' });
    navigation.navigate('map');
  };

  const handleCopy = (item: MarkerPoint) => {
    const text = `名称: ${item.name || '未命名'}\n坐标: ${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}\n时间: ${new Date(item.createdAt).toLocaleString()}`;
    Clipboard.setString(text);
    Alert.alert('已复制', '标记点信息已复制到剪贴板');
  };

  const handleEditPress = (item: MarkerPoint) => {
    setEditingItem(item);
    setEditNameInput(item.name || '');
    setShowEditModal(true);
  };

  const handleConfirmEdit = () => {
    if (editingItem) {
      const name = editNameInput.trim();
      updateMarkerName(editingItem.id, name);
    }
    setShowEditModal(false);
    setEditingItem(null);
    setEditNameInput('');
  };

  const handleCancelEdit = () => {
    setShowEditModal(false);
    setEditingItem(null);
    setEditNameInput('');
  };

  const renderItem = ({ item, index }: { item: MarkerPoint; index: number }) => (
    <View style={styles.item}>
      <View style={styles.itemIndex}>
        <Text style={styles.indexText}>{index + 1}</Text>
      </View>
      <View style={styles.itemInfo}>
        <Text style={styles.itemName}>{item.name || '未命名'}</Text>
        <Text style={styles.itemCoord}>
          {item.lat.toFixed(6)}, {item.lng.toFixed(6)}
        </Text>
        <Text style={styles.itemTime}>
          {new Date(item.createdAt).toLocaleString()}
        </Text>
        <View style={styles.itemActions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleLocation(item)}>
            <Text style={styles.actionBtnText}>位置</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleNavigate(item)}>
            <Text style={styles.actionBtnText}>导航</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.editAction]} onPress={() => handleEditPress(item)}>
            <Text style={[styles.actionBtnText, styles.editActionText]}>编辑</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => handleCopy(item)}>
            <Text style={styles.actionBtnText}>复制</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.deleteAction]} onPress={() => handleDelete(item.id)}>
            <Text style={[styles.actionBtnText, styles.deleteActionText]}>删除</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>我的收藏 ({favorites.length})</Text>
        {favorites.length > 0 && (
          <TouchableOpacity onPress={handleClearAll}>
            <Text style={styles.clearBtn}>清空全部</Text>
          </TouchableOpacity>
        )}
      </View>
      {favorites.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>⭐</Text>
          <Text style={styles.emptyText}>暂无收藏</Text>
          <Text style={styles.emptyHint}>在地图打点后，点击星标收藏标记点</Text>
        </View>
      ) : (
        <FlatList
          data={favorites}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}

      {/* 编辑名称弹框 */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showEditModal}
        onRequestClose={handleCancelEdit}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.editModalContent}>
            <Text style={styles.editModalTitle}>编辑名称</Text>
            <TextInput
              style={styles.editModalInput}
              value={editNameInput}
              onChangeText={setEditNameInput}
              placeholder="输入标记名称"
              autoFocus={true}
              selectTextOnFocus={true}
            />
            <View style={styles.editModalActions}>
              <TouchableOpacity style={styles.editModalBtn} onPress={handleCancelEdit}>
                <Text style={styles.editModalBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.editModalBtn, styles.editModalBtnPrimary]} onPress={handleConfirmEdit}>
                <Text style={[styles.editModalBtnText, styles.editModalBtnPrimaryText]}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: { fontSize: 18, fontWeight: 'bold', color: '#333' },
  clearBtn: { fontSize: 14, color: '#E53935' },
  list: { padding: 12 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  itemIndex: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFB300',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  indexText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 15, fontWeight: '600', color: '#333', marginBottom: 4 },
  itemCoord: { fontSize: 12, color: '#666', fontFamily: 'monospace', marginBottom: 2 },
  itemTime: { fontSize: 11, color: '#999' },
  itemActions: {
    flexDirection: 'row',
    marginTop: 6,
    gap: 6,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  actionBtnText: { color: '#555', fontSize: 11, fontWeight: '600' },
  editAction: {
    backgroundColor: '#E8F5E9',
    borderColor: '#A5D6A7',
  },
  editActionText: { color: '#388E3C' },
  deleteAction: {
    backgroundColor: '#FFEBEE',
    borderColor: '#EF9A9A',
  },
  deleteActionText: { color: '#E53935' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editModalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '80%',
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 10,
  },
  editModalTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
    textAlign: 'center',
  },
  editModalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#333',
    marginBottom: 16,
  },
  editModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  editModalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#f5f5f5',
  },
  editModalBtnPrimary: {
    backgroundColor: '#007AFF',
  },
  editModalBtnText: {
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  editModalBtnPrimaryText: {
    color: '#fff',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 16, color: '#666', marginBottom: 8 },
  emptyHint: { fontSize: 13, color: '#999' },
});
