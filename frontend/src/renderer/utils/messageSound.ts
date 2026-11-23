/**
 * 「协作沟通收到新消息」提示音：清脆的双音"叮咚"（纯正弦 + 二次谐波）。
 *
 * 刻意与 knockSound 的上线敲门声区分开：
 *  - 敲门声 = 带通白噪声瞬态 + 190→120Hz 三角波低频共鸣，两声"咚—咚"，偏闷；
 *  - 新消息 = 1046Hz→784Hz 高频纯音，短促、明亮、带轻微金属泛音。
 * 复用同一个 AudioContext，不依赖任何外部音频文件（WebView2 与网页端一致）。
 */
import { ensureContext } from './knockSound'

/** 连续多条消息只响一次，避免刷屏时吵人 */
const MIN_INTERVAL_MS = 1200
let lastPlayedAt = 0

function chime(context: AudioContext, startAt: number, frequency: number,
               duration: number, gainValue: number) {
  const main = context.createOscillator()
  main.type = 'sine'
  main.frequency.setValueAtTime(frequency, startAt)

  const mainGain = context.createGain()
  mainGain.gain.setValueAtTime(0.0001, startAt)
  mainGain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.012)
  mainGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)

  main.connect(mainGain)
  mainGain.connect(context.destination)
  main.start(startAt)
  main.stop(startAt + duration + 0.01)

  // 二次谐波：给"叮"一点金属质感，音量只有基音的 1/5，衰减更快
  const overtone = context.createOscillator()
  overtone.type = 'sine'
  overtone.frequency.setValueAtTime(frequency * 2, startAt)

  const overtoneGain = context.createGain()
  overtoneGain.gain.setValueAtTime(0.0001, startAt)
  overtoneGain.gain.exponentialRampToValueAtTime(gainValue * 0.2, startAt + 0.008)
  overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration * 0.7)

  overtone.connect(overtoneGain)
  overtoneGain.connect(context.destination)
  overtone.start(startAt)
  overtone.stop(startAt + duration + 0.01)
}

/** 被 @ 专用提示音：三音上行（659→880→1175Hz），与下行"叮咚"及低频敲门声三者区分 */
const MENTION_MIN_INTERVAL_MS = 1200
let lastMentionPlayedAt = 0

export function playImMentionSound() {
  const now = Date.now()
  if (now - lastMentionPlayedAt < MENTION_MIN_INTERVAL_MS) return
  lastMentionPlayedAt = now
  try {
    const context = ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    const base = context.currentTime + 0.02
    chime(context, base, 659.3, 0.13, 0.20)
    chime(context, base + 0.11, 880.0, 0.13, 0.22)
    chime(context, base + 0.22, 1174.7, 0.26, 0.24)
  } catch {
    /* 忽略：提示音失败不应影响消息接收 */
  }
}

/** 播放"叮咚"。静默失败：浏览器禁止音频或不支持 Web Audio 时不影响消息接收。 */
export function playImMessageSound() {
  const now = Date.now()
  if (now - lastPlayedAt < MIN_INTERVAL_MS) return
  lastPlayedAt = now
  try {
    const context = ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    const base = context.currentTime + 0.02
    chime(context, base, 1046.5, 0.16, 0.26)
    chime(context, base + 0.14, 784.0, 0.22, 0.22)
  } catch {
    /* 忽略：提示音失败不应影响消息接收 */
  }
}
