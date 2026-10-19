import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  ScrollView, Alert, Modal, Platform, Appearance,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import { cacheService } from '../../src/services/cacheService';
import { useMapStore, SectorData } from '../../src/store/mapStore';
import { ImportProgress, CacheMeta, SkipStats, SkipDetail, ImportResult } from '../../src/types/data';
import { downloadGongcanTemplate } from '../../src/utils/templateGenerator';
import AuthGuard from '../../src/components/Auth/AuthGuard';

// ==================== 工具函数 ====================

function buildSkipReport(
  stats: { lte: SkipStats; nr: SkipStats } | undefined,
  summary: string,
): string {
  if (!stats) return summary || '导入完成';
  const lines: string[] = [];
  if (summary) lines.push(summary);
  const sections: string[] = [];
  const formatNet = (label: string, s: SkipStats) => {
    const otherReasons = [
      { name: '重复行', count: s.duplicate },
      { name: '经纬度超中国范围', count: s.outOfRange },
      { name: '小区标识为空', count: s.missingSectorId },
      { name: '基站标识为空', count: s.missingSiteId },
      { name: '空行', count: s.emptyRow },
    ].filter(r => r.count > 0);
    const imported = s.totalDataRows - s.emptyRow - s.missingSiteId - s.missingSectorId
      - s.invalidLatLng - s.outOfRange - s.duplicate;
    const expected = s.totalDataRows - s.invalidLatLng;
    const unexpectedMissing = Math.max(0, expected - imported);
    if (otherReasons.length === 0 && unexpectedMissing === 0 && s.invalidLatLng === 0) return;
    const parts: string[] = [`${label}:`, `共 ${s.totalDataRows} 行`];
    if (s.invalidLatLng > 0) parts.push(`经纬度空值 ${s.invalidLatLng} 行`);
    parts.push(`导入 ${imported} 个小区`);
    const block: string[] = [parts.join(' ')];
    if (unexpectedMissing > 0) {
      block.push(`  缺失 ${unexpectedMissing} 个:`);
      for (const r of otherReasons) block.push(`    • ${r.name} ${r.count}`);
    }
    sections.push(block.join('\n'));
  };
  formatNet('LTE', stats.lte);
  formatNet('NR', stats.nr);
  if (sections.length > 0) {
    lines.push('');
    lines.push(sections.join('\n\n'));
  }
  return lines.join('\n');
}

function mergeSkipStats(results: ImportResult[]): { lte: SkipStats; nr: SkipStats } | null {
  let hasAny = false;
  const merged = {
    lte: { totalDataRows: 0, emptyRow: 0, missingSiteId: 0, missingSectorId: 0, invalidLatLng: 0, outOfRange: 0, duplicate: 0, skipDetails: [] as SkipDetail[] },
    nr: { totalDataRows: 0, emptyRow: 0, missingSiteId: 0, missingSectorId: 0, invalidLatLng: 0, outOfRange: 0, duplicate: 0, skipDetails: [] as SkipDetail[] },
  };
  for (const r of results) {
    if (!r.skipStats) continue;
    hasAny = true;
    for (const net of ['lte', 'nr'] as const) {
      for (const k of Object.keys(merged[net]) as (keyof SkipStats)[]) {
        if (k === 'skipDetails') {
          merged[net].skipDetails.push(...(r.skipStats[net].skipDetails || []));
        } else {
          (merged[net] as any)[k] += (r.skipStats[net] as any)[k] || 0;
        }
      }
    }
  }
  return hasAny ? merged : null;
}

// ==================== 配色方案 ====================

const LIGHT_COLORS = {
  bg: '#f5f5f5',
  card: '#FFFFFF',
  cardBorder: '#E5E5E5',
  border: '#E5E5E5',
  divider: '#EEEEEE',
  textPrimary: '#1A1A1A',
  textSecondary: '#666666',
  textMuted: '#999999',
  textDisabled: '#D0D0D0',
  lte: '#2563EB',
  nr: '#2563EB',
  lteBg: '#EFF6FF',
  nrBg: '#EFF6FF',
  success: '#16A34A',
  danger: '#E53935',
  accent: '#007AFF',
  btnPrimaryText: '#FFFFFF',
  btnGhostText: '#1A1A1A',
  inputBg: '#FFFFFF',
  overlayBg: 'rgba(0,0,0,0.4)',
} as const;

const DARK_COLORS = {
  bg: '#2B2B2F',
  card: '#36363A',
  cardBorder: '#4A4A50',
  border: '#4A4A50',
  divider: '#424248',
  textPrimary: '#E8E6E3',
  textSecondary: '#B0AEA8',
  textMuted: '#8A8880',
  textDisabled: '#6A6A6E',
  lte: '#7EB6F6',
  nr: '#7EB6F6',
  lteBg: '#2A3040',
  nrBg: '#2A3040',
  success: '#7EC87E',
  danger: '#F07070',
  accent: '#7EB6F6',
  btnPrimaryText: '#FFFFFF',
  btnGhostText: '#E8E6E3',
  inputBg: '#3A3A3F',
  overlayBg: 'rgba(0,0,0,0.55)',
} as const;

type ColorScheme = {
  readonly bg: string; readonly card: string; readonly cardBorder: string;
  readonly border: string; readonly divider: string;
  readonly textPrimary: string; readonly textSecondary: string;
  readonly textMuted: string; readonly textDisabled: string;
  readonly lte: string; readonly nr: string;
  readonly lteBg: string; readonly nrBg: string;
  readonly success: string; readonly danger: string; readonly accent: string;
  readonly btnPrimaryText: string; readonly btnGhostText: string;
  readonly inputBg: string; readonly overlayBg: string;
};

// ==================== 主组件 ====================

export default function DataScreen() {
  const insets = useSafeAreaInsets();
  const { setCacheAvailable, setCacheUpdatedAt } = useMapStore();
  const darkMode = useMapStore((s) => s.darkMode);
  const COLORS: ColorScheme = darkMode ? DARK_COLORS : LIGHT_COLORS;

  useEffect(() => {
    Appearance.setColorScheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const [meta, setMeta] = useState<CacheMeta | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const importCancelledRef = useRef(false);
  const [availableFiles, setAvailableFiles] = useState<{uri: string; name: string; selected: boolean}[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  // 异常数据展示状态
  const [lastImportSkipDetails, setLastImportSkipDetails] = useState<{lte: SkipDetail[]; nr: SkipDetail[]} | null>(null);
  const [skipDetailsExpanded, setSkipDetailsExpanded] = useState(false);

  // ==================== 数据加载 ====================

  const loadMeta = useCallback(async () => {
    const m = await cacheService.getMeta();
    setMeta(m);
    setCacheAvailable(m.dataTypes.fullParams);
    setCacheUpdatedAt(m.lastRefreshAt);
  }, [setCacheAvailable, setCacheUpdatedAt]);

  // Tab 获得焦点时刷新 meta，确保自动同步后的数据也能及时展示
  useFocusEffect(
    useCallback(() => {
      cacheService.init().then(() => loadMeta());
    }, [loadMeta])
  );

  const reloadMapSectors = useCallback(async () => {
    const setSectors = useMapStore.getState().setSectors;
    const cached = await cacheService.reloadSectorsFromCache();
    if (cached) {
      const mapSector = (list: any[], net: 'LTE' | 'NR'): SectorData[] =>
        (list || []).map((s: any) => ({
          id: s.id, name: s.name || '未命名', siteName: s.siteName, siteId: s.siteId, sectorId: s.sectorId,
          vendor: s.vendor,
          latitude: s.latitude, longitude: s.longitude, networkType: net,
          frequency: s.frequency, pci: s.pci, tac: s.tac, azimuth: s.azimuth,
          beamwidth: s.beamwidth, height: s.height, cell_cover_type: s.cell_cover_type,
          earfcn: s.earfcn, ssbFrequency: s.ssbFrequency, mcc: s.mcc, mnc: s.mnc, is_shared: s.is_shared,
          extraFields: s.extraFields,
        }));
      setSectors(mapSector(cached.lte, 'LTE'), mapSector(cached.nr, 'NR'));
    } else {
      // 缓存已清空（用户删除工参缓存），同步清空内存中的扇区数据
      setSectors([], []);
    }
  }, []);

  // ==================== 全量工参操作 ====================

  const handleRefreshFromBackend = () => {
    Alert.alert('确认刷新', '将从后端重新下载全量工参数据,确定?', [
      { text: '取消', style: 'cancel' },
      {
        text: '刷新', style: 'destructive',
        onPress: async () => {
          setRefreshing(true);
          try {
            await cacheService.cacheFullParamsFromBackend();
            await loadMeta();
            await reloadMapSectors();
          } catch (e: any) {
            Alert.alert('刷新失败', e.message || '无法连接到后端');
          } finally {
            setRefreshing(false);
          }
        },
      },
    ]);
  };

  const pickAndImportFile = async () => {
    try {
      importCancelledRef.current = false;
      const SAF = (FileSystem as any).StorageAccessFramework;
      const dirResult = await SAF.requestDirectoryPermissionsAsync();
      if (!dirResult.granted) return;
      const allFiles = await SAF.readDirectoryAsync(dirResult.directoryUri);
      const extractFileName = (uri: string): string => {
        const decoded = decodeURIComponent(uri);
        let name = decoded.split('/').pop() || '';
        if (name.includes('/') || name.includes('\\')) name = name.split(/[/\\]/).pop() || name;
        return name;
      };
      const matched = allFiles
        .filter((uri: string) => {
          const name = extractFileName(uri).toLowerCase();
          return name.endsWith('.xlsx') || name.endsWith('.xls');
        })
        .map((uri: string) => ({ uri, name: extractFileName(uri), selected: false }));
      if (matched.length === 0) {
        Alert.alert('未找到文件', '目录中没有 Excel 文件（.xlsx / .xls）');
        return;
      }
      if (matched.length === 1) {
        const r = await startImport(matched[0].uri, matched[0].name);
        if (r) {
          const hasDetails = r.skipStats && (r.skipStats.lte.skipDetails.length > 0 || r.skipStats.nr.skipDetails.length > 0);
          if (hasDetails) {
            setLastImportSkipDetails({ lte: r.skipStats!.lte.skipDetails, nr: r.skipStats!.nr.skipDetails });
            setSkipDetailsExpanded(false);
          } else {
            setLastImportSkipDetails(null);
          }
          Alert.alert('导入完成', buildSkipReport(r.skipStats, r.message || ''));
        }
      } else {
        setAvailableFiles(matched);
        setShowFilePicker(true);
      }
    } catch (e: any) {
      console.error('[DataScreen] pickAndImportFile error:', e);
      Alert.alert('选择文件失败', e.message || '无法读取目录');
    }
  };

  const toggleFileSelection = (index: number) => {
    const files = [...availableFiles];
    const wasSelected = files[index].selected;
    // 单选模式：先取消所有选中，再切换当前项
    files.forEach((f, i) => { f.selected = false; });
    if (!wasSelected) files[index].selected = true;
    setAvailableFiles(files);
  };

  const confirmFileImport = async () => {
    const selectedFiles = availableFiles.filter(f => f.selected);
    if (selectedFiles.length === 0) {
      Alert.alert('请选择文件', '请至少选择一个文件导入');
      return;
    }
    setShowFilePicker(false);
    setImporting(true);
    let successCount = 0;
    const results: ImportResult[] = [];
    for (const file of selectedFiles) {
      if (importCancelledRef.current) break;
      const r = await startImport(file.uri, file.name);
      if (r) { successCount++; results.push(r); }
    }
    if (successCount > 0) {
      await reloadMapSectors();
      const mergedStats = mergeSkipStats(results);
      const hasDetails = mergedStats && (mergedStats.lte.skipDetails.length > 0 || mergedStats.nr.skipDetails.length > 0);
      if (hasDetails) {
        setLastImportSkipDetails({ lte: mergedStats!.lte.skipDetails, nr: mergedStats!.nr.skipDetails });
        setSkipDetailsExpanded(false);
      } else {
        setLastImportSkipDetails(null);
      }
      Alert.alert('导入完成', buildSkipReport(mergedStats || undefined, `成功导入 ${successCount} 个全量工参文件`));
    }
    setImporting(false);
    setAvailableFiles([]);
  };

  const startImport = async (fileUri: string, fileName: string): Promise<ImportResult | null> => {
    try {
      if (importCancelledRef.current) return null;
      console.log('[DataScreen] startImport:', fileName);
      setImportProgress({ fileName, progress: 0, status: 'parsing', message: '正在处理...' });
      const r = await cacheService.importFile(fileUri, fileName, (p) => {
        if (importCancelledRef.current) { setImportProgress(null); return; }
        setImportProgress(p);
      });
      if (importCancelledRef.current) return null;
      setImportProgress(null);
      if (r.success) {
        await loadMeta();
        await reloadMapSectors();
        return r;
      } else {
        Alert.alert('导入失败', r.message || '未知错误');
        return null;
      }
    } catch (e: any) {
      if (!importCancelledRef.current) {
        setImportProgress(null);
        Alert.alert('导入异常', e.message || '未知错误');
      }
      return null;
    }
  };

  const handleDelete = () => {
    Alert.alert('确认删除', '将删除已导入的全量工参数据,确定?', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive',
        onPress: async () => {
          await cacheService.clearDataType('fullParams');
          await loadMeta();
          await reloadMapSectors();
        },
      },
    ]);
  };

  // ==================== 渲染 ====================

  const formatTime = (isoStr: string | null) => {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const hasFullParams = meta?.dataTypes.fullParams || false;
  const isBusy = refreshing || importing;

  // 渲染异常数据分区（LTE/NR）
  const SKIP_DETAIL_COLLAPSE_THRESHOLD = 5;
  const renderSkipDetailsSection = (label: string, details: SkipDetail[], COLORS: any) => {
    if (details.length === 0) return null;
    const isExpanded = skipDetailsExpanded;
    const showToggle = details.length > SKIP_DETAIL_COLLAPSE_THRESHOLD;
    const visibleDetails = showToggle && !isExpanded ? details.slice(0, SKIP_DETAIL_COLLAPSE_THRESHOLD) : details;
    return (
      <View style={{ paddingVertical: 8 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: COLORS.textPrimary, marginBottom: 6 }}>
          {label} · {details.length} 条异常
        </Text>
        {visibleDetails.map((d, i) => (
          <View key={i} style={{ flexDirection: 'row', paddingVertical: 3, paddingLeft: 4 }}>
            <Text style={{ fontSize: 11, color: COLORS.textSecondary, width: 44, flexShrink: 0 }}>
              第{d.rowNumber}行
            </Text>
            <Text style={{ fontSize: 11, color: COLORS.textPrimary, flex: 1 }} numberOfLines={1}>
              {d.sectorName || '—'}
            </Text>
            <Text style={{ fontSize: 11, color: COLORS.textDisabled, flex: 1 }} numberOfLines={1}>
              {d.reason}
            </Text>
          </View>
        ))}
        {showToggle && (
          <TouchableOpacity
            onPress={() => setSkipDetailsExpanded(!isExpanded)}
            activeOpacity={0.6}
            style={{ paddingVertical: 6, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 12, color: COLORS.accent }}>
              {isExpanded ? '收起' : `展开全部 ${details.length} 条`}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <AuthGuard>
      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: COLORS.bg }]}>
        <StatusBar style={darkMode ? 'light' : 'dark'} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 顶部标题 */}
        <View style={[styles.header, { backgroundColor: COLORS.bg }]}>
          <Text style={[styles.headerTitle, { color: COLORS.textPrimary }]}>数据</Text>
        </View>

        {/* 进度条 */}
        {importProgress && (
          <View style={[styles.progressCard, { backgroundColor: COLORS.card }]}>
            <View style={styles.progressHeader}>
              <Text style={[styles.progressTitle, { color: COLORS.textPrimary }]}>{importProgress.fileName}</Text>
              <TouchableOpacity
                onPress={() => { importCancelledRef.current = true; setImportProgress(null); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.cancelText, { color: COLORS.textSecondary }]}>取消</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.progressBar, { backgroundColor: COLORS.divider }]}>
              <View style={[styles.progressFill, { width: `${importProgress.progress}%`, backgroundColor: COLORS.accent }]} />
            </View>
            <Text style={[styles.progressText, { color: COLORS.textSecondary }]}>{importProgress.message}</Text>
          </View>
        )}

        {/* ====== 工参配置 ====== */}
        <Section title="工参配置" colors={COLORS}>
          <View style={[styles.card, { backgroundColor: COLORS.card }]}>
            {meta?.fullParamsInfo ? (
              <View style={styles.dataBlock}>
                {meta.fullParamsInfo.sourceFileName ? (
                  <Text style={[styles.dataFileName, { color: COLORS.textPrimary }]} numberOfLines={1}>{meta.fullParamsInfo.sourceFileName}</Text>
                ) : null}
                <DataRow
                  label="LTE"
                  value={`${meta.fullParamsInfo.lteSiteCount} 站 / ${meta.fullParamsInfo.lteSectorCount} 小区`}
                  color={COLORS.lte}
                  colorBg={COLORS.lteBg}
                  colors={COLORS}
                />
                <DataRow
                  label="NR"
                  value={`${meta.fullParamsInfo.nrSiteCount} 站 / ${meta.fullParamsInfo.nrSectorCount} 小区`}
                  color={COLORS.nr}
                  colorBg={COLORS.nrBg}
                  colors={COLORS}
                />
                <DataRow
                  label={meta.fullParamsInfo.fromPhone ? '导入于' : '缓存于'}
                  value={formatTime(meta.fullParamsInfo.cachedAt)}
                  colors={COLORS}
                />
              </View>
            ) : (
              <Text style={[styles.emptyText, { color: COLORS.textMuted }]}>尚未导入</Text>
            )}

            <View style={[styles.divider, { backgroundColor: COLORS.divider }]} />

            <View style={styles.actionGrid}>
              <ActionCard
                text="后端加载"
                onPress={handleRefreshFromBackend}
                loading={refreshing}
                disabled={isBusy}
                colors={COLORS}
              />
              <ActionCard
                text="本地上传"
                onPress={pickAndImportFile}
                loading={importing}
                disabled={isBusy}
                colors={COLORS}
              />
              <ActionCard
                text="模板下载"
                onPress={async () => {
                  try {
                    await downloadGongcanTemplate();
                  } catch (e) {
                    Alert.alert('下载失败', '无法生成模板文件，请重试');
                  }
                }}
                disabled={isBusy}
                colors={COLORS}
              />
              <ActionCard
                text="删除"
                onPress={handleDelete}
                disabled={!hasFullParams || isBusy}
                danger
                colors={COLORS}
              />
            </View>
          </View>
        </Section>

        {/* ====== 异常数据 ====== */}
        {lastImportSkipDetails && (lastImportSkipDetails.lte.length > 0 || lastImportSkipDetails.nr.length > 0) && (
          <Section title="异常数据" colors={COLORS}>
            <View style={[styles.card, { backgroundColor: COLORS.card }]}>
              {renderSkipDetailsSection('LTE', lastImportSkipDetails.lte, COLORS)}
              {lastImportSkipDetails.lte.length > 0 && lastImportSkipDetails.nr.length > 0 && (
                <View style={[styles.divider, { backgroundColor: COLORS.divider }]} />
              )}
              {renderSkipDetailsSection('NR', lastImportSkipDetails.nr, COLORS)}
              <View style={{ marginTop: 8, alignItems: 'flex-end' }}>
                <TouchableOpacity onPress={() => setLastImportSkipDetails(null)} activeOpacity={0.6}>
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>关闭</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Section>
        )}

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* 文件选择弹窗 */}
      <Modal visible={showFilePicker} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: COLORS.overlayBg, justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: COLORS.card, borderTopLeftRadius: 14, borderTopRightRadius: 14, maxHeight: '75%', paddingTop: 4 }}>
            <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.divider }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: COLORS.textPrimary }}>选择文件</Text>
              <Text style={{ fontSize: 11, color: COLORS.textSecondary, marginTop: 2 }}>
                共 {availableFiles.length} 个文件
              </Text>
            </View>
            <ScrollView style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
              {availableFiles.map((file, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.divider }}
                  onPress={() => toggleFileSelection(idx)}
                  activeOpacity={0.6}
                >
                  <View style={{
                    width: 18, height: 18, borderRadius: 9, borderWidth: 1.5,
                    borderColor: file.selected ? COLORS.accent : COLORS.textDisabled,
                    backgroundColor: 'transparent',
                    alignItems: 'center', justifyContent: 'center', marginRight: 12,
                  }}>
                    {file.selected && <View style={{ width: 10, height: 10, backgroundColor: COLORS.accent, borderRadius: 5 }} />}
                  </View>
                  <Text style={{ fontSize: 13, color: COLORS.textPrimary, flex: 1 }} numberOfLines={1}>{file.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={{ flexDirection: 'row', padding: 16, gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.divider }}>
              <TouchableOpacity
                onPress={() => { setShowFilePicker(false); setAvailableFiles([]); }}
                style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 8, backgroundColor: COLORS.bg }}
                activeOpacity={0.6}
              >
                <Text style={{ color: COLORS.textPrimary, fontSize: 14, fontWeight: '500' }}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={confirmFileImport} style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 8, backgroundColor: COLORS.accent }} activeOpacity={0.8}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>导入</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      </View>
    </AuthGuard>
  );
}

// ==================== 内部小组件 ====================

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: ColorScheme }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

function DataRow({ label, value, color, colorBg, colors }: {
  label: string; value: string; color?: string; colorBg?: string; colors: ColorScheme;
}) {
  return (
    <View style={styles.dataRow}>
      <View style={styles.dataRowLeft}>
        {color ? (
          <View style={[styles.dataRowBadge, colorBg ? { backgroundColor: colorBg } : null]}>
            <Text style={[styles.dataRowBadgeText, { color: color }]}>{label}</Text>
          </View>
        ) : (
          <Text style={[styles.dataRowLabel, { color: colors.textSecondary }]}>{label}</Text>
        )}
      </View>
      <Text style={[styles.dataRowValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function ActionCard({ text, onPress, loading, disabled, danger, colors }: {
  text: string; onPress: () => void; loading?: boolean; disabled?: boolean; danger?: boolean; colors: ColorScheme;
}) {
  const innerStyle = [
    styles.actionCardInner,
    { backgroundColor: colors.bg, borderColor: colors.border },
    danger && { borderColor: colors.danger },
    disabled && { borderColor: colors.cardBorder, backgroundColor: colors.inputBg },
  ];
  const textStyle = [
    { fontSize: 14, color: colors.textPrimary, fontWeight: '600' as const },
    danger && { color: colors.danger },
    disabled && { color: colors.textDisabled },
  ];
  return (
    <View style={styles.actionCard}>
      <TouchableOpacity
        style={innerStyle}
        onPress={onPress}
        disabled={disabled || loading}
        activeOpacity={0.6}
      >
        {loading
          ? <ActivityIndicator size="small" color={danger ? '#9A9A9A' : colors.textPrimary} />
          : <Text style={textStyle}>{text}</Text>}
      </TouchableOpacity>
    </View>
  );
}

// ==================== 样式(仅布局) ====================

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  header: {
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28, fontWeight: '700',
    letterSpacing: -0.4,
  },

  // 进度条
  progressCard: {
    marginHorizontal: 16, marginBottom: 12, padding: 14,
    borderRadius: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  progressTitle: { fontSize: 12, flex: 1, marginRight: 8 },
  cancelText: { fontSize: 12 },
  progressBar: { height: 2, borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%' },
  progressText: { fontSize: 11, marginTop: 8 },

  // 区块
  section: { paddingHorizontal: 16, marginBottom: 16 },
  sectionTitle: {
    fontSize: 12,
    letterSpacing: 0.4, marginBottom: 10, marginLeft: 4,
    fontWeight: '600',
  },
  card: {
    borderRadius: 10, padding: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 14 },

  // 数据行
  dataBlock: {},
  dataFileName: {
    fontSize: 13, fontWeight: '500',
    marginBottom: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  dataRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingVertical: 8,
  },
  dataRowLeft: { flexDirection: 'row', alignItems: 'center' },
  dataRowLabel: { fontSize: 13 },
  dataRowValue: { fontSize: 13, fontWeight: '500' },
  // 彩色 badge(LTE/NR 区分)
  dataRowBadge: {
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 4,
  },
  dataRowBadgeText: {
    fontSize: 11, fontWeight: '700', letterSpacing: 0.5,
  },
  emptyText: { fontSize: 13, textAlign: 'center', paddingVertical: 12 },

  // 操作按钮(2×2 网格,各自独立卡片)
  actionGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginHorizontal: -6,
  },
  actionCard: {
    width: '50%', paddingHorizontal: 6, marginBottom: 12,
  },
  actionCardInner: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: 10,
    borderWidth: 1,
  },
});
