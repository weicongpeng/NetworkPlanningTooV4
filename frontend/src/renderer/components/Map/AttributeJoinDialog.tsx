/**
 * 条件选择（图层属性空间连接）弹窗
 *
 * 图层1要素按锚点判定是否落在图层2面边界内 → 命中追加图层2属性列 → 导出单个工作表 Excel。
 * 执行中弹窗不可关闭（遮罩 / X / Esc 均被拦截），完成或失败后才可操作。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, AlertTriangle, Download, Check, Loader2, Filter } from 'lucide-react'
import { attributeJoinApi } from '../../services/api'
import type { AttributeJoinStats } from '@shared/types'
import type { SectorLayerOption, LayerFileOption } from './LayerControl'
import {
  buildLayer1Options,
  buildLayer2Options,
  JOIN_GROUP_ORDER,
  type JoinGroup,
  type JoinOption,
} from './attributeJoinOptions'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 触发浏览器下载 blob */
function saveBlobAs(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

interface Props {
  open: boolean
  onClose: () => void
  layers: SectorLayerOption[]
  layerFiles: LayerFileOption[]
  pointFiles: LayerFileOption[]
}

type Phase = 'config' | 'running' | 'done' | 'error'

export default function AttributeJoinDialog({ open, onClose, layers, layerFiles, pointFiles }: Props) {
  const { t } = useTranslation()

  const l1All = useMemo(
    () => buildLayer1Options(layers, layerFiles, pointFiles),
    [layers, layerFiles, pointFiles],
  )
  const l1Options = l1All
  const l2Options = useMemo(() => buildLayer2Options(l1All), [l1All])

  const [l1Key, setL1Key] = useState('')
  const [l2Key, setL2Key] = useState('')
  const [phase, setPhase] = useState<Phase>('config')
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [stats, setStats] = useState<AttributeJoinStats | null>(null)
  const [taskId, setTaskId] = useState('')
  const [showNameInput, setShowNameInput] = useState(false)
  const [filename, setFilename] = useState('')
  const [downloading, setDownloading] = useState(false)
  /** 已下载文件名（下载成功后展示；弹窗保留，须用户点关闭才退出） */
  const [downloadedName, setDownloadedName] = useState('')

  const cancelledRef = useRef(false)

  // 打开时重置
  useEffect(() => {
    if (open) {
      cancelledRef.current = false
      setL1Key('')
      setL2Key('')
      setPhase('config')
      setProgress(0)
      setErrorMsg('')
      setStats(null)
      setTaskId('')
      setShowNameInput(false)
      setFilename('')
      setDownloading(false)
      setDownloadedName('')
    }
  }, [open])

  // 卸载时终止轮询
  useEffect(() => () => { cancelledRef.current = true }, [])

  // running 期间拦截 Esc
  useEffect(() => {
    if (!open || phase !== 'running') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, phase])

  const groupLabel = (g: JoinGroup) =>
    t(g === 'baseStation' ? 'map.baseStation' : g === 'layerFiles' ? 'map.layerFiles' : 'map.geoData')

  if (!open) return null

  const pollUntilDone = async (tid: string) => {
    for (let guard = 0; guard < 2400; guard++) {
      await sleep(1500)
      if (cancelledRef.current) return
      let resp
      try {
        resp = await attributeJoinApi.getProgress(tid)
      } catch {
        continue // 网络抖动，下轮再试
      }
      const d = resp?.data
      if (!d) continue
      if (typeof d.progress === 'number') setProgress(d.progress)
      if (d.status === 'completed') {
        setStats(d as AttributeJoinStats)
        setProgress(100)
        setPhase('done')
        return
      }
      if (d.status === 'failed') {
        throw new Error(d.error || t('map.joinFailed') || '条件选择失败')
      }
    }
    throw new Error(t('map.joinTimeout') || '条件选择执行超时')
  }

  const handleExecute = async () => {
    const o1 = l1Options.find((o) => o.key === l1Key)
    const o2 = l2Options.find((o) => o.key === l2Key)
    if (!o1 || !o2) return
    setPhase('running')
    setProgress(2)
    setErrorMsg('')
    setShowNameInput(false)
    try {
      const resp = await attributeJoinApi.plan({
        layer1: o1.ref,
        condition: 'within',
        layer2: o2.ref,
      })
      if (!resp.success || !resp.data?.taskId) {
        throw new Error((resp as any)?.message || t('map.joinStartFailed') || '启动条件选择失败')
      }
      const tid = resp.data.taskId
      setTaskId(tid)
      await pollUntilDone(tid)
    } catch (e: any) {
      if (cancelledRef.current) return
      setErrorMsg(e?.response?.data?.detail || e?.message || t('map.joinFailed') || '条件选择失败')
      setPhase('error')
    }
  }

  const handleAskFilename = () => {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    setFilename(`${t('map.attributeJoin') || '条件选择'}_${stamp}`)
    setShowNameInput(true)
  }

  const confirmDownload = async () => {
    let name = filename.trim()
    if (!name) return
    if (!name.toLowerCase().endsWith('.xlsx')) name += '.xlsx'
    setDownloading(true)
    try {
      const blob = await attributeJoinApi.download(taskId)
      saveBlobAs(blob, name)
      // 下载成功：弹窗保留，仅记录已下载文件名；必须由用户点击"完成/关闭"才退出
      setDownloadedName(name)
      setShowNameInput(false)
    } catch (e: any) {
      setErrorMsg(e?.message || t('map.downloadFailed') || '下载失败')
    } finally {
      setDownloading(false)
    }
  }

  const running = phase === 'running'
  const selectCls =
    'px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary w-full'

  const renderOptions = (opts: JoinOption[]) =>
    JOIN_GROUP_ORDER.map((g) => {
      const items = opts.filter((o) => o.group === g)
      if (items.length === 0) return null
      return (
        <optgroup key={g} label={groupLabel(g)}>
          {items.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )
    })

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/20"
      onClick={running ? undefined : onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[440px] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Filter size={16} className="text-primary" />
            {t('map.attributeJoin') || '条件选择'}
          </div>
          {!running && (
            <button
              className="text-muted-foreground hover:text-foreground transition-colors"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {phase !== 'done' && (
          <>
            {/* 图层1 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.layer1File') || '图层文件1'}
              </label>
              <select
                value={l1Key}
                disabled={running}
                onChange={(e) => setL1Key(e.target.value)}
                className={selectCls}
              >
                <option value="" disabled>
                  {t('map.pleaseSelect') || '请选择'}
                </option>
                {renderOptions(l1Options)}
              </select>
            </div>

            {/* 条件 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.condition') || '条件'}
              </label>
              <select value="within" disabled className={selectCls}>
                <option value="within">{t('map.conditionWithin') || '在...之内'}</option>
              </select>
            </div>

            {/* 图层2 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.layer2File') || '图层文件2'}
              </label>
              <select
                value={l2Key}
                disabled={running}
                onChange={(e) => setL2Key(e.target.value)}
                className={selectCls}
              >
                <option value="" disabled>
                  {t('map.pleaseSelect') || '请选择'}
                </option>
                {renderOptions(l2Options)}
              </select>
            </div>
          </>
        )}

        {/* 执行中：进度 */}
        {phase === 'running' && (
          <div className="flex flex-col gap-2 py-1">
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.min(100, progress)}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              {t('map.executing') || '执行中'} {Math.round(progress)}%
            </div>
          </div>
        )}

        {/* 完成：统计 + 文件名输入 */}
        {phase === 'done' && stats && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                { l: t('map.totalFeatures') || '图层1要素数', v: stats.total1, alert: false },
                { l: t('map.matchedCount') || '在边界内', v: stats.matched, alert: false },
                { l: t('map.unmatchedCount') || '不在边界内', v: stats.unmatched, alert: false },
                { l: t('map.danglingBoundaries') || '无归属边界', v: stats.dangling2, alert: false },
                { l: t('map.skippedCount') || '经纬度缺失', v: stats.skipped1, alert: stats.skipped1 > 0 },
              ].map((s) => (
                <div key={s.l} className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs">
                  <span className={s.alert ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>{s.l}</span>
                  <span className={`font-semibold ${s.alert ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>{s.v}</span>
                </div>
              ))}
            </div>

            {/* 经纬度缺失要素明细（可滚动；提示用户补全坐标） */}
            {stats.skipped1 > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle size={12} />
                  {t('map.missingInfoTitle', { count: stats.skipped1 })}
                </label>
                <div className="max-h-32 overflow-y-auto rounded border border-border divide-y divide-border">
                  {stats.skipped1Details.map((it, idx) => (
                    <div key={`${it.id}-${idx}`} className="flex items-center gap-2 px-2.5 py-1 text-xs">
                      <span className="text-muted-foreground shrink-0">{it.id}</span>
                      <span className="text-foreground truncate">{it.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 下载完成提示：弹窗保留，须用户点击"完成"才退出 */}
            {downloadedName && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Check size={13} />
                {t('map.downloadedHint', { name: downloadedName })}
              </div>
            )}

            {showNameInput && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('map.inputFilename') || '文件名'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={filename}
                    autoFocus
                    onChange={(e) => setFilename(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmDownload() }}
                    className="px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary flex-1"
                  />
                  <button
                    onClick={confirmDownload}
                    disabled={downloading || !filename.trim()}
                    className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1"
                  >
                    {downloading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    {t('common.confirm') || '确认'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 错误 */}
        {phase === 'error' && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 mt-1">
          {phase === 'config' && (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
              >
                {t('common.cancel') || '取消'}
              </button>
              <button
                onClick={handleExecute}
                disabled={!l1Key || !l2Key}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {t('map.execute') || '执行'}
              </button>
            </>
          )}
          {phase === 'error' && (
            <button
              onClick={() => setPhase('config')}
              className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              {t('map.back') || '返回'}
            </button>
          )}
          {phase === 'done' && (
            <>
              {!showNameInput && (
                <button
                  onClick={handleAskFilename}
                  disabled={downloading}
                  className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center gap-1"
                >
                  <Download size={12} />
                  {t('map.download') || '下载'}
                </button>
              )}
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
              >
                {t('map.finish') || '完成'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
