/**
 * 「敲门」提示音：用户上线提醒时播放两声清脆的叩门声。
 *
 * 用 Web Audio API 实时合成（白噪声瞬态 + 木质低频共鸣），
 * 不依赖任何外部音频文件，桌面端（WebView2）与网页端行为一致。
 */

let ctx: AudioContext | null = null
let noiseBuffer: AudioBuffer | null = null

type AudioContextCtor = new () => AudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return w.AudioContext || w.webkitAudioContext || null
}

/** 共用一个 AudioContext：其它提示音（如 IM 新消息）复用它，避免多上下文占用。 */
export function ensureContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  // 浏览器自动播放策略：上下文可能被挂起，交互后再恢复
  const resume = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }
  window.addEventListener('pointerdown', resume, { passive: true })
  window.addEventListener('keydown', resume)
  return ctx
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer
  const length = Math.floor(context.sampleRate * 0.08)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) {
    // 指数衰减的噪声：模拟指节敲击门板的瞬态
    const decay = Math.exp((-6 * i) / length)
    data[i] = (Math.random() * 2 - 1) * decay
  }
  noiseBuffer = buffer
  return buffer
}

/** 敲一声：噪声瞬态（"哒"）+ 低频共鸣（"咚"） */
function knock(context: AudioContext, startAt: number, gainValue: number) {
  // 1) 指节敲击的清脆瞬态
  const noise = context.createBufferSource()
  noise.buffer = getNoiseBuffer(context)

  const bandpass = context.createBiquadFilter()
  bandpass.type = 'bandpass'
  bandpass.frequency.value = 2200
  bandpass.Q.value = 1.1

  const noiseGain = context.createGain()
  noiseGain.gain.setValueAtTime(gainValue * 0.85, startAt)
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.07)

  noise.connect(bandpass)
  bandpass.connect(noiseGain)
  noiseGain.connect(context.destination)
  noise.start(startAt)
  noise.stop(startAt + 0.09)

  // 2) 门板/木头的低频共鸣，让声音更"实"
  const body = context.createOscillator()
  body.type = 'triangle'
  body.frequency.setValueAtTime(190, startAt)
  body.frequency.exponentialRampToValueAtTime(120, startAt + 0.12)

  const bodyGain = context.createGain()
  bodyGain.gain.setValueAtTime(0.0001, startAt)
  bodyGain.gain.exponentialRampToValueAtTime(gainValue * 0.5, startAt + 0.008)
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.18)

  body.connect(bodyGain)
  bodyGain.connect(context.destination)
  body.start(startAt)
  body.stop(startAt + 0.2)
}

/**
 * 播放两声敲门声（"咚—咚"）。
 * 静默失败：浏览器禁止音频时不影响其它功能。
 */
export function playKnockSound() {
  try {
    const context = ensureContext()
    if (!context) return
    if (context.state === 'suspended') void context.resume()

    const base = context.currentTime + 0.02
    knock(context, base, 0.9)
    knock(context, base + 0.28, 0.75)
  } catch {
    /* 忽略：提示音失败不应影响上线提醒本身 */
  }
}
