import { ApiError, request } from './client.js'
import { getApiOrigin, joinApiPath, normalizeOrigin } from './origin.js'

/**
 * 语音接口：
 * - 默认（DeepSeek）：ASR POST /v1/tools/asr、TTS POST /v1/tools/tts
 * - 自定义（OpenAI 兼容）：ASR POST /v1/audio/transcriptions、TTS POST /v1/audio/speech
 */
const toolsBaseUrl = () => `${getApiOrigin()}/v1/tools`

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

export type SpeechChannelOverride = {
  baseUrl: string
  apiKey: string
  model: string
  voice?: string
}

/** 语音识别：支持 DeepSeek 默认接口与自定义 OpenAI 兼容 /audio/transcriptions */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal,
  custom?: SpeechChannelOverride
): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const useCustom = Boolean(custom && (normalizeOrigin(custom.baseUrl) || custom.model.trim()))
  if (useCustom && custom) {
    if (custom.model.trim()) {
      form.append('model', custom.model.trim())
    }
    const url = joinApiPath(custom.baseUrl, '/audio/transcriptions')
    const key = custom.apiKey.trim() || apiKey
    const response = await request(url, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal,
    })
    const raw = await response.text()
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return raw.trim()
    }
    if (
      typeof body === 'object' &&
      body !== null &&
      'text' in body &&
      typeof (body as { text: unknown }).text === 'string'
    ) {
      return (body as { text: string }).text
    }
    throw new ApiError('protocol', raw)
  }

  const response = await request(`${toolsBaseUrl()}/asr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

export type SynthesizeResult = {
  stream: ReadableStream<Uint8Array>
  isPcm: boolean
}

/** 语音合成：DeepSeek 默认返回裸 PCM；自定义渠道兼容 OpenAI /audio/speech（pcm 或封装音频） */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal,
  custom?: SpeechChannelOverride
): Promise<SynthesizeResult> => {
  const useCustom = Boolean(custom && (normalizeOrigin(custom.baseUrl) || custom.model.trim()))
  if (useCustom && custom) {
    const url = joinApiPath(custom.baseUrl, '/audio/speech')
    const key = custom.apiKey.trim() || apiKey
    const response = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: custom.model.trim() || 'tts-1',
        input: text,
        voice: custom.voice?.trim() || 'alloy',
        response_format: 'pcm',
      }),
      signal,
    })
    if (!response.body) {
      throw new ApiError('protocol', await response.text())
    }
    const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
    const isEncodedAudio =
      contentType.includes('mpeg') ||
      contentType.includes('mp3') ||
      contentType.includes('wav') ||
      contentType.includes('ogg') ||
      contentType.includes('opus') ||
      contentType.includes('aac') ||
      contentType.includes('flac') ||
      contentType.includes('mp4')
    return { stream: response.body, isPcm: !isEncodedAudio }
  }

  const response = await request(`${toolsBaseUrl()}/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return { stream: response.body, isPcm: true }
}
