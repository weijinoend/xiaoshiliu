import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Select, type SelectOption } from '../base/Select.js'
import styles from './AssistantMessage.module.css'

const PRESETS = [
  'match',
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1024x1792',
  '1792x1024',
] as const
const GIF_PRESETS = ['match', 'auto', '512x512', '512x768', '768x512', '512x896', '896x512'] as const
const CUSTOM_VALUE = '__custom__'

/** 图片尺寸选择与自定义输入（共用组件：输入框生图条 + 生图确认卡片） */
export const ImageSizePicker = ({
  value,
  hasReference,
  isGif = false,
  compact = false,
  onChange,
}: {
  value: string
  hasReference: boolean
  isGif?: boolean
  compact?: boolean
  onChange: (next: string) => void
}) => {
  const t = useTranslate()
  const normalized = value.trim() || (hasReference ? 'match' : 'auto')
  const presets: readonly string[] = isGif ? GIF_PRESETS : PRESETS
  const isPreset = presets.includes(normalized)
  const [customActive, setCustomActive] = useState(!isPreset)

  useEffect(() => {
    const available: readonly string[] = isGif ? GIF_PRESETS : PRESETS
    if (value.trim() && !available.includes(value.trim())) {
      setCustomActive(true)
    }
  }, [isGif, value])

  const showCustom = customActive || !isPreset

  const isEn = t('latestReminderLanguage') === 'English'
  const compactAuto = isEn ? 'Auto' : '自动'
  const compactMatch = isEn ? 'Match' : '原比例'
  const compactCustom = isEn ? 'Custom' : '自定义'

  const options: SelectOption<string>[] = [
    ...(hasReference
      ? [
          {
            value: 'match',
            label: t('imageGenSizeMatch'),
            triggerLabel: compact ? compactMatch : undefined,
          },
        ]
      : []),
    {
      value: 'auto',
      label: t('imageGenSizeAuto'),
      triggerLabel: compact ? compactAuto : undefined,
    },
    ...(isGif
      ? [
          { value: '512x512', label: '1:1 (512×512)', triggerLabel: compact ? '1:1' : undefined },
          { value: '512x768', label: '2:3 (512×768)', triggerLabel: compact ? '2:3' : undefined },
          { value: '768x512', label: '3:2 (768×512)', triggerLabel: compact ? '3:2' : undefined },
          {
            value: '512x896',
            label: '9:16 (512×896)',
            triggerLabel: compact ? '9:16' : undefined,
          },
          {
            value: '896x512',
            label: '16:9 (896×512)',
            triggerLabel: compact ? '16:9' : undefined,
          },
        ]
      : [
          {
            value: '1024x1024',
            label: '1:1 (1024×1024)',
            triggerLabel: compact ? '1:1' : undefined,
          },
          {
            value: '1024x1536',
            label: '2:3 (1024×1536)',
            triggerLabel: compact ? '2:3' : undefined,
          },
          {
            value: '1536x1024',
            label: '3:2 (1536×1024)',
            triggerLabel: compact ? '3:2' : undefined,
          },
          {
            value: '1024x1792',
            label: '9:16 (1024×1792)',
            triggerLabel: compact ? '9:16' : undefined,
          },
          {
            value: '1792x1024',
            label: '16:9 (1792×1024)',
            triggerLabel: compact ? '16:9' : undefined,
          },
        ]),
    {
      value: CUSTOM_VALUE,
      label: t('imageGenSizeCustom'),
      triggerLabel: compact ? compactCustom : undefined,
    },
  ]

  return (
    <div className={compact ? styles.sizePickerCompact : styles.sizePickerRow}>
      <Select
        value={showCustom ? CUSTOM_VALUE : normalized}
        options={options}
        ariaLabel={t('imageGenSizeLabel')}
        className={compact ? styles.sizeSelectCompact : undefined}
        onChange={(selected) => {
          if (selected === CUSTOM_VALUE) {
            setCustomActive(true)
            if (isPreset) {
              onChange('1280x720')
            }
          } else {
            setCustomActive(false)
            onChange(selected)
          }
        }}
      />
      {showCustom ? (
        <input
          type="text"
          className={styles.sizeCustomInput}
          placeholder={t('imageGenSizePlaceholder')}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  )
}
