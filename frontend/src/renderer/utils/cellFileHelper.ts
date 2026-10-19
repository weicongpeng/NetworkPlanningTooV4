/**
 * 待规划小区文件处理工具
 *
 * 用于解析上传的 cell-tree Excel 文件，提取小区ID并与小区选择列表匹配，
 * 以及动态生成待规划小区模板文件
 */
import * as XLSX from 'xlsx'

/**
 * 在列名列表中模糊查找匹配的列名（不区分大小写）
 */
function findColumn(columns: string[], patterns: string[]): string | undefined {
  const lowerCols = columns.map(c => c.toLowerCase().trim())
  for (const p of patterns) {
    const idx = lowerCols.findIndex(c => c === p.toLowerCase())
    if (idx >= 0) return columns[idx]
  }
  // 宽松匹配：包含关键词
  for (const p of patterns) {
    const idx = lowerCols.findIndex(c => c.includes(p.toLowerCase()))
    if (idx >= 0) return columns[idx]
  }
  return undefined
}

/**
 * 从上传的 cell-tree Excel 文件中按网络类型分组提取小区ID
 *
 * 文件格式：
 * - LTE Sheet: eNodeBID + CellID → `${siteId}_${cellId}`
 * - NR Sheet: gNodeBID + CellID → `${siteId}_${cellId}`
 *
 * @returns { lte: string[], nr: string[] } 分别对应 LTE / NR Sheet 提取的小区ID
 */
export function extractCellIdsFromFileGrouped(file: File): Promise<{ lte: string[]; nr: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })

        const lteIds: string[] = []
        const nrIds: string[] = []

        for (const sheetName of workbook.SheetNames) {
          const upperName = sheetName.toUpperCase()
          if (upperName !== 'LTE' && upperName !== 'NR') continue

          const isLTE = upperName === 'LTE'
          const siteIdPatterns = isLTE
            ? ['enodebid', 'eNodeBID', 'enodeb_id', 'site_id', 'siteid']
            : ['gnodebid', 'gNodeBID', 'gnodeb_id', 'site_id', 'siteid']
          const cellIdPatterns = ['cellid', 'CellID', 'cell_id', 'localcellid', 'LocalCellID']

          const sheet = workbook.Sheets[sheetName]
          const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' })

          if (rows.length === 0) continue

          // 从第一行数据推断列名
          const firstRow = rows[0]
          const columns = Object.keys(firstRow)

          const siteIdCol = findColumn(columns, siteIdPatterns)
          const cellIdCol = findColumn(columns, cellIdPatterns)

          if (!siteIdCol || !cellIdCol) {
            console.warn(`[cellFileHelper] Sheet "${sheetName}" 未找到ID列: siteIdCol=${siteIdCol}, cellIdCol=${cellIdCol}, columns=${columns.join(',')}`)
            continue
          }

          const target = isLTE ? lteIds : nrIds
          for (const row of rows) {
            const siteId = String(row[siteIdCol] ?? '').trim()
            const cellId = String(row[cellIdCol] ?? '').trim()
            // 移除可能的浮点数小数点后缀（如 "123.0" → "123"）
            const cleanSiteId = siteId.replace(/\.0+$/, '')
            const cleanCellId = cellId.replace(/\.0+$/, '')
            if (cleanSiteId && cleanCellId) {
              target.push(`${cleanSiteId}_${cleanCellId}`)
            }
          }
        }

        resolve({ lte: lteIds, nr: nrIds })
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 从上传的 cell-tree Excel 文件中提取全部小区ID（LTE + NR 合并）
 *
 * @returns 提取的小区ID数组（不区分网络类型）
 */
export function extractCellIdsFromFile(file: File): Promise<string[]> {
  return extractCellIdsFromFileGrouped(file).then(({ lte, nr }) => [...lte, ...nr])
}

/**
 * 将提取的小区ID与小区选择列表匹配，返回匹配的ID数组
 *
 * 匹配逻辑：eNodeBID+CellID 或 gNodeBID+CellID →
 *           cellList中对应的 siteId_cellId 格式
 * 支持整数/浮点数归一化（去除 .0 后缀）
 */
export function matchCellIds(
  extractedIds: string[],
  availableIds: string[]
): string[] {
  // 归一化可用ID（移除可能的 .0 后缀）
  const normalized = new Map<string, string>()
  for (const id of availableIds) {
    const parts = id.split('_')
    if (parts.length >= 2) {
      const cleanSiteId = parts[0].replace(/\.0+$/, '')
      const cleanCellId = parts[1].replace(/\.0+$/, '')
      normalized.set(`${cleanSiteId}_${cleanCellId}`, id)
    }
    normalized.set(id.replace(/\.0+$/, ''), id)
  }

  const result: string[] = []
  for (const id of extractedIds) {
    const cleanId = id.replace(/\.0+$/, '')
    const match = normalized.get(cleanId)
    if (match) {
      result.push(match)
    }
  }
  return result
}

/**
 * 动态生成待规划小区模板文件并触发下载
 *
 * @param networkType - 'LTE' | 'NR'
 *   - LTE: Sheet名称="LTE", 列: MCC, MNC, eNodeBID, CellID
 *   - NR:  Sheet名称="NR",  列: MCC, MNC, gNodeBID, CellID
 */
export function downloadCellTreeTemplate(networkType: 'LTE' | 'NR'): void {
  const sheetName = networkType
  const columns = networkType === 'LTE'
    ? ['MCC', 'MNC', 'eNodeBID', 'CellID']
    : ['MCC', 'MNC', 'gNodeBID', 'CellID']

  // 添加一行示例数据
  const exampleRow = networkType === 'LTE'
    ? { MCC: 460, MNC: 0, eNodeBID: 123456, CellID: 11 }
    : { MCC: 460, MNC: 0, gNodeBID: 123456, CellID: 11 }

  const worksheet = XLSX.utils.json_to_sheet([exampleRow], { header: columns })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)

  const filename = 'cell-tree-export.xlsx'
  XLSX.writeFile(workbook, filename)
}
