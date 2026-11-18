import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { useSettings } from '../settings.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1

let current: { controller: AbortController; context: AudioContext } | null = null
let readAloudBlocked = false

/** 语音通话期间屏蔽并立刻打断自动/手动朗读，避免与通话音频叠音 */
export const setReadAloudBlocked = (blocked: boolean) => {
  readAloudBlocked = blocked
  if (blocked) {
    stopReadAloud()
  }
}

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  void current.context.close()
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    finish(controller)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

/** 消费 TTS 字节流并排程到 AudioContext；支持裸 PCM 流与封装音频（mp3/wav/opus 等） */
export const scheduleTtsStream = async ({
  context,
  destination,
  stream,
  isPcm,
  signal,
  initialNextTime,
  startDelay = START_DELAY,
  onSource,
  onFirstAudio,
}: {
  context: AudioContext
  destination: AudioNode
  stream: ReadableStream<Uint8Array>
  isPcm: boolean
  signal: AbortSignal
  initialNextTime: number
  startDelay?: number
  onSource: (source: AudioBufferSourceNode) => void
  onFirstAudio?: () => void
}): Promise<{ nextTime: number; lastSource: AudioBufferSourceNode | null }> => {
  const reader = stream.getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  let nextTime = initialNextTime
  let lastSource: AudioBufferSourceNode | null = null
  let firstFired = false

  const enqueueBuffer = (buffer: AudioBuffer) => {
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(destination)
    nextTime = Math.max(
      nextTime,
      context.currentTime + (!lastSource && nextTime === 0 ? startDelay : 0)
    )
    onSource(source)
    source.start(nextTime)
    nextTime += buffer.duration
    lastSource = source
    if (!firstFired) {
      firstFired = true
      onFirstAudio?.()
    }
  }

  try {
    if (isPcm) {
      let rest = new Uint8Array(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done || signal.aborted) {
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        buffer.copyToChannel(samples, 0)
        enqueueBuffer(buffer)
      }
    } else {
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done || signal.aborted) {
          break
        }
        chunks.push(value)
        total += value.length
      }
      if (!signal.aborted && total > 0) {
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.length
        }
        const decoded = await context.decodeAudioData(merged.buffer)
        if (!signal.aborted) {
          enqueueBuffer(decoded)
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }

  return { nextTime, lastSource }
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  if (readAloudBlocked) {
    return
  }
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const controller = new AbortController()
  const context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  if (context.state === 'suspended') {
    void context.resume().catch(() => {})
  }
  current = { controller, context }
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice, ttsChannel } = useSettings.getState()

  void (async () => {
    try {
      const { stream, isPcm } = await synthesize(
        apiKey ?? '',
        text,
        ttsVoice,
        controller.signal,
        ttsChannel.mode === 'custom' ? ttsChannel : undefined
      )
      const { lastSource } = await scheduleTtsStream({
        context,
        destination: context.destination,
        stream,
        isPcm,
        signal: controller.signal,
        initialNextTime: 0,
        startDelay: START_DELAY,
        onSource: () => {},
        onFirstAudio: () => {
          if (useReadAloud.getState().status === 'loading') {
            useReadAloud.setState({ status: 'playing' })
          }
        },
      })
      if (lastSource) {
        lastSource.onended = () => finish(controller)
      } else {
        finish(controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(controller)
        onError(error)
      }
    }
  })()
}
