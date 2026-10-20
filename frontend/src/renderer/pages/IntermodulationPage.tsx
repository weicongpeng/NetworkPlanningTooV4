import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import BandInputCard, { type BandState } from '../components/Intermodulation/BandInputCard'
import { IM3_PRESETS, assessIm3Risk, im3CoreCalc } from '../utils/intermodulation'
import type {
  Im3CalcInput,
  Im3CalcSuccess,
  Im3Product,
  Im3RiskLevel,
  Im3RiskResult,
  Im3Type,
} from '../utils/intermodulation'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'

const RISK_BADGE: Record<Im3RiskLevel, string> = {
  none: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  low: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

type ParsedBands =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'ok'; input: Im3CalcInput }

function presetState(id: string): BandState {
  const preset = IM3_PRESETS.find(item => item.id === id)
  return {
    presetId: id,
    customName: '',
    low: preset?.low === null || preset?.low === undefined ? '' : String(preset.low),
    high: preset?.high === null || preset?.high === undefined ? '' : String(preset.high),
  }
}

function ProductBlock({ name, product }: { name: string; product: Im3Product }) {
  const { t } = useTranslation()
  return (
    <div className="text-sm p-3 rounded-lg bg-muted space-y-1">
      <div className="font-medium">
        {name}:{' '}
        <b className="text-primary">
          {product.rangeMin} ~ {product.rangeMax}
        </b>{' '}
        MHz
      </div>
      {!product.overlap.valid ? (
        <div className="text-muted-foreground">{t('im3Evaluation.negativeProduct')}</div>
      ) : product.overlap.hasOverlap ? (
        <div className="text-red-600 dark:text-red-400">
          {t('im3Evaluation.overlapYes', {
            low: product.overlap.low,
            high: product.overlap.high,
            bw: product.overlap.bandwidth,
          })}
        </div>
      ) : (
        <div className="text-muted-foreground">{t('im3Evaluation.overlapNo')}</div>
      )}
    </div>
  )
}

function ResultPanel({ calc, risk }: { calc: Im3CalcSuccess; risk: Im3RiskResult | null }) {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      {calc.singlePoint && (
        <p className="text-xs text-muted-foreground">{t('im3Evaluation.singlePoint')}</p>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t('im3Evaluation.sortedTitle')}
        </h3>
        <div className="text-sm p-3 rounded-lg bg-muted space-y-1">
          <div>
            {t('im3Evaluation.lowSource', {
              tag: t('im3Evaluation.sourceN', { n: calc.sorted.lowSource }),
            })}
            :{' '}
            <b className="text-primary">
              {calc.sorted.low[0]} ~ {calc.sorted.low[1]}
            </b>{' '}
            MHz
          </div>
          <div>
            {t('im3Evaluation.highSource', {
              tag: t('im3Evaluation.sourceN', { n: calc.sorted.highSource }),
            })}
            :{' '}
            <b className="text-primary">
              {calc.sorted.high[0]} ~ {calc.sorted.high[1]}
            </b>{' '}
            MHz
          </div>
          <div>
            {t('im3Evaluation.rxBand')}:{' '}
            <b className="text-primary">
              {calc.sorted.rx[0]} ~ {calc.sorted.rx[1]}
            </b>{' '}
            MHz
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <ProductBlock name={t('im3Evaluation.lowIm3')} product={calc.lowProduct} />
        <ProductBlock name={t('im3Evaluation.highIm3')} product={calc.highProduct} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t('im3Evaluation.judgment')}
        </h3>
        <div
          className={`inline-flex px-2.5 py-1 rounded text-xs font-medium ${
            calc.hasInterference
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {calc.hasInterference
            ? t('im3Evaluation.hasInterference')
            : t('im3Evaluation.noInterference')}
        </div>
      </section>

      {risk && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t('im3Evaluation.riskTitle')}
          </h3>
          <div className="text-sm p-3 rounded-lg bg-muted space-y-2">
            <span
              className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${RISK_BADGE[risk.level]}`}
            >
              {t(`im3Evaluation.risk.${risk.level}`)}
            </span>
            <p>
              {t(`im3Evaluation.reason.${risk.reason}`, {
                bw: calc.totalOverlapBw,
                diff: Math.abs(risk.levelDiffDb),
              })}
            </p>
            <p className="text-muted-foreground">{t(`im3Evaluation.suggestion.${risk.reason}`)}</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-muted-foreground">
              <div>
                {t('im3Evaluation.estimateLevel')}:{' '}
                <b className="text-foreground">{risk.im3LevelDbm} dBm</b>
              </div>
              <div>
                {t('im3Evaluation.noiseFloor')}:{' '}
                <b className="text-foreground">{risk.noiseFloorDbm} dBm</b>
              </div>
              <div>
                {t('im3Evaluation.levelDiff')}:{' '}
                <b className="text-foreground">{risk.levelDiffDb} dB</b>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="text-xs text-muted-foreground space-y-1 border-t border-border pt-3">
        <p>{t('im3Evaluation.standards')}</p>
        <p>{t('im3Evaluation.note1')}</p>
        <p>{t('im3Evaluation.note2')}</p>
        <p>{t('im3Evaluation.note3')}</p>
        <p>{t('im3Evaluation.note4')}</p>
        <p className="text-amber-600 dark:text-amber-400">{t('im3Evaluation.calibration')}</p>
      </section>
    </div>
  )
}

export default function IntermodulationPage() {
  const { t } = useTranslation()

  const [source1, setSource1] = useState<BandState>(() => presetState('1'))
  const [source2, setSource2] = useState<BandState>(() => presetState('3'))
  const [receiver, setReceiver] = useState<BandState>(() => presetState('4'))

  const [imType, setImType] = useState<Im3Type>('pim')
  const [txPower, setTxPower] = useState('43')
  const [isolation, setIsolation] = useState('20')

  const parsed = useMemo<ParsedBands>(() => {
    const raw = [
      source1.low,
      source1.high,
      source2.low,
      source2.high,
      receiver.low,
      receiver.high,
    ]
    if (raw.some(value => value.trim() === '')) return { kind: 'empty' }
    const numbers = raw.map(Number)
    if (numbers.some(value => !Number.isFinite(value) || value <= 0)) {
      return { kind: 'invalid' }
    }
    return {
      kind: 'ok',
      input: {
        band1Low: numbers[0],
        band1High: numbers[1],
        band2Low: numbers[2],
        band2High: numbers[3],
        rxLow: numbers[4],
        rxHigh: numbers[5],
      },
    }
  }, [source1, source2, receiver])

  const calc = useMemo(
    () => (parsed.kind === 'ok' ? im3CoreCalc(parsed.input) : null),
    [parsed],
  )

  const txPowerNum = Number(txPower)
  const isolationNum = Number(isolation)
  const txPowerValid =
    txPower.trim() !== '' && Number.isFinite(txPowerNum) && txPowerNum > 0 && txPowerNum <= 100
  // 隔离度仅对有源互调生效，无源模式下不参与校验
  const isolationValid =
    imType === 'pim' ||
    (isolation.trim() !== '' &&
      Number.isFinite(isolationNum) &&
      isolationNum >= 0 &&
      isolationNum <= 100)
  const paramsValid = txPowerValid && isolationValid

  const risk = useMemo(() => {
    if (!calc?.ok || !paramsValid) return null
    return assessIm3Risk(calc, {
      type: imType,
      txPowerDbm: txPowerNum,
      isolationDb: isolationNum,
    })
  }, [calc, imType, txPowerNum, isolationNum, paramsValid])

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-base font-bold flex items-center gap-2">
          <Waves size={20} className="text-violet-500" />
          {t('im3Evaluation.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('im3Evaluation.subtitle')}</p>
      </div>

      <BandInputCard
        title={t('im3Evaluation.source1')}
        value={source1}
        onChange={setSource1}
      />
      <BandInputCard
        title={t('im3Evaluation.source2')}
        value={source2}
        onChange={setSource2}
      />
      <BandInputCard
        title={t('im3Evaluation.receiver')}
        value={receiver}
        onChange={setReceiver}
      />

      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('im3Evaluation.params')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('im3Evaluation.imType')}</span>
            <select
              value={imType}
              onChange={event => setImType(event.target.value as Im3Type)}
              className={inputCls + ' mt-1'}
            >
              <option value="pim">{t('im3Evaluation.pim')}</option>
              <option value="active">{t('im3Evaluation.active')}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('im3Evaluation.txPower')}</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={txPower}
              onChange={event => setTxPower(event.target.value)}
              className={inputCls + ' mt-1'}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('im3Evaluation.isolation')}</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={isolation}
              disabled={imType === 'pim'}
              onChange={event => setIsolation(event.target.value)}
              className={inputCls + ' mt-1 disabled:opacity-50 disabled:cursor-not-allowed'}
            />
          </label>
        </div>
        {imType === 'pim' && (
          <p className="text-xs text-muted-foreground">{t('im3Evaluation.isolationHint')}</p>
        )}
        {!paramsValid && <p className="text-xs text-red-500">{t('im3Evaluation.invalidParams')}</p>}
      </div>

      <div className="p-6 bg-card rounded-lg border border-border space-y-4">
        <h2 className="text-sm font-semibold">{t('im3Evaluation.result')}</h2>
        {parsed.kind === 'empty' && (
          <p className="text-sm text-muted-foreground">{t('im3Evaluation.emptyHint')}</p>
        )}
        {parsed.kind === 'invalid' && (
          <p className="text-sm text-red-500">{t('im3Evaluation.invalidFreq')}</p>
        )}
        {calc && !calc.ok && <p className="text-sm text-red-500">{t('im3Evaluation.invalidFreq')}</p>}
        {calc?.ok && <ResultPanel calc={calc} risk={risk} />}
      </div>
    </div>
  )
}
