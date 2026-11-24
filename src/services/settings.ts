import { create } from 'zustand'
import { setRuntimeApiOrigin } from './api/origin.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'
export type Skin = 'ocean' | 'ink' | 'cloud'
export type ReplyMode = 'default' | 'debate' | 'objective' | 'validate'
export type AvatarShape = 'circle' | 'square'
export type CrossChatMemoryScope = 'all' | 'selected'

/** 主语言模型接口协议：deepseek / openai / responses / local（本地部署免密钥） */
export type ChatProtocol = 'deepseek' | 'openai' | 'responses' | 'local'
export type ThinkingEffort = 'low' | 'high' | 'max' | 'xhigh'

export type ImageGenProtocol = 'auto' | 'images' | 'responses'
export type ImageOutputFormat = 'auto' | 'png' | 'jpeg' | 'webp' | 'gif'

/** 子能力渠道模式：inherit 跟随主 DeepSeek 服务，custom 使用独立的别家服务 */
export type ServiceChannelMode = 'inherit' | 'custom'

export type ServiceChannelConfig = {
  mode: ServiceChannelMode
  baseUrl: string
  apiKey: string
  model: string
}

export type TtsChannelConfig = ServiceChannelConfig & {
  voice: string
}

export type ImageGenChannelConfig = {
  enabled: boolean
  protocol: ImageGenProtocol
  baseUrl: string
  apiKey: string
  model: string
  size: string
  outputFormat: ImageOutputFormat
  gifFrameCount: number
  gifFrameDurationMs: number
  customHeaders: string
  requireConfirm: boolean
}

const EMPTY_CHANNEL: ServiceChannelConfig = {
  mode: 'inherit',
  baseUrl: '',
  apiKey: '',
  model: '',
}

const EMPTY_TTS_CHANNEL: TtsChannelConfig = {
  ...EMPTY_CHANNEL,
  voice: 'alloy',
}

const DEFAULT_IMAGE_GEN_CHANNEL: ImageGenChannelConfig = {
  enabled: false,
  protocol: 'auto',
  baseUrl: '',
  apiKey: '',
  model: '',
  size: 'auto',
  outputFormat: 'auto',
  gifFrameCount: 9,
  gifFrameDurationMs: 200,
  customHeaders: '',
  requireConfirm: true,
}

/** GPT Image 2.6 的 Flare / Sunburst 及网关别名均支持 GIF 输出。 */
export const supportsImageGifModel = (model: string) =>
  /^gpt-image-2\.6(?:$|-)/i.test(model.trim())

export const DEFAULT_MODEL = 'deepseek-flash'
export const DEFAULT_SYSTEM_PROMPT = '该助手为小石榴，一个圆润、机灵、有丰富想法的 AI 助手。'
export const DEFAULT_VOICE_SYSTEM_PROMPT = `你是小石榴，一个圆润、机灵、有丰富想法的 AI 助手，正在与用户进行实时语音通话，请严格使用自然口语交流：
1. 直接开口回答，像真人面对面聊天一样简洁、自然、有温度，每次尽量控制在 1~3 句话内，不要长篇大论。
2. 禁止使用任何 Markdown 格式（不要出现标题、星号加粗、列表序号、代码块、表格或网址链接），不要用“首先、其次、第一、总结如下”等书面八股结构。
3. 适合耳朵听而不是眼睛看：遇到复杂内容先用一两句大白话说核心结论，再自然询问用户想继续了解哪部分。`

/** 本机设置，存 localStorage */
export type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  skin: Skin
  replyMode: ReplyMode
  location: UserLocation | null
  ttsVoice: TtsVoice
  autoPlayVoice: boolean
  voiceAutoSend: boolean
  collapseThinking: boolean
  avatarEnabled: boolean
  avatarDataUrl: string
  avatarShape: AvatarShape
  avatarSize: number
  autoCheckUpdate: boolean
  tokenLimitEnabled: boolean
  dailyTokenLimit: number
  thinking: boolean
  thinkingEffort: ThinkingEffort
  search: boolean
  imageGen: boolean
  siderCollapsed: boolean
  // 模型与请求参数
  chatProtocol: ChatProtocol
  apiOrigin: string
  customHeaders: string
  model: string
  systemPrompt: string
  voiceSystemPrompt: string
  temperature: number | null
  topP: number | null
  maxTokens: number | null
  // 多能力独立渠道
  asrChannel: ServiceChannelConfig
  ttsChannel: TtsChannelConfig
  visionChannel: ServiceChannelConfig
  ocrChannel: ServiceChannelConfig
  imageGenChannel: ImageGenChannelConfig
  // 协议与工具开关
  safetyCheck: boolean
  readUrl: boolean
  sendLatestReminder: boolean
  autoTitle: boolean
  // 回复与拒答策略
  keepRefusedContent: boolean
  allowRefusedContext: boolean
  allowEditAssistant: boolean
  savedMemoryEnabled: boolean
  autoExtractMemory: boolean
  memoryUpdateNotice: boolean
  crossChatMemory: boolean
  crossChatMemoryLimit: number
  crossChatMemoryScope: CrossChatMemoryScope
  crossChatMemorySessionIds: string[]
  // 自定义关键词拒答（仅检查用户输入）
  refusalEnabled: boolean
  refusalKeywords: string
  refusalCaseSensitive: boolean
  refusalMessage: string
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  skin: 'deepjeek:skin',
  replyMode: 'xiaoshiliu:reply-mode',
  ttsVoice: 'chat-demo:tts-voice',
  autoPlayVoice: 'chat-demo:auto-play-voice',
  voiceAutoSend: 'chat-demo:voice-auto-send',
  collapseThinking: 'chat-demo:collapse-thinking',
  avatarEnabled: 'chat-demo:avatar-enabled',
  avatarDataUrl: 'chat-demo:avatar-data-url',
  avatarShape: 'chat-demo:avatar-shape',
  avatarSize: 'chat-demo:avatar-size',
  autoCheckUpdate: 'chat-demo:auto-check-update',
  tokenLimitEnabled: 'chat-demo:token-limit-enabled',
  dailyTokenLimit: 'chat-demo:daily-token-limit',
  thinking: 'chat-demo:thinking',
  thinkingEffort: 'chat-demo:thinking-effort',
  search: 'chat-demo:search',
  imageGen: 'chat-demo:image-gen',
  siderCollapsed: 'chat-demo:sider-collapsed',
  chatProtocol: 'chat-demo:chat-protocol',
  apiOrigin: 'chat-demo:api-origin',
  customHeaders: 'chat-demo:custom-headers',
  model: 'chat-demo:model',
  systemPrompt: 'chat-demo:system-prompt',
  voiceSystemPrompt: 'chat-demo:voice-system-prompt',
  temperature: 'chat-demo:temperature',
  topP: 'chat-demo:top-p',
  maxTokens: 'chat-demo:max-tokens',
  asrChannel: 'chat-demo:asr-channel',
  ttsChannel: 'chat-demo:tts-channel',
  visionChannel: 'chat-demo:vision-channel',
  ocrChannel: 'chat-demo:ocr-channel',
  imageGenChannel: 'chat-demo:image-gen-channel',
  safetyCheck: 'chat-demo:safety-check',
  readUrl: 'chat-demo:read-url',
  sendLatestReminder: 'chat-demo:send-latest-reminder',
  autoTitle: 'chat-demo:auto-title',
  keepRefusedContent: 'chat-demo:keep-refused-content',
  allowRefusedContext: 'chat-demo:allow-refused-context',
  allowEditAssistant: 'chat-demo:allow-edit-assistant',
  savedMemoryEnabled: 'chat-demo:saved-memory-enabled',
  autoExtractMemory: 'chat-demo:auto-extract-memory',
  memoryUpdateNotice: 'chat-demo:memory-update-notice',
  crossChatMemory: 'chat-demo:cross-chat-memory',
  crossChatMemoryLimit: 'chat-demo:cross-chat-memory-limit',
  crossChatMemoryScope: 'chat-demo:cross-chat-memory-scope',
  crossChatMemorySessionIds: 'chat-demo:cross-chat-memory-session-ids',
  refusalEnabled: 'chat-demo:refusal-enabled',
  refusalKeywords: 'chat-demo:refusal-keywords',
  refusalCaseSensitive: 'chat-demo:refusal-case-sensitive',
  refusalMessage: 'chat-demo:refusal-message',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

const initialSkin = (): Skin => {
  const saved = read(KEYS.skin)
  return saved === 'ink' || saved === 'cloud' ? saved : 'ocean'
}

const initialReplyMode = (): ReplyMode => {
  const saved = read(KEYS.replyMode)
  return saved === 'debate' || saved === 'objective' || saved === 'validate'
    ? saved
    : 'default'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const readBool = (key: string, fallback: boolean): boolean => {
  const saved = read(key)
  if (saved === 'true') {
    return true
  }
  if (saved === 'false') {
    return false
  }
  return fallback
}

const readNumber = (key: string): number | null => {
  const saved = read(key)
  if (saved === null || saved === '') {
    return null
  }
  const value = Number(saved)
  return Number.isFinite(value) ? value : null
}

const readChannel = (key: string): ServiceChannelConfig => {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...EMPTY_CHANNEL }
    }
    const obj = parsed as Record<string, unknown>
    return {
      mode: obj.mode === 'custom' ? 'custom' : 'inherit',
      baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : '',
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
      model: typeof obj.model === 'string' ? obj.model : '',
    }
  } catch {
    return { ...EMPTY_CHANNEL }
  }
}

const readTtsChannel = (key: string): TtsChannelConfig => {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...EMPTY_TTS_CHANNEL }
    }
    const obj = parsed as Record<string, unknown>
    return {
      ...readChannel(key),
      voice: typeof obj.voice === 'string' ? obj.voice : 'alloy',
    }
  } catch {
    return { ...EMPTY_TTS_CHANNEL }
  }
}

const readImageGenChannel = (key: string): ImageGenChannelConfig => {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_IMAGE_GEN_CHANNEL }
    }
    const obj = parsed as Record<string, unknown>
    return {
      enabled: obj.enabled === true,
      protocol: obj.protocol === 'responses' || obj.protocol === 'images' ? obj.protocol : 'auto',
      baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : '',
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
      model: typeof obj.model === 'string' ? obj.model : '',
      size: typeof obj.size === 'string' && obj.size ? obj.size : 'auto',
      outputFormat:
        obj.outputFormat === 'png' ||
        obj.outputFormat === 'jpeg' ||
        obj.outputFormat === 'webp' ||
        obj.outputFormat === 'gif'
          ? obj.outputFormat
          : 'auto',
      gifFrameCount:
        typeof obj.gifFrameCount === 'number' && Number.isFinite(obj.gifFrameCount)
          ? Math.min(16, Math.max(2, Math.round(obj.gifFrameCount)))
          : DEFAULT_IMAGE_GEN_CHANNEL.gifFrameCount,
      gifFrameDurationMs:
        typeof obj.gifFrameDurationMs === 'number' && Number.isFinite(obj.gifFrameDurationMs)
          ? Math.min(2000, Math.max(20, Math.round(obj.gifFrameDurationMs)))
          : DEFAULT_IMAGE_GEN_CHANNEL.gifFrameDurationMs,
      customHeaders: typeof obj.customHeaders === 'string' ? obj.customHeaders : '',
      requireConfirm: obj.requireConfirm !== false,
    }
  } catch {
    return { ...DEFAULT_IMAGE_GEN_CHANNEL }
  }
}

const initialThinkingEffort = (): ThinkingEffort => {
  const value = read(KEYS.thinkingEffort)
  return value === 'low' || value === 'high' || value === 'max' || value === 'xhigh' ? value : 'low'
}

const initialChatProtocol = (): ChatProtocol => {
  const saved = read(KEYS.chatProtocol)
  if (saved === 'openai' || saved === 'responses' || saved === 'local') {
    return saved
  }
  return 'deepseek'
}

const initialApiOrigin = read(KEYS.apiOrigin) ?? ''
setRuntimeApiOrigin(initialApiOrigin)

const readStringArray = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(read(key) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  skin: initialSkin(),
  replyMode: initialReplyMode(),
  ttsVoice: initialTtsVoice(),
  autoPlayVoice: readBool(KEYS.autoPlayVoice, false),
  voiceAutoSend: readBool(KEYS.voiceAutoSend, true),
  collapseThinking: readBool(KEYS.collapseThinking, false),
  avatarEnabled: readBool(KEYS.avatarEnabled, false),
  avatarDataUrl: read(KEYS.avatarDataUrl) ?? '',
  avatarShape: read(KEYS.avatarShape) === 'square' ? 'square' : 'circle',
  avatarSize: Math.min(64, Math.max(24, Math.round(readNumber(KEYS.avatarSize) ?? 36))),
  autoCheckUpdate: readBool(KEYS.autoCheckUpdate, true),
  tokenLimitEnabled: readBool(KEYS.tokenLimitEnabled, false),
  dailyTokenLimit: Math.max(1000, Math.round(readNumber(KEYS.dailyTokenLimit) ?? 100_000)),
  thinking: read(KEYS.thinking) === 'true',
  thinkingEffort: initialThinkingEffort(),
  search: read(KEYS.search) === 'true',
  imageGen: read(KEYS.imageGen) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  chatProtocol: initialChatProtocol(),
  apiOrigin: initialApiOrigin,
  customHeaders: read(KEYS.customHeaders) ?? '',
  model: read(KEYS.model) ?? DEFAULT_MODEL,
  systemPrompt: read(KEYS.systemPrompt) ?? DEFAULT_SYSTEM_PROMPT,
  voiceSystemPrompt: read(KEYS.voiceSystemPrompt) ?? DEFAULT_VOICE_SYSTEM_PROMPT,
  temperature: readNumber(KEYS.temperature),
  topP: readNumber(KEYS.topP),
  maxTokens: readNumber(KEYS.maxTokens),
  asrChannel: readChannel(KEYS.asrChannel),
  ttsChannel: readTtsChannel(KEYS.ttsChannel),
  visionChannel: readChannel(KEYS.visionChannel),
  ocrChannel: readChannel(KEYS.ocrChannel),
  imageGenChannel: readImageGenChannel(KEYS.imageGenChannel),
  safetyCheck: readBool(KEYS.safetyCheck, true),
  readUrl: readBool(KEYS.readUrl, true),
  sendLatestReminder: readBool(KEYS.sendLatestReminder, true),
  autoTitle: readBool(KEYS.autoTitle, true),
  keepRefusedContent: readBool(KEYS.keepRefusedContent, false),
  allowRefusedContext: readBool(KEYS.allowRefusedContext, false),
  allowEditAssistant: readBool(KEYS.allowEditAssistant, true),
  savedMemoryEnabled: readBool(KEYS.savedMemoryEnabled, true),
  autoExtractMemory: readBool(KEYS.autoExtractMemory, true),
  memoryUpdateNotice: readBool(KEYS.memoryUpdateNotice, false),
  crossChatMemory: readBool(KEYS.crossChatMemory, true),
  crossChatMemoryLimit: Math.min(10, Math.max(1, readNumber(KEYS.crossChatMemoryLimit) ?? 4)),
  crossChatMemoryScope: read(KEYS.crossChatMemoryScope) === 'selected' ? 'selected' : 'all',
  crossChatMemorySessionIds: readStringArray(KEYS.crossChatMemorySessionIds),
  refusalEnabled: readBool(KEYS.refusalEnabled, false),
  refusalKeywords: read(KEYS.refusalKeywords) ?? '',
  refusalCaseSensitive: readBool(KEYS.refusalCaseSensitive, false),
  refusalMessage: read(KEYS.refusalMessage) ?? '',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setSkin = (skin: Skin) => {
  write(KEYS.skin, skin)
  useSettings.setState({ skin })
}

export const setReplyMode = (replyMode: ReplyMode) => {
  write(KEYS.replyMode, replyMode)
  useSettings.setState({ replyMode })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setAutoPlayVoice = (value: boolean) =>
  setBoolSetting(KEYS.autoPlayVoice, 'autoPlayVoice', value)

export const setVoiceAutoSend = (value: boolean) =>
  setBoolSetting(KEYS.voiceAutoSend, 'voiceAutoSend', value)

export const setCollapseThinking = (value: boolean) =>
  setBoolSetting(KEYS.collapseThinking, 'collapseThinking', value)

export const setAvatarEnabled = (value: boolean) =>
  setBoolSetting(KEYS.avatarEnabled, 'avatarEnabled', value)

export const setAvatarDataUrl = (avatarDataUrl: string) => {
  write(KEYS.avatarDataUrl, avatarDataUrl || null)
  useSettings.setState({ avatarDataUrl })
}

export const setAvatarShape = (avatarShape: AvatarShape) => {
  write(KEYS.avatarShape, avatarShape)
  useSettings.setState({ avatarShape })
}

export const setAvatarSize = (value: number) => {
  const avatarSize = Math.min(64, Math.max(24, Math.round(value)))
  write(KEYS.avatarSize, String(avatarSize))
  useSettings.setState({ avatarSize })
}

export const setAutoCheckUpdate = (value: boolean) =>
  setBoolSetting(KEYS.autoCheckUpdate, 'autoCheckUpdate', value)

export const setTokenLimitEnabled = (value: boolean) =>
  setBoolSetting(KEYS.tokenLimitEnabled, 'tokenLimitEnabled', value)

export const setDailyTokenLimit = (value: number) => {
  const limit = Math.max(1000, Math.round(value))
  write(KEYS.dailyTokenLimit, String(limit))
  useSettings.setState({ dailyTokenLimit: limit })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setImageGen = (imageGen: boolean) => {
  write(KEYS.imageGen, String(imageGen))
  useSettings.setState({ imageGen })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setChatProtocol = (chatProtocol: ChatProtocol) => {
  write(KEYS.chatProtocol, chatProtocol)
  useSettings.setState({ chatProtocol })
}

export const setAsrChannel = (asrChannel: ServiceChannelConfig) => {
  write(KEYS.asrChannel, JSON.stringify(asrChannel))
  useSettings.setState({ asrChannel })
}

export const setTtsChannel = (ttsChannel: TtsChannelConfig) => {
  write(KEYS.ttsChannel, JSON.stringify(ttsChannel))
  useSettings.setState({ ttsChannel })
}

export const setVisionChannel = (visionChannel: ServiceChannelConfig) => {
  write(KEYS.visionChannel, JSON.stringify(visionChannel))
  useSettings.setState({ visionChannel })
}

export const setOcrChannel = (ocrChannel: ServiceChannelConfig) => {
  write(KEYS.ocrChannel, JSON.stringify(ocrChannel))
  useSettings.setState({ ocrChannel })
}

export const setImageGenChannel = (imageGenChannel: ImageGenChannelConfig) => {
  write(KEYS.imageGenChannel, JSON.stringify(imageGenChannel))
  useSettings.setState({ imageGenChannel })
}

export const setApiOrigin = (apiOrigin: string) => {
  write(KEYS.apiOrigin, apiOrigin ? apiOrigin : null)
  setRuntimeApiOrigin(apiOrigin)
  useSettings.setState({ apiOrigin })
}

export const setCustomHeaders = (customHeaders: string) => {
  write(KEYS.customHeaders, customHeaders ? customHeaders : null)
  useSettings.setState({ customHeaders })
}

export const setModel = (model: string) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setSystemPrompt = (systemPrompt: string) => {
  write(KEYS.systemPrompt, systemPrompt)
  useSettings.setState({ systemPrompt })
}

export const setVoiceSystemPrompt = (voiceSystemPrompt: string) => {
  write(KEYS.voiceSystemPrompt, voiceSystemPrompt)
  useSettings.setState({ voiceSystemPrompt })
}

export const setTemperature = (temperature: number | null) => {
  write(KEYS.temperature, temperature === null ? null : String(temperature))
  useSettings.setState({ temperature })
}

export const setTopP = (topP: number | null) => {
  write(KEYS.topP, topP === null ? null : String(topP))
  useSettings.setState({ topP })
}

export const setMaxTokens = (maxTokens: number | null) => {
  write(KEYS.maxTokens, maxTokens === null ? null : String(maxTokens))
  useSettings.setState({ maxTokens })
}

const setBoolSetting = <K extends keyof Settings>(
  key: (typeof KEYS)[keyof typeof KEYS],
  field: K,
  value: boolean
) => {
  write(key, String(value))
  useSettings.setState({ [field]: value } as Pick<Settings, K>)
}

export const setSafetyCheck = (value: boolean) =>
  setBoolSetting(KEYS.safetyCheck, 'safetyCheck', value)

export const setReadUrl = (value: boolean) => setBoolSetting(KEYS.readUrl, 'readUrl', value)

export const setSendLatestReminder = (value: boolean) =>
  setBoolSetting(KEYS.sendLatestReminder, 'sendLatestReminder', value)

export const setAutoTitle = (value: boolean) => setBoolSetting(KEYS.autoTitle, 'autoTitle', value)

export const setKeepRefusedContent = (value: boolean) =>
  setBoolSetting(KEYS.keepRefusedContent, 'keepRefusedContent', value)

export const setAllowRefusedContext = (value: boolean) =>
  setBoolSetting(KEYS.allowRefusedContext, 'allowRefusedContext', value)

export const setAllowEditAssistant = (value: boolean) =>
  setBoolSetting(KEYS.allowEditAssistant, 'allowEditAssistant', value)

export const setSavedMemoryEnabled = (value: boolean) =>
  setBoolSetting(KEYS.savedMemoryEnabled, 'savedMemoryEnabled', value)

export const setAutoExtractMemory = (value: boolean) =>
  setBoolSetting(KEYS.autoExtractMemory, 'autoExtractMemory', value)

export const setMemoryUpdateNotice = (value: boolean) =>
  setBoolSetting(KEYS.memoryUpdateNotice, 'memoryUpdateNotice', value)

export const setCrossChatMemory = (value: boolean) =>
  setBoolSetting(KEYS.crossChatMemory, 'crossChatMemory', value)

export const setCrossChatMemoryLimit = (value: number) => {
  const limit = Math.min(10, Math.max(1, Math.round(value)))
  write(KEYS.crossChatMemoryLimit, String(limit))
  useSettings.setState({ crossChatMemoryLimit: limit })
}

export const setCrossChatMemoryScope = (crossChatMemoryScope: CrossChatMemoryScope) => {
  write(KEYS.crossChatMemoryScope, crossChatMemoryScope)
  useSettings.setState({ crossChatMemoryScope })
}

export const setCrossChatMemorySessionIds = (sessionIds: string[]) => {
  const unique = [...new Set(sessionIds.filter(Boolean))]
  write(KEYS.crossChatMemorySessionIds, unique.length > 0 ? JSON.stringify(unique) : null)
  useSettings.setState({ crossChatMemorySessionIds: unique })
}

export const toggleCrossChatMemorySession = (sessionId: string) => {
  const current = useSettings.getState().crossChatMemorySessionIds
  const next = current.includes(sessionId)
    ? current.filter((id) => id !== sessionId)
    : [...current, sessionId]
  setCrossChatMemorySessionIds(next)
}

export const setRefusalEnabled = (value: boolean) =>
  setBoolSetting(KEYS.refusalEnabled, 'refusalEnabled', value)

export const setRefusalKeywords = (refusalKeywords: string) => {
  write(KEYS.refusalKeywords, refusalKeywords || null)
  useSettings.setState({ refusalKeywords })
}

export const setRefusalCaseSensitive = (value: boolean) =>
  setBoolSetting(KEYS.refusalCaseSensitive, 'refusalCaseSensitive', value)

export const setRefusalMessage = (refusalMessage: string) => {
  write(KEYS.refusalMessage, refusalMessage || null)
  useSettings.setState({ refusalMessage })
}

export const resetModelAndPolicySettings = () => {
  setChatProtocol('deepseek')
  setApiOrigin('')
  setCustomHeaders('')
  setModel(DEFAULT_MODEL)
  setSystemPrompt(DEFAULT_SYSTEM_PROMPT)
  setVoiceSystemPrompt(DEFAULT_VOICE_SYSTEM_PROMPT)
  setTemperature(null)
  setTopP(null)
  setMaxTokens(null)
  setAsrChannel({ ...EMPTY_CHANNEL })
  setTtsChannel({ ...EMPTY_TTS_CHANNEL })
  setVisionChannel({ ...EMPTY_CHANNEL })
  setOcrChannel({ ...EMPTY_CHANNEL })
  setImageGenChannel({ ...DEFAULT_IMAGE_GEN_CHANNEL })
  setImageGen(false)
  setSafetyCheck(true)
  setReadUrl(true)
  setSendLatestReminder(true)
  setAutoTitle(true)
  setKeepRefusedContent(false)
  setAllowRefusedContext(false)
  setAllowEditAssistant(true)
  setSavedMemoryEnabled(true)
  setAutoExtractMemory(true)
  setMemoryUpdateNotice(false)
  setThinkingEffort('low')
  setCrossChatMemory(true)
  setCrossChatMemoryLimit(4)
  setCrossChatMemoryScope('all')
  setCrossChatMemorySessionIds([])
  setRefusalEnabled(false)
  setRefusalKeywords('')
  setRefusalCaseSensitive(false)
  setRefusalMessage('')
}

/** 按换行或中英文逗号拆分关键词，检查用户输入是否命中任一拒答关键词 */
export const matchesRefusalKeyword = (
  input: string,
  config: Pick<
    Settings,
    'refusalEnabled' | 'refusalKeywords' | 'refusalCaseSensitive'
  > = useSettings.getState()
): boolean => {
  if (!config.refusalEnabled || !input) {
    return false
  }
  const keywords = config.refusalKeywords
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (keywords.length === 0) {
    return false
  }
  const target = config.refusalCaseSensitive ? input : input.toLowerCase()
  return keywords.some((keyword) =>
    target.includes(config.refusalCaseSensitive ? keyword : keyword.toLowerCase())
  )
}
