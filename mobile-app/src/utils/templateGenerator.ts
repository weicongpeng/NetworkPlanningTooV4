import * as XLSX from 'xlsx';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert, Platform } from 'react-native';

/**
 * 手动上传工参模板生成器
 *
 * 字段来源: cacheService.ts 中 parseAppProjectParams() 的解析规则
 * - 必填列: 基站标识、小区标识、小区名称、经度、纬度、天线方向角、小区覆盖类型
 * - 可选列: 基站名称、厂家、天线挂高、PCI、频点、TAC、是否共享
 *
 * 必填字段列名添加"(必填)"后缀标识，解析时自动去除
 */

// 必填字段集合（不含后缀）
const REQUIRED_FIELDS = new Set(['基站标识', '小区标识', '小区名称', '经度', '纬度', '天线方向角', '小区覆盖类型']);

// LTE 工参模板列（必填写在前，可选在后；必填列名加"(必填)"后缀）
const LTE_TEMPLATE_COLUMNS: Record<string, string> = {
  '基站标识(必填)': '100001',
  '小区标识(必填)': '1',
  '小区名称(必填)': '示例基站A-1',
  '经度(必填)': '116.397428',
  '纬度(必填)': '39.90923',
  '天线方向角(必填)': '0',
  '小区覆盖类型(必填)': '室分/室外',
  '基站名称': '示例基站A',
  '厂家': '华为',
  '天线挂高': '30',
  'PCI': '100',
  '下行链路的中心载频': '1300',
  'TAC': '26000',
  '是否共享': '否',
};

// NR 工参模板列
const NR_TEMPLATE_COLUMNS: Record<string, string> = {
  '基站标识(必填)': '200001',
  '小区标识(必填)': '1',
  '小区名称(必填)': '示例基站B-1',
  '经度(必填)': '116.407428',
  '纬度(必填)': '39.90923',
  '天线方向角(必填)': '120',
  '小区覆盖类型(必填)': '室分/室外',
  '基站名称': '示例基站B',
  '厂家': '中兴',
  '天线挂高': '25',
  'PCI': '200',
  'CenterARFCN': '504990',
  'TAC': '26001',
  '是否共享': '否',
};

/**
 * 为 worksheet 的表头行设置必填字段的红色字体样式
 */
function applyRequiredFieldStyles(ws: XLSX.WorkSheet, headers: string[]): void {
  for (let colIdx = 0; colIdx < headers.length; colIdx++) {
    const headerName = headers[colIdx];
    // 检查是否为必填列（列名含"(必填)"后缀）
    if (!headerName.includes('(必填)')) continue;

    const cellRef = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    const cell = ws[cellRef];
    if (!cell) continue;

    // 设置红色字体样式
    cell.s = { font: { color: { rgb: 'FFFF0000' }, bold: true } };
  }
}

/**
 * 生成工参 Excel 模板的 base64 数据
 */
function generateTemplateBase64(): string {
  // 创建 LTE 工作表
  const lteHeaders = Object.keys(LTE_TEMPLATE_COLUMNS);
  const lteExampleRow = Object.values(LTE_TEMPLATE_COLUMNS);
  const lteData = [lteHeaders, lteExampleRow];
  const lteWs = XLSX.utils.aoa_to_sheet(lteData);
  lteWs['!cols'] = lteHeaders.map((h) => ({ wch: Math.max(h.length * 2, 14) }));
  applyRequiredFieldStyles(lteWs, lteHeaders);

  // 创建 NR 工作表
  const nrHeaders = Object.keys(NR_TEMPLATE_COLUMNS);
  const nrExampleRow = Object.values(NR_TEMPLATE_COLUMNS);
  const nrData = [nrHeaders, nrExampleRow];
  const nrWs = XLSX.utils.aoa_to_sheet(nrData);
  nrWs['!cols'] = nrHeaders.map((h) => ({ wch: Math.max(h.length * 2, 14) }));
  applyRequiredFieldStyles(nrWs, nrHeaders);

  // 创建工作簿
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, lteWs, 'LTE Project Parameters');
  XLSX.utils.book_append_sheet(wb, nrWs, 'NR Project Parameters');

  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx', cellStyles: true });
}

/**
 * 生成工参 Excel 模板文件并保存到手机本地
 * 使用 StorageAccessFramework 让用户选择保存目录
 */
export async function downloadGongcanTemplate(): Promise<void> {
  const base64Content = generateTemplateBase64();
  const fileName = 'ProjectParameter_template.xlsx';
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // Android: 使用 SAF 让用户选择保存目录
  if (Platform.OS === 'android') {
    const SAF = (FileSystem as any).StorageAccessFramework;
    if (SAF && typeof SAF.requestDirectoryPermissionsAsync === 'function') {
      const dirResult = await SAF.requestDirectoryPermissionsAsync();
      if (!dirResult.granted) {
        Alert.alert('提示', '需要选择保存目录才能下载模板');
        return;
      }

      try {
        const fileUri = await SAF.createFileAsync(
          dirResult.directoryUri,
          fileName,
          mimeType,
        );
        await SAF.writeAsStringAsync(fileUri, base64Content, {
          encoding: FileSystem.EncodingType.Base64,
        });
        Alert.alert('保存成功', `模板已保存到所选目录：\n${fileName}`);
      } catch (e: any) {
        console.error('[templateGenerator] SAF save failed:', e);
        Alert.alert('保存失败', e.message || '无法写入文件到所选目录');
      }
      return;
    }
  }

  // Fallback: 写入缓存目录
  const filePath = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(filePath, base64Content, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(filePath, {
      mimeType,
      dialogTitle: '保存工参模板',
    });
  } else {
    Alert.alert('已生成', `模板已保存到应用缓存：\n${fileName}`);
  }
}
