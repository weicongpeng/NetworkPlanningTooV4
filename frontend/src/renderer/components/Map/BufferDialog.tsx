/**
 * 绘制缓冲区弹窗
 *
 * 参考图层（点/线/面任意）按米制半径生成测地线缓冲多边形，直接保存到装饰图层
 * （前端 localStorage）或已有 TAB 图层。支持每要素单独缓冲 / 所有要素合并缓冲。
 * 执行中弹窗不可关闭（遮罩 / X / Esc 均被拦截），完成或失败后才可操作。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, AlertTriangle, Check, Loader2, CircleDashed } from 'lucide-react'
import { bufferApi } from '../../services/api'
import { useMapStore } from '../../store/mapStore'
import {
  useLayerEditStore,
  DECORATION_LAYER_ID,
  DECORATION_DATA_ID,
} from '../../store/layerEditStore'
import type { BufferStats } from '@shared/types'
import type { SectorLayerOption, LayerFileOption } from './LayerControl'
import { buildLayer1Options, JOIN_GROUP_ORDER, type JoinGroup } from './attributeJoinOptions'
import { buildBufferTargetOptions } from './bufferOptions'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Props {
  open: boolean
  onClose: () => void
  layers: SectorLayerOption[]
  layerFiles: LayerFileOption[]
  pointFiles: LayerFileOption[]
  /** target=mapinfo 保存成功后回调，由 MapPage 刷新图层 */
  onSaved?: (layerId: string) => void
}

type Phase = 'config' | 'running' | 'done' | 'error'

export default function BufferDialog(
  { open, onClose, layers, layerFiles, pointFiles, onSaved }: Props,
) {
  const { t } = useTranslation()

  const sourceOptions = useMemo(
    () => buildLayer1Options(layers, layerFiles, pointFiles),
    [layers, layerFiles, pointFiles],
  )
  const targetOptions = useMemo(() => buildBufferTargetOptions(layerFiles), [layerFiles])

  const [sourceKey, setSourceKey] = useState('')
  const [targetKey, setTargetKey] = useState('')
  const [radius, setRadius] = useState('500')
  const [segments, setSegments] = useState('12')
  const [mode, setMode] = useState<'each' | 'dissolve'>('dissolve')
  const [phase, setPhase] = useState<Phase>('config')
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [stats, setStats] = useState<BufferStats | null>(null)

  const cancelledRef = useRef(false)
  /** done 后落图形只执行一次（StrictMode 双渲染 / 重渲染不能重复追加） */
  const handledRef = useRef(false)

  // 打开时重置
  useEffect(() => {
    if (open) {
      cancelledRef.current = false
      handledRef.current = false
      setSourceKey('')
      setTargetKey('')
      setRadius('500')
      setSegments('12')
      setMode('each')
      setPhase('config')
      setProgress(0)
      setErrorMsg('')
      setStats(null)
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

  // 完成后落图形（Effect 触发，仅一次）：装饰目标前端写入，mapinfo 目标通知 MapPage 刷新
  useEffect(() => {
    if (phase !== 'done' || !stats || handledRef.current) return
    handledRef.current = true
    try {
      if (stats.savedTo === 'decoration') {
        const store = useLayerEditStore.getState()
        if (!store.getWorkspace(DECORATION_LAYER_ID)) {
          store.seedWorkspace(
            DECORATION_LAYER_ID, DECORATION_DATA_ID, 'mixed',
            useMapStore.getState().decorationFeatures ?? [], null,
          )
        }
        store.addFeatures(
          DECORATION_LAYER_ID,
          (stats.features ?? []).map((f) => ({ geometry: f.geometry, properties: f.properties })),
        )
      } else if (stats.savedTo === 'mapinfo' && stats.layerId) {
        onSaved?.(stats.layerId)
      }
    } catch (e: any) {
      // 存储失败（如配额超限）不得冒泡导致白屏：转错误态，提示改用 TAB 图层
      handledRef.current = false
      setErrorMsg(
        e?.message === 'QuotaExceededError'
          ? (t('map.bufferStorageQuota') || '装饰图层存储空间不足，请将保存目标改为 TAB 图层')
          : (e?.message || t('map.bufferFailed') || '缓冲区生成失败'),
      )
      setPhase('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stats])

  const groupLabel = (g: JoinGroup) =>
    t(g === 'baseStation' ? 'map.baseStation' : g === 'layerFiles' ? 'map.layerFiles' : 'map.geoData')

  if (!open) return null

  const radiusNum = parseFloat(radius)
  const segmentsNum = parseInt(segments, 10)
  const canExecute =
    !!sourceKey && !!targetKey && radiusNum > 0 &&
    Number.isFinite(segmentsNum) && segmentsNum >= 4 && segmentsNum <= 360

  const pollUntilDone = async (tid: string) => {
    for (let guard = 0; guard < 2400; guard++) {
      await sleep(1500)
      if (cancelledRef.current) return
      let resp
      try {
        resp = await bufferApi.getProgress(tid)
      } catch {
        continue // 网络抖动，下轮再试
      }
      const d = resp?.data
      if (!d) continue
      if (typeof d.progress === 'number') setProgress(d.progress)
      if (d.status === 'completed') {
        setStats(d as BufferStats)
        setProgress(100)
        setPhase('done')
        return
      }
      if (d.status === 'failed') {
        throw new Error(d.error || t('map.bufferFailed') || '缓冲区生成失败')
      }
    }
    throw new Error(t('map.bufferTimeout') || '缓冲区执行超时')
  }

  const handleExecute = async () => {
    const source = sourceOptions.find((o) => o.key === sourceKey)
    const target = targetOptions.find((o) => o.key === targetKey)
    if (!source || !target || !canExecute) return
    setPhase('running')
    setProgress(2)
    setErrorMsg('')
    try {
      const resp = await bufferApi.plan({
        source: source.ref,
        target: target.ref,
        radius: radiusNum,
        segments: segmentsNum,
        mode,
      })
      if (!resp.success || !resp.data?.taskId) {
        throw new Error((resp as any)?.message || t('map.bufferStartFailed') || '启动缓冲区任务失败')
      }
      await pollUntilDone(resp.data.taskId)
    } catch (e: any) {
      if (cancelledRef.current) return
      setErrorMsg(e?.response?.data?.detail || e?.message || t('map.bufferFailed') || '缓冲区生成失败')
      setPhase('error')
    }
  }

  const running = phase === 'running'
  const selectCls =
    'px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary w-full'
  const inputCls =
    'px-2.5 py-1.5 text-xs rounded border border-border bg-background text-foreground outline-none focus:border-primary w-full'

  const renderSourceOptions = () =>
    JOIN_GROUP_ORDER.map((g) => {
      const items = sourceOptions.filter((o) => o.group === g)
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
        className="bg-card border border-border rounded-lg shadow-lg p-5 w-[460px] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CircleDashed size={16} className="text-primary" />
            {t('map.drawBuffer') || '绘制缓冲区'}
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
            {/* 参考图层 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.bufferSourceLayer') || '参考图层'}
              </label>
              <select
                value={sourceKey}
                disabled={running}
                onChange={(e) => setSourceKey(e.target.value)}
                className={selectCls}
              >
                <option value="" disabled>
                  {t('map.pleaseSelect') || '请选择'}
                </option>
                {renderSourceOptions()}
              </select>
            </div>

            {/* 保存到图层 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.bufferTargetLayer') || '保存到图层'}
              </label>
              <select
                value={targetKey}
                disabled={running}
                onChange={(e) => setTargetKey(e.target.value)}
                className={selectCls}
              >
                <option value="" disabled>
                  {t('map.pleaseSelect') || '请选择'}
                </option>
                {targetOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 参数：半径 / 平滑度 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('map.bufferRadius') || '缓冲半径（米）'}
                </label>
                <input
                  type="number"
                  min="0.1"
                  value={radius}
                  disabled={running}
                  onChange={(e) => setRadius(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('map.bufferSegments') || '平滑度（每圈段数）'}
                </label>
                <input
                  type="number"
                  min={4}
                  max={360}
                  value={segments}
                  disabled={running}
                  onChange={(e) => setSegments(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground -mt-2">
              {t('map.bufferSegmentsHint') || '段数取 4 的倍数（实际段数就近取整），越大越圆滑'}
            </div>

            {/* 缓冲方式 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">
                {t('map.bufferMode') || '缓冲方式'}
              </label>
              <div className="flex gap-4">
                {(
                  [
                    ['each', t('map.bufferModeEach') || '每个要素缓冲（每要素一个结果）'],
                    ['dissolve', t('map.bufferModeDissolve') || '合并所有要素缓冲（一个结果）'],
                  ] as const
                ).map(([val, label]) => (
                  <label key={val} className="flex items-center gap-1.5 text-xs text-foreground">
                    <input
                      type="radio"
                      checked={mode === val}
                      disabled={running}
                      onChange={() => setMode(val)}
                    />
                    {label}
                  </label>
                ))}
              </div>
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

        {/* 完成：统计 */}
        {phase === 'done' && stats && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                { l: t('map.bufferInputCount') || '参考有效要素数', v: stats.inputCount },
                { l: t('map.bufferResultCount') || '缓冲多边形数', v: stats.resultCount },
                {
                  l: t('map.skippedCount') || '跳过要素数',
                  v: stats.skippedCount,
                  alert: stats.skippedCount > 0,
                },
              ].map((s) => (
                <div
                  key={s.l}
                  className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs"
                >
                  <span className="text-muted-foreground">{s.l}</span>
                  <span
                    className={`font-semibold ${s.alert ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}
                  >
                    {s.v}
                  </span>
                </div>
              ))}
            </div>

            {/* 跳过要素明细 */}
            {stats.skippedCount > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle size={12} />
                  {t('map.missingInfoTitle', { count: stats.skippedCount })}
                </label>
                <div className="max-h-32 overflow-y-auto rounded border border-border divide-y divide-border">
                  {stats.skippedDetails.map((it, idx) => (
                    <div key={`${it.id}-${idx}`} className="flex items-center gap-2 px-2.5 py-1 text-xs">
                      <span className="text-muted-foreground shrink-0">{it.id}</span>
                      <span className="text-foreground truncate">{it.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <Check size={13} />
              {stats.savedTo === 'decoration'
                ? (t('map.bufferSavedDecoration') || '缓冲图形已保存到装饰图层')
                : (t('map.bufferSavedMapinfo') || '缓冲图形已保存到目标图层')}
            </div>
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
                disabled={!canExecute}
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
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              {t('map.finish') || '完成'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
