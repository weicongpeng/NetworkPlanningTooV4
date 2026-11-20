/**
 * 网优助手页面
 * - 对话查基站参数/小区指标/周边站点/全量工参（Function Calling，数值全部来自后端）
 * - 每条回答带「图表 / 明细表 / 取数配方」三段，图上数字与明细同源、可核对
 * - 数据导入与管理统一在【数据管理】页完成；只读助手，不提供参数修改入口
 * - 配色一律用主题语义 token（项目主题只切 CSS 变量、不加 .dark 类，dark: 变体不生效）
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Bot, Send, Database, AlertTriangle, Loader2, ArrowRight, Table2, Receipt } from 'lucide-react'
import { assistantApi, type AssistantArtifact, type AssistantProvenance } from '../services/api'
import { ChartRenderer } from './assistant/Charts'

type Msg = { role: 'user' | 'assistant'; content: string; artifacts?: AssistantArtifact[] }

export function AssistantPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const suggestions = t('assistant.suggestions', { returnObjects: true }) as unknown as string[]

  useEffect(() => {
    assistantApi.getLlmConfig().then((c) => setConfigured(!!c.configured)).catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || loading) return
    const history: Msg[] = [...messages, { role: 'user', content: q }]
    setMessages(history)
    setInput('')
    setLoading(true)
    try {
      const res = await assistantApi.chat(history.map((m) => ({ role: m.role, content: m.content })))
      if (!res.configured) {
        setMessages((m) => [...m, { role: 'assistant', content: res.message || t('assistant.notConfiguredShort') }])
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: res.reply, artifacts: res.artifacts }])
      }
    } catch (e: any) {
      setMessages((m) => [...m, {
        role: 'assistant',
        content: `${t('assistant.errorPrefix')}：${e?.response?.data?.detail || e.message || t('assistant.unknownError')}`,
      }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {configured === false && (
        <button
          onClick={() => navigate('/license')}
          className="flex items-start gap-2 text-left rounded-lg px-3 py-2 border border-amber-500/20 bg-amber-500/10 text-sm text-warning-foreground hover:border-amber-500/50"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="flex-1">{t('assistant.notConfigured')}</div>
          <ArrowRight size={16} className="mt-0.5 shrink-0" />
        </button>
      )}

      <button
        onClick={() => navigate('/data')}
        className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground hover:border-primary hover:text-foreground"
      >
        <span className="flex items-center gap-2"><Database size={16} /> {t('assistant.dataHint')}</span>
        <ArrowRight size={16} />
      </button>

      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-border bg-card p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 text-muted-foreground">
            <Bot size={40} />
            <div className="text-sm max-w-2xl">{t('assistant.emptyHint')}</div>
            <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
              {(Array.isArray(suggestions) ? suggestions : []).map((s) => (
                <button key={s} onClick={() => send(s)}
                  className="text-xs text-left px-3 py-2 rounded-full border border-border hover:border-primary hover:text-primary">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
              m.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground'}`}>
              {m.role === 'user' ? <Database size={16} /> : <Bot size={16} />}
            </div>
            <div className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-foreground'}`}>
              {m.content}
              {m.artifacts?.map((a, ai) => <ArtifactView key={ai} artifact={a} />)}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-3 items-center text-muted-foreground text-sm">
            <Loader2 size={16} className="animate-spin" /> {t('assistant.loading')}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(input)}
          placeholder={t('assistant.placeholder')}
          className="flex-1 rounded-lg border border-border bg-background text-foreground px-4 py-2.5 text-sm focus:outline-none focus:border-primary placeholder:text-muted-foreground"
        />
        <button
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-5 py-2.5 text-sm hover:opacity-90 disabled:opacity-50"
        >
          <Send size={15} /> {t('assistant.send')}
        </button>
      </div>
    </div>
  )
}

function ArtifactView({ artifact }: { artifact: AssistantArtifact }) {
  const { t } = useTranslation()
  const [showTable, setShowTable] = useState(false)
  const [showRecipe, setShowRecipe] = useState(false)
  const charts = artifact.charts || []
  const table = artifact.table
  const prov = artifact.provenance
  const hasPanel = (table?.rows?.length || 0) > 0 || !!prov

  return (
    <div className="mt-2 space-y-2">
      {charts.map((c, i) => <ChartRenderer key={i} chart={c} />)}

      {hasPanel && (
        <div className="flex flex-wrap gap-2 text-xs">
          {!!table?.rows?.length && (
            <button onClick={() => setShowTable((v) => !v)}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-primary">
              <Table2 size={13} /> {t('assistant.details')}（{prov?.row_count ?? table.rows.length}）
            </button>
          )}
          {!!prov && (
            <button onClick={() => setShowRecipe((v) => !v)}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-muted-foreground hover:border-primary hover:text-primary">
              <Receipt size={13} /> {t('assistant.recipe')}
            </button>
          )}
        </div>
      )}

      {showTable && table && (
        <div className="max-h-72 overflow-auto rounded border border-border">
          <table className="min-w-full text-xs npt-resizable">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri} className="border-t border-border">
                  {table.columns.map((c) => (
                    <td key={c} className="px-2 py-1 whitespace-nowrap text-foreground">{formatCell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRecipe && prov && <RecipePanel prov={prov} />}
    </div>
  )
}

function RecipePanel({ prov }: { prov: AssistantProvenance }) {
  const { t } = useTranslation()
  const timeText = prov.time_range?.start || prov.time_range?.end
    ? `${prov.time_range?.start || '—'} ~ ${prov.time_range?.end || '—'}`
    : t('assistant.allTime')
  return (
    <div className="rounded border border-border bg-card p-2.5 text-[11px] leading-5 text-muted-foreground space-y-0.5">
      <div><span className="opacity-70">{t('assistant.dataset')}：</span>{prov.dataset_label}</div>
      <div><span className="opacity-70">{t('assistant.timeRange')}：</span>{timeText}{prov.granularity ? ` · ${prov.granularity}` : ''}</div>
      {!!prov.dimensions?.length && (
        <div><span className="opacity-70">{t('assistant.groupBy')}：</span>{prov.dimensions.join('、')}</div>
      )}
      {!!prov.filters?.length && (
        <div><span className="opacity-70">{t('assistant.filters')}：</span>
          {prov.filters.map((f) => `${f.field} ${f.op} ${Array.isArray(f.value) ? f.value.join(',') : f.value ?? ''}`).join('；')}
        </div>
      )}
      <div><span className="opacity-70">{t('assistant.aggregation')}：</span>
        {prov.metrics.map((m) => `${m.metric}=${m.aggregation}${m.unit ? `(${m.unit})` : ''}`).join('；') || '—'}
      </div>
      <div><span className="opacity-70">{t('assistant.performance')}：</span>
        {t('assistant.rowsCount', { count: prov.row_count })} · {prov.elapsed_ms}ms · limit {prov.limit}
      </div>
      {!!prov.degraded?.length && (
        <div className="text-warning-foreground">{t('assistant.degraded')}：{prov.degraded.join('；')}</div>
      )}
      {prov.metrics.some((m) => m.source) && (
        <div className="opacity-70">{t('assistant.source')}：{prov.metrics.map((m) => m.source).filter(Boolean).join('；')}</div>
      )}
    </div>
  )
}

function formatCell(v: any): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000)
  }
  return String(v)
}
