/**
 * 系统设置 - 大模型配置卡片
 * 网优助手 LLM 连接配置：协议、接口地址、API Key（掩码不可见）、模型名、超时。
 * 支持 DeepSeek / 通义千问 / 豆包 / 本地 vLLM·Ollama（均走 OpenAI 兼容协议）。
 */
import { useEffect, useState } from 'react'
import { Bot, Eye, EyeOff, Loader2, Check, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { assistantApi } from '../services/api'

const PRESETS = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '豆包(方舟)', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  { name: '本地 vLLM/Ollama', base_url: 'http://127.0.0.1:8000/v1', model: '' },
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
      setMsg({ ok: true, text: r.configured ? '配置已保存，连接可用' : '已保存，但接口地址/密钥/模型可能不完整' })
    } catch (e: any) {
      setMsg({ ok: false, text: `保存失败：${e?.response?.data?.detail || e.message}` })
    } finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true); setMsg(null)
    try {
      const r = await assistantApi.testLlmConfig()
      setMsg(r.success ? { ok: true, text: `连接成功：${r.reply || 'OK'}` } : { ok: false, text: `连接失败：${r.error}` })
    } catch (e: any) {
      setMsg({ ok: false, text: `测试失败：${e?.response?.data?.detail || e.message}` })
    } finally { setTesting(false) }
  }

  const inputCls = 'w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary'

  return (
    <div className="bg-card p-5 rounded-lg border border-border">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={20} className="text-primary" />
        <h2 className="text-base font-semibold">{t('llm.title', '大模型配置（网优助手）')}</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        {t('llm.desc', '配置网优助手对话所用大模型。支持 OpenAI 兼容协议（DeepSeek/通义千问/豆包/本地 vLLM 等）。')}
      </p>

      {/* 服务商预设 */}
      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((p) => (
          <button key={p.name} onClick={() => { setBaseUrl(p.base_url); if (p.model) setModel(p.model) }}
            className="text-xs px-3 py-1 rounded-full border border-border hover:border-primary hover:text-primary">
            {p.name}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">接口地址 Base URL</label>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">
            API Key {hasKey && <span className="text-green-500">（已配置，留空不修改）</span>}
          </label>
          <div className="relative">
            <input className={inputCls} type={showKey ? 'text' : 'password'} value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '••••••••（已保存，输入新值可替换）' : 'sk-...'} autoComplete="off" />
            <button type="button" onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">模型名称</label>
            <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">超时(秒)</label>
            <input className={inputCls} type="number" min={5} max={300} value={timeout}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)} />
          </div>
        </div>
      </div>

      {msg && (
        <div className={`mt-3 flex items-start gap-1.5 text-xs ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>
          {msg.ok ? <Check size={14} className="mt-0.5" /> : <AlertCircle size={14} className="mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button onClick={save} disabled={saving || !baseUrl || !model}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} 保存配置
        </button>
        <button onClick={test} disabled={testing}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-2 text-sm hover:border-primary disabled:opacity-50">
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />} 测试连接
        </button>
      </div>
    </div>
  )
}
