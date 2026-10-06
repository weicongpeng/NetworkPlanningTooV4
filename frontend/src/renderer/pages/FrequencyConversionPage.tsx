import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RadioTower } from 'lucide-react'
import {
  getLteBandTable, lteConvert, matchNrBand,
  nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq,
  findGscnBandViolation,
} from '../utils/frequencyConversion'
import type { GscnBandViolation } from '../utils/frequencyConversion'

/** NR 换算结果；ok 时附频段可用 GSCN 范围校验（越界才非 null） */
type NrResult =
  | { kind: 'error'; error: string }
  | { kind: 'ok'; freq: number; arfcn: number; gscn: number; band: string | null; deviationKHz: number; violation: GscnBandViolation | null }
  | { kind: 'empty' }

/** 组装 ok 结果：band 由频率匹配，GSCN 越界时附带内最近点 */
function okNrResult(freq: number, arfcn: number, gscn: number, deviationKHz: number): NrResult {
  const band = matchNrBand(freq)?.band ?? null
  return { kind: 'ok', freq, arfcn, gscn, band, deviationKHz, violation: findGscnBandViolation(gscn, band) }
}

export default function FrequencyConversionPage() {
  const { t } = useTranslation()

  // ===== LTE 卡片状态：频段 + 3 输入框（上行频率/下行频率/下行频点号） =====
  const [lteBand, setLteBand] = useState(1)
  const [lteUlFreqInput, setLteUlFreqInput] = useState('')
  const [lteDlFreqInput, setLteDlFreqInput] = useState('')
  const [lteDlEarfcnInput, setLteDlEarfcnInput] = useState('')

  const lteBands = useMemo(() => getLteBandTable(), [])

  type LteResult =
    | { kind: 'error'; error: string }
    | { kind: 'ok'; fUl: number; fDl: number; nDl: number; nUl: number; source: 'ulFreq' | 'dlFreq' | 'dlEarfcn' }
    | { kind: 'empty' }

  /** 任一输入 → lteConvert 一键换算出四量；以最后编辑的输入为基准 */
  const lteResult = useMemo<LteResult>(() => {
    const ulFreq = parseFloat(lteUlFreqInput)
    if (lteUlFreqInput.trim() !== '' && Number.isFinite(ulFreq)) {
      const r = lteConvert(lteBand, { fUl: ulFreq })
      return r === null ? { kind: 'error', error: t('freqConversion.invalid') } : { kind: 'ok', ...r, source: 'ulFreq' }
    }
    const dlFreq = parseFloat(lteDlFreqInput)
    if (lteDlFreqInput.trim() !== '' && Number.isFinite(dlFreq)) {
      const r = lteConvert(lteBand, { fDl: dlFreq })
      return r === null ? { kind: 'error', error: t('freqConversion.invalid') } : { kind: 'ok', ...r, source: 'dlFreq' }
    }
    const nDl = parseInt(lteDlEarfcnInput, 10)
    if (lteDlEarfcnInput.trim() !== '' && Number.isInteger(nDl)) {
      const r = lteConvert(lteBand, { nDl })
      return r === null ? { kind: 'error', error: t('freqConversion.invalid') } : { kind: 'ok', ...r, source: 'dlEarfcn' }
    }
    return { kind: 'empty' }
  }, [lteUlFreqInput, lteDlFreqInput, lteDlEarfcnInput, lteBand, t])

  const clearLteOthers = (keep: 'ulFreq' | 'dlFreq' | 'dlEarfcn') => {
    if (keep !== 'ulFreq') setLteUlFreqInput('')
    if (keep !== 'dlFreq') setLteDlFreqInput('')
    if (keep !== 'dlEarfcn') setLteDlEarfcnInput('')
  }

  // ===== NR 卡片状态：3 输入框（SSB 频率/NR-ARFCN/GSCN） =====
  const [nrFreqInput, setNrFreqInput] = useState('')
  const [nrArfcnInput, setNrArfcnInput] = useState('')
  const [nrGscnInput, setNrGscnInput] = useState('')

  /** 任一输入 → 其余两个实时输出 */
  const nrResult = useMemo<NrResult>(() => {
    const freq = parseFloat(nrFreqInput)
    if (nrFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const arfcn = nrFreqToArfcn(freq)
      if (arfcn === null) return { kind: 'error', error: t('freqConversion.invalid') }
      const g = gsnFreqToGscn(freq)
      if (g === null) return { kind: 'error', error: t('freqConversion.invalid') }
      return okNrResult(freq, arfcn, g.gscn, g.deviationKHz)
    }
    const arfcn = parseInt(nrArfcnInput, 10)
    if (nrArfcnInput.trim() !== '' && Number.isInteger(arfcn)) {
      const f = nrArfcnToFreq(arfcn)
      if (f === null) return { kind: 'error', error: t('freqConversion.invalid') }
      const g = gsnFreqToGscn(f)
      if (g === null) return { kind: 'error', error: t('freqConversion.invalid') }
      return okNrResult(f, arfcn, g.gscn, g.deviationKHz)
    }
    const gscn = parseInt(nrGscnInput, 10)
    if (nrGscnInput.trim() !== '' && Number.isInteger(gscn)) {
      const fr = gsnGscnToFreq(gscn)
      if (fr === null) return { kind: 'error', error: t('freqConversion.invalid') }
      const arfcn = nrFreqToArfcn(fr.freqMhz)
      if (arfcn === null) return { kind: 'error', error: t('freqConversion.invalid') }
      return okNrResult(fr.freqMhz, arfcn, gscn, 0)
    }
    return { kind: 'empty' }
  }, [nrFreqInput, nrArfcnInput, nrGscnInput, t])

  const clearNrOthers = (keep: 'freq' | 'arfcn' | 'gscn') => {
    if (keep !== 'freq') setNrFreqInput('')
    if (keep !== 'arfcn') setNrArfcnInput('')
    if (keep !== 'gscn') setNrGscnInput('')
  }

  // ===== 渲染 =====
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-base font-bold flex items-center gap-2">
          <RadioTower size={20} className="text-indigo-500" />
          {t('freqConversion.title')}
        </h1>
      </div>

      {/* ===== LTE 卡片 ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('freqConversion.lteCard')}</h2>
        <div className="flex gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('freqConversion.band')}</span>
            <select value={lteBand} onChange={e => setLteBand(Number(e.target.value))} className={inputCls + ' w-auto'}>
              {lteBands.map(b => (
                <option key={b.band} value={b.band}>
                  B{b.band} ({b.type}) {b.dlLow}MHz
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.ulFreq')}</span>
            <input
              type="number"
              value={lteUlFreqInput}
              onChange={e => { setLteUlFreqInput(e.target.value); clearLteOthers('ulFreq') }}
              placeholder={t('freqConversion.placeholderUlFreq')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.dlFreq')}</span>
            <input
              type="number"
              value={lteDlFreqInput}
              onChange={e => { setLteDlFreqInput(e.target.value); clearLteOthers('dlFreq') }}
              placeholder={t('freqConversion.placeholderDlFreq')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.dlEarfcn')}</span>
            <input
              type="number"
              value={lteDlEarfcnInput}
              onChange={e => { setLteDlEarfcnInput(e.target.value); clearLteOthers('dlEarfcn') }}
              placeholder={t('freqConversion.placeholderDlEarfcn')}
              className={inputCls + ' mt-1'}
            />
          </label>
        </div>
        {/* LTE 结果区 */}
        <div className="text-sm p-3 rounded-lg bg-muted">
          {lteResult.kind === 'error' ? (
            <span className="text-red-500">{lteResult.error}</span>
          ) : lteResult.kind === 'ok' ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                {t('freqConversion.ulFreqShort')}: <b className="text-primary">{lteResult.fUl}</b> MHz
              </span>
              <span>
                {t('freqConversion.dlFreqShort')}: <b className="text-primary">{lteResult.fDl}</b> MHz
              </span>
              <span>
                {t('freqConversion.nDlShort')}: <b className="text-primary">{lteResult.nDl}</b>
              </span>
              <span>
                {t('freqConversion.nUlShort')}: <b className="text-primary">{lteResult.nUl}</b>
              </span>
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* ===== NR 卡片 ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('freqConversion.nrCard')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.gsnFreq')}</span>
            <input
              type="number"
              value={nrFreqInput}
              onChange={e => { setNrFreqInput(e.target.value); clearNrOthers('freq') }}
              placeholder={t('freqConversion.placeholderGsnFreq')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.arfcn')}</span>
            <input
              type="number"
              value={nrArfcnInput}
              onChange={e => { setNrArfcnInput(e.target.value); clearNrOthers('arfcn') }}
              placeholder={t('freqConversion.placeholderArfcn')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.gsn')}</span>
            <input
              type="number"
              value={nrGscnInput}
              onChange={e => { setNrGscnInput(e.target.value); clearNrOthers('gscn') }}
              placeholder={t('freqConversion.placeholderGscn')}
              className={inputCls + ' mt-1'}
            />
          </label>
        </div>
        {/* NR 结果区 */}
        <div className="text-sm p-3 rounded-lg bg-muted space-y-1">
          {nrResult.kind === 'error' ? (
            <span className="text-red-500">{nrResult.error}</span>
          ) : nrResult.kind === 'ok' ? (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  {t('freqConversion.gsnFreq')}: <b className="text-primary">{nrResult.freq}</b> MHz
                </span>
                <span>
                  {t('freqConversion.resultArfcn')}: <b className="text-primary">{nrResult.arfcn}</b>
                </span>
                <span>
                  {t('freqConversion.resultGscn')}: <b className="text-primary">{nrResult.gscn}</b>
                </span>
              </div>
              {nrResult.deviationKHz > 0 && (
                <div className="text-muted-foreground">
                  {t('freqConversion.actualFreq')}: {nrResult.freq} MHz · {t('freqConversion.deviation')}: {nrResult.deviationKHz} kHz
                </div>
              )}
              <div className="text-muted-foreground">
                {t('freqConversion.inBand')}: {nrResult.band ?? t('freqConversion.inBandNone')}
              </div>
              {nrResult.violation && (
                <div className="text-amber-500">
                  {t('freqConversion.gscnOutOfBand', {
                    gscn: nrResult.gscn,
                    band: nrResult.violation.band,
                    min: nrResult.violation.gscnMin,
                    max: nrResult.violation.gscnMax,
                    nearest: nrResult.violation.nearestInBand,
                    freq: nrResult.violation.nearestInBandFreqMhz,
                  })}
                </div>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>
    </div>
  )
}
