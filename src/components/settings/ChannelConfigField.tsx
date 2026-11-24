import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { fetchAvailableModels } from '../../services/api/models.js'
import type {
  ImageGenChannelConfig,
  ServiceChannelConfig,
  ServiceChannelMode,
  TtsChannelConfig,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Select, type SelectOption } from '../base/Select.js'
import styles from './Settings.module.css'

/** 自由输入模型名 + 从 /models 动态获取模型列表，不写死模型选项 */
export const ModelFetcherInput = ({
  value,
  baseUrl,
  apiKey,
  customHeaders = '',
  placeholder,
  onChange,
}: {
  value: string
  baseUrl: string
  apiKey: string
  customHeaders?: string
  placeholder: string
  onChange: (model: string) => void
}) => {
  const t = useTranslate()
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
    }
  }, [])

  const handleFetch = async () => {
    if (loading) {
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setStatus(null)
    try {
      const list = await fetchAvailableModels(baseUrl, apiKey, controller.signal, customHeaders)
      if (!mountedRef.current || controller.signal.aborted) {
        return
      }
      setModels(list)
      setStatus({ text: t('fetchModelsSuccess', { count: list.length }) })
      if (!valueRef.current.trim() && list.length > 0) {
        onChangeRef.current(list[0])
      }
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) {
        return
      }
      setStatus({
        text: t('fetchModelsFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
        error: true,
      })
    } finally {
      if (mountedRef.current && controllerRef.current === controller) {
        setLoading(false)
      }
    }
  }

  const options: SelectOption<string>[] = models.map((id) => ({ value: id, label: id }))

  return (
    <div className={styles.field}>
      <div className={styles.fetchRow}>
        <input
          type="text"
          className={clsx(styles.textInput, styles.fetchInput)}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button size="m" variant="outlined" disabled={loading} onClick={() => void handleFetch()}>
          {loading ? t('fetchingModels') : t('fetchModelsButton')}
        </Button>
      </div>
      {models.length > 0 ? (
        <Select
          value={models.includes(value) ? value : ''}
          options={options}
          placeholder={t('fetchedModelsPlaceholder')}
          className={styles.fetchSelect}
          onChange={onChange}
        />
      ) : null}
      {status ? (
        <div className={status.error ? styles.error : styles.fetchHint}>{status.text}</div>
      ) : null}
    </div>
  )
}

/** 语音识别 / 语音合成 / 图片识别 / 文字识别 的统一自定义渠道配置卡片 */
export const CapabilityChannelCard = <T extends ServiceChannelConfig | TtsChannelConfig>({
  title,
  channel,
  fallbackBaseUrl,
  fallbackApiKey,
  modelPlaceholder,
  withVoice = false,
  onChange,
}: {
  title: string
  channel: T
  fallbackBaseUrl: string
  fallbackApiKey: string
  modelPlaceholder: string
  withVoice?: boolean
  onChange: (next: T) => void
}) => {
  const t = useTranslate()
  const modeOptions: SelectOption<ServiceChannelMode>[] = [
    { value: 'inherit', label: t('channelModeInherit') },
    { value: 'custom', label: t('channelModeCustom') },
  ]

  return (
    <div className={styles.channelCard}>
      <div className={styles.channelCardHeader}>
        <span className={styles.label}>{title}</span>
        <Select
          value={channel.mode}
          options={modeOptions}
          ariaLabel={title}
          onChange={(mode) => onChange({ ...channel, mode })}
        />
      </div>
      {channel.mode === 'custom' ? (
        <div className={styles.channelBody}>
          <label className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelBaseUrlLabel')}</span>
            <input
              type="url"
              className={styles.textInput}
              placeholder={fallbackBaseUrl || 'https://api.openai.com'}
              spellCheck={false}
              value={channel.baseUrl}
              onChange={(event) => onChange({ ...channel, baseUrl: event.target.value })}
            />
          </label>
          <label className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelApiKeyLabel')}</span>
            <input
              type="password"
              className={styles.textInput}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              value={channel.apiKey}
              onChange={(event) => onChange({ ...channel, apiKey: event.target.value })}
            />
          </label>
          <div className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelModelLabel')}</span>
            <ModelFetcherInput
              value={channel.model}
              baseUrl={channel.baseUrl.trim() || fallbackBaseUrl}
              apiKey={channel.apiKey.trim() || fallbackApiKey}
              placeholder={modelPlaceholder}
              onChange={(model) => onChange({ ...channel, model })}
            />
          </div>
          {withVoice && 'voice' in channel ? (
            <label className={styles.paramItem}>
              <span className={styles.paramLabel}>{t('channelVoiceLabel')}</span>
              <input
                type="text"
                className={styles.textInput}
                placeholder="alloy"
                spellCheck={false}
                value={channel.voice}
                onChange={(event) => onChange({ ...channel, voice: event.target.value })}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 极简生图模型渠道配置：只需开关、网址、API 密钥、获取模型即可生图（尺寸放到点生图时设置） */
export const ImageGenChannelCard = ({
  channel,
  fallbackBaseUrl,
  fallbackApiKey,
  fallbackCustomHeaders,
  onChange,
}: {
  channel: ImageGenChannelConfig
  fallbackBaseUrl: string
  fallbackApiKey: string
  fallbackCustomHeaders: string
  onChange: (next: ImageGenChannelConfig) => void
}) => {
  const t = useTranslate()

  return (
    <div className={styles.channelCard}>
      <div className={styles.channelCardHeader}>
        <div className={styles.text}>
          <div className={styles.label}>{t('imageGenEnabledLabel')}</div>
          <div className={styles.description}>{t('imageGenEnabledDesc')}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={channel.enabled}
          aria-label={t('imageGenEnabledLabel')}
          className={styles.switch}
          onClick={() => onChange({ ...channel, enabled: !channel.enabled })}
        >
          <span className={styles.switchThumb} />
        </button>
      </div>
      {channel.enabled ? (
        <div className={styles.channelBody}>
          <div className={styles.channelCardHeader}>
            <div className={styles.text}>
              <div className={styles.label}>{t('imageGenRequireConfirmLabel')}</div>
              <div className={styles.description}>{t('imageGenRequireConfirmDesc')}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={channel.requireConfirm}
              aria-label={t('imageGenRequireConfirmLabel')}
              className={styles.switch}
              onClick={() => onChange({ ...channel, requireConfirm: !channel.requireConfirm })}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>
          <label className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelBaseUrlLabel')}</span>
            <input
              type="url"
              className={styles.textInput}
              placeholder={fallbackBaseUrl || 'https://api.openai.com/v1'}
              spellCheck={false}
              value={channel.baseUrl}
              onChange={(event) => onChange({ ...channel, baseUrl: event.target.value })}
            />
          </label>
          <label className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelApiKeyLabel')}</span>
            <input
              type="password"
              className={styles.textInput}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              value={channel.apiKey}
              onChange={(event) => onChange({ ...channel, apiKey: event.target.value })}
            />
          </label>
          <div className={styles.paramItem}>
            <span className={styles.paramLabel}>{t('channelModelLabel')}</span>
            <ModelFetcherInput
              value={channel.model}
              baseUrl={channel.baseUrl.trim() || fallbackBaseUrl}
              apiKey={channel.apiKey.trim() || fallbackApiKey}
              customHeaders={channel.customHeaders.trim() || fallbackCustomHeaders}
              placeholder="gpt-image-1 / dall-e-3 / flux"
              onChange={(model) => onChange({ ...channel, model })}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
