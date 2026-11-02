/**
 * 系统设置 - 大模型配置卡片
 * 网优助手 LLM 连接配置：协议、接口地址、API Key（掩码不可见）、模型名、超时。
 * 支持 DeepSeek / 通义千问 / 豆包 / 本地 vLLM·Ollama（均走 OpenAI 兼容协议）。
 * 文案全部走 i18n（zh/en），配色只用主题语义 token。
 */
import { useEffect, useState } from 'react'
import { Bot, Eye, EyeOff, Loader2, Check, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { assistantApi } from '../services/api'

const PRESETS = [
  { key: 'llm.presetDeepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'llm.presetQwen', name: 'Qwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'llm.presetDoubao', name: 'Doubao', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  { key: 'llm.presetLocal', name: 'vLLM/Ollama', base_url: 'http://127.0.0.1:8000/v1', model: '' },
]

export function LLMConfigCard() {
  const { t } = useTranslation()
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [timeout, setTimeoutSec] = useState(60)
  const [showKey, setShowKey] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    assistantApi.getLlmConfig().then((c) => {
      setBaseUrl(c.base_url || '')
      setModel(c.model || '')
      setTimeoutSec(c.timeout || 60)
      setHasKey(!!c.has_api_key)
    }).catch(() => { /* 未登录/未配置时静默 */ })
  }, [])

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const r = await assistantApi.saveLlmConfig({
        protocol: 'openai', base_url: baseUrl.trim(),
        api_key: apiKey, model: model.trim(), timeout,
      })
      setHasKey(true); setApiKey('')
      setMsg({ ok: true, text: r.configured ? t('llm.savedOk') : t('llm.savedIncomplete') })
    } catch (e: any) {
      setMsg({ ok: false, text: t('llm.saveFailed', { error: e?.response?.data?.detail || e.message }) })
    } finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true); setMsg(null)
    try {
      const r = await assistantApi.testLlmConfig()
      setMsg(r.success
        ? { ok: true, text: t('llm.testOk', { reply: r.reply || 'OK' }) }
        : { ok: false, text: t('llm.testFailed', { error: r.error }) })
    } catch (e: any) {
      setMsg({ ok: false, text: t('llm.requestFailed', { error: e?.response?.data?.detail || e.message }) })
    } finally { setTesting(false) }
  }

  const inputCls = 'w-full rounded border border-border bg-background text-foreground px-3 py-2 text-sm focus:outline-none focus:border-primary placeholder:text-muted-foreground'

  return (
    <div className="bg-card p-5 rounded-lg border border-border">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={20} className="text-primary" />
        <h2 className="text-base font-semibold text-foreground">{t('llm.title')}</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">{t('llm.desc')}</p>

      {/* 服务商预设 */}
      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((p) => (
          <button key={p.key} onClick={() => { setBaseUrl(p.base_url); if (p.model) setModel(p.model) }}
            className="text-xs px-3 py-1 rounded-full border border-border text-muted-foreground hover:border-primary hover:text-primary">
            {t(p.key)}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">{t('llm.baseUrl')}</label>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">
            {t('llm.apiKey')} {hasKey && <span className="text-primary">{t('llm.apiKeyConfigured')}</span>}
          </label>
          <div className="relative">
            <input className={inputCls} type={showKey ? 'text' : 'password'} value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? t('llm.apiKeyKeep') : 'sk-...'} autoComplete="off" />
            <button type="button" onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? t('llm.hideKey') : t('llm.showKey')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">{t('llm.model')}</label>
            <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('llm.timeout')}</label>
            <input className={inputCls} type="number" min={5} max={300} value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)} />
          </div>
        </div>
      </div>

      {msg && (
        <div className={`mt-3 flex items-start gap-1.5 text-xs ${msg.ok ? 'text-primary' : 'text-destructive'}`}>
          {msg.ok ? <Check size={14} className="mt-0.5" /> : <AlertCircle size={14} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button onClick={save} disabled={saving || !baseUrl || !model}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('llm.save')}
        </button>
        <button onClick={test} disabled={testing}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-2 text-sm text-foreground hover:border-primary disabled:opacity-50">
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />} {t('llm.test')}
        </button>
      </div>
    </div>
  )
}
