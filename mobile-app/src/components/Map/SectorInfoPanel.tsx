import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Clipboard,
  Alert,
  TextInput,
} from 'react-native';
import { useMapStore } from '../../store/mapStore';

export default function SectorInfoPanel() {
  const {
    selectedSector,
    setSelectedSector,
    setPendingNavi,
    addFavorite,
    removeFavorite,
    favorites,
  } = useMapStore();
  const darkMode = useMapStore((s) => s.darkMode);
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;

  // ===== 属性过滤搜索 state(hooks 必须在 early return 之前调用) =====
  const [showAttrSearch, setShowAttrSearch] = useState(false);
  const [attrKeyword, setAttrKeyword] = useState('');

  // 构建当前扇区的全部属性字段(含 extraFields),并根据关键字过滤
  const filteredFields = useMemo<[string, any][]>(() => {
    if (!selectedSector) return [];
    const coverType =
      selectedSector.cell_cover_type === 4 ||
      String(selectedSector.cell_cover_type) === '室分' ||
      String(selectedSector.cell_cover_type) === '室内'
        ? '室内'
        : '室外';
    const allFields: [string, any][] = [
      ['小区名称', selectedSector.name],
      ['基站名称', selectedSector.siteName],
      ['厂家', selectedSector.vendor],
      ['基站ID', selectedSector.siteId],
      ['小区ID', selectedSector.sectorId],
      ['纬度', selectedSector.latitude?.toFixed(6)],
      ['经度', selectedSector.longitude?.toFixed(6)],
      ['方位角', selectedSector.azimuth],
      ['波束宽度', selectedSector.beamwidth],
      ['PCI', selectedSector.pci],
      ['TAC', selectedSector.tac],
      ['频点', selectedSector.frequency],
      ['EARFCN', selectedSector.earfcn],
      ['SSB频点', selectedSector.ssbFrequency],
      ['站高', selectedSector.height],
      ['覆盖类型', coverType],
      ['MCC', selectedSector.mcc],
      ['MNC', selectedSector.mnc],
      ['是否共享', selectedSector.is_shared],
    ];
    if (selectedSector.extraFields) {
      for (const [k, v] of Object.entries(selectedSector.extraFields)) {
        allFields.push([k, v]);
      }
    }
    // 过滤空值
    const nonEmpty = allFields.filter(
      ([_, v]) => v !== undefined && v !== null && v !== ''
    );
    // 应用关键字模糊匹配(匹配属性名或属性值)
    const lowerKw = attrKeyword.trim().toLowerCase();
    if (!lowerKw) return nonEmpty;
    return nonEmpty.filter(
      ([label, v]) =>
        String(label).toLowerCase().includes(lowerKw) ||
        String(v).toLowerCase().includes(lowerKw)
    );
  }, [selectedSector, attrKeyword]);

  // 关闭属性过滤搜索
  const closeAttrSearch = () => {
    setShowAttrSearch(false);
    setAttrKeyword('');
  };

  if (!selectedSector) return null;

  // ===== 收藏状态判断 =====
  const isFavorited = favorites.some(
    (f) =>
      Math.abs(f.lat - selectedSector.latitude) < 0.00001 &&
      Math.abs(f.lng - selectedSector.longitude) < 0.00001
  );

  const handleToggleFavorite = () => {
    if (isFavorited) {
      const toRemove = favorites.find(
        (f) =>
          Math.abs(f.lat - selectedSector.latitude) < 0.00001 &&
          Math.abs(f.lng - selectedSector.longitude) < 0.00001
      );
      if (toRemove) removeFavorite(toRemove.id);
    } else {
      const marker = {
        id: `fav-${selectedSector.latitude}-${selectedSector.longitude}-${Date.now()}`,
        lat: selectedSector.latitude,
        lng: selectedSector.longitude,
        name: selectedSector.name || '收藏点',
        createdAt: Date.now(),
      };
      addFavorite(marker);
    }
  };

  const isLte = selectedSector.networkType === 'LTE';

  const handleCopy = () => {
    if (!selectedSector) return;
    const fields: [string, any][] = [
      ['小区名称', selectedSector.name],
      ['基站名称', selectedSector.siteName],
      ['厂家', selectedSector.vendor],
      ['基站ID', selectedSector.siteId],
      ['小区ID', selectedSector.sectorId],
      ['纬度', selectedSector.latitude?.toFixed(6)],
      ['经度', selectedSector.longitude?.toFixed(6)],
      ['方位角', selectedSector.azimuth],
      ['波束宽度', selectedSector.beamwidth],
      ['PCI', selectedSector.pci],
      ['TAC', selectedSector.tac],
      ['频点', selectedSector.frequency],
      ['EARFCN', selectedSector.earfcn],
      ['SSB频点', selectedSector.ssbFrequency],
      ['站高', selectedSector.height],
      ['覆盖类型', selectedSector.cell_cover_type === 4 || String(selectedSector.cell_cover_type) === '室分' || String(selectedSector.cell_cover_type) === '室内' ? '室内' : '室外'],
      ['MCC', selectedSector.mcc],
      ['MNC', selectedSector.mnc],
      ['是否共享', selectedSector.is_shared],
    ];
    // 追加导入工参文件中的所有原始列
    if (selectedSector.extraFields) {
      for (const [k, v] of Object.entries(selectedSector.extraFields)) {
        fields.push([k, v]);
      }
    }
    const text = fields
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    Clipboard.setString(text);
    Alert.alert('复制成功', '扇区属性信息已复制到剪贴板');
  };

  const handleNavigate = () => {
    if (!selectedSector) return;
    setPendingNavi({
      lat: selectedSector.latitude,
      lng: selectedSector.longitude,
      name: selectedSector.name || '扇区位置',
    });
    setSelectedSector(null);
  };

  const renderField = (label: string, value: any) => {
    if (value === undefined || value === null || value === '') return null;
    return (
      <View style={[styles.fieldRow, { borderBottomColor: COLORS.fieldBorder }]} key={label}>
        <Text style={[styles.fieldLabel, { color: COLORS.fieldLabel }]}>{label}</Text>
        <Text style={[styles.fieldValue, { color: COLORS.fieldValue }]}>{String(value)}</Text>
      </View>
    );
  };

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={!!selectedSector}
      onRequestClose={() => setSelectedSector(null)}
      statusBarTranslucent={true}
    >
      <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
        <View style={[styles.panel, { backgroundColor: COLORS.card }]}>
          <View style={[styles.header, { borderBottomColor: COLORS.divider }]}>
            <View style={styles.titleRow}>
              <View style={[styles.networkBadge, { backgroundColor: isLte ? '#4CAF50' : '#2196F3' }]}>
                <Text style={styles.networkBadgeText}>{selectedSector.networkType}</Text>
              </View>
              <Text style={[styles.title, { color: COLORS.textPrimary }]} numberOfLines={1}>
                {selectedSector.name}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedSector(null)}>
              <Text style={[styles.closeBtn, { color: COLORS.textMuted }]}>×</Text>
            </TouchableOpacity>
          </View>

          {/* ===== 属性过滤搜索输入区(条件渲染在 header 与 ScrollView 之间) ===== */}
          {showAttrSearch && (
            <View style={styles.attrSearchContainer}>
              <View
                style={[
                  styles.attrInputWrap,
                  {
                    backgroundColor: COLORS.attrInputBg,
                    borderColor: COLORS.attrInputBorder,
                  },
                ]}
              >
                <TextInput
                  style={[styles.attrInput, { color: COLORS.textPrimary }]}
                  placeholder="输入属性名或值过滤(如 PCI、TAC、室内)..."
                  placeholderTextColor={COLORS.attrPlaceholder}
                  value={attrKeyword}
                  onChangeText={setAttrKeyword}
                  autoCorrect={false}
                  autoCapitalize="none"
                  autoFocus
                />
                {attrKeyword.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setAttrKeyword('')}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Text style={[styles.attrClearText, { color: COLORS.attrClearText }]}>×</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={closeAttrSearch}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  style={styles.attrCloseBtn}
                >
                  <Text style={[styles.attrCloseText, { color: COLORS.attrClearText }]}>关闭</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {filteredFields.length > 0 ? (
              filteredFields.map(([label, v]) => renderField(label, v))
            ) : (
              <Text style={[styles.attrEmptyText, { color: COLORS.textMuted }]}>
                无匹配属性
              </Text>
            )}
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.copyBtn, styles.copyBtnFull]} onPress={handleCopy}>
              <Text style={styles.copyBtnText}>复制</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.navigateBtn} onPress={handleNavigate}>
              <Text style={styles.navigateBtnText}>导航</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: isFavorited ? '#888' : '#FF9500' }]}
              onPress={handleToggleFavorite}
            >
              <Text style={styles.actionBtnText}>{isFavorited ? '已收藏' : '收藏'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#007AFF' }]}
              onPress={() => setShowAttrSearch((v) => !v)}
            >
              <Text style={styles.actionBtnText}>搜索</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const LIGHT_COLORS = {
  overlayBg: 'rgba(0,0,0,0.4)',
  card: '#fff',
  divider: '#eee',
  textPrimary: '#333',
  textMuted: '#999',
  fieldLabel: '#666',
  fieldValue: '#333',
  fieldBorder: '#f0f0f0',
  // 属性过滤搜索区颜色
  attrInputBg: 'rgba(255,255,255,0.7)',
  attrInputBorder: 'rgba(0,0,0,0.1)',
  attrPlaceholder: '#999',
  attrClearText: '#999',
} as const;

const DARK_COLORS = {
  overlayBg: 'rgba(0,0,0,0.55)',
  card: '#36363A',
  divider: '#424248',
  textPrimary: '#E8E6E3',
  textMuted: '#8A8880',
  fieldLabel: '#B0AEA8',
  fieldValue: '#E8E6E3',
  fieldBorder: '#3A3A3F',
  // 属性过滤搜索区颜色
  attrInputBg: 'rgba(58,58,63,0.7)',
  attrInputBorder: 'rgba(255,255,255,0.12)',
  attrPlaceholder: '#7A7870',
  attrClearText: '#7A7870',
} as const;

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  panel: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  networkBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginRight: 8,
  },
  networkBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    flex: 1,
  },
  closeBtn: {
    fontSize: 28,
    color: '#999',
    paddingHorizontal: 4,
  },
  content: {
    maxHeight: 300,
  },
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  fieldLabel: {
    fontSize: 14,
    color: '#666',
    flex: 1,
  },
  fieldValue: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
    flex: 1,
    textAlign: 'right',
  },
  copyBtn: {
    flex: 1,
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  copyBtnFull: {
    flex: 1,
  },
  navigateBtn: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginLeft: 8,
  },
  copyBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  navigateBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  // ===== 新增按钮通用样式(收藏 / 搜索) =====
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  // ===== 属性过滤搜索输入区样式 =====
  attrSearchContainer: {
    marginBottom: 8,
  },
  attrInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
  },
  attrInput: {
    flex: 1,
    height: 34,
    fontSize: 12,
    padding: 0,
  },
  attrClearText: {
    fontSize: 16,
    paddingHorizontal: 6,
  },
  attrCloseBtn: {
    marginLeft: 4,
  },
  attrCloseText: {
    fontSize: 12,
  },
  attrEmptyText: {
    paddingVertical: 16,
    fontSize: 13,
    textAlign: 'center',
  },
});
