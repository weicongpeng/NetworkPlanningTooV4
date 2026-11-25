/**
 * 桌面共享模式专用：直连云端 /api/v1/ws/tasks 的轻量 IM 推送客户端。
 *
 * 为什么不复用 WebSocketService 单例：它按 window.location.host 拼 URL、auth 消息
 * 只接受 JWT、2 次重连后永久降级，且两条连接各自 onopen 会重复派发 IM_RESYNC_EVENT。
 * 本客户端只负责「鉴权 → 派发既有 window 事件」，刷新逻辑完全复用
 * attachImEvents → imStore.handleImMessage / resync，零改动接入现有链路。
 *
 * 桌面端没有云端 JWT（本机 token 的 sub 是本机 users.id，直接用于云端会匿名或串号），
 * 因此云端 WS 新增了「签名许可 + 机器码」auth 分支；凭证只经本机端点下发，
 * 放在首条 auth 消息里，绝不进 URL / 访问日志。
 */
import { desktopLoginApi } from './api'
import type { DesktopCloudWsConfig } from './api'
import {
  IM_MESSAGE_EVENT, IM_PRESENCE_EVENT, IM_RECALL_EVENT, IM_RESYNC_EVENT,
} from './websocketService'

/** 云 WS 不可用（未激活 / 旧服务端 / 鉴权失败 / Tunnel 抖动）→ 恢复 relay 轮询 */
export const IM_CLOUD_WS_FALLBACK_EVENT = 'npt:im-cloud-ws-fallback'
/** 云 WS 鉴权成功 → 停掉 relay 轮询 */
export const IM_CLOUD_WS_ACTIVE_EVENT = 'npt:im-cloud-ws-active'

const DEFAULT_AUTH_TIMEOUT_MS = 8000
const DEFAULT_REAUTH_INTERVAL_MS = 300000
const HEARTBEAT_MS = 30000
const LICENSE_CHECK_MS = 60000
const MAX_RETRY_DELAY_MS = 30000

type ActiveConfig = DesktopCloudWsConfig & {
  enabled: true
  url: string
  license_file: string
  machine_code: string
}

class ImCloudWebSocketClient {
  private ws: WebSocket | null = null
  private config: ActiveConfig | null = null
  private stopped = true
  private authed = false
  private retry = 0
  private startToken = 0
  private lastAuthAt = 0
  private fallbackNotified = false
  private retryTimer: number | null = null
  private authTimer: number | null = null
  private heartbeatTimer: number | null = null
  private licenseCheckTimer: number | null = null

  /** 只在桌面共享模式调用；配置不可用时立即降级，不阻塞 UI */
  async start(): Promise<void> {
    const token = ++this.startToken
    let cfg: DesktopCloudWsConfig
    try {
      const response = await desktopLoginApi.cloudWsConfig()
      cfg = response?.data ?? { enabled: false }
    } catch { /* 本机端点不可用 / 非桌面壳 */ cfg = { enabled: false } }
    if (token !== this.startToken) return

    this.stopped = false
    if (!cfg.enabled || !cfg.url || !cfg.license_file || !cfg.machine_code) {
      // 本机端点瞬时不可用 / Tunnel 抖动时不能永久停在降级态：退避重试，
      // 否则要等退出桌面端重启才能重新鉴权、广播在线。
      this.notifyFallback()
      this.scheduleRetry()
      return
    }
    this.config = cfg as ActiveConfig
    this.clearTimers()
    if (this.ws) { try { this.ws.close() } catch { /* 已关闭 */ } this.ws = null }
    this.open()
    this.startLicenseCheck()
  }

  stop(): void {
    this.startToken += 1
    this.stopped = true
    this.clearTimers()
    if (this.ws) {
      try { this.ws.close() } catch { /* 已关闭 */ }
      this.ws = null
    }
    this.authed = false
    this.config = null
    this.fallbackNotified = false
  }

  /** 许可续期或云 WS 配置变化后强制重连重鉴权，避免旧身份常驻 */
  forceReconnect(): void {
    if (this.stopped) return
    void this.start()
  }

  private open(): void {
    if (this.stopped || !this.config) return
    const cfg = this.config
    let ws: WebSocket
    try {
      ws = new WebSocket(cfg.url)
    } catch {
      this.notifyFallback()
      this.scheduleRetry()
      return
    }
    this.ws = ws
    this.authed = false

    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) return
      // 首条消息带许可凭证；不放 URL，避免进 Cloudflare / 访问日志
      try {
        ws.send(JSON.stringify({
          type: 'auth', kind: 'license',
          license_file: cfg.license_file, machine_code: cfg.machine_code,
        }))
      } catch {
        this.notifyFallback()
        return
      }
      if (this.authTimer !== null) window.clearTimeout(this.authTimer)
      this.authTimer = window.setTimeout(() => {
        if (!this.authed) {
          // 旧服务端不认识许可 auth 会静默匿名：超时即降级回轮询
          this.notifyFallback()
          try { ws.close() } catch { /* 已关闭 */ }
        }
      }, cfg.auth_timeout_ms || DEFAULT_AUTH_TIMEOUT_MS)
      this.startHeartbeat(ws)
    }

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || this.stopped) return
      let payload: { type?: string; data?: unknown }
      try { payload = JSON.parse(String(event.data)) } catch { return }
      switch (payload.type) {
        case 'auth_ok':
          this.authed = true
          this.lastAuthAt = Date.now()
          this.retry = 0
          this.fallbackNotified = false
          if (this.authTimer !== null) { window.clearTimeout(this.authTimer); this.authTimer = null }
          window.dispatchEvent(new CustomEvent(IM_CLOUD_WS_ACTIVE_EVENT))
          // 每次重连补偿一次：复用既有 resync 的 after_id 游标链路
          window.dispatchEvent(new CustomEvent(IM_RESYNC_EVENT))
          break
        case 'auth_failed':
          this.notifyFallback()
          try { ws.close() } catch { /* 已关闭 */ }
          break
        case 'im_message':
          window.dispatchEvent(new CustomEvent(IM_MESSAGE_EVENT, { detail: payload.data || {} }))
          break
        case 'im_recall':
          window.dispatchEvent(new CustomEvent(IM_RECALL_EVENT, { detail: payload.data || {} }))
          break
        case 'im_presence':
          window.dispatchEvent(new CustomEvent(IM_PRESENCE_EVENT, { detail: payload.data || {} }))
          break
        default:
          break // pong / 任务进度等与本客户端无关
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.authed = false
      this.clearConnectionTimers()
      this.notifyFallback()
      if (!this.stopped) this.scheduleRetry()
    }
    ws.onerror = () => { /* onclose 随后触发，统一在那里降级与重连 */ }
  }

  private startHeartbeat(ws: WebSocket): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* 连接已断 */ }
      }
    }, HEARTBEAT_MS)
  }

  /** 许可续期会换掉许可文件：定期比对指纹并强制周期性重鉴权 */
  private startLicenseCheck(): void {
    if (this.licenseCheckTimer !== null) return
    this.licenseCheckTimer = window.setInterval(() => {
      void this.checkLicenseRotation()
    }, LICENSE_CHECK_MS)
  }

  private async checkLicenseRotation(): Promise<void> {
    if (this.stopped || !this.config) return
    try {
      const response = await desktopLoginApi.cloudWsConfig()
      const next = response?.data
      if (!next?.enabled) { this.notifyFallback(); return }
      if (next.license_fingerprint
          && next.license_fingerprint !== this.config.license_fingerprint) {
        this.forceReconnect()
        return
      }
    } catch { /* 本机后端短暂不可用：保留现有连接，别误降级 */ }
    const interval = this.config.reauth_interval_ms || DEFAULT_REAUTH_INTERVAL_MS
    if (this.authed && Date.now() - this.lastAuthAt > interval) this.forceReconnect()
  }

  private notifyFallback(): void {
    if (this.fallbackNotified) return
    this.fallbackNotified = true
    window.dispatchEvent(new CustomEvent(IM_CLOUD_WS_FALLBACK_EVENT))
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retry += 1
    const delay = Math.min(500 * 2 ** Math.min(this.retry, 5), MAX_RETRY_DELAY_MS)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private clearConnectionTimers(): void {
    if (this.authTimer !== null) { window.clearTimeout(this.authTimer); this.authTimer = null }
    if (this.heartbeatTimer !== null) { window.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  private clearTimers(): void {
    this.clearConnectionTimers()
    if (this.retryTimer !== null) { window.clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.licenseCheckTimer !== null) {
      window.clearInterval(this.licenseCheckTimer)
      this.licenseCheckTimer = null
    }
  }
}

export const imCloudWebSocket = new ImCloudWebSocketClient()
