import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getApiOrigin } from '../../services/api/origin.js'
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VOICE_SYSTEM_PROMPT,
  resetModelAndPolicySettings,
  setAllowEditAssistant,
  setAllowRefusedContext,
  setApiKey,
  setApiOrigin,
  setAsrChannel,
  setAutoTitle,
  setChatProtocol,
  setCustomHeaders,
  setImageGenChannel,
  setKeepRefusedContent,
  setMaxTokens,
  setModel,
  setOcrChannel,
  setReadUrl,
  setRefusalCaseSensitive,
  setRefusalEnabled,
  setRefusalKeywords,
  setRefusalMessage,
  setSafetyCheck,
  setSendLatestReminder,
  setSystemPrompt,
  setTemperature,
  setTopP,
  setTtsChannel,
  setVisionChannel,
  setVoiceSystemPrompt,
  useSettings,
  type ChatProtocol,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Select, type SelectOption } from '../base/Select.js'
import { ApiKeyConfirm, ApiKeyField, type useApiKeyEditor } from './ApiKeyField.js'
import {
  CapabilityChannelCard,
  ImageGenChannelCard,
  ModelFetcherInput,
} from './ChannelConfigField.js'
import styles from './Settings.module.css'

export const ToggleSwitch = ({
  checked,
  ariaLabel,
  onChange,
}: {
  checked: boolean
  ariaLabel: string
  onChange: (next: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    className={styles.switch}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.switchThumb} />
  </button>
)

export const ToggleCell = ({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) => (
  <div className={`${styles.cell} ${styles.row}`}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {description ? <div className={styles.description}>{description}</div> : null}
    </div>
    <ToggleSwitch checked={checked} ariaLabel={label} onChange={onChange} />
  </div>
)

export const NumberParamInput = ({
  label,
  value,
  placeholder,
  step,
  min,
  max,
  integer = false,
  onChange,
}: {
  label: string
  value: number | null
  placeholder: string
  step: string
  min?: number
  max?: number
  integer?: boolean
  onChange: (next: number | null) => void
}) => {
  const [draft, setDraft] = useState(value === null ? '' : String(value))

  useEffect(() => {
    setDraft(value === null ? '' : String(value))
  }, [value])

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) {
      onChange(null)
      setDraft('')
      return
    }
    const parsed = integer ? Number.parseInt(trimmed, 10) : Number(trimmed)
    if (!Number.isFinite(parsed)) {
      setDraft(value === null ? '' : String(value))
      return
    }
    const clamped =
      min !== undefined && parsed < min ? min : max !== undefined && parsed > max ? max : parsed
    onChange(clamped)
    setDraft(String(clamped))
  }

  return (
    <label className={styles.paramItem}>
      {label ? <span className={styles.paramLabel}>{label}</span> : null}
      <input
        type="number"
        className={styles.textInput}
        placeholder={placeholder}
        step={step}
        min={min}
        max={max}
        value={draft}
        onChange={(event) => {
          const raw = event.target.value
          setDraft(raw)
          const trimmed = raw.trim()
          if (!trimmed) {
            onChange(null)
            return
          }
          const parsed = integer ? Number.parseInt(trimmed, 10) : Number(trimmed)
          if (Number.isFinite(parsed)) {
            if ((min === undefined || parsed >= min) && (max === undefined || parsed <= max)) {
              onChange(parsed)
            }
          }
        }}
        onBlur={() => commit(draft)}
      />
    </label>
  )
}

/** 解析 TOML / JSON 渠道配置片段（如 base_url、model、wire_api、bearer_token、http_headers、image_generation） */
const applyConfigSnippet = (raw: string): boolean => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return false
  }
  const matchTomlString = (key: string): string | null => {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm')
    return re.exec(trimmed)?.[1]?.trim() ?? null
  }
  const matchTomlBool = (key: string): boolean | null => {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\b`, 'mi')
    const val = re.exec(trimmed)?.[1]?.toLowerCase()
    return val === 'true' ? true : val === 'false' ? false : null
  }

  let baseUrl = matchTomlString('base_url') ?? matchTomlString('api_base')
  let model = matchTomlString('model')
  let wireApi = matchTomlString('wire_api')
  let token =
    matchTomlString('experimental_bearer_token') ??
    matchTomlString('bearer_token') ??
    matchTomlString('api_key')
  let headersRaw = ''
  const headersMatch = /^\s*http_headers\s*=\s*(\{[^}]*\})/m.exec(trimmed)
  if (headersMatch?.[1]) {
    // 把 TOML 内联表 `{"k" = "v"}` 转成 `k: v` 行格式
    const pairs: string[] = []
    const pairRe = /["']([^"']+)["']\s*[:=]\s*["']([^"']+)["']/g
    for (const m of headersMatch[1].matchAll(pairRe)) {
      pairs.push(`${m[1]}: ${m[2]}`)
    }
    if (pairs.length > 0) {
      headersRaw = pairs.join('\n')
    }
  }
  let imageGenFlag = matchTomlBool('image_generation')

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof json.base_url === 'string') {
        baseUrl = json.base_url
      }
      if (typeof json.model === 'string') {
        model = json.model
      }
      if (typeof json.wire_api === 'string') {
        wireApi = json.wire_api
      }
      if (typeof json.experimental_bearer_token === 'string') {
        token = json.experimental_bearer_token
      } else if (typeof json.api_key === 'string') {
        token = json.api_key
      }
      if (typeof json.http_headers === 'object' && json.http_headers !== null) {
        headersRaw = JSON.stringify(json.http_headers)
      }
      if (typeof json.image_generation === 'boolean') {
        imageGenFlag = json.image_generation
      }
    } catch {
      // 忽略无效 JSON
    }
  }

  if (!baseUrl && !model && !wireApi && !token && !headersRaw && imageGenFlag === null) {
    return false
  }

  const nextProtocol: ChatProtocol =
    wireApi === 'responses' ? 'responses' : wireApi ? 'openai' : baseUrl ? 'openai' : 'deepseek'
  setChatProtocol(nextProtocol)
  if (baseUrl) {
    setApiOrigin(baseUrl)
  }
  if (model) {
    setModel(model)
  }
  if (token) {
    setApiKey(token)
  }
  if (headersRaw) {
    setCustomHeaders(headersRaw)
  }
  if (imageGenFlag) {
    const prevImg = useSettings.getState().imageGenChannel
    setImageGenChannel({
      ...prevImg,
      enabled: true,
      protocol: wireApi === 'responses' ? 'responses' : prevImg.protocol,
      baseUrl: baseUrl ?? prevImg.baseUrl,
      apiKey: token ?? prevImg.apiKey,
      model: model ?? prevImg.model,
      customHeaders: headersRaw || prevImg.customHeaders,
    })
  }
  return true
}

const LOCAL_PRESETS = [
  { label: 'Ollama (:11434)', url: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio (:1234)', url: 'http://127.0.0.1:1234/v1' },
  { label: 'vLLM (:8000)', url: 'http://127.0.0.1:8000/v1' },
  { label: 'LocalAI (:8080)', url: 'http://127.0.0.1:8080/v1' },
] as const

/** 模型与接口设置：API 密钥、语言模型（动态获取）、多能力渠道、生图渠道及回复/拒答策略 */
export const ModelSettings = ({
  apiKeyEditor,
  isMobile,
}: {
  apiKeyEditor: ReturnType<typeof useApiKeyEditor>
  isMobile: boolean
}) => {
  const t = useTranslate()
  const settings = useSettings()
  const [snippetOpen, setSnippetOpen] = useState(false)
  const [snippetText, setSnippetText] = useState('')
  const [snippetStatus, setSnippetStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const mainBaseUrl = settings.apiOrigin.trim() || getApiOrigin()
  const mainApiKey = settings.apiKey ?? ''

  const protocolOptions: SelectOption<ChatProtocol>[] = [
    { value: 'deepseek', label: t('chatProtocolDeepSeek') },
    { value: 'openai', label: t('chatProtocolOpenAI') },
    { value: 'responses', label: t('chatProtocolResponses') },
    { value: 'local', label: t('chatProtocolLocal') },
  ]

  return (
    <>
      <div className={styles.groupTitle}>{t('modelSettingsSectionRequest')}</div>

      <ApiKeyField editor={apiKeyEditor} />
      {settings.chatProtocol === 'local' ? (
        <div className={styles.fetchHint} style={{ marginTop: -4, marginBottom: 8 }}>
          {t('localApiKeyOptionalHint')}
        </div>
      ) : null}
      {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <span className={styles.description}>{t('importSnippetToggle')}</span>
            <button
              type="button"
              className={styles.linkAction}
              onClick={() => {
                setSnippetOpen((prev) => !prev)
                setSnippetStatus(null)
              }}
            >
              {snippetOpen ? t('cancel') : t('importSnippetToggle')}
            </button>
          </div>
          {snippetOpen ? (
            <>
              <textarea
                className={styles.textareaInput}
                placeholder={t('importSnippetPlaceholder')}
                spellCheck={false}
                value={snippetText}
                onChange={(event) => setSnippetText(event.target.value)}
              />
              <div className={styles.errorRow}>
                {snippetStatus ? (
                  <span className={snippetStatus.error ? styles.error : styles.fetchHint}>
                    {snippetStatus.text}
                  </span>
                ) : (
                  <span />
                )}
                <Button
                  size="s"
                  disabled={!snippetText.trim()}
                  onClick={() => {
                    if (applyConfigSnippet(snippetText)) {
                      setSnippetStatus({ text: t('importSnippetSuccess') })
                      setSnippetText('')
                    } else {
                      setSnippetStatus({ text: t('importSnippetEmpty'), error: true })
                    }
                  }}
                >
                  {t('importSnippetApply')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className={`${styles.cell} ${styles.row}`}>
        <div className={styles.text}>
          <div className={styles.label}>{t('chatProtocolLabel')}</div>
          <div className={styles.description}>{t('chatProtocolDesc')}</div>
        </div>
        <Select
          value={settings.chatProtocol}
          options={protocolOptions}
          ariaLabel={t('chatProtocolLabel')}
          onChange={(protocol) => {
            setChatProtocol(protocol)
            if (protocol === 'local' && !settings.apiOrigin.trim()) {
              setApiOrigin('http://127.0.0.1:11434/v1')
              if (settings.model === DEFAULT_MODEL) {
                setModel('')
              }
            }
          }}
        />
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <div className={styles.label}>{t('modelSettingsApiOriginLabel')}</div>
            {settings.apiOrigin ? (
              <button type="button" className={styles.linkAction} onClick={() => setApiOrigin('')}>
                {t('modelSettingsRestoreDefault')}
              </button>
            ) : null}
          </div>
          <div className={styles.description}>{t('modelSettingsApiOriginDesc')}</div>
          <input
            type="url"
            className={styles.textInput}
            placeholder={
              settings.chatProtocol === 'local'
                ? 'http://127.0.0.1:11434/v1'
                : t('modelSettingsApiOriginPlaceholder')
            }
            spellCheck={false}
            value={settings.apiOrigin}
            onChange={(event) => setApiOrigin(event.target.value)}
          />
          {settings.chatProtocol === 'local' ? (
            <div className={styles.presetRow}>
              <span className={styles.fetchHint}>{t('localPresetLabel')}</span>
              {LOCAL_PRESETS.map((preset) => (
                <button
                  key={preset.url}
                  type="button"
                  className={styles.presetPill}
                  onClick={() => setApiOrigin(preset.url)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <div className={styles.label}>{t('modelSettingsModelLabel')}</div>
            {settings.model !== DEFAULT_MODEL ? (
              <button
                type="button"
                className={styles.linkAction}
                onClick={() => setModel(DEFAULT_MODEL)}
              >
                {t('modelSettingsRestoreDefault')}
              </button>
            ) : null}
          </div>
          <div className={styles.description}>{t('modelSettingsModelDesc')}</div>
          <ModelFetcherInput
            value={settings.model}
            baseUrl={mainBaseUrl}
            apiKey={mainApiKey}
            customHeaders={settings.customHeaders}
            placeholder={t('modelSettingsModelPlaceholder')}
            onChange={setModel}
          />
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <div className={styles.label}>{t('modelSettingsSystemPromptLabel')}</div>
            {settings.systemPrompt !== DEFAULT_SYSTEM_PROMPT ? (
              <button
                type="button"
                className={styles.linkAction}
                onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
              >
                {t('modelSettingsRestoreDefault')}
              </button>
            ) : null}
          </div>
          <div className={styles.description}>{t('modelSettingsSystemPromptDesc')}</div>
          <textarea
            className={styles.textareaInput}
            placeholder={t('modelSettingsSystemPromptPlaceholder')}
            value={settings.systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <div className={styles.label}>{t('modelSettingsVoicePromptLabel')}</div>
            {settings.voiceSystemPrompt !== DEFAULT_VOICE_SYSTEM_PROMPT ? (
              <button
                type="button"
                className={styles.linkAction}
                onClick={() => setVoiceSystemPrompt(DEFAULT_VOICE_SYSTEM_PROMPT)}
              >
                {t('modelSettingsRestoreDefault')}
              </button>
            ) : null}
          </div>
          <div className={styles.description}>{t('modelSettingsVoicePromptDesc')}</div>
          <textarea
            className={styles.textareaInput}
            placeholder={t('modelSettingsVoicePromptPlaceholder')}
            value={settings.voiceSystemPrompt}
            onChange={(event) => setVoiceSystemPrompt(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.paramGrid}>
            <NumberParamInput
              label={t('modelSettingsTemperatureLabel')}
              value={settings.temperature}
              placeholder={t('modelSettingsParamPlaceholder')}
              step="0.1"
              min={0}
              max={2}
              onChange={setTemperature}
            />
            <NumberParamInput
              label={t('modelSettingsTopPLabel')}
              value={settings.topP}
              placeholder={t('modelSettingsParamPlaceholder')}
              step="0.05"
              min={0}
              max={1}
              onChange={setTopP}
            />
            <NumberParamInput
              label={t('modelSettingsMaxTokensLabel')}
              value={settings.maxTokens}
              placeholder={t('modelSettingsParamPlaceholder')}
              step="1"
              min={1}
              integer
              onChange={setMaxTokens}
            />
          </div>
          <div className={styles.description}>{t('modelSettingsParamHint')}</div>
        </div>
      </div>

      <div className={styles.groupTitle}>{t('modelSettingsSectionChannels')}</div>
      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.description}>{t('modelSettingsChannelsHint')}</div>
          <CapabilityChannelCard
            title={t('channelAsrTitle')}
            channel={settings.asrChannel}
            fallbackBaseUrl={mainBaseUrl}
            fallbackApiKey={mainApiKey}
            modelPlaceholder="whisper-1"
            onChange={setAsrChannel}
          />
          <CapabilityChannelCard
            title={t('channelTtsTitle')}
            channel={settings.ttsChannel}
            fallbackBaseUrl={mainBaseUrl}
            fallbackApiKey={mainApiKey}
            modelPlaceholder="tts-1"
            withVoice
            onChange={setTtsChannel}
          />
          <CapabilityChannelCard
            title={t('channelVisionTitle')}
            channel={settings.visionChannel}
            fallbackBaseUrl={mainBaseUrl}
            fallbackApiKey={mainApiKey}
            modelPlaceholder="gpt-4o / qwen-vl-max"
            onChange={setVisionChannel}
          />
          <CapabilityChannelCard
            title={t('channelOcrTitle')}
            channel={settings.ocrChannel}
            fallbackBaseUrl={mainBaseUrl}
            fallbackApiKey={mainApiKey}
            modelPlaceholder="qwen-vl-ocr / gpt-4o"
            onChange={setOcrChannel}
          />
        </div>
      </div>

      <div className={styles.groupTitle}>{t('modelSettingsSectionImageGen')}</div>
      <div className={styles.cell}>
        <ImageGenChannelCard
          channel={settings.imageGenChannel}
          fallbackBaseUrl={mainBaseUrl}
          fallbackApiKey={mainApiKey}
          fallbackCustomHeaders={settings.customHeaders}
          onChange={setImageGenChannel}
        />
      </div>

      <div className={styles.groupTitle}>{t('modelSettingsSectionProtocol')}</div>

      <ToggleCell
        label={t('modelSettingsSafetyCheckLabel')}
        description={t('modelSettingsSafetyCheckDesc')}
        checked={settings.safetyCheck}
        onChange={setSafetyCheck}
      />
      <ToggleCell
        label={t('modelSettingsReadUrlLabel')}
        description={t('modelSettingsReadUrlDesc')}
        checked={settings.readUrl}
        onChange={setReadUrl}
      />
      <ToggleCell
        label={t('modelSettingsLatestReminderLabel')}
        description={t('modelSettingsLatestReminderDesc')}
        checked={settings.sendLatestReminder}
        onChange={setSendLatestReminder}
      />
      <ToggleCell
        label={t('modelSettingsAutoTitleLabel')}
        description={t('modelSettingsAutoTitleDesc')}
        checked={settings.autoTitle}
        onChange={setAutoTitle}
      />

      <div className={styles.groupTitle}>{t('modelSettingsSectionReply')}</div>

      <ToggleCell
        label={t('modelSettingsKeepRefusedLabel')}
        description={t('modelSettingsKeepRefusedDesc')}
        checked={settings.keepRefusedContent}
        onChange={setKeepRefusedContent}
      />
      <ToggleCell
        label={t('modelSettingsAllowRefusedContextLabel')}
        description={t('modelSettingsAllowRefusedContextDesc')}
        checked={settings.allowRefusedContext}
        onChange={setAllowRefusedContext}
      />
      <ToggleCell
        label={t('modelSettingsAllowEditAssistantLabel')}
        description={t('modelSettingsAllowEditAssistantDesc')}
        checked={settings.allowEditAssistant}
        onChange={setAllowEditAssistant}
      />

      <div className={styles.groupTitle}>{t('modelSettingsSectionRefusal')}</div>

      <ToggleCell
        label={t('modelSettingsRefusalEnabledLabel')}
        description={t('modelSettingsRefusalEnabledDesc')}
        checked={settings.refusalEnabled}
        onChange={setRefusalEnabled}
      />
      <ToggleCell
        label={t('modelSettingsRefusalCaseSensitiveLabel')}
        checked={settings.refusalCaseSensitive}
        onChange={setRefusalCaseSensitive}
      />

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.label}>{t('modelSettingsRefusalKeywordsLabel')}</div>
          <div className={styles.description}>{t('modelSettingsRefusalKeywordsDesc')}</div>
          <textarea
            className={styles.textareaInput}
            placeholder={t('modelSettingsRefusalKeywordsPlaceholder')}
            value={settings.refusalKeywords}
            onChange={(event) => setRefusalKeywords(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.field}>
          <div className={styles.fieldHeader}>
            <div className={styles.label}>{t('modelSettingsRefusalMessageLabel')}</div>
            {settings.refusalMessage ? (
              <button
                type="button"
                className={styles.linkAction}
                onClick={() => setRefusalMessage('')}
              >
                {t('modelSettingsRestoreDefault')}
              </button>
            ) : null}
          </div>
          <div className={styles.description}>{t('modelSettingsRefusalMessageDesc')}</div>
          <textarea
            className={styles.textareaInput}
            placeholder={t('replyRefused')}
            value={settings.refusalMessage}
            onChange={(event) => setRefusalMessage(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.resetRow}>
        <Button variant="outlined" size="s" onClick={resetModelAndPolicySettings}>
          {t('modelSettingsResetAll')}
        </Button>
      </div>
    </>
  )
}
