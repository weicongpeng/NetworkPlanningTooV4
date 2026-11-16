/** 桌面共享模式云 WS：许可 auth、事件派发、能力探测超时与降级回轮询。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  desktopLoginApi: { cloudWsConfig: vi.fn() },
}))

import { desktopLoginApi } from '../api'
import {
  IM_CLOUD_WS_ACTIVE_EVENT, IM_CLOUD_WS_FALLBACK_EVENT, imCloudWebSocket,
} from '../imCloudWebSocket'
import {
  IM_MESSAGE_EVENT, IM_PRESENCE_EVENT, IM_RESYNC_EVENT,
} from '../websocketService'

const CONFIG = {
  enabled: true,
  url: 'wss://app.example.test/api/v1/ws/tasks?kind=license',
  license_file: 'signed-license',
  machine_code: 'A1B2-C3D4',
  auth_timeout_ms: 100,
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readonly readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) { this.sent.push(data) }
  close() { this.onclose?.() }
  open() { this.onopen?.() }
  emit(payload: object) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }
}

function listen(event: string): ReturnType<typeof vi.fn> {
  const handler = vi.fn()
  window.addEventListener(event, handler)
  return handler
}

describe('imCloudWebSocket', () => {
  let cleanup: Array<[string, ReturnType<typeof vi.fn>]> = []

  const on = (event: string) => {
    const handler = listen(event)
    cleanup.push([event, handler])
    return handler
  }

  beforeEach(() => {
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    cleanup = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.mocked(desktopLoginApi.cloudWsConfig).mockResolvedValue({ success: true, data: CONFIG } as never)
  })

  afterEach(() => {
    imCloudWebSocket.stop()
    cleanup.forEach(([event, handler]) => window.removeEventListener(event, handler))
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('配置不可用时立即降级回 relay 轮询，不建连接', async () => {
    const fallback = on(IM_CLOUD_WS_FALLBACK_EVENT)
    vi.mocked(desktopLoginApi.cloudWsConfig).mockResolvedValue({
      success: true, data: { enabled: false },
    } as never)
    await imCloudWebSocket.start()
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('许可凭证只放首条 auth 消息，不放 URL', async () => {
    await imCloudWebSocket.start()
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toBe(CONFIG.url)
    expect(ws.url).not.toContain('license_file')
    ws.open()
    const auth = JSON.parse(ws.sent[0])
    expect(auth).toMatchObject({
      type: 'auth', kind: 'license',
      license_file: CONFIG.license_file, machine_code: CONFIG.machine_code,
    })
  })

  it('auth_ok 后停轮询并派发一次重连补偿', async () => {
    const active = on(IM_CLOUD_WS_ACTIVE_EVENT)
    const resync = on(IM_RESYNC_EVENT)
    await imCloudWebSocket.start()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emit({ type: 'auth_ok' })
    expect(active).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('im_message / im_presence 派发既有 window 事件，零改动复用 imStore', async () => {
    const message = on(IM_MESSAGE_EVENT)
    const presence = on(IM_PRESENCE_EVENT)
    await imCloudWebSocket.start()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    ws.emit({ type: 'auth_ok' })
    ws.emit({ type: 'im_message', data: { conversation_id: 7, message_id: 12 } })
    ws.emit({ type: 'im_presence', data: { user_id: 3, online: true } })
    expect(message).toHaveBeenCalledTimes(1)
    expect((message.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ conversation_id: 7 })
    expect(presence).toHaveBeenCalledTimes(1)
  })

  it('鉴权失败或连接关闭时降级回轮询', async () => {
    const fallback = on(IM_CLOUD_WS_FALLBACK_EVENT)
    await imCloudWebSocket.start()
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].emit({ type: 'auth_failed' })
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('旧服务端不回 auth_ok 时按超时降级', async () => {
    vi.useFakeTimers()
    const fallback = on(IM_CLOUD_WS_FALLBACK_EVENT)
    await imCloudWebSocket.start()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    vi.advanceTimersByTime(CONFIG.auth_timeout_ms + 10)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
