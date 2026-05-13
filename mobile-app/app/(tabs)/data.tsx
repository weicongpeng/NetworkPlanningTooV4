import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { apiService } from '../../src/services/api';

interface DataItem {
  id: string;
  name: string;
  fileType: string;
  type: string;
  subType?: string;
  geometryType?: string;
  uploadDate: string;
  originalPath?: string;
  metadata?: {
    siteCount?: number;
    sectorCount?: number;
    pointCount?: number;
    LTESiteCount?: number;
    LTESectorCount?: number;
    NRSiteCount?: number;
    NRSectorCount?: number;
    layerCount?: number;
  };
}

export default function DataScreen() {
  const [items, setItems] = useState<DataItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchList = useCallback(async (isRefresh = false) => {
    setErrorMsg(null);
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      console.log('[DataScreen] 后端地址:', await apiService.getCurrentBaseUrl());
      const response = await apiService.getDataList();
      console.log('[DataScreen] 数据列表响应:', JSON.stringify(response, null, 2)?.substring(0, 500));
      if (response.success && response.data) {
        // 后端 data 直接是数组，不是 {items: [...]} 对象
        const list = Array.isArray(response.data) ? response.data : response.data.items || [];
        setItems(list);
      } else {
        setItems([]);
      }
    } catch (error: any) {
      console.error('[DataScreen] 获取数据列表失败:', error);
      const msg = error?.message || '无法连接到服务器，请检查网络';
      setErrorMsg(msg);
      if (!isRefresh) {
        Alert.alert('连接失败', `请检查网络`);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);



  const handlePreview = async (item: DataItem) => {
    setSelectedId(item.id);
    setPreviewLoading(true);
    try {
      const result = await apiService.getDataPreview(item.id);
      if (result?.success) {
        setPreviewData(result.data);
      } else {
        setPreviewData(null);
      }
    } catch (error) {
      console.error('加载预览失败:', error);
      setPreviewData(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownload = async (item: DataItem) => {
    setDownloadLoading(item.id);
    try {
      const result = await apiService.downloadData(item.id, item.name);
      if (result.success) {
        Alert.alert('成功', result.message || '文件已下载');
      } else {
        Alert.alert('失败', result.message || '下载失败');
      }
    } catch (error: any) {
      console.error('下载失败:', error);
      Alert.alert('失败', error?.message || '下载失败');
    } finally {
      setDownloadLoading(null);
    }
  };

  const getTypeLabel = (item: DataItem) => {
    if (item.fileType === 'geo_data') return item.geometryType === 'sector' ? '扇区数据' : '地理化';
    if (item.fileType === 'full_params') return '全量工参';
    if (item.fileType === 'target_cells') return '待规划';
    if (item.fileType === 'current_params') return '现网工参';
    if (item.subType === 'mapinfo') return 'MapInfo';
    if (item.type === 'excel') return 'Excel';
    return 'ZIP';
  };

  const getTypeColor = (item: DataItem) => {
    if (item.fileType === 'geo_data') return '#9333EA';
    if (item.fileType === 'full_params') return '#2563EB';
    if (item.fileType === 'target_cells') return '#EA580C';
    if (item.fileType === 'current_params') return '#4F46E5';
    if (item.subType === 'mapinfo') return '#0891B2';
    return '#6B7280';
  };

  const getMetaText = (item: DataItem) => {
    const m = item.metadata;
    if (item.fileType === 'geo_data') {
      return `${m?.pointCount || 0} 个${item.geometryType === 'sector' ? '扇区' : '点'}`;
    }
    if (item.type === 'excel' && m?.LTESiteCount) {
      return `LTE ${m.LTESiteCount}站/${m.LTESectorCount}小区 · NR ${m.NRSiteCount}站/${m.NRSectorCount}小区`;
    }
    if (m?.siteCount) return `${m.siteCount} 个基站`;
    if (item.type === 'map' && m?.layerCount) return `${m.layerCount} 个图层`;
    return '';
  };

  const renderItem = ({ item }: { item: DataItem }) => {
    const isSelected = selectedId === item.id;
    const isDownloading = downloadLoading === item.id;
    return (
      <TouchableOpacity
        style={[styles.itemCard, isSelected && styles.itemCardSelected]}
        onPress={() => handlePreview(item)}
      >
        <View style={styles.itemHeader}>
          <View style={[styles.typeBadge, { backgroundColor: getTypeColor(item) + '15' }]}>
            <Text style={[styles.typeBadgeText, { color: getTypeColor(item) }]}>
              {getTypeLabel(item)}
            </Text>
          </View>
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.downloadBtn, isDownloading && styles.downloadBtnActive]}
              onPress={() => handleDownload(item)}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <ActivityIndicator size="small" color="#007AFF" />
              ) : (
                <Text style={styles.downloadBtnText}>下载</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
        {getMetaText(item) ? (
          <Text style={styles.itemMeta}>{getMetaText(item)}</Text>
        ) : null}
        <Text style={styles.itemDate}>
          {new Date(item.uploadDate).toLocaleDateString('zh-CN')}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderPreview = () => {
    if (!selectedId) {
      return (
        <View style={styles.previewEmpty}>
          <Text style={styles.previewEmptyText}>请选择数据查看预览</Text>
        </View>
      );
    }

    if (previewLoading) {
      return (
        <View style={styles.previewLoading}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.previewLoadingText}>加载中...</Text>
        </View>
      );
    }

    if (!previewData) {
      return (
        <View style={styles.previewEmpty}>
          <Text style={styles.previewEmptyText}>无法加载数据预览</Text>
        </View>
      );
    }

    // ZIP 文件：显示文件列表
    if (previewData.files) {
      return (
        <ScrollView style={styles.previewScroll}>
          <Text style={styles.previewTitle}>包含 {previewData.files.length} 个文件</Text>
          {previewData.files.map((file: string, idx: number) => (
            <Text key={idx} style={styles.previewFileItem}>{file}</Text>
          ))}
        </ScrollView>
      );
    }

    // 站点数据：显示表格
    const sites = Array.isArray(previewData) ? previewData : previewData.sites || [];
    return (
      <ScrollView style={styles.previewScroll} horizontal>
        <View>
          <Text style={styles.previewTitle}>共 {sites.length} 个基站 (显示前50个)</Text>
          <View style={styles.table}>
            <View style={[styles.tableRow, styles.tableHeader]}>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 100 }]}>基站ID</Text>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 120 }]}>基站名称</Text>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 60 }]}>类型</Text>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 90 }]}>经度</Text>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 90 }]}>纬度</Text>
              <Text style={[styles.tableCell, styles.tableCellHeader, { width: 60 }]}>小区数</Text>
            </View>
            {sites.slice(0, 50).map((site: any, idx: number) => (
              <View key={idx} style={[styles.tableRow, idx % 2 === 1 && styles.tableRowAlt]}>
                <Text style={[styles.tableCell, { width: 100 }]} numberOfLines={1}>{site.id}</Text>
                <Text style={[styles.tableCell, { width: 120 }]} numberOfLines={1}>{site.name}</Text>
                <Text style={[styles.tableCell, { width: 60 }]}>{site.networkType}</Text>
                <Text style={[styles.tableCell, { width: 90 }]}>{site.longitude?.toFixed(6)}</Text>
                <Text style={[styles.tableCell, { width: 90 }]}>{site.latitude?.toFixed(6)}</Text>
                <Text style={[styles.tableCell, { width: 60 }]}>{site.sectors?.length || 0}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>数据</Text>
        <Text style={styles.headerSubtitle}>共 {items.length} 个数据文件</Text>
      </View>

      <View style={styles.listSection}>
        {loading && items.length === 0 ? (
          <ActivityIndicator size="large" color="#007AFF" style={styles.loader} />
        ) : items.length === 0 ? (
          <View style={styles.emptyState}>
            {errorMsg ? (
              <>
                <Text style={styles.errorTitle}>连接失败</Text>
                <Text style={styles.errorText}>{errorMsg}</Text>
                <Text style={styles.errorHint}>请确认：\n1. 桌面端服务已启动\n2. 手机与电脑在同一网络</Text>
              </>
            ) : (
              <Text style={styles.emptyText}>暂无数据，请在桌面端导入</Text>
            )}
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => fetchList(true)} />
            }
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>

      <View style={styles.previewSection}>
        <Text style={styles.previewSectionTitle}>数据预览</Text>
        {renderPreview()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    paddingTop: 52,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#888',
    marginTop: 4,
  },
  listSection: {
    flex: 1,
    maxHeight: '55%',
  },
  listContent: {
    padding: 12,
    gap: 10,
  },
  loader: {
    marginTop: 40,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#999',
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#DC2626',
    marginBottom: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#666',
    marginBottom: 12,
    textAlign: 'center',
  },
  errorHint: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    lineHeight: 20,
  },
  itemCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#eee',
  },
  itemCardSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F7FF',
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  downloadBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#E0F2FE',
    borderRadius: 4,
    minWidth: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadBtnActive: {
    backgroundColor: '#BAE6FD',
  },
  downloadBtnText: {
    fontSize: 12,
    color: '#0369A1',
    fontWeight: '500',
  },
  itemName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  itemMeta: {
    fontSize: 12,
    color: '#666',
    marginBottom: 2,
  },
  itemDate: {
    fontSize: 11,
    color: '#aaa',
  },
  previewSection: {
    flex: 1,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    padding: 12,
  },
  previewSectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  previewScroll: {
    flex: 1,
  },
  previewEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewEmptyText: {
    fontSize: 14,
    color: '#999',
  },
  previewLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  previewLoadingText: {
    fontSize: 14,
    color: '#666',
  },
  previewTitle: {
    fontSize: 13,
    color: '#666',
    marginBottom: 10,
  },
  previewFileItem: {
    fontSize: 13,
    color: '#333',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  table: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tableRowAlt: {
    backgroundColor: '#fafafa',
  },
  tableHeader: {
    backgroundColor: '#f5f5f5',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  tableCell: {
    fontSize: 12,
    color: '#333',
    paddingHorizontal: 4,
  },
  tableCellHeader: {
    fontWeight: 'bold',
    color: '#555',
  },
});
