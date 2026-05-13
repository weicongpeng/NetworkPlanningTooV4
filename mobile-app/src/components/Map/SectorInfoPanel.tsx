import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, Clipboard, Alert } from 'react-native';
import { useMapStore } from '../../store/mapStore';
import { wgs84ToGcj02 } from '../../utils/coordinate';

export default function SectorInfoPanel() {
  const { selectedSector, setSelectedSector, setPendingNavi } = useMapStore();

  if (!selectedSector) return null;

  const isLte = selectedSector.networkType === 'LTE';

  const handleCopy = () => {
    if (!selectedSector) return;
    const fields: [string, any][] = [
      ['小区名称', selectedSector.name],
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
      ['覆盖类型', selectedSector.cell_cover_type === 4 ? '室内' : '室外'],
      ['MCC', selectedSector.mcc],
      ['MNC', selectedSector.mnc],
      ['是否共享', selectedSector.is_shared],
    ];
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
      <View style={styles.fieldRow} key={label}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Text style={styles.fieldValue}>{String(value)}</Text>
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
      <View style={styles.modalOverlay}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={[styles.networkBadge, { backgroundColor: isLte ? '#4CAF50' : '#2196F3' }]}>
                <Text style={styles.networkBadgeText}>{selectedSector.networkType}</Text>
              </View>
              <Text style={styles.title} numberOfLines={1}>
                {selectedSector.name}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedSector(null)}>
              <Text style={styles.closeBtn}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {renderField('小区名称', selectedSector.name)}
            {renderField('基站ID', selectedSector.siteId)}
            {renderField('小区ID', selectedSector.sectorId)}
            {renderField('纬度', selectedSector.latitude?.toFixed(6))}
            {renderField('经度', selectedSector.longitude?.toFixed(6))}
            {renderField('方位角', selectedSector.azimuth)}
            {renderField('波束宽度', selectedSector.beamwidth)}
            {renderField('PCI', selectedSector.pci)}
            {renderField('TAC', selectedSector.tac)}
            {renderField('频点', selectedSector.frequency)}
            {renderField('EARFCN', selectedSector.earfcn)}
            {renderField('SSB频点', selectedSector.ssbFrequency)}
            {renderField('站高', selectedSector.height)}
            {renderField('覆盖类型', selectedSector.cell_cover_type === 4 ? '室内' : '室外')}
            {renderField('MCC', selectedSector.mcc)}
            {renderField('MNC', selectedSector.mnc)}
            {renderField('是否共享', selectedSector.is_shared)}
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.copyBtn, styles.copyBtnFull]} onPress={handleCopy}>
              <Text style={styles.copyBtnText}>复制</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.navigateBtn} onPress={handleNavigate}>
              <Text style={styles.navigateBtnText}>导航</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

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
});
