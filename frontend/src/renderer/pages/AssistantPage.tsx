/**
 * 网优助手页面
 * - 对话查基站参数/小区指标/周边站点/全量工参（Function Calling，数值全部来自后端）
 * - 数据导入与管理统一在【数据管理】页完成
 * 只读助手，不提供任何参数修改入口。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Bot, Send, Database, AlertTriangle, Loader2, ArrowRight } from 'lucide-react'
import { assistantApi, type AssistantChart } from '../services/api'
import { ChartRenderer } from './assistant/Charts'

type Msg = { role: 'user' | 'assistant'; content: string; charts?: AssistantChart[] }

const SUGGESTIONS = [
  '查询 GO_N1_河源东源_双田AAU3 1公里内的LTE站点清单',
  '查询某小区 2026-08-01 到 2026-08-13 的掉线率和接通率趋势',
  '查询某小区切换到4G的B2门限配置值',
  '双田AAU3 的经纬度、方位角、PCI、频点是多少',
]

export function AssistantPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    assistantApi.getLlmConfig().then((c) => setConfigured(!!c.configured)).catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || loading) return
    const history = [...messages, { role: 'user' as const, content: q }]
    setMessages(history)
    setInput('')
    setLoading(true)
    try {
      const res = await assistantApi.chat(history)
      if (!res.configured) {
        setMessages((m) => [...m, { role: 'assistant', content: res.message || '大模型未配置' }])
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: res.reply, charts: res.charts }])
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `查询失败：${e?.response?.data?.detail || e.message || '未知错误'}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {/* 模型未配置提示 */}
      {configured === false && (
        <button
          onClick={() => navigate('/license')}
          className="flex items-start gap-2 text-left rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200 hover:border-amber-500"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            网优助手尚未配置大模型。点击前往【系统设置 → 大模型配置】填写接口地址、API Key、模型名称。
          </div>
          <ArrowRight size={16} className="mt-0.5 shrink-0" />
        </button>
      )}

      {/* 数据管理入口 */}
      <button
        onClick={() => navigate('/data')}
        className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm text-gray-600 dark:text-gray-300 hover:border-blue-400"
      >
        <span className="flex items-center gap-2"><Database size={16} /> 基站参数 / 指标 / 工参数据在【数据管理】页导入与管理</span>
        <ArrowRight size={16} />
      </button>

      {/* 对话区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 text-gray-400">
            <Bot size={40} />
            <div className="text-sm">网优助手：用自然语言查询基站参数、小区指标趋势、周边站点、全量工参</div>
            <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}
                  className="text-xs text-left px-3 py-2 rounded-full border border-gray-200 dark:border-gray-700 hover:border-blue-400 hover:text-blue-500">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
              m.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-200'}`}>
              {m.role === 'user' ? <Database size={16} /> : <Bot size={16} />}
            </div>
            <div className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-50 dark:bg-gray-900/50 text-gray-800 dark:text-gray-100'}`}>
              {m.content}
              {m.charts?.map((c, ci) => <ChartRenderer key={ci} chart={c} />)}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-3 items-center text-gray-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> 正在查询数据…
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(input)}
          placeholder={t('assistant.placeholder', '请输入问题，如：双田AAU3 8月1日到13日的掉线率趋势')}
          className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm focus:outline-none focus:border-blue-400"
        />
        <button
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-blue-500 px-5 py-2.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
        >
          <Send size={15} /> 发送
        </button>
      </div>
    </div>
  )
}
