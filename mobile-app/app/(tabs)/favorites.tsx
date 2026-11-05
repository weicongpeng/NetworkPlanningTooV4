import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Clipboard, Modal, TextInput, Appearance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useMapStore, MarkerPoint } from '../../src/store/mapStore';
import { wgs84ToGcj02 } from '../../src/utils/coordinate';
import AuthGuard from '../../src/components/Auth/AuthGuard';

const LIGHT_COLORS = {
  bg: '#f5f5f5', card: '#FFFFFF', cardBorder: '#E5E5E5', divider: '#EEEEEE',
  textPrimary: '#1A1A1A', textSecondary: '#666666', textMuted: '#999999',
  accent: '#007AFF', danger: '#E53935', avatarBg: '#FFB300',
  inputBg: '#f0f0f0', switchTrackFalse: '#E0E0E0', overlayBg: 'rgba(0,0,0,0.4)',
  actionBtnBg: '#f0f0f0', actionBtnBorder: '#ddd', actionBtnText: '#555',
  editBtnBg: '#E8F5E9', editBtnBorder: '#A5D6A7', editBtnText: '#388E3C',
  deleteBtnBg: '#FFEBEE', deleteBtnBorder: '#EF9A9A', deleteBtnText: '#E53935',
} as const;

const DARK_COLORS = {
  bg: '#2B2B2F', card: '#36363A', cardBorder: '#4A4A50', divider: '#424248',
  textPrimary: '#E8E6E3', textSecondary: '#B0AEA8', textMuted: '#8A8880',
  accent: '#7EB6F6', danger: '#F07070', avatarBg: '#C49A2A',
  inputBg: '#3A3A3F', switchTrackFalse: '#55555A', overlayBg: 'rgba(0,0,0,0.55)',
  actionBtnBg: '#3A3A3F', actionBtnBorder: '#4A4A50', actionBtnText: '#B0AEA8',
  editBtnBg: '#1B3A1B', editBtnBorder: '#2E5A2E', editBtnText: '#7EC87E',
  deleteBtnBg: '#3A1B1B', deleteBtnBorder: '#5A2E2E', deleteBtnText: '#F07070',
} as const;

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { favorites, removeFavorite, clearFavorites, setFocusLocation, setSearchMarker, updateMarkerName } = useMapStore();

  const darkMode = useMapStore((s) => s.darkMode);
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;

  useEffect(() => { Appearance.setColorScheme(darkMode ? 'dark' : 'light'); }, [darkMode]);

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
    <View style={[styles.item, { backgroundColor: COLORS.card }]}>
      <View style={[styles.itemIndex, { backgroundColor: COLORS.avatarBg }]}>
        <Text style={styles.indexText}>{index + 1}</Text>
      </View>
      <View style={styles.itemInfo}>
        <Text style={[styles.itemName, { color: COLORS.textPrimary }]}>{item.name || '未命名'}</Text>
        <Text style={[styles.itemCoord, { color: COLORS.textSecondary }]}>
          {item.lat.toFixed(6)}, {item.lng.toFixed(6)}
        </Text>
        <Text style={[styles.itemTime, { color: COLORS.textMuted }]}>
          {new Date(item.createdAt).toLocaleString()}
        </Text>
        <View style={styles.itemActions}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: COLORS.actionBtnBg, borderColor: COLORS.actionBtnBorder }]} onPress={() => handleLocation(item)}>
            <Text style={[styles.actionBtnText, { color: COLORS.actionBtnText }]}>位置</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: COLORS.actionBtnBg, borderColor: COLORS.actionBtnBorder }]} onPress={() => handleNavigate(item)}>
            <Text style={[styles.actionBtnText, { color: COLORS.actionBtnText }]}>导航</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.editAction, { backgroundColor: COLORS.editBtnBg, borderColor: COLORS.editBtnBorder }]} onPress={() => handleEditPress(item)}>
            <Text style={[styles.actionBtnText, styles.editActionText, { color: COLORS.editBtnText }]}>编辑</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: COLORS.actionBtnBg, borderColor: COLORS.actionBtnBorder }]} onPress={() => handleCopy(item)}>
            <Text style={[styles.actionBtnText, { color: COLORS.actionBtnText }]}>复制</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, styles.deleteAction, { backgroundColor: COLORS.deleteBtnBg, borderColor: COLORS.deleteBtnBorder }]} onPress={() => handleDelete(item.id)}>
            <Text style={[styles.actionBtnText, styles.deleteActionText, { color: COLORS.deleteBtnText }]}>删除</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  return (
    <AuthGuard>
      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: COLORS.bg }]}>
        <StatusBar style={darkMode ? 'light' : 'dark'} />
      <View style={[styles.header, { backgroundColor: COLORS.card, borderBottomColor: COLORS.divider }]}>
        <Text style={[styles.title, { color: COLORS.textPrimary }]}>我的收藏 ({favorites.length})</Text>
        {favorites.length > 0 && (
          <TouchableOpacity onPress={handleClearAll}>
            <Text style={[styles.clearBtn, { color: COLORS.danger }]}>清空全部</Text>
          </TouchableOpacity>
        )}
      </View>
      {favorites.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>⭐</Text>
          <Text style={[styles.emptyText, { color: COLORS.textSecondary }]}>暂无收藏</Text>
          <Text style={[styles.emptyHint, { color: COLORS.textMuted }]}>在地图打点后，点击星标收藏标记点</Text>
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
        <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.editModalContent, { backgroundColor: COLORS.card }]}>
            <Text style={[styles.editModalTitle, { color: COLORS.textPrimary }]}>编辑名称</Text>
            <TextInput
              style={[styles.editModalInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={editNameInput}
              onChangeText={setEditNameInput}
              placeholder="输入标记名称"
              placeholderTextColor={COLORS.textMuted}
              autoFocus={true}
              selectTextOnFocus={true}
            />
            <View style={styles.editModalActions}>
              <TouchableOpacity style={[styles.editModalBtn, { backgroundColor: COLORS.inputBg }]} onPress={handleCancelEdit}>
                <Text style={[styles.editModalBtnText, { color: COLORS.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.editModalBtn, styles.editModalBtnPrimary, { backgroundColor: COLORS.accent }]} onPress={handleConfirmEdit}>
                <Text style={[styles.editModalBtnText, styles.editModalBtnPrimaryText]}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      </View>
    </AuthGuard>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontWeight: 'bold' },
  clearBtn: { fontSize: 14 },
  list: { padding: 12 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
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
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  indexText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 15, fontWeight: '600', marginBottom: 4 },
  itemCoord: { fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
  itemTime: { fontSize: 11 },
  itemActions: {
    flexDirection: 'row',
    marginTop: 6,
    gap: 6,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
  },
  actionBtnText: { fontSize: 11, fontWeight: '600' },
  editAction: {},
  editActionText: {},
  deleteAction: {},
  deleteActionText: {},
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editModalContent: {
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
    marginBottom: 12,
    textAlign: 'center',
  },
  editModalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
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
  },
  editModalBtnPrimary: {},
  editModalBtnText: {
    fontSize: 15,
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
  emptyText: { fontSize: 16, marginBottom: 8 },
  emptyHint: { fontSize: 13 },
});
