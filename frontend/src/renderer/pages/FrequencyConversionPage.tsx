import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RadioTower } from 'lucide-react'
import {
  getLteBandTable, lteFreqToEarfcn, lteEarfcnToFreq, matchNrBand,
  nrFreqToArfcn, nrArfcnToFreq, gsnFreqToGscn, gsnGscnToFreq,
} from '../utils/frequencyConversion'
import type { LteDirection } from '../utils/frequencyConversion'

export default function FrequencyConversionPage() {
  const { t } = useTranslation()

  // ===== LTE 卡片状态 =====
  const [lteDirection, setLteDirection] = useState<LteDirection>('DL')
  const [lteBand, setLteBand] = useState(1)
  const [lteFreqInput, setLteFreqInput] = useState('')
  const [lteEarfcnInput, setLteEarfcnInput] = useState('')

  const lteBands = useMemo(() => getLteBandTable(), [])

  /** 双向锁定：以最后编辑的输入为基准算另一个 */
  const lteResult = useMemo(() => {
    const freq = parseFloat(lteFreqInput)
    if (lteFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const earfcn = lteFreqToEarfcn(lteBand, freq, lteDirection)
      return earfcn === null ? { error: t('freqConversion.invalid') } : { earfcn }
    }
    const earfcn = parseInt(lteEarfcnInput, 10)
    if (lteEarfcnInput.trim() !== '' && Number.isInteger(earfcn)) {
      const f = lteEarfcnToFreq(lteBand, earfcn, lteDirection)
      return f === null ? { error: t('freqConversion.invalid') } : { freq: f }
    }
    return {}
  }, [lteFreqInput, lteEarfcnInput, lteBand, lteDirection, t])

  const handleLteFreqChange = (v: string) => { setLteFreqInput(v); setLteEarfcnInput('') }
  const handleLteEarfcnChange = (v: string) => { setLteEarfcnInput(v); setLteFreqInput('') }

  // ===== NR 卡片状态 =====
  const [nrFreqInput, setNrFreqInput] = useState('')
  const [nrArfcnInput, setNrArfcnInput] = useState('')
  const [gsnFreqInput, setGsnFreqInput] = useState('')
  const [gsnInput, setGsnInput] = useState('')

  const nrResult = useMemo(() => {
    const freq = parseFloat(nrFreqInput)
    if (nrFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const arfcn = nrFreqToArfcn(freq)
      return arfcn === null ? { error: t('freqConversion.invalid') } : { arfcn, band: matchNrBand(freq) }
    }
    const arfcn = parseInt(nrArfcnInput, 10)
    if (nrArfcnInput.trim() !== '' && Number.isInteger(arfcn)) {
      const f = nrArfcnToFreq(arfcn)
      return f === null ? { error: t('freqConversion.invalid') } : { freq: f, band: matchNrBand(f ?? NaN) }
    }
    return {}
  }, [nrFreqInput, nrArfcnInput, t])

  type GsnResult =
    | { kind: 'error'; error: string }
    | { kind: 'freqToGscn'; gscn: number; actualFreq: number; deviationKHz: number }
    | { kind: 'gscnToFreq'; actualFreq: number }
    | { kind: 'empty' }

  const gsnResult = useMemo<GsnResult>(() => {
    const freq = parseFloat(gsnFreqInput)
    if (gsnFreqInput.trim() !== '' && Number.isFinite(freq)) {
      const r = gsnFreqToGscn(freq)
      return r === null ? { kind: 'error', error: t('freqConversion.invalid') } : { kind: 'freqToGscn', ...r }
    }
    const gscn = parseInt(gsnInput, 10)
    if (gsnInput.trim() !== '' && Number.isInteger(gscn)) {
      const r = gsnGscnToFreq(gscn)
      return r === null ? { kind: 'error', error: t('freqConversion.invalid') } : { kind: 'gscnToFreq', actualFreq: r.freqMhz }
    }
    return { kind: 'empty' }
  }, [gsnFreqInput, gsnInput, t])

  // ===== 渲染 =====
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-base font-bold flex items-center gap-2">
          <RadioTower size={20} className="text-indigo-500" />
          {t('freqConversion.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('freqConversion.subtitle')}</p>
      </div>

      {/* ===== LTE 卡片 ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('freqConversion.lteCard')}</h2>
        <div className="flex gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('freqConversion.direction')}</span>
            <select
              value={lteDirection}
              onChange={e => setLteDirection(e.target.value as LteDirection)}
              className={inputCls + ' w-auto'}
            >
              <option value="DL">{t('freqConversion.dl')}</option>
              <option value="UL">{t('freqConversion.ul')}</option>
            </select>
          </label>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.freq')}</span>
            <input
              type="number"
              value={lteFreqInput}
              onChange={e => handleLteFreqChange(e.target.value)}
              placeholder={t('freqConversion.placeholderFreq')}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('freqConversion.earfcn')}</span>
            <input
              type="number"
              value={lteEarfcnInput}
              onChange={e => handleLteEarfcnChange(e.target.value)}
              placeholder={t('freqConversion.placeholderEarfcn')}
              className={inputCls + ' mt-1'}
            />
          </label>
        </div>
        {/* 结果 */}
        <div className="text-sm p-3 rounded-lg bg-muted">
          {'error' in lteResult ? (
            <span className="text-red-500">{lteResult.error}</span>
          ) : lteResult.earfcn !== undefined ? (
            <span>
              {t('freqConversion.resultEarfcn')} = <b className="text-primary">{lteResult.earfcn}</b>
            </span>
          ) : lteResult.freq !== undefined ? (
            <span>
              {t('freqConversion.resultFreq')} = <b className="text-primary">{lteResult.freq}</b> MHz
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* ===== NR 卡片（含 GSCN 子区） ===== */}
      <div className="p-6 bg-card rounded-lg border border-border space-y-6">
        <h2 className="text-sm font-semibold">{t('freqConversion.nrCard')}</h2>
        {/* ARFCN 换算区 */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.freq')}</span>
              <input
                type="number"
                value={nrFreqInput}
                onChange={e => { setNrFreqInput(e.target.value); setNrArfcnInput('') }}
                placeholder={t('freqConversion.placeholderFreq')}
                className={inputCls + ' mt-1'}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.arfcn')}</span>
              <input
                type="number"
                value={nrArfcnInput}
                onChange={e => { setNrArfcnInput(e.target.value); setNrFreqInput('') }}
                placeholder={t('freqConversion.placeholderArfcn')}
                className={inputCls + ' mt-1'}
              />
            </label>
          </div>
          <div className="text-sm p-3 rounded-lg bg-muted">
            {'error' in nrResult ? (
              <span className="text-red-500">{nrResult.error}</span>
            ) : nrResult.arfcn !== undefined ? (
              <span>
                {t('freqConversion.resultArfcn')} = <b className="text-primary">{nrResult.arfcn}</b>
                {nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBand')}: {nrResult.band.band})</span>}
                {!nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBandNone')})</span>}
              </span>
            ) : nrResult.freq !== undefined ? (
              <span>
                {t('freqConversion.resultFreq')} = <b className="text-primary">{nrResult.freq}</b> MHz
                {nrResult.band && <span className="ml-2 text-muted-foreground">({t('freqConversion.inBand')}: {nrResult.band.band})</span>}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>
        {/* GSCN 子区 */}
        <div className="border-t border-border pt-4 space-y-4">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('freqConversion.gsnSub')}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.gsnFreq')}</span>
              <input
                type="number"
                value={gsnFreqInput}
                onChange={e => { setGsnFreqInput(e.target.value); setGsnInput('') }}
                placeholder={t('freqConversion.placeholderGsnFreq')}
                className={inputCls + ' mt-1'}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">{t('freqConversion.gsn')}</span>
              <input
                type="number"
                value={gsnInput}
                onChange={e => { setGsnInput(e.target.value); setGsnFreqInput('') }}
                placeholder={t('freqConversion.placeholderGscn')}
                className={inputCls + ' mt-1'}
              />
            </label>
          </div>
          <div className="text-sm p-3 rounded-lg bg-muted space-y-1">
            {gsnResult.kind === 'error' ? (
              <span className="text-red-500">{gsnResult.error}</span>
            ) : gsnResult.kind === 'freqToGscn' ? (
              <>
                <div>
                  {t('freqConversion.resultGscn')} = <b className="text-primary">{gsnResult.gscn}</b>
                </div>
                <div className="text-muted-foreground">
                  {t('freqConversion.actualFreq')}: {gsnResult.actualFreq} MHz · {t('freqConversion.deviation')}: {gsnResult.deviationKHz} kHz
                </div>
              </>
            ) : gsnResult.kind === 'gscnToFreq' ? (
              <div>
                {t('freqConversion.resultFreq')} = <b className="text-primary">{gsnResult.actualFreq}</b> MHz
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            <p className="text-xs text-muted-foreground">{t('freqConversion.gsnHint')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
