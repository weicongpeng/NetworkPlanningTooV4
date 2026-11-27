/** IM 实时通知：复用 /api/v1/ws/tasks，只接收轻通知，正文一律 REST 补拉。 */
import { getEffectiveApiBaseUrl } from '../utils/config';

export interface ImWsHandlers {
  onMessage: (data: { conversation_id: number; message_id: number; sender_id: number }) => void
  onRecall: (data: { conversation_id: number; message_id: number }) => void
  onPresence: (data: { user_id: number; online: boolean }) => void
  onResync: () => void
  onStatus: (connected: boolean) => void
}

const HEARTBEAT_MS = 25_000;
const RECONNECT_DELAYS = [1200, 3500];

class ImWebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: ImWsHandlers | null = null;
  private token: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectIndex = 0;
  private connecting = false;
  private stopped = true;
  private fallback = false;

  configure(handlers: ImWsHandlers): void {
    this.handlers = handlers;
  }

  async start(token: string): Promise<void> {
    this.stopped = false;
    this.fallback = false;
    this.reconnectIndex = 0;
    this.token = token;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* 已断开 */ }
    }
    this.handlers?.onStatus(false);
  }

  /** 回到前台时重试一次；轮询兜底由 store 自行维持。 */
  async resume(): Promise<void> {
    if (this.stopped || !this.token || this.ws?.readyState === WebSocket.OPEN) return;
    this.fallback = false;
    this.reconnectIndex = 0;
    await this.connect();
  }

  isFallback(): boolean {
    return this.fallback;
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || !this.token) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    try {
      const base = (await getEffectiveApiBaseUrl()).replace(/\/+$/, '');
      const wsBase = base.replace(/^http/, 'ws');
      // token 只出现在连接 URL，不写日志
      const url = `${wsBase}/api/v1/ws/tasks?token=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.connecting = false;
        this.reconnectIndex = 0;
        this.fallback = false;
        this.handlers?.onStatus(true);
        this.handlers?.onResync();
        this.heartbeat = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
          } catch { /* 心跳失败等 onclose 处理 */ }
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (!message || typeof message.type !== 'string') return;
          const data = message.data || {};
          if (message.type === 'im_message') this.handlers?.onMessage(data);
          else if (message.type === 'im_recall') this.handlers?.onRecall(data);
          else if (message.type === 'im_presence') this.handlers?.onPresence(data);
        } catch { /* 忽略非法帧 */ }
      };
      ws.onerror = () => { /* onclose 统一处理重连 */ };
      ws.onclose = () => {
        this.connecting = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (this.stopped) return;
        this.handlers?.onStatus(false);
        if (this.reconnectIndex < RECONNECT_DELAYS.length) {
          const delay = RECONNECT_DELAYS[this.reconnectIndex];
          this.reconnectIndex += 1;
          this.reconnectTimer = setTimeout(() => { void this.connect(); }, delay);
        } else {
          this.fallback = true;
        }
      };
    } catch {
      this.connecting = false;
      if (!this.stopped) {
        this.fallback = true;
        this.handlers?.onStatus(false);
      }
    }
  }
}

export const imWebSocket = new ImWebSocketClient();
