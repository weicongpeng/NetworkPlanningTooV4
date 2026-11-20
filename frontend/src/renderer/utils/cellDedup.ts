/**
 * 小区查重唯一键（新站录入）
 *
 * 与后端 data_service._cell_dedup_key / 工参入库唯一键保持同一口径：
 *  - LTE : 基站ID_小区ID
 *  - NR  : MCC_MNC_基站ID_小区ID
 *
 * NR 共享小区同基站/同小区、不同 MNC 是两条 PLMN 记录（电信 460-11 / 联通 460-01），
 * 唯一键必须带 PLMN 才能区分，否则录入另一 PLMN 时会被误判为重复。
 */

/** 归一化 ID 分量：数字串按整数归一（'01'→'1'、'541379.0'→'541379'），非数字保留 trim 原值 */
export function normId(v: string | number | null | undefined): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const n = Number(s)
  return Number.isFinite(n) ? String(Math.trunc(n)) : s
}

export interface CellDedupInput {
  siteId: string | number
  cellId: string | number
  mcc?: string | number | null
  mnc?: string | number | null
}

/** 计算小区查重唯一键（LTE=基站_小区；NR=MCC_MNC_基站_小区） */
export function cellDedupKey(nt: 'LTE' | 'NR', cell: CellDedupInput): string {
  const site = normId(cell.siteId)
  const cid = normId(cell.cellId)
  if (nt === 'NR') {
    return `${normId(cell.mcc)}_${normId(cell.mnc)}_${site}_${cid}`
  }
  return `${site}_${cid}`
}
